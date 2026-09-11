import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionProvider } from '../agent/session.js';
import { CapabilityRegistry } from '../contract/capability.js';
import { openDatabase } from '../database.js';
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

  it('refuses a gated environment whose digest was never confirmed, and records nothing', async () => {
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
    expect(releaseRolledBackEvents(root)).toEqual([]);
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

  it('refuses a release artifact that is not a valid one, before touching the gate or the log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-rollback-'));
    const writes: string[] = [];

    const result = await rollback(
      newContext(root, writes),
      'r1',
      'test',
      declaredRepo('test', 'none'),
      { ...artifact(), changelog: '' },
      'macg',
      '',
      { envProvision: fakeEnvProvision(true) },
    );

    expect(result.ok).toBe(false);
    expect(writes.join('\n')).toContain('not a valid release artifact');
  });
});
