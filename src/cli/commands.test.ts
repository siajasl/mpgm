import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionProvider } from '../agent/session.js';
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
import { rollback, type CliContext } from './commands.js';

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

/** A fake `env.provision` reporting whatever `up`/`services` a test wants. */
function fakeEnvProvision(
  up: boolean,
  services: readonly {
    name: string;
    state: string;
    health?: string;
    containerId?: string;
  }[] = [],
) {
  const registry = new CapabilityRegistry();
  return registry.bind(envProvisionContract, {
    up: () => Promise.resolve({ env: 'x', up, services }),
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
 */
function fakeEnvProvisionRejecting(error: Error) {
  const registry = new CapabilityRegistry();
  return registry.bind(envProvisionContract, {
    up: () => Promise.reject(error),
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

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      to,
      'macg',
      'restoring the last known-good build',
      {
        envProvision: fakeEnvProvision(true, [
          { name: 'svc', state: 'running', health: 'healthy', containerId: 'c1' },
        ]),
      },
    );

    expect(result.ok).toBe(true);
    expect(writes.join('\n')).toContain('rolled back to 1.0.0');

    // The durable "reached the environment" record exists before the
    // provider is called (T4.1.5, DESIGN §6), not only once the outcome is
    // known.
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
    expect(writes.join('\n')).toContain('NOT up — check the environment');

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

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      repo,
      to,
      'macg',
      'restoring the last known-good build',
      { envProvision: fakeEnvProvisionRejecting(failure) },
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
    // proves it, not just the classification of what was thrown.
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
