import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionProvider } from '../agent/session.js';
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
import { projectArtifactSchemas, projectOutputSchemas } from '../schemas.js';
import { fileDefect, routeDefect } from '../test/defect.js';
import { intervene, rollback, status, type CliContext } from './commands.js';

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
