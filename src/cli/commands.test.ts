import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentSessionProvider } from '../agent/session.js';
import { scriptedSuccess } from '../agent/scripted-provider.js';
import { ArtifactStore } from '../artifact/store.js';
import { CapabilityRegistry } from '../contract/capability.js';
import { openDatabase } from '../database.js';
import { ComposeProviderError } from '../env/compose-provider.js';
import { envProvisionContract } from '../env/provision.js';
import type { OperatorIo } from '../elicit/session.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { deployFingerprint } from '../policy/deploy-gate.js';
import type { ReleaseArtifact } from '../release/deliver.js';
import { planSchema, projectArtifactSchemas, projectOutputSchemas } from '../schemas.js';
import { summaryOf } from '../dashboard/projection.js';
import { computeEscapedDefectRate } from '../state/escaped-defect-rate.js';
import { computeRunMetrics } from '../state/metrics.js';
import { fold } from '../state/reduce.js';
import { defectSchema, fileDefect, routeDefect } from '../test/defect.js';
import { CONVENTION_CITATION_REASON } from '../trace/index-store.js';
import {
  defect,
  intervene,
  recordMerge,
  rollback,
  run,
  status,
  supersede,
  trace,
  type CliContext,
} from './commands.js';

/**
 * `rollback` (T4.1.5), against a fake `env.provision` rather than a real
 * Docker daemon — `dockerReleaseProvider#rollback` delegates straight to
 * `env.provision#up` with no `assemble` step in between (`../release/
 * docker-provider.ts`), so a fake `env.provision` provider is enough to
 * exercise the real gate (`gateProductionRelease`, applied inside
 * `dockerReleaseProvider` exactly as `rollback`'s own real wiring applies
 * it) and the real event recording, with nothing here needing a container
 * runtime. `scripts/demo/cli-e2e.mjs` covers the CLI's own argument parsing
 * end to end; this covers what happens once `rollback` (the function) is
 * actually called.
 */

const noProvider: AgentSessionProvider = {
  run: () => Promise.reject(new Error('rollback never starts a session')),
};

const noIo: OperatorIo = {
  ask: () => Promise.reject(new Error('rollback never asks the operator anything')),
  notify: () => {
    throw new Error('rollback never notifies the operator directly');
  },
};

/** `src/cli/` -> repo root, to read mpgm's own Scope artifact as a fixture. */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function newContext(root: string, writes: string[]): CliContext {
  return {
    root,
    provider: noProvider,
    io: noIo,
    outputSchemas: projectOutputSchemas(),
    artifactSchemas: projectArtifactSchemas(),
    write: (line) => writes.push(line),
  };
}

/**
 * A fake `env.provision` reporting whatever `up`/`services` a test wants.
 *
 * `onUp`, when given, runs synchronously at the moment `up` is *called* —
 * before it resolves, and before `rollback` can have done anything in
 * response to the outcome. A test that wants to prove `ReleaseRollbackStarted`
 * exists *before* the provider is invoked (not merely before `rollback`
 * returns) reads the log from inside this callback: reading it only after
 * `rollback` settles cannot tell "recorded before the call" from "recorded
 * once the outcome was known", since by then both are already true.
 */
function fakeEnvProvision(
  up: boolean,
  services: readonly {
    name: string;
    state: string;
    health?: string;
    containerId?: string;
  }[] = [],
  onUp?: () => void,
) {
  const registry = new CapabilityRegistry();
  return registry.bind(envProvisionContract, {
    up: () => {
      onUp?.();
      return Promise.resolve({ env: 'x', up, services });
    },
    down: () => Promise.resolve({ env: 'x', up: false, services: [] }),
    status: () => Promise.resolve({ env: 'x', up: false, services: [] }),
  });
}

/**
 * A fake `env.provision` whose `up` rejects, the way `composeProvider#up`
 * does once `docker compose up -d --wait` exits non-zero
 * (`../env/compose-provider.ts`) — after the containers have already been
 * recreated on the restored digest, never before. Exercises the same "the
 * gate let this through, then the call itself failed" path without a real
 * Docker daemon.
 *
 * `onUp` runs synchronously at the moment `up` is called, before the
 * rejection — see `fakeEnvProvision` above for why that timing is the point.
 */
function fakeEnvProvisionRejecting(error: Error, onUp?: () => void) {
  const registry = new CapabilityRegistry();
  return registry.bind(envProvisionContract, {
    up: () => {
      onUp?.();
      return Promise.reject(error);
    },
    down: () => Promise.resolve({ env: 'x', up: false, services: [] }),
    status: () => Promise.resolve({ env: 'x', up: false, services: [] }),
  });
}

function artifact(overrides: Partial<ReleaseArtifact> = {}): ReleaseArtifact {
  return {
    version: '1.0.0',
    image: 'sample:1.0.0',
    digest: `sha256:${'a'.repeat(64)}`,
    changelog: 'Restores the last known-good build.',
    rollbackTo: null,
    ...overrides,
  };
}

/**
 * Writes a `deploy/environments/environments.yaml` declaring `env` — every
 * caller of `gatedEnvironments` (`../policy/deploy-gate.ts`'s
 * `DeployGateOptions.gatedEnvs`) reads this manifest to decide whether an
 * environment is gated *at all*, so even the ungated case needs one to
 * exist, not just the gated case.
 */
function declaredRepo(env: string, approval: 'required' | 'none'): string {
  const repo = mkdtempSync(join(tmpdir(), 'mpgm-rollback-target-'));
  mkdirSync(join(repo, 'deploy', 'environments'), { recursive: true });
  writeFileSync(
    join(repo, 'deploy', 'environments', 'environments.yaml'),
    [
      'environments:',
      `  - name: ${env}`,
      '    compose: deploy/environments/x/compose.yaml',
      '    project: mpgm-x-test',
      `    approval: ${approval}`,
    ].join('\n'),
  );
  return repo;
}

function releaseRolledBackEvents(root: string): readonly unknown[] {
  const db = openDatabase(join(root, '.mpgm', 'state.db'));
  try {
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    return log.read({ type: 'ReleaseRolledBack' }).map((event) => event.payload);
  } finally {
    db.close();
  }
}

/** `ReleaseRollbackStarted` — the durable "reached the environment" record
 * (T4.1.5, DESIGN §6) `rollback` appends before ever calling the provider. */
function releaseRollbackStartedEvents(root: string): readonly unknown[] {
  const db = openDatabase(join(root, '.mpgm', 'state.db'));
  try {
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    return log.read({ type: 'ReleaseRollbackStarted' }).map((event) => event.payload);
  } finally {
    db.close();
  }
}

/** `ReleaseRollbackRefused` — what a refusal reachable before the
 * environment is touched records instead of a `ReleaseRolledBack` (HIL-5). */
function releaseRollbackRefusedEvents(root: string): readonly unknown[] {
  const db = openDatabase(join(root, '.mpgm', 'state.db'));
  try {
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    return log.read({ type: 'ReleaseRollbackRefused' }).map((event) => event.payload);
  } finally {
    db.close();
  }
}

describe('rollback', () => {
  it('rolls back an ungated environment and records the outcome (HIL-5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('test', 'none');
    const writes: string[] = [];
    const to = artifact();
    // Captured *inside* the provider's `up`, at the moment it is called —
    // not after `rollback` returns, when both "recorded before the call"
    // and "recorded only once the outcome is known" would already look the
    // same (T4.1.5). A version of `rollback` that appended
    // `ReleaseRollbackStarted` only after `release.invoke` settled would
    // leave this `[]`.
    let startedWhenProviderRan: readonly unknown[] | undefined;

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      to,
      'macg',
      'restoring the last known-good build',
      {
        envProvision: fakeEnvProvision(
          true,
          [{ name: 'svc', state: 'running', health: 'healthy', containerId: 'c1' }],
          () => {
            startedWhenProviderRan = releaseRollbackStartedEvents(root);
          },
        ),
      },
    );

    expect(result.ok).toBe(true);
    expect(writes.join('\n')).toContain('rolled back to 1.0.0');

    // The durable "reached the environment" record exists before the
    // provider is called (T4.1.5, DESIGN §6), not only once the outcome is
    // known — proved by reading it from inside the provider itself, above.
    const expectedStarted = [
      { repo, env: 'test', to: { version: to.version, digest: to.digest }, by: 'macg' },
    ];
    expect(startedWhenProviderRan).toEqual(expectedStarted);
    expect(releaseRollbackStartedEvents(root)).toEqual(expectedStarted);
    const recorded = releaseRolledBackEvents(root);
    expect(recorded).toEqual([
      {
        repo,
        env: 'test',
        to: { version: to.version, digest: to.digest },
        by: 'macg',
        reason: 'restoring the last known-good build',
        up: true,
      },
    ]);
  });

  it('reports failure, not success, when the restored environment does not come up — but still records it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('test', 'none');
    const writes: string[] = [];
    const to = artifact();

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      to,
      'macg',
      'restoring the last known-good build',
      { envProvision: fakeEnvProvision(false) },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('not up');
    // CONV-3: the caveat this outcome is most concretely true for — the
    // provider *returned*, so the environment may already be serving the
    // restored digest and is merely not reporting healthy — plus what was
    // recorded, alongside the existing summary.
    const message = writes.join('\n');
    expect(message).toContain('NOT up — check the environment');
    expect(message).toContain('may already be serving the restored digest');
    expect(message).toContain('ReleaseRollbackStarted');
    expect(message).toContain('ReleaseRolledBack');

    expect(releaseRollbackStartedEvents(root)).toEqual([
      { repo, env: 'test', to: { version: to.version, digest: to.digest }, by: 'macg' },
    ]);
    const recorded = releaseRolledBackEvents(root);
    expect(recorded).toEqual([
      {
        repo,
        env: 'test',
        to: { version: to.version, digest: to.digest },
        by: 'macg',
        reason: 'restoring the last known-good build',
        up: false,
      },
    ]);
  });

  it('records a rollback that threw after the gate let it through, rather than reporting it as refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('test', 'none');
    const writes: string[] = [];
    const to = artifact();
    const failure = new Error(
      "'docker compose up' for 'test' did not become healthy: some stderr",
    );
    // See the ungated success test above: captured inside the provider,
    // before it rejects, so this proves the record predates the call rather
    // than merely predating `rollback`'s return.
    let startedWhenProviderRan: readonly unknown[] | undefined;

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      to,
      'macg',
      'restoring the last known-good build',
      {
        envProvision: fakeEnvProvisionRejecting(failure, () => {
          startedWhenProviderRan = releaseRollbackStartedEvents(root);
        }),
      },
    );

    expect(result.ok).toBe(false);
    // Not 'rollback refused' — the provider was actually invoked, and by the
    // time it threw the containers had already been recreated on the
    // restored digest (`composeProvider#up` throws only after `docker
    // compose up -d --wait` runs).
    expect(result.detail).toBe('rollback failed');
    // The provider's own message (CONV-3)...
    expect(writes.join('\n')).toContain('did not become healthy');
    // ...alongside what this failure means for the environment and what was
    // recorded because of it (CONV-3, the finding the previous review left
    // open).
    expect(writes.join('\n')).toContain('may already be serving the restored digest');
    expect(writes.join('\n')).toContain('ReleaseRollbackStarted');
    expect(writes.join('\n')).toContain('ReleaseRolledBack');

    // The environment was reached before this failure — the durable record
    // proves it, not just the classification of what was thrown. Read from
    // inside the provider, `startedWhenProviderRan` shows the record already
    // existed *before* the rejection, not merely before `rollback` returned.
    const expectedStarted = [
      { repo, env: 'test', to: { version: to.version, digest: to.digest }, by: 'macg' },
    ];
    expect(startedWhenProviderRan).toEqual(expectedStarted);
    expect(releaseRollbackStartedEvents(root)).toEqual(expectedStarted);
    const recorded = releaseRolledBackEvents(root);
    expect(recorded).toEqual([
      {
        repo,
        env: 'test',
        to: { version: to.version, digest: to.digest },
        by: 'macg',
        reason: `restoring the last known-good build — rollback failed: ${failure.message}`,
        up: false,
      },
    ]);
  });

  it('refuses a gated environment whose digest was never confirmed, recording the refusal itself but nothing that claims the environment was touched (HIL-5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('staging', 'required');
    const writes: string[] = [];

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'staging',
      repo,
      artifact(),
      'macg',
      '',
      {
        envProvision: fakeEnvProvision(true, [
          { name: 'svc', state: 'running', health: 'healthy', containerId: 'c1' },
        ]),
      },
    );

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain('has not been simulated');
    // No claim this reached the environment...
    expect(releaseRollbackStartedEvents(root)).toEqual([]);
    expect(releaseRolledBackEvents(root)).toEqual([]);
    // ...but the attempt itself is still in the log (HIL-5): an operator who
    // tried is not indistinguishable from one who never ran the command.
    const refused = releaseRollbackRefusedEvents(root);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ repo, env: 'staging', by: 'macg' });
    expect((refused[0] as { reason: string }).reason).toContain('has not been simulated');
  });

  it("proceeds without a fresh confirmation once this environment's digest was already confirmed (DESIGN §9 decision 11)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('staging', 'required');
    const to = artifact({ digest: `sha256:${'b'.repeat(64)}` });

    // The exact confirmation `release.deliver#deliver` of the same
    // `{repo, env, digest}` would have recorded — a rollback restoring it
    // asks for nothing new.
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    const print = deployFingerprint({ repo, env: 'staging', digest: to.digest });
    log.append({
      runId: 'r1',
      type: 'RunStarted',
      payload: { project: root, operator: 'macg' },
    });
    log.append({
      runId: 'r1',
      type: 'DryRunRecorded',
      payload: { taskId: 'kernel:deploy-gate', tool: 'deploy', fingerprint: print },
    });
    log.append({
      runId: 'r1',
      type: 'DestructiveOpConfirmed',
      payload: {
        taskId: 'kernel:deploy-gate',
        tool: 'deploy',
        fingerprint: print,
        by: 'macg',
        reason: 'approved when v1.0.0 was delivered',
      },
    });
    db.close();

    const writes: string[] = [];
    const result = await rollback(
      newContext(root, writes),
      'r1',
      'staging',
      repo,
      to,
      'macg',
      'v1.1.0 failed its smoke checks',
      {
        envProvision: fakeEnvProvision(true, [
          { name: 'svc', state: 'running', health: 'healthy', containerId: 'c1' },
        ]),
      },
    );

    expect(result.ok).toBe(true);
    expect(releaseRollbackStartedEvents(root)).toEqual([
      {
        repo,
        env: 'staging',
        to: { version: to.version, digest: to.digest },
        by: 'macg',
      },
    ]);
    expect(releaseRolledBackEvents(root)).toEqual([
      {
        repo,
        env: 'staging',
        to: { version: to.version, digest: to.digest },
        by: 'macg',
        reason: 'v1.1.0 failed its smoke checks',
        up: true,
      },
    ]);
  });

  it('refuses a release artifact that is not a valid one, before the gate or the environment is ever touched, but records the refusal itself (HIL-5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('test', 'none');
    const writes: string[] = [];

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      { ...artifact(), changelog: '' },
      'macg',
      '',
      { envProvision: fakeEnvProvision(true) },
    );

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain('not a valid release artifact');
    expect(releaseRollbackStartedEvents(root)).toEqual([]);
    expect(releaseRolledBackEvents(root)).toEqual([]);
    const refused = releaseRollbackRefusedEvents(root);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ repo, env: 'test', by: 'macg' });
    expect((refused[0] as { reason: string }).reason).toContain(
      'not a valid release artifact',
    );
  });

  it('refuses an environment the manifest does not declare, before the gate or the environment is ever touched, but records the refusal itself (HIL-5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const repo = declaredRepo('test', 'none');
    const writes: string[] = [];

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'not-declared',
      repo,
      artifact(),
      'macg',
      '',
      { envProvision: fakeEnvProvision(true) },
    );

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain("'not-declared' is not declared");
    expect(releaseRollbackStartedEvents(root)).toEqual([]);
    expect(releaseRolledBackEvents(root)).toEqual([]);
    const refused = releaseRollbackRefusedEvents(root);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ repo, env: 'not-declared', by: 'macg' });
  });

  it('refuses an absent or unreadable repository, before the gate or the environment is ever touched, but records the refusal itself (HIL-5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    // No `deploy/environments/environments.yaml` at all — unlike
    // `declaredRepo`, nothing here writes one.
    const repo = mkdtempSync(join(tmpdir(), 'mpgm-rollback-no-manifest-'));
    const writes: string[] = [];

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      artifact(),
      'macg',
      '',
      { envProvision: fakeEnvProvision(true) },
    );

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain('no environments manifest');
    expect(releaseRollbackStartedEvents(root)).toEqual([]);
    expect(releaseRolledBackEvents(root)).toEqual([]);
    const refused = releaseRollbackRefusedEvents(root);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ repo, env: 'test', by: 'macg' });
  });

  it('records two rollbacks that fail with the identical error type differently, depending on whether the environment was already touched (T4.1.5)', async () => {
    // Both cases throw the very same error class `composeProvider` itself
    // raises (`ComposeProviderError`) — the point is that classifying by
    // exception type alone cannot tell these apart; only the durable record
    // written before the provider is ever called can.

    // Before: the repo has no readable environments manifest at all, so
    // `loadDeclaredEnvironments` throws `ComposeProviderError` before
    // anything downstream of it — including the provider — is ever reached.
    const beforeRoot = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const beforeRepo = mkdtempSync(join(tmpdir(), 'mpgm-rollback-no-manifest-'));
    const before = await rollback(
      newContext(beforeRoot, []),
      'r1',
      'test',
      beforeRepo,
      artifact(),
      'macg',
      '',
      { envProvision: fakeEnvProvision(true) },
    );
    expect(before.ok).toBe(false);

    // After: the environment is declared and ungated, so every refusal
    // above already passed and the provider was actually invoked — it is
    // the provider itself (`composeProvider#up`, faked here) that throws the
    // identical `ComposeProviderError`, after the containers were already
    // recreated on the restored digest.
    const afterRoot = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const afterRepo = declaredRepo('test', 'none');
    const after = await rollback(
      newContext(afterRoot, []),
      'r1',
      'test',
      afterRepo,
      artifact(),
      'macg',
      '',
      {
        envProvision: fakeEnvProvisionRejecting(
          new ComposeProviderError(
            "'docker compose up' for 'test' did not become healthy: some stderr",
          ),
        ),
      },
    );
    expect(after.ok).toBe(false);

    // Before the environment was ever touched: a refusal, and nothing that
    // claims a rollback reached or happened.
    expect(releaseRollbackStartedEvents(beforeRoot)).toEqual([]);
    expect(releaseRolledBackEvents(beforeRoot)).toEqual([]);
    expect(releaseRollbackRefusedEvents(beforeRoot)).toHaveLength(1);

    // After the environment was already touched: the durable "reached"
    // record exists, and the failure is recorded as a rollback that ran and
    // failed — not as a refusal, even though the thrown error is the exact
    // same class as the "before" case above.
    expect(releaseRollbackStartedEvents(afterRoot)).toEqual([
      {
        repo: afterRepo,
        env: 'test',
        to: { version: '1.0.0', digest: artifact().digest },
        by: 'macg',
      },
    ]);
    expect(releaseRolledBackEvents(afterRoot)).toEqual([
      {
        repo: afterRepo,
        env: 'test',
        to: { version: '1.0.0', digest: artifact().digest },
        by: 'macg',
        reason:
          "rollback failed: 'docker compose up' for 'test' did not become healthy: some stderr",
        up: false,
      },
    ]);
    expect(releaseRollbackRefusedEvents(afterRoot)).toEqual([]);
  });
});

/**
 * `recordMerge` / `mpgm record-merge` (T4.2.15, HIL-5, OBS-1) — a task the
 * implement loop abandoned on a budget, merged by an operator's own hand
 * afterwards.
 */
describe('recordMerge', () => {
  function newGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-repo-'));
    const git = (args: readonly string[]): void => {
      execFileSync('git', [...args], { cwd: dir, encoding: 'utf8' });
    };
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'README.md'), '# sample\n');
    git(['add', '--all']);
    git(['commit', '-m', 'initial']);
    return dir;
  }

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
  }

  /**
   * A pull request GitHub merged, played back locally: a branch carrying the
   * task's change, merged into `main` the way an operator's "Merge pull
   * request" button would — `recordMerge` never asks how the commit got
   * there, only whether it is reachable, so a plain `--no-ff` merge is
   * enough to stand in for one.
   */
  function mergeTaskBranch(repo: string, taskId: string): string {
    git(repo, ['checkout', '-b', `mpgm/${taskId}`]);
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = 1;\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'add the feature']);
    git(repo, ['checkout', 'main']);
    git(repo, [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Merge mpgm/${taskId}`,
      `mpgm/${taskId}`,
    ]);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  /** A task abandoned on a review budget, the M4.2 shape this task exists
   * for: completed, reviewed and rejected three times, then blocked. */
  function abandonedOnReviewBudget(root: string, runId: string, taskId: string): void {
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        { runId, type: 'RunStarted', payload: { project: root, operator: 'op' } },
        {
          runId,
          type: 'TaskDispatched',
          payload: { taskId, role: 'implementer', model: 'claude-sonnet-5' },
        },
        { runId, type: 'TaskCompleted', payload: { taskId, artifactRefs: [] } },
        {
          runId,
          type: 'ChangeReviewed',
          payload: {
            taskId,
            reviewTaskId: `${taskId}-review-3`,
            reviewerRole: 'code-reviewer',
            ref: 'abc1234',
            approved: false,
            summary: 'still not addressed',
            findings: 1,
          },
        },
        {
          runId,
          type: 'BudgetExceeded',
          payload: { taskId, kind: 'reviews', limit: 3, observed: 3 },
        },
        {
          runId,
          type: 'TaskBlocked',
          payload: { taskId, reason: 'the review still refuses the change' },
        },
      ]);
    } finally {
      db.close();
    }
  }

  function eventsOf(root: string): readonly unknown[] {
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      return log.read();
    } finally {
      db.close();
    }
  }

  it('drives a task to BudgetExceeded, records the operator merge, and reads it back from the log alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-root-'));
    const repo = newGitRepo();
    const commit = mergeTaskBranch(repo, 'T1');
    abandonedOnReviewBudget(root, 'r1', 'T1');

    const writes: string[] = [];
    const result = await recordMerge(
      newContext(root, writes),
      'r1',
      'T1',
      commit,
      'macg',
      'merged pull request #135 by hand',
      repo,
      'main',
    );

    expect(result.ok).toBe(true);
    expect(writes.join('\n')).toContain('T1 recorded merged by macg');

    // CONV-6: this must be able to fail. Checked independently of the code
    // path under test — not by trusting `result.ok` — that the recorded sha
    // really is reachable from the trunk.
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', commit, 'main'], {
        cwd: repo,
        encoding: 'utf8',
      }),
    ).not.toThrow();

    // Everything from here reads a fresh open of the log alone, not `result`.
    const events = eventsOf(root);
    const state = fold(events as never);
    const task = state.runs.r1?.tasks.T1;

    expect(task?.status).toBe('blocked'); // the harness's own outcome, unchanged
    expect(task?.merged).toMatchObject({
      commit,
      branch: 'mpgm/T1',
      into: 'main',
      by: 'macg',
      lastReviewApproved: false,
      reviewTaskId: '', // a rejected review does not authorise a merge
    });

    // The merged-tasks denominator moved: nothing had merged for this run
    // before this task's own change landed and was recorded.
    const rate = computeEscapedDefectRate('r1', events as never, []);
    expect(rate.merged).toBe(1);
  });

  // T4.2.15: `status` prints `task.status`, and that field never becomes
  // anything but `blocked` for this task — the log is append-only. A reader
  // of `status` alone must be able to see the merge without folding the log
  // themselves, the same combined reading `pm/projection.ts`'s `columnFor`
  // and `dashboard/projection.ts` already give this state.
  it('reports a hand-merged task as blocked-and-merged in one status line, not blocked alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-root-'));
    const repo = newGitRepo();
    const commit = mergeTaskBranch(repo, 'T1');
    abandonedOnReviewBudget(root, 'r1', 'T1');

    await recordMerge(
      newContext(root, []),
      'r1',
      'T1',
      commit,
      'macg',
      'merged pull request #135 by hand',
      repo,
      'main',
    );

    const writes: string[] = [];
    const result = status(newContext(root, writes), 'r1');

    expect(result.ok).toBe(true);
    const taskLine = writes
      .join('\n')
      .split('\n')
      .find((line) => line.includes('task T1 '));
    expect(taskLine).toContain('blocked');
    expect(taskLine).toContain(`merged by macg at ${commit.slice(0, 12)}`);
  });

  it('refuses to record a merge that never reached the trunk, and appends nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-root-'));
    const repo = newGitRepo();
    // A real commit, on a branch never merged into `main`.
    git(repo, ['checkout', '-b', 'mpgm/T1']);
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = 1;\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'add the feature']);
    const unmerged = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    abandonedOnReviewBudget(root, 'r1', 'T1');

    const writes: string[] = [];
    const result = await recordMerge(
      newContext(root, writes),
      'r1',
      'T1',
      unmerged,
      'macg',
      'claims a merge that never happened',
      repo,
      'main',
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unverified merge');
    expect(writes.join('\n')).toContain('not reachable');

    const events = eventsOf(root);
    expect(
      (events as { type: string }[]).some(
        (event) => event.type === 'ChangeMergedByOperator',
      ),
    ).toBe(false);
    const state = fold(events as never);
    expect(state.runs.r1?.tasks.T1?.merged).toBeNull();
  });

  // T4.2.15 rework: `--commit` is operator input, and an operator reaches for
  // `HEAD` (or `main`, or an abbreviation) as readily as a sha. Every one of
  // those resolves elsewhere — or here, later — to a different commit, so
  // writing the string as typed into an append-only log is the T4.2.12 defect
  // arriving by another door. What is appended is the sha git resolved.
  it('records the resolved sha, not the symbolic ref the operator typed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-root-'));
    const repo = newGitRepo();
    const commit = mergeTaskBranch(repo, 'T1');
    abandonedOnReviewBudget(root, 'r1', 'T1');

    const result = await recordMerge(
      newContext(root, []),
      'r1',
      'T1',
      'HEAD',
      'macg',
      'merged by hand, sha copied from the local checkout',
      repo,
      'main',
    );

    expect(result.ok).toBe(true);

    const merged = fold(eventsOf(root) as never).runs.r1?.tasks.T1?.merged;
    expect(merged?.commit).toBe(commit);
    expect(merged?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // T4.2.15 rework: reachable-from-the-trunk is not the same claim as this
  // task's change landed. Without the tie, any commit on `main` records as
  // any task's merge, and the resulting event is indistinguishable in the log
  // from a true one — a record nothing verified, which is what this verb
  // exists to refuse (CONV-4).
  it('refuses a trunk commit that is not this task-s merge, and appends nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-root-'));
    const repo = newGitRepo();
    mergeTaskBranch(repo, 'T1');
    // Somebody else's work, landing on the trunk after T1's own merge.
    writeFileSync(join(repo, 'unrelated.ts'), 'export const other = 2;\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'unrelated work']);
    const unrelated = git(repo, ['rev-parse', 'HEAD']);
    abandonedOnReviewBudget(root, 'r1', 'T2');

    const writes: string[] = [];
    const result = await recordMerge(
      newContext(root, writes),
      'r1',
      'T2',
      unrelated,
      'macg',
      'a commit on main that carries nothing of T2',
      repo,
      'main',
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unverified merge');
    expect(writes.join('\n')).toContain('nothing ties it to T2');

    const events = eventsOf(root);
    expect(
      (events as { type: string }[]).some(
        (event) => event.type === 'ChangeMergedByOperator',
      ),
    ).toBe(false);
    expect(fold(events as never).runs.r1?.tasks.T2?.merged).toBeNull();
  });

  it('refuses to overwrite a merge already recorded, kernel or operator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-record-merge-root-'));
    const repo = newGitRepo();
    const commit = mergeTaskBranch(repo, 'T1');
    abandonedOnReviewBudget(root, 'r1', 'T1');

    const writes: string[] = [];
    const first = await recordMerge(
      newContext(root, writes),
      'r1',
      'T1',
      commit,
      'macg',
      'merged pull request #135 by hand',
      repo,
      'main',
    );
    expect(first.ok).toBe(true);

    const secondWrites: string[] = [];
    const second = await recordMerge(
      newContext(root, secondWrites),
      'r1',
      'T1',
      commit,
      'someone-else',
      'trying again',
      repo,
      'main',
    );

    expect(second.ok).toBe(false);
    expect(second.detail).toBe('already merged');

    const events = eventsOf(root) as { type: string }[];
    expect(
      events.filter((event) => event.type === 'ChangeMergedByOperator'),
    ).toHaveLength(1);
  });
});

/**
 * `supersede` (T4.3.7, PLN-4, OBS-1, OBS-4) — mpgm's own T4.1.4 was split
 * into T4.1.4a/b/c as a document revision, and nothing told the log:
 * T4.1.4 sat on `blocked` after `BudgetExceeded{kind: 'steps'}`, and
 * T4.1.4-review-2 sat on `dispatched` with no terminal event at all, both
 * permanent denominator entries `aggregate()` (`state/metrics.ts`) could
 * never settle.
 */
describe('supersede', () => {
  const splitTask = (id: string) => ({
    id,
    title: `Task ${id}`,
    completionCriteria: [`${id} is done`],
    dependsOn: [],
    tracesTo: ['PLN-4'],
  });

  /** A gated Plan that declares T4.1.4a/b/c and no T4.1.4 at all — the
   * PLN-4 split applied as a document revision, exactly as it happened. */
  const PLAN_AFTER_SPLIT = planSchema.parse({
    summary: 'One phase, one milestone, split after the fact.',
    risks: [{ id: 'R1', assumption: 'It works.', validatedBy: ['M4.1'] }],
    phases: [
      {
        id: 'P4',
        title: 'Implement',
        intent: 'Build it.',
        milestones: [
          {
            id: 'M4.1',
            title: 'Split milestone',
            verification: 'All three parts work.',
            validatesRisk: 'R1',
            tasks: [splitTask('T4.1.4a'), splitTask('T4.1.4b'), splitTask('T4.1.4c')],
          },
        ],
      },
    ],
  });

  /** The same plan before the split: T4.1.4, one task, undivided. */
  const PLAN_BEFORE_SPLIT = planSchema.parse({
    summary: 'One phase, one milestone, not yet split.',
    risks: [{ id: 'R1', assumption: 'It works.', validatedBy: ['M4.1'] }],
    phases: [
      {
        id: 'P4',
        title: 'Implement',
        intent: 'Build it.',
        milestones: [
          {
            id: 'M4.1',
            title: 'Split milestone',
            verification: 'It works.',
            validatesRisk: 'R1',
            tasks: [splitTask('T4.1.4')],
          },
        ],
      },
    ],
  });

  function planStore(root: string): ArtifactStore {
    return new ArtifactStore({ root, schemas: projectArtifactSchemas() });
  }

  function planRequest(data: unknown) {
    return {
      id: 'plan',
      basePath: 'artifacts/plan/plan.md',
      schema: 'plan',
      data,
      producedBy: {
        task: 'plan',
        role: 'planner',
        model: 'claude-sonnet-5',
        runId: 'r1',
      },
      tracesTo: ['PLN-4'],
    };
  }

  /**
   * The plan as a replan leaves it: v1 declaring T4.1.4, v2 declaring
   * T4.1.4a/b/c and no T4.1.4 at all.
   *
   * v1 is written deliberately rather than as scene-setting. `supersede`
   * refuses an id no Plan ever declared — otherwise a blocked phase step or
   * a mistyped dispatch, equally absent from the current Plan, would be
   * retired out of the success denominator on the operator's word (CONV-4)
   * — so the predecessor version *is* the evidence the split happened.
   */
  function writeGatedPlan(root: string): void {
    const store = planStore(root);
    store.write(planRequest(PLAN_BEFORE_SPLIT));
    store.write(planRequest(PLAN_AFTER_SPLIT));
  }

  /** `git init` + one commit of everything, isolated from the operator's own
   * signing config (the same shape `mpgm verify`'s fixture uses). */
  function commitAll(root: string, message: string): void {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    if (!existsSync(join(root, '.git'))) {
      git('init', '--quiet');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
    }
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '-m', message);
  }

  function eventsOf(root: string): readonly unknown[] {
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      return log.read();
    } finally {
      db.close();
    }
  }

  /**
   * The two shapes T4.3.7 names: a blocked task with a terminal event, and
   * a dispatched task with none — both under ids the split left behind.
   *
   * A clock fixed in the run's own past (2026-09-06, PLAN.md's own date for
   * T4.1.4's `BudgetExceeded`), advancing one second per event, so T4.1.4's
   * latency is computable and asserted against an exact value rather than
   * merely "not null" (the same discipline `state/metrics.test.ts`'s own
   * `logWith` uses) — and so `supersede`'s own real-wall-clock `ts`, minted
   * when the test calls it, is unambiguously later than anything here,
   * exactly as recording a PLN-4 split weeks after the fact would be.
   */
  function twoOrphanedShapes(root: string): void {
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      let seconds = 0;
      const log = EventLog.attach(db, {
        registry: kernelRegistry(),
        clock: () => {
          const ts = new Date(
            Date.parse('2026-09-06T15:00:00.000Z') + seconds * 1000,
          ).toISOString();
          seconds += 1;
          return ts;
        },
      });
      log.appendMany([
        { runId: 'r1', type: 'RunStarted', payload: { project: root, operator: 'op' } },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'Tgood', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'r1',
          type: 'TaskCompleted',
          payload: { taskId: 'Tgood', artifactRefs: [] },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T4.1.4', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'r1',
          type: 'SessionUsage',
          payload: {
            taskId: 'T4.1.4',
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 50.84,
            durationMs: 1000,
            apiDurationMs: 800,
          },
        },
        {
          runId: 'r1',
          type: 'BudgetExceeded',
          payload: { taskId: 'T4.1.4', kind: 'steps', limit: 50, observed: 51 },
        },
        {
          runId: 'r1',
          type: 'TaskBlocked',
          payload: { taskId: 'T4.1.4', reason: 'max_turns' },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: {
            taskId: 'T4.1.4-review-2',
            role: 'reviewer',
            model: 'claude-sonnet-5',
          },
        },
      ]);
    } finally {
      db.close();
    }
  }

  it('folds both the blocked and the dispatched orphan to superseded, and the success denominator moves — from the log alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);

    // Before: one real failure counted alongside the one real success —
    // T4.1.4 reads exactly as blocked-forever as PLAN.md describes.
    const beforeRun = fold(eventsOf(root) as never).runs.r1;
    if (beforeRun === undefined) {
      throw new Error('fixture did not fold a run');
    }
    const before = computeRunMetrics(beforeRun, eventsOf(root) as never);
    expect(before.overall.blocked).toBe(1);
    expect(before.overall.dispatched).toBe(1);
    expect(before.overall.successRate).toBe(0.5); // 1 completed / (1 completed + 1 blocked)
    // Tgood: 1000ms (dispatch→complete). T4.1.4: 3000ms (dispatch→blocked).
    expect(before.overall.avgLatencyMs).toBe(2000);

    const writes: string[] = [];
    const blockedResult = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4',
      'macg',
      'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
      ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
    );
    const dispatchedResult = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4-review-2',
      'macg',
      'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
      ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
    );

    expect(blockedResult.ok).toBe(true);
    expect(dispatchedResult.ok).toBe(true);

    // Everything from here reads a fresh open of the log alone, not the
    // command results.
    const events = eventsOf(root);
    const run = fold(events as never).runs.r1;
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }
    expect(run.tasks['T4.1.4']?.status).toBe('superseded');
    expect(run.tasks['T4.1.4-review-2']?.status).toBe('superseded');

    // The dashboard's blocked count falls to zero on a run whose work is
    // done (T4.3.7's own framing).
    expect(summaryOf(run).blockedTasks).toBe(0);

    // The intervention is in the audit log with who decided it and why
    // (HIL-5): a retirement recorded as a bare status change would leave the
    // figure corrected and the authority for correcting it nowhere.
    expect(
      (events as { type: string; payload: unknown }[])
        .filter((event) => event.type === 'TaskSuperseded')
        .map((event) => event.payload),
    ).toEqual([
      {
        taskId: 'T4.1.4',
        by: 'macg',
        reason: 'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
        supersededBy: ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
      },
      {
        taskId: 'T4.1.4-review-2',
        by: 'macg',
        reason: 'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
        supersededBy: ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
      },
    ]);

    const after = computeRunMetrics(run, events as never);
    expect(after.overall.blocked).toBe(0);
    expect(after.overall.dispatched).toBe(0);
    expect(after.overall.superseded).toBe(2);
    // The denominator moved: 1/1, not 1/2 — T4.1.4 is no longer a
    // permanent failure the implementer rate can never recover from.
    expect(after.overall.successRate).toBe(1);
    // The 19 sessions' spend stays in the ledger — the work was really
    // done, and its successors carry it.
    expect(after.overall.costUsd).toBeCloseTo(50.84);
    // Not rewritten (§6): `TaskSuperseded` lands weeks after either task's
    // own last event, with its own later `ts`, and neither reads it as
    // "when the task finished" — the two shapes stay distinguished. T4.1.4
    // reached `TaskBlocked` before this and keeps exactly the 3000ms that
    // measured, unmoved by what later retired its id; overall average
    // latency is therefore unchanged by superseding (still 2000ms).
    // T4.1.4-review-2 never reached a terminal event of its own, and being
    // superseded does not invent one — its latency reads null exactly as it
    // did while merely `dispatched`.
    expect(after.byTask['T4.1.4']?.avgLatencyMs).toBe(3000);
    expect(after.byTask['T4.1.4-review-2']?.avgLatencyMs).toBeNull();
    expect(after.overall.avgLatencyMs).toBe(2000);
  });

  it('refuses a task the harness already completed — there is nothing to supersede', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'Tgood', // completed, and not even absent from the plan
      'macg',
      'not actually superseded',
      ['T4.1.4a'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('not supersedable');

    const events = eventsOf(root) as { type: string }[];
    expect(events.some((event) => event.type === 'TaskSuperseded')).toBe(false);
  });

  // Fails closed on the claim itself (CONV-4), not only on the task's
  // status: an id a mistyped dispatch or a plan regression left behind
  // reads identically to a genuine PLN-4 split from folded state alone,
  // so the Plan artifact — not the operator's say-so — decides whether
  // `taskId` is actually gone.
  it('refuses an id the gated Plan still declares, even though this run left it blocked', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T4.1.4a', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'r1',
          type: 'TaskBlocked',
          payload: { taskId: 'T4.1.4a', reason: 'CI red' },
        },
      ]);
    } finally {
      db.close();
    }

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4a', // genuinely blocked in this run, but the Plan still declares it
      'macg',
      'wrongly claimed superseded',
      ['T4.1.4b'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('still declared');
    expect(writes.join('\n')).toContain('still declares it');

    const events = eventsOf(root) as { type: string }[];
    expect(events.some((event) => event.type === 'TaskSuperseded')).toBe(false);
    expect(fold(events as never).runs.r1?.tasks['T4.1.4a']?.status).toBe('blocked');
  });

  // A review-session id is never itself declared in the Plan (the Plan
  // declares tasks, not review rounds), so the membership check above
  // would pass unconditionally for one unless it is resolved against its
  // *parent* task id instead — this pins that resolution down, alongside
  // T4.1.4-review-2's own case above (still refused: the Plan does not
  // declare T4.1.4-review-2's parent, T4.1.4, at all).
  it('refuses a review session of a task the gated Plan still declares, even though its own id is undeclared', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T4.1.4a', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: {
            taskId: 'T4.1.4a-review-1',
            role: 'reviewer',
            model: 'claude-sonnet-5',
          },
        },
      ]);
    } finally {
      db.close();
    }

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4a-review-1', // genuinely dispatched, and its own id is undeclared
      'macg',
      'wrongly claimed superseded',
      ['T4.1.4b'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('still declared');
    expect(writes.join('\n')).toContain('still declares T4.1.4a');

    const events = eventsOf(root) as { type: string }[];
    expect(events.some((event) => event.type === 'TaskSuperseded')).toBe(false);
    expect(fold(events as never).runs.r1?.tasks['T4.1.4a-review-1']?.status).toBe(
      'dispatched',
    );
  });

  // A conflict-resolution catchup session's own id (`${task}-catchup`,
  // `implement/loop.ts`'s own `resolveTaskId`, T4.3.9) is a second
  // session-only shape alongside a review round's, minted the same way and
  // never itself declared in the Plan either — this pins the same
  // parent-resolution `isSessionOnlyTaskId` now has to cover both shapes
  // for, mirroring T4.1.4-review-2's own case just above.
  it('resolves a catchup session id to its parent task, and refuses it while the Plan still declares the parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T4.1.4a', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: {
            taskId: 'T4.1.4a-catchup',
            role: 'implementer',
            model: 'claude-sonnet-5',
          },
        },
      ]);
    } finally {
      db.close();
    }

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4a-catchup', // genuinely dispatched, and its own id is undeclared
      'macg',
      'wrongly claimed superseded',
      ['T4.1.4b'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('still declared');
    expect(writes.join('\n')).toContain('still declares T4.1.4a');

    const events = eventsOf(root) as { type: string }[];
    expect(events.some((event) => event.type === 'TaskSuperseded')).toBe(false);
    expect(fold(events as never).runs.r1?.tasks['T4.1.4a-catchup']?.status).toBe(
      'dispatched',
    );
  });

  it('supersedes a catchup session id whose parent the split left behind, resolving it via its parent (T4.3.9)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        // T4.1.4 itself, undeclared since the split (`twoOrphanedShapes`
        // already dispatched it, see above), catches up against the trunk
        // mid-task and the catchup session is what is left dispatched.
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T4.1.4-catchup', role: 'implementer', model: 'claude-sonnet-5' },
        },
      ]);
    } finally {
      db.close();
    }

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4-catchup',
      'macg',
      'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
      ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
    );

    expect(result.ok).toBe(true);

    const events = eventsOf(root);
    const run = fold(events as never).runs.r1;
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }
    expect(run.tasks['T4.1.4-catchup']?.status).toBe('superseded');
    expect(
      (events as { type: string; payload: unknown }[])
        .filter((event) => event.type === 'TaskSuperseded')
        .map((event) => event.payload),
    ).toEqual([
      {
        taskId: 'T4.1.4-catchup',
        by: 'macg',
        reason: 'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
        supersededBy: ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
      },
    ]);
  });

  it('refuses a successor id the gated Plan does not declare, and appends nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4',
      'macg',
      'claims a successor the Plan never declared',
      ['T4.1.4a', 'T4.1.4-invented'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unknown successor');
    expect(writes.join('\n')).toContain('T4.1.4-invented');

    const events = eventsOf(root) as { type: string }[];
    expect(events.some((event) => event.type === 'TaskSuperseded')).toBe(false);
    expect(fold(events as never).runs.r1?.tasks['T4.1.4']?.status).toBe('blocked');
  });

  it('refuses a task this run never dispatched, distinct from one the Plan still declares', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4a', // in the Plan, but no session of this run ever touched it
      'macg',
      'wrong id entirely',
      ['T4.1.4b'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unknown task');
  });

  /**
   * The hole the Plan-membership checks cannot close on their own: they can
   * only refuse an id the Plan *declares*, so for an id it never declared
   * they pass unconditionally. A phase step is dispatched under its node id
   * ('draft', 'critique', … — `phase/runner.ts` calls `SessionRunner.runTask`
   * with `taskId: step.id`) and is never a plan task, so a genuinely blocked
   * step would be retired out of `successRate`'s denominator on the
   * operator's word alone — the wrong-but-plausible figure this whole task
   * exists to close, arriving through the control meant to prevent it
   * (CONV-4). The Plan history here is committed as well as versioned, so
   * the refusal is not an artefact of there being no git history to search.
   */
  it('refuses a blocked phase-step id no version or revision of the Plan ever declared', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    writeGatedPlan(root);
    twoOrphanedShapes(root);
    commitAll(root, 'Split T4.1.4 into T4.1.4a/b/c');
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'draft', role: 'drafter', model: 'claude-sonnet-5' },
        },
        {
          runId: 'r1',
          type: 'TaskBlocked',
          payload: { taskId: 'draft', reason: 'max_turns' },
        },
      ]);
    } finally {
      db.close();
    }

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'draft',
      'macg',
      'claims a phase step was superseded',
      ['T4.1.4a'],
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('never declared');
    expect(writes.join('\n')).toContain('has ever declared it');

    // Nothing was appended, and the figure stays honest: the blocked step
    // is still blocked and still in the denominator.
    const events = eventsOf(root);
    expect((events as { type: string }[]).some((e) => e.type === 'TaskSuperseded')).toBe(
      false,
    );
    const run = fold(events as never).runs.r1;
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }
    expect(run.tasks.draft?.status).toBe('blocked');
    expect(computeRunMetrics(run, events as never).overall.blocked).toBe(2);
  });

  /**
   * mpgm's own shape, which the version check alone cannot see: the T4.1.4
   * split was applied *in place* to `artifacts/plan/plan.v1.md` (commit
   * `4fe2c61`), so on disk there is one version and it does not declare
   * T4.1.4. The only surviving record that T4.1.4 was ever a task is the
   * blob under an earlier commit of that same file — which is why the
   * evidence search reads committed revisions too, and why refusing
   * everything absent from the stored versions would have refused the very
   * case this task was filed for.
   */
  it('accepts an id only a committed earlier revision of the Plan file declared', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-supersede-'));
    const store = planStore(root);
    store.write(planRequest(PLAN_BEFORE_SPLIT));
    commitAll(root, 'Plan T4.1.4');
    // The revision that made it stop being a task: same file, same version.
    store.overwrite(planRequest(PLAN_AFTER_SPLIT), 1);
    commitAll(root, 'Split T4.1.4, which three sessions could not close');
    twoOrphanedShapes(root);

    expect(store.latestVersion('artifacts/plan/plan.md')).toBe(1);

    const writes: string[] = [];
    const result = supersede(
      newContext(root, writes),
      'r1',
      'T4.1.4',
      'macg',
      'PLN-4 split into T4.1.4a/T4.1.4b/T4.1.4c',
      ['T4.1.4a', 'T4.1.4b', 'T4.1.4c'],
    );

    expect(result.ok).toBe(true);
    const run = fold(eventsOf(root) as never).runs.r1;
    expect(run?.tasks['T4.1.4']?.status).toBe('superseded');
  });
});

/**
 * `status --metrics` (T4.2.1, OBS-2) — exercises `formatMetric` (`./commands.ts`)
 * through the real `status` command rather than as an unexported helper, the
 * way `scripts/demo/cli-e2e.mjs` only ever asserts on shape (`/role \S+:
 * tasks \d+/`) and never pins the documented "-" rendering down anywhere.
 */
describe('status --metrics', () => {
  it('renders "-" for an unsettled bucket and real numbers once a task completes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-metrics-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      // A fixed clock, explicit offsets: real numbers below (`0ms`) must be
      // exact, not merely non-null, and a wall clock would make this test
      // flaky by however long the write to sqlite happens to take.
      // `ToolCallLogged` and `TaskCompleted` below deliberately share an
      // offset — `closeRound` (T4.2.9) ends a round's busy interval at its
      // own last recorded activity, not the terminal event's own timestamp,
      // so T2's last real activity has to land at the same instant its
      // terminal event does for T2's busy span to read as a clean [4s, 6s).
      const offsetsSeconds = [0, 1, 2, 3, 4, 5, 6, 6];
      let i = 0;
      const log = EventLog.attach(db, {
        registry: kernelRegistry(),
        clock: () => {
          const offset = offsetsSeconds[i];
          if (offset === undefined) throw new Error('offsetsSeconds shorter than inputs');
          const ts = new Date(2026_01_01_00_00_00 + offset * 1000).toISOString();
          i += 1;
          return ts;
        },
      });
      log.appendMany([
        {
          runId: 'r1',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        { runId: 'r1', type: 'PhaseEntered', payload: { phase: 'implement' } },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
        },
        { runId: 'r1', type: 'PhaseEntered', payload: { phase: 'review' } },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T2', role: 'reviewer', model: 'claude' },
        },
        {
          runId: 'r1',
          type: 'SessionUsage',
          payload: {
            taskId: 'T2',
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.25,
            durationMs: 1000,
            apiDurationMs: 800,
          },
        },
        // T2's own last recorded activity before it completes:
        // `computeHarnessOverhead`'s `closeRound` ends a round's busy
        // interval there, not at the terminal event's own timestamp (T4.2.9),
        // so this is what puts T2's span at [4s, 6s) rather than [4s, 5s).
        {
          runId: 'r1',
          type: 'ToolCallLogged',
          payload: {
            taskId: 'T2',
            tool: 'Bash',
            decision: 'allowed',
            detail: '',
            outputBlob: null,
          },
        },
        {
          runId: 'r1',
          type: 'TaskCompleted',
          payload: { taskId: 'T2', artifactRefs: [] },
        },
      ]);
    } finally {
      db.close();
    }

    const result = status(newContext(root, writes), 'r1', { metrics: true });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    // T1 was dispatched but never reached a terminal event: nothing to
    // average and nothing settled, and neither must read as 0ms/0%.
    expect(output).toContain(
      '  phase implement: tasks 1  cost $0.0000  tokens 0  avg-latency -  retries 0  success -',
    );
    // T2 completed, so its bucket reports real numbers rather than "-".
    expect(output).toContain(
      '  phase review: tasks 1  cost $0.2500  tokens 15  avg-latency 2000ms  retries 0  success 100% (1/1)',
    );
    // No `ContextAssembled` event exists in this fixture, so nothing
    // measures the numerator: the ratio reads unmeasured, not 0%, even
    // though T2's `SessionUsage` records a 1000ms session against an 800ms
    // API call. That 200ms gap is agent tool-execution time, not harness
    // code (`../state/overhead.ts` module doc) — reported as its own
    // "non-API session time" figure, but excluded from the ratio and from
    // the 10% comparison. T2 did settle, so `observedMs` (T2's own 2000ms
    // busy span; T1 never settled, so it contributes no interval) and
    // `coverage` (0 of 1 settled tasks instrumented) are both still real
    // numbers, not "-": there is something to report, just not overhead.
    expect(output).toContain(
      "  overhead - of NFR-3's 10% threshold (- context-assembly / - instrumented task span, " +
        'coverage 0/1 tasks (0%); run busy span 2000ms; context-assembly 0ms over 0 calls; ' +
        'non-API session time 200ms over 1 sessions (agent tool execution, not harness — ' +
        'excluded from the ratio); cannot see scheduling, validation)',
    );
  });

  it('reads a run with no recorded session duration as unmeasured, not 0%', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-metrics-unmeasured-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, {
        registry: kernelRegistry(),
        clock: () => '2026-01-01T00:00:00.000Z',
      });
      // A session that never produced a duration to report (the same "null,
      // not zero" case a pre-T4.2.8 log upcasts to), and no `ContextAssembled`
      // event either.
      log.appendMany([
        {
          runId: 'r1',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
        },
        {
          runId: 'r1',
          type: 'SessionUsage',
          payload: {
            taskId: 'T1',
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
            durationMs: null,
            apiDurationMs: null,
          },
        },
        {
          runId: 'r1',
          type: 'TaskCompleted',
          payload: { taskId: 'T1', artifactRefs: [] },
        },
      ]);
    } finally {
      db.close();
    }

    const result = status(newContext(root, writes), 'r1', { metrics: true });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    expect(output).toContain(
      "  overhead - of NFR-3's 10% threshold (- context-assembly / - instrumented task span, " +
        'coverage 0/1 tasks (0%); run busy span 0ms; context-assembly 0ms over 0 calls; ' +
        'non-API session time 0ms over 0 sessions (agent tool execution, not harness — ' +
        'excluded from the ratio); cannot see scheduling, validation)',
    );
  });

  it('renders the measured overhead ratio as a percentage, not only the unmeasured dash', () => {
    // Every log in this repository today reads `ratio: null`, so both tests
    // above exercise `formatOverhead`'s null branch alone, and its measured
    // branch would first run unchecked on the operator's first instrumented
    // run. Mutating `ratio * 100` to `ratio * 0.001` leaves those two green;
    // it fails this one.
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-metrics-measured-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      // `ContextAssembled` at 10s backdates the round's start by its own
      // 1000ms (`../state/overhead.ts`: the assembly ran in
      // `[ts - durationMs, ts)`), so the round opens at 9s. `SessionUsage`
      // and `TaskCompleted` share 29s for the same reason the fixture above
      // shares an offset: `closeRound` ends a round at its last real
      // activity, not at the terminal event. Span [9s, 29s) = 20,000ms
      // against a 1000ms numerator, so the ratio is exactly 5.0%.
      const offsetsSeconds = [0, 10, 11, 29, 29];
      let i = 0;
      const log = EventLog.attach(db, {
        registry: kernelRegistry(),
        clock: () => {
          const offset = offsetsSeconds[i];
          if (offset === undefined) throw new Error('offsetsSeconds shorter than inputs');
          const ts = new Date(2026_01_01_00_00_00 + offset * 1000).toISOString();
          i += 1;
          return ts;
        },
      });
      log.appendMany([
        {
          runId: 'r1',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: 'r1',
          type: 'ContextAssembled',
          payload: { taskId: 'T1', site: 'implement', durationMs: 1000 },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
        },
        {
          runId: 'r1',
          type: 'SessionUsage',
          payload: {
            taskId: 'T1',
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.25,
            durationMs: 1500,
            apiDurationMs: 1200,
          },
        },
        {
          runId: 'r1',
          type: 'TaskCompleted',
          payload: { taskId: 'T1', artifactRefs: [] },
        },
      ]);
    } finally {
      db.close();
    }

    const result = status(newContext(root, writes), 'r1', { metrics: true });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    expect(output).toContain(
      "  overhead 5.0% of NFR-3's 10% threshold (1000ms context-assembly / 20000ms " +
        'instrumented task span, coverage 1/1 tasks (100%); run busy span 20000ms; ' +
        'context-assembly 1000ms over 1 calls; non-API session time 300ms over 1 sessions ' +
        '(agent tool execution, not harness — excluded from the ratio); cannot see ' +
        'scheduling, validation)',
    );
  });
});

/**
 * `status --rates` (T4.2.2a, OBS-4) — the phase-gate, merge-gate and rework
 * rates through the real `status` command, the same way `status --metrics`
 * above is exercised rather than testing `formatGateRates` unexported.
 */
describe('status --rates', () => {
  it('reports phase-gate, merge-gate and rework rates, and says nothing without the flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-rates-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        {
          runId: 'r1',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: 'r1',
          type: 'GatePresented',
          payload: { gateId: 'gate-plan', phase: 'plan', artifactRefs: [] },
        },
        {
          runId: 'r1',
          type: 'GateRejected',
          payload: { gateId: 'gate-plan', by: 'operator', reason: 'not ready' },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
        },
        {
          runId: 'r1',
          type: 'ChecksReported',
          payload: {
            taskId: 'T1',
            ref: 'abc123',
            mergeable: true,
            summary: 'green',
            blocking: [],
          },
        },
        {
          runId: 'r1',
          type: 'ChangeReviewed',
          payload: {
            taskId: 'T1',
            reviewTaskId: 'T1-review',
            reviewerRole: 'code-reviewer',
            ref: 'abc123',
            approved: true,
            summary: 'looks good',
            findings: 0,
            deviations: [],
            declaredDeviations: [],
            undeclaredDeviations: [],
          },
        },
      ]);
    } finally {
      db.close();
    }

    const withoutFlag = status(newContext(root, writes), 'r1', {});
    expect(withoutFlag.ok).toBe(true);
    expect(writes.join('\n')).not.toContain('rates:');

    writes.length = 0;
    const result = status(newContext(root, writes), 'r1', { rates: true });
    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    expect(output).toContain('  rates:');
    // One rejected of one decided: 100%, and no gate left merely presented.
    expect(output).toContain('    phase-gate 100% (1/1 decided rejected)');
    // One clean approval out of one attempt, and one review out of one taken
    // sent nothing back.
    expect(output).toContain(
      '    merge-gate 0% (0/2 reconstructed from ChecksReported+ChangeReviewed; 0 out of repair/review rounds (BudgetExceeded); cannot see',
    );
    expect(output).toContain('    rework 0% (0/1 reviews sent the change back)');
    // No task merged in this fixture, so there is nothing to divide by —
    // `-`, not `0%`.
    expect(output).toContain(
      '    escaped-defects - (0/0 merged tasks; 0 defects filed project-wide; 0 filed but not yet routed to a task; 0 routed but not datable from TaskCompleted)',
    );
  });

  it('renders BudgetExceeded{repairs|reviews} on the merge-gate line', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-rates-budget-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.appendMany([
        {
          runId: 'r1',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        { runId: 'r1', type: 'PhaseEntered', payload: { phase: 'implement' } },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
        },
        {
          runId: 'r1',
          type: 'ChecksReported',
          payload: {
            taskId: 'T1',
            ref: 'abc123',
            mergeable: false,
            summary: 'red',
            blocking: ['test failed'],
          },
        },
        {
          runId: 'r1',
          type: 'BudgetExceeded',
          payload: { taskId: 'T1', kind: 'repairs', limit: 3, observed: 4 },
        },
      ]);
    } finally {
      db.close();
    }

    const result = status(newContext(root, writes), 'r1', { rates: true });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    // Would be silent (dead to the operator) if `budgetExhausted` were
    // computed and never rendered, which is exactly what the review found.
    expect(output).toContain('1 out of repair/review rounds (BudgetExceeded)');
  });

  /**
   * T4.2.2b, end to end: a Defect artifact actually written to git through
   * `ArtifactStore` (not a fixture handed to `computeGateRates` directly),
   * read back the same way `mpgm status --rates` reads it in production —
   * `escaped-defect-rate.test.ts` covers the arithmetic; this covers the
   * wiring: that `status` actually opens the artifact store and finds it.
   */
  it('reads a Defect artifact through the real artifact store and reports it escaped', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-rates-defect-'));
    const writes: string[] = [];

    const defect = routeDefect(
      fileDefect({
        title: 'splitEvenly divides by zero instead of refusing an empty split',
        severity: 'high',
        description: 'An adversarial case caught splitEvenly accepting a zero amount.',
        evidence: {
          kind: 'adversarial',
          caseId: 'zero-split-refused',
          detail: 'returned an array instead of refusing',
        },
        tracesTo: ['LOAN-3'],
      }),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug, not a design assumption',
    );
    const artifact = new ArtifactStore({ root, schemas: projectArtifactSchemas() }).write(
      {
        id: 'defect-1',
        basePath: 'artifacts/defect/defect-1.md',
        schema: 'defect',
        data: defect,
        producedBy: { task: 'retest', role: 'tester', model: 'claude', runId: 'r1' },
      },
    );

    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      // A clock that advances, so "T-old merged before the defect was
      // filed" is a real ordering rather than two events racing for the
      // same wall-clock millisecond.
      let seconds = 0;
      const log = EventLog.attach(db, {
        registry: kernelRegistry(),
        clock: () => {
          const ts = new Date(2026_01_01_00_00_00 + seconds * 1000).toISOString();
          seconds += 1;
          return ts;
        },
      });
      log.appendMany([
        {
          runId: 'r1',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'T-old', role: 'implementer', model: 'claude' },
        },
        // T-old merged before the defect against it was filed: an escape.
        {
          runId: 'r1',
          type: 'ChangeMerged',
          payload: {
            taskId: 'T-old',
            branch: 'task/T-old',
            into: 'main',
            commit: 'deadbeef',
            reviewTaskId: 'T-old-review',
          },
        },
        {
          runId: 'r1',
          type: 'TaskDispatched',
          payload: { taskId: 'test-task', role: 'tester', model: 'claude' },
        },
        {
          runId: 'r1',
          type: 'TaskCompleted',
          payload: {
            taskId: 'test-task',
            artifactRefs: [
              {
                id: artifact.id,
                path: artifact.path,
                commit: null,
                version: artifact.version,
              },
            ],
          },
        },
      ]);
    } finally {
      db.close();
    }

    const result = status(newContext(root, writes), 'r1', { rates: true });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    expect(output).toContain(
      '    escaped-defects 100% (1/1 merged tasks; 1 defects filed project-wide; 0 filed but not yet routed to a task; 0 routed but not datable from TaskCompleted)',
    );
  });
});

/**
 * `status --rates` with no `--run` (T4.2.2a, OBS-4, CONV-6): the report must
 * give each run's rates in the order the log holds them, not in whatever
 * order `Object.values(state.runs)` happens to enumerate. Run ids are
 * free-form strings an operator may reuse for anything, including one that
 * looks like an integer — JS objects put integer-like keys first, in
 * ascending numeric order, ahead of insertion-ordered string keys, so a run
 * started last under an integer-like id is exactly the case that would sort
 * to the front of a naive `Object.values` read and pass unnoticed if this
 * test only ever used names like `r1`/`r2`/`r3`.
 */
describe('status --rates, no --run — longitudinal order (CONV-6)', () => {
  it('prints three runs with three different phase-gate rates in log order', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-status-rates-order-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      // Started in this order: 'zz' first, then 'aa', then the integer-like
      // '2' last. `Object.values(state.runs)` would enumerate '2' first —
      // ahead of the two runs the log shows starting before it — which is
      // the defect the review caught.
      log.appendMany([
        {
          runId: 'zz',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: 'zz',
          type: 'GatePresented',
          payload: { gateId: 'g1', phase: 'plan', artifactRefs: [] },
        },
        {
          runId: 'zz',
          type: 'GateApproved',
          payload: { gateId: 'g1', by: 'operator' },
        },

        {
          runId: 'aa',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: 'aa',
          type: 'GatePresented',
          payload: { gateId: 'g1', phase: 'plan', artifactRefs: [] },
        },
        {
          runId: 'aa',
          type: 'GateApproved',
          payload: { gateId: 'g1', by: 'operator' },
        },
        {
          runId: 'aa',
          type: 'GatePresented',
          payload: { gateId: 'g2', phase: 'plan', artifactRefs: [] },
        },
        {
          runId: 'aa',
          type: 'GateRejected',
          payload: { gateId: 'g2', by: 'operator', reason: 'not ready' },
        },

        {
          runId: '2',
          type: 'RunStarted',
          payload: { project: 'x', operator: 'operator' },
        },
        {
          runId: '2',
          type: 'GatePresented',
          payload: { gateId: 'g1', phase: 'plan', artifactRefs: [] },
        },
        {
          runId: '2',
          type: 'GateRejected',
          payload: { gateId: 'g1', by: 'operator', reason: 'not ready' },
        },
      ]);
    } finally {
      db.close();
    }

    const result = status(newContext(root, writes), undefined, { rates: true });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    const phaseGateLines = output
      .split('\n')
      .filter((line) => line.includes('phase-gate'));

    // Three different figures (0%, 50%, 100%) — an implementation that
    // averaged the runs or emitted a constant would fail this.
    expect(phaseGateLines).toEqual([
      '    phase-gate 0% (0/1 decided rejected)',
      '    phase-gate 50% (1/2 decided rejected)',
      '    phase-gate 100% (1/1 decided rejected)',
    ]);
    // And in log order — 'zz' started first, '2' last — not the order a
    // plain `Object.values` read of `state.runs` would produce ('2' first).
    expect(output.indexOf('run zz')).toBeLessThan(output.indexOf('run aa'));
    expect(output.indexOf('run aa')).toBeLessThan(output.indexOf('run 2'));
  });
});

describe('intervene redirect — unknown task ids (T4.2.4, CONV-3)', () => {
  it('refuses a redirect to a task in neither the run nor a Plan that does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-intervene-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      EventLog.attach(db, { registry: kernelRegistry() }).append({
        runId: 'r1',
        type: 'RunStarted',
        payload: { project: root, operator: 'operator' },
      });
    } finally {
      db.close();
    }

    const result = intervene(
      newContext(root, writes),
      'r1',
      'redirect',
      'go fix it',
      'T99',
    );

    // No Plan artifact was ever written, so falling back to the run's own
    // dispatched tasks is the right call, and does not claim the Plan was
    // consulted.
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unknown task');
    expect(writes.join('\n')).toContain(
      "no task 'T99' in run r1 or the gated Plan at artifacts/plan/plan.md",
    );
  });

  it('says why a Plan that exists but fails to parse could not be consulted, rather than reporting the task simply unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-intervene-'));
    const writes: string[] = [];
    const db = openDatabase(join(root, '.mpgm', 'state.db'));
    try {
      EventLog.attach(db, { registry: kernelRegistry() }).append({
        runId: 'r1',
        type: 'RunStarted',
        payload: { project: root, operator: 'operator' },
      });
    } finally {
      db.close();
    }

    // A Plan artifact exists, but is not readable — malformed frontmatter, the
    // same shape `ArtifactStore.read` refuses for any artifact (CONV-3: the
    // refusal below must say this happened, not silently fall back to "no
    // task" the way it would for a Plan that was never written at all).
    mkdirSync(join(root, 'artifacts', 'plan'), { recursive: true });
    writeFileSync(
      join(root, 'artifacts', 'plan', 'plan.v1.md'),
      'not frontmatter at all\n',
    );

    const result = intervene(
      newContext(root, writes),
      'r1',
      'redirect',
      'go fix it',
      'T99',
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unknown task');
    const output = writes.join('\n');
    // Names the real cause — the Plan could not be read — rather than
    // reusing the "or the gated Plan at ..." wording that implies it was
    // checked and simply did not list the task.
    expect(output).toContain('could not be consulted');
    expect(output).toContain('has no frontmatter');
    expect(output).not.toContain('or the gated Plan at artifacts/plan/plan.md. Known');
  });
});

describe('trace --coverage over mpgm’s own Scope artifact (T4.3.1, SCP-1, TST-2)', () => {
  /**
   * Before T4.3.1, `artifacts/` held nothing under the `scope` schema — the
   * `requirements` list `trace`'s coverage mode assembles (`commands.ts`
   * above) was empty, so this command reported "0/0 verified", a vacuously
   * met Test gate (TST-2's completion criterion this file exists to refuse).
   * This exercises the real fixture at `artifacts/scope/requirements.v1.md`
   * through the same `trace(..., 'coverage')` the CLI runs, in a temp git
   * repository rather than this checkout's own history: the history here is
   * a moving target (a future rework could add or remove a `Verifies:`
   * trailer), and CI's checkout depth is not this test's to depend on. One
   * seeded commit reproduces the one relationship this repository's real
   * history already has to mpgm's own Scope: a `Verifies: NFR-6` trailer
   * (see `0f374aba` in this repository's own log).
   */
  it('names both a verified and unverified requirement, not just a row count', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-trace-coverage-'));
    mkdirSync(join(root, 'artifacts', 'scope'), { recursive: true });
    writeFileSync(
      join(root, 'artifacts', 'scope', 'requirements.v1.md'),
      readFileSync(join(projectRoot, 'artifacts', 'scope', 'requirements.v1.md'), 'utf8'),
    );

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Seed the Scope artifact');
    git(
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Measure NFR-6 against a fresh install\n\nVerifies: NFR-6',
    );

    const writes: string[] = [];
    const result = trace(newContext(root, writes), undefined, 'coverage');
    const output = writes.join('\n');

    expect(result.ok).toBe(true);
    expect(result.detail).toBe('1/84');
    // Named, not merely counted (CONV-6: a report of 84 rows all reading
    // unverified would pass a test that only checked the row count).
    expect(output).toMatch(/verified\s+NFR-6/);
    expect(output).toContain('UNVERIFIED ORC-1');
    expect(output).toContain('UNVERIFIED TST-5');
    expect(output).toContain('UNVERIFIED OBS-4');
    // Every id REQUIREMENTS.md assigns carries across unchanged (ART-2) —
    // spot-checked here rather than diffed whole, since the point is that
    // these specific ids (already cited by commit trailers, ADRs and the
    // Plan artifact elsewhere in this repository) still resolve.
    expect(output).toContain('UNVERIFIED SCP-1');
    expect(output).toContain('UNVERIFIED IMP-3');
    // The figure says what it rests on (T4.3.11). A bare `1/84` invites the
    // reading that eighty-three requirements go unchecked, which is not what
    // it measured: one commit here claims to verify, and the rest of this
    // repository's checking is done by tests no commit names. The real-
    // history assertion is in `src/trace/index.test.ts` — over a fixture
    // this only pins the wording.
    expect(output).toMatch(/Basis: 1 of 2 commits carry `Verifies:`/);
    expect(output).toContain('this counts claims, not checks');
  });
});

describe('trace --dangling names an excluded convention citation (T4.2.16)', () => {
  /**
   * The exclusion block in `trace(..., 'dangling')` (`commands.ts`, printed
   * after the dangling count) is the only operator-facing half of "the
   * report states which do not and why that is deliberate" — the CLI
   * demo (`scripts/demo/cli-e2e.mjs`) only ever runs against a clean
   * fixture with no `CONV-` citation, so deleting the block entirely left
   * every existing test and demo green while `mpgm trace --dangling` would
   * silently drop `CONV-6` again. This seeds a commit trailer citing one,
   * the same shape `7b09783` in this repository's own history has, and
   * asserts the exclusion line by id and by reason rather than merely by
   * count (CONV-6: a count alone would pass with the wrong id reported).
   */
  it('reports a CONV- citation as excluded, not as dangling, with the reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-trace-excluded-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('commit', '--quiet', '--allow-empty', '-m', 'Seed history');
    git(
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Cite a convention the trailer vocabulary was never meant to carry\n\nTraces: CONV-6',
    );

    const writes: string[] = [];
    const result = trace(newContext(root, writes), undefined, 'dangling');
    const output = writes.join('\n');

    expect(result.ok).toBe(true);
    expect(output).toContain('No citation resolves to nothing.');
    expect(output).toContain('1 citation(s) excluded (not counted above):');
    expect(output).toContain('-> CONV-6');
    expect(output).toContain(CONVENTION_CITATION_REASON);
  });
});

/**
 * `mpgm run <phase>` over a playbook whose work is code (T4.3.2).
 *
 * The point of this test is the binding, not the arithmetic: before it,
 * `test.nfr` had a contract, a runner and no provider, and the only
 * production caller of `runPhase` passed no capabilities at all — so every
 * `nfr` node blocked from the one entry point the kernel exposes, however
 * well the step itself worked under a unit test's own registry. Nothing is
 * injected here: the verb binds `commandNfrProvider`, the provider reads the
 * project's own `test/nfr.yaml`, and the measurement is a real child process
 * printing a real number.
 */
describe('run — a phase whose nfr node reaches a bound test.nfr (T4.3.2)', () => {
  const PLAYBOOK = `
phase: test
description: measure the quantified NFRs
artifacts:
  coverage:
    schema: nfr-coverage
    path: artifacts/coverage.md
    description: nfr coverage
tasks:
  - id: scope-nfrs
    role: nfr-scoper
    description: state the quantified NFRs
    prompt: list the quantified requirements
  - kind: nfr
    id: measure
    description: measure them against test.nfr
    requirements: scope-nfrs
    produces: coverage
gate:
  id: test-gate
  description: coverage exists
  criteria:
    - id: c1
      kind: artifact-exists
      description: coverage exists
      artifact: coverage
`;

  const ROLE = [
    '---',
    'name: nfr-scoper',
    'description: states the quantified NFRs of the Test phase',
    'model: claude-sonnet-5',
    'tools: { allow: [Read] }',
    'budgets: { tokens: 100000, costUsd: 5, steps: 10, wallClockSeconds: 600 }',
    'output: { schema: scope }',
    '---',
    'You are the nfr-scoper.',
  ].join('\n');

  const SCOPE = {
    summary: 'a service that answers, and answers quickly',
    requirements: [
      {
        kind: 'functional',
        id: 'FUN-1',
        statement: 'the service answers GET /health',
        rationale: 'the deploy gate reads it',
        priority: 'must',
        acceptanceCriteria: ['200 with a body'],
        tracesTo: ['GOAL-1'],
      },
      {
        kind: 'non-functional',
        id: 'PERF-1',
        statement: 'p95 latency stays under 300ms',
        rationale: 'the operator notices anything slower',
        priority: 'must',
        acceptanceCriteria: ['a load test reports p95 under 300ms'],
        tracesTo: ['GOAL-2'],
        threshold: { metric: 'p95-latency', value: 300, unit: 'ms', measuredBy: 'k6' },
      },
    ],
    outOfScope: [{ item: 'authentication', why: 'a later milestone' }],
  };

  /**
   * A project the verb can actually measure: a git checkout, because the
   * bound provider refuses to measure a directory whose commit it cannot read
   * or which is not at the `--ref` the operator named. The ref this returns is
   * that commit, so the run below reports the checkout it measured.
   */
  function project(measurement: string): { root: string; ref: string } {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-run-nfr-'));
    mkdirSync(join(root, 'phases'), { recursive: true });
    mkdirSync(join(root, 'roles'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'phases', 'test.yaml'), PLAYBOOK, 'utf8');
    writeFileSync(join(root, 'roles', 'nfr-scoper.md'), ROLE, 'utf8');
    writeFileSync(
      join(root, 'test', 'nfr.yaml'),
      `measurements:\n` +
        `  - requirement: PERF-1\n` +
        `    metric: p95-latency\n` +
        `    unit: ms\n` +
        `    direction: at-most\n` +
        `    command: node\n` +
        `    args: ['-e', 'console.log(${measurement})']\n`,
      'utf8',
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Declare what measures PERF-1');
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    return { root, ref };
  }

  function contextFor(root: string, writes: string[]): CliContext {
    return {
      ...newContext(root, writes),
      provider: { run: () => Promise.resolve(scriptedSuccess(SCOPE)) },
    };
  }

  it('measures the project’s own declared command and writes the coverage it produced', async () => {
    const writes: string[] = [];
    const { root, ref } = project('250');

    const result = await run(contextFor(root, writes), 'run-1', 'test', {
      repo: 'siajasl/library-loans',
      ref,
      defectSeverity: 'high',
    });

    expect(result.ok).toBe(true);
    const coverage = readFileSync(join(root, 'artifacts', 'coverage.v1.md'), 'utf8');
    // 250 against a 300ms ceiling: verified, and verified *by* what Scope
    // said measures it. A stub provider could not have produced the number.
    expect(coverage).toMatch(/PERF-1/);
    expect(coverage).toMatch(/"?measured"?:\s*250/);
    expect(coverage).toMatch(/"?verified"?:\s*true/);
    // And the row says which checkout produced the number, so the artifact is
    // not a measurement of one commit filed against another.
    expect(coverage).toContain(`measured siajasl/library-loans@${ref}`);
    expect(writes.join('\n')).toMatch(/met\s+c1: coverage v1/);
  });

  it('carries a real failure through: the same wiring, a measurement over threshold', async () => {
    const writes: string[] = [];
    const { root, ref } = project('900');

    const result = await run(contextFor(root, writes), 'run-1', 'test', {
      repo: 'siajasl/library-loans',
      ref,
      defectSeverity: 'high',
    });

    expect(result.ok).toBe(true);
    const coverage = readFileSync(join(root, 'artifacts', 'coverage.v1.md'), 'utf8');
    expect(coverage).toMatch(/"?verified"?:\s*false/);
    expect(coverage).toMatch(/below-threshold/);
  });

  it('blocks rather than reporting this checkout as a measurement of some other ref', async () => {
    const writes: string[] = [];
    const { root } = project('250');

    // A ref the checkout is not at — the operator's most ordinary mistake,
    // running the phase from a working tree that has moved on. Before the
    // provider read `input.ref` this wrote a coverage artifact whose rows
    // were measurements of the working tree, offered as measurements of a
    // commit nothing measured (CONV-4).
    const result = await run(contextFor(root, writes), 'run-1', 'test', {
      repo: 'siajasl/library-loans',
      ref: '0000000000000000000000000000000000000000',
      defectSeverity: 'high',
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/refusing to measure/);
    expect(existsSync(join(root, 'artifacts', 'coverage.v1.md'))).toBe(false);
  });

  it('blocks rather than measuring a repo nobody named', async () => {
    const writes: string[] = [];
    const { root } = project('250');

    // No --repo/--ref: `test.nfr#run` reports against a specific repo and
    // ref, and the verb refuses to guess one from the checkout it happens to
    // be running in.
    const result = await run(contextFor(root, writes), 'run-1', 'test');

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/--repo <owner\/name> --ref <ref>/);
  });
});

/**
 * `mpgm defect route|fix` — the operator's half of TST-5's round trip
 * (T4.3.4, ORC-1).
 *
 * The kernel files a defect and re-tests it; where it goes and which commit
 * fixed it are the two calls a run cannot make for itself, and this verb is
 * the component that makes them. Driven here over a defect written to a real
 * store the way an `nfr`/`suite` step writes one.
 */
describe('mpgm defect (T4.3.4)', () => {
  const filedAt = (root: string): string => {
    const defect = fileDefect({
      title: "Adversarial case 'zero-split-refused' failed: splitting between nobody",
      severity: 'high',
      description: 'splitEvenly divides by zero instead of refusing an empty split.',
      evidence: {
        kind: 'adversarial',
        caseId: 'zero-split-refused',
        detail: 'returned an array instead of refusing',
      },
      tracesTo: ['LOAN-3'],
    });
    new ArtifactStore({ root, schemas: projectArtifactSchemas() }).write({
      id: 'defect-adversarial-zero-split-refused',
      basePath: 'artifacts/defect/defect-adversarial-zero-split-refused.md',
      schema: 'defect',
      data: defect,
      producedBy: { task: 'attack', role: 'kernel', model: '(none)', runId: 'r1' },
    });
    return 'defect-adversarial-zero-split-refused';
  };

  const newRoot = (): string => mkdtempSync(join(tmpdir(), 'mpgm-defect-verb-'));

  it('routes a filed defect, showing the evidence the decision is made on', () => {
    const root = newRoot();
    const writes: string[] = [];
    const id = filedAt(root);

    const result = defect(newContext(root, writes), 'route', id, {
      by: 'operator',
      to: 'implement',
      taskId: 'T9.9.9',
      reason: 'an implementation bug, not a design assumption',
    });

    expect(result.ok).toBe(true);
    const output = writes.join('\n');
    // ORC-1's call is made on the filed artifact's own evidence, and an
    // operator asked to make it must be shown it rather than sent to a log:
    // every field `fileDefect` recorded is printed before anything is
    // written (CONV-6: this fails against a verb that writes silently).
    expect(output).toContain('zero-split-refused');
    expect(output).toContain('LOAN-3');
    expect(output).toContain('returned an array instead of refusing');
    expect(output).toContain('high');

    const stored = new ArtifactStore({ root, schemas: projectArtifactSchemas() }).read(
      'artifacts/defect/defect-adversarial-zero-split-refused.md',
    );
    const routed = defectSchema.parse(stored.data);
    expect(stored.version).toBe(2);
    expect(routed.status).toBe('routed');
    expect(routed.status !== 'open' && routed.route).toStrictEqual({
      to: 'implement',
      taskId: 'T9.9.9',
    });
    // Who decided is on the record, in the defect's own append-only history.
    expect(routed.history.at(-1)?.detail).toContain('operator');
  });

  it('records the fix a routed defect produced', () => {
    const root = newRoot();
    const writes: string[] = [];
    const id = filedAt(root);
    const context = newContext(root, writes);
    defect(context, 'route', id, {
      by: 'operator',
      to: 'design',
      phase: 'design',
      changed: ['C-4'],
      reason: 'the design assumed non-empty splits',
    });

    const result = defect(context, 'fix', id, {
      by: 'operator',
      ref: 'abc1234',
      summary: 'splitEvenly refuses an empty split',
    });

    expect(result.ok).toBe(true);
    const stored = new ArtifactStore({ root, schemas: projectArtifactSchemas() }).read(
      'artifacts/defect/defect-adversarial-zero-split-refused.md',
    );
    const pending = defectSchema.parse(stored.data);
    expect(stored.version).toBe(3);
    expect(pending.status).toBe('fix-pending');
    expect(pending.status === 'fix-pending' && pending.fix.ref).toBe('abc1234');
  });

  it('refuses an edge the lifecycle does not have, and writes nothing', () => {
    const root = newRoot();
    const writes: string[] = [];
    const id = filedAt(root);
    const context = newContext(root, writes);

    // No route yet: recording a fix here is the out-of-band patch TST-5
    // refuses, and the refusal comes from `recordFix` rather than from a
    // second copy of its rules in the CLI.
    const result = defect(context, 'fix', id, {
      by: 'operator',
      ref: 'abc1234',
      summary: 'a patch nobody routed',
    });

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain("status is 'open'");
    expect(
      new ArtifactStore({ root, schemas: projectArtifactSchemas() }).latestVersion(
        'artifacts/defect/defect-adversarial-zero-split-refused.md',
      ),
    ).toBe(1);
  });

  it('says where it looked when there is no such defect', () => {
    const root = newRoot();
    const writes: string[] = [];

    const result = defect(newContext(root, writes), 'route', 'defect-nope', {
      by: 'operator',
      to: 'implement',
      taskId: 'T1',
      reason: 'why',
    });

    expect(result.ok).toBe(false);
    // CONV-3: the path it looked at, not just "not found".
    expect(writes.join('\n')).toContain('artifacts/defect/defect-nope.md');
  });

  // review round 3: `main.ts` now refuses a missing `--reason`/`--summary`
  // before `defect` (this function) is ever called, but a caller that skips
  // that layer — a direct call, the way these tests all make one — must not
  // be able to reach `routeDefect`/`recordFix` with a reason or summary that
  // says nothing (CONV-4, HIL-5). These drive `defect` itself, not the CLI's
  // own `require()`.
  it('refuses to route with no reason, writing no new version', () => {
    const root = newRoot();
    const writes: string[] = [];
    const id = filedAt(root);

    const result = defect(newContext(root, writes), 'route', id, {
      by: 'operator',
      to: 'implement',
      taskId: 'T9.9.9',
      // reason omitted
    });

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain('--reason is required');
    expect(
      new ArtifactStore({ root, schemas: projectArtifactSchemas() }).latestVersion(
        'artifacts/defect/defect-adversarial-zero-split-refused.md',
      ),
    ).toBe(1);
  });

  it('refuses to fix with no summary, writing no new version', () => {
    const root = newRoot();
    const writes: string[] = [];
    const id = filedAt(root);
    const context = newContext(root, writes);
    defect(context, 'route', id, {
      by: 'operator',
      to: 'implement',
      taskId: 'T9.9.9',
      reason: 'an implementation bug, not a design assumption',
    });

    const result = defect(context, 'fix', id, {
      by: 'operator',
      ref: 'abc1234',
      // summary omitted
    });

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain('--summary is required');
    expect(
      new ArtifactStore({ root, schemas: projectArtifactSchemas() }).latestVersion(
        'artifacts/defect/defect-adversarial-zero-split-refused.md',
      ),
    ).toBe(2);
  });
});
