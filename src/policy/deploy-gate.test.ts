import { describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import { MEMORY } from '../database.js';
import { KERNEL_TASK, kernelRegistry } from '../event/catalog.js';
import type { EventInput } from '../event/envelope.js';
import type { ReleaseArtifact } from '../release/deliver.js';
import { EventLog } from '../event/store.js';
import { fold } from '../state/reduce.js';
import {
  crossRunLedger,
  DeployGateError,
  deployFingerprint,
  gateProductionRelease,
  type DeployGateOptions,
  type DeployLedger,
} from './deploy-gate.js';

/**
 * `gateProductionRelease` returns the same `Provider` type it was given — a
 * bare `Record`, so a caller cannot call `.deliver`/`.rollback` on it
 * without narrowing first. Every real caller reaches these operations
 * through a `BoundContract`, which does that narrowing for them
 * (`contract/capability.ts`); this test calls the gate directly, so it
 * narrows once here instead of repeating a non-null assertion at every
 * call.
 */
interface GatedReleaseProvider {
  readonly deliver: (input: never) => Promise<unknown>;
  readonly rollback: (input: never) => Promise<unknown>;
}

function gate(provider: Provider, options: DeployGateOptions): GatedReleaseProvider {
  return gateProductionRelease(provider, options) as unknown as GatedReleaseProvider;
}

/**
 * `gatedEnvs` naming only `production` — every test below that does not
 * exercise `gatedEnvs` itself uses this, the same set a caller reading a
 * project's own manifest (`env/compose-provider.ts`'s `gatedEnvironments`)
 * would build for a project that marks that environment `approval:
 * required` (this repository's own manifest marks `staging`, never a name
 * this module assumes on its own).
 */
const PRODUCTION_GATED: ReadonlySet<string> = new Set(['production']);

/** A ledger over in-memory sets, mirroring `stateLedger`'s shape. */
function ledger(seen = new Set<string>(), confirmed = new Set<string>()): DeployLedger {
  return {
    dryRunSeen: (print) => seen.has(print),
    confirmed: (print) => confirmed.has(print),
  };
}

function release(version: string, digest = `sha256:${version}`): ReleaseArtifact {
  return { version, image: 'sample:latest', digest, changelog: 'x', rollbackTo: null };
}

/**
 * A fake `release.deliver` provider that records every call it actually
 * received, so a test can tell "the gate let this through" from "the gate
 * denied it" without a real Docker daemon.
 */
function fakeProvider(): { provider: Provider; calls: string[] } {
  const calls: string[] = [];
  const provider: Provider = {
    assemble: () => Promise.resolve({}),
    deliver: (input: never) => {
      calls.push(`deliver:${JSON.stringify(input)}`);
      return Promise.resolve({
        env: (input as { env: string }).env,
        up: true,
        services: [],
      });
    },
    rollback: (input: never) => {
      calls.push(`rollback:${JSON.stringify(input)}`);
      return Promise.resolve({
        env: (input as { env: string }).env,
        up: true,
        services: [],
      });
    },
  };
  return { provider, calls };
}

describe('gateProductionRelease — deliver', () => {
  it('refuses a gated environment without a recorded dry run', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { gatedEnvs: PRODUCTION_GATED, ledger: ledger() });

    await expect(
      gated.deliver({ repo: 'r', env: 'production', release: release('1.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  /**
   * CONV-3: an operator reading this refusal has to know whether the next
   * command really is `mpgm confirm`, or whether nothing was recorded at
   * all — telling them to run a command that will itself fail is worse than
   * telling them nothing was recorded.
   */
  it('tells the caller whether this refusal actually recorded the dry run', async () => {
    const { provider: unwired } = fakeProvider();
    await expect(
      gate(unwired, { gatedEnvs: PRODUCTION_GATED, ledger: ledger() }).deliver({
        repo: 'r',
        env: 'production',
        release: release('1.0.0'),
      } as never),
    ).rejects.toThrow(/Nothing recorded it/);

    const { provider: wired } = fakeProvider();
    await expect(
      gate(wired, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
        onDryRunNeeded: () => undefined,
      }).deliver({
        repo: 'r',
        env: 'production',
        release: release('1.0.0'),
      } as never),
    ).rejects.toThrow(/This refusal has recorded it as a dry run/);
  });

  it('refuses a gated environment once simulated but still unconfirmed', async () => {
    const { provider, calls } = fakeProvider();
    const target = { repo: 'r', env: 'production', digest: release('1.0.0').digest };
    const print = deployFingerprint(target);
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print])),
    });

    await expect(
      gated.deliver({ repo: 'r', env: 'production', release: release('1.0.0') } as never),
    ).rejects.toThrow(/simulated but not confirmed/);
    expect(calls).toEqual([]);
  });

  it('delivers to a gated environment once the exact call is dry-run and confirmed', async () => {
    const { provider, calls } = fakeProvider();
    const target = { repo: 'r', env: 'production', digest: release('1.0.0').digest };
    const print = deployFingerprint(target);
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await expect(
      gated.deliver({ repo: 'r', env: 'production', release: release('1.0.0') } as never),
    ).resolves.toEqual({
      env: 'production',
      up: true,
      services: [],
    });
    expect(calls).toHaveLength(1);
  });

  it('a confirmation for one release does not confirm a different one', async () => {
    const { provider, calls } = fakeProvider();
    const confirmed = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: release('1.0.0').digest,
    });
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([confirmed]), new Set([confirmed])),
    });

    await expect(
      gated.deliver({ repo: 'r', env: 'production', release: release('2.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('leaves a non-gated environment ungated', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { gatedEnvs: PRODUCTION_GATED, ledger: ledger() });

    await gated.deliver({
      repo: 'r',
      env: 'staging',
      release: release('1.0.0'),
    } as never);
    expect(calls).toHaveLength(1);
  });

  it('gates whichever environments the caller names, not a hardcoded one', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, {
      gatedEnvs: new Set(['prod-eu']),
      ledger: ledger(),
    });

    // 'production' is not in this caller's `gatedEnvs` — a target project
    // whose manifest never mentions that name gets no gate on it, and this
    // caller's `gatedEnvs` says exactly that, rather than a default this
    // module would otherwise fall back to (CONV-4).
    await gated.deliver({
      repo: 'r',
      env: 'production',
      release: release('1.0.0'),
    } as never);
    expect(calls).toHaveLength(1);

    await expect(
      gated.deliver({ repo: 'r', env: 'prod-eu', release: release('1.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
  });

  it('calls onDryRunNeeded and onConfirmationNeeded exactly when each is refused', async () => {
    const { provider } = fakeProvider();
    const dryRunNeeded: string[] = [];
    const confirmationNeeded: string[] = [];
    const target = { repo: 'r', env: 'production', digest: release('1.0.0').digest };
    const print = deployFingerprint(target);

    const gated1 = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
      onDryRunNeeded: (record) => dryRunNeeded.push(record.fingerprint),
      onConfirmationNeeded: (record) => confirmationNeeded.push(record.fingerprint),
    });
    await expect(
      gated1.deliver({
        repo: 'r',
        env: 'production',
        release: release('1.0.0'),
      } as never),
    ).rejects.toThrow(DeployGateError);
    expect(dryRunNeeded).toEqual([print]);
    expect(confirmationNeeded).toEqual([]);

    const gated2 = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print])),
      onDryRunNeeded: (record) => dryRunNeeded.push(record.fingerprint),
      onConfirmationNeeded: (record) => confirmationNeeded.push(record.fingerprint),
    });
    await expect(
      gated2.deliver({
        repo: 'r',
        env: 'production',
        release: release('1.0.0'),
      } as never),
    ).rejects.toThrow(DeployGateError);
    expect(confirmationNeeded).toEqual([print]);
  });

  it('refuses to wrap a provider that does not implement deliver and rollback', () => {
    expect(() =>
      gateProductionRelease(
        { assemble: () => Promise.resolve({}) },
        { gatedEnvs: PRODUCTION_GATED, ledger: ledger() },
      ),
    ).toThrow(DeployGateError);
  });
});

describe('gateProductionRelease — rollback', () => {
  it('refuses restoring a release the environment never had confirmed', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { gatedEnvs: PRODUCTION_GATED, ledger: ledger() });

    await expect(
      gated.rollback({ repo: 'r', env: 'production', to: release('1.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('restores a release the environment already had confirmed, with no new confirmation', async () => {
    const { provider, calls } = fakeProvider();
    // The confirmation on record is for *delivering* 1.0.0 to production —
    // the same fingerprint a rollback to 1.0.0 computes.
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: release('1.0.0').digest,
    });
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await gated.rollback({ repo: 'r', env: 'production', to: release('1.0.0') } as never);
    expect(calls).toHaveLength(1);
  });

  it('does not let rollback smuggle in a release deliver would still refuse', async () => {
    const { provider, calls } = fakeProvider();
    // Confirmed for 1.0.0, but the rollback names a release that was never
    // confirmed — rollback must not be a second, ungated door into a gated
    // environment.
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: release('1.0.0').digest,
    });
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await expect(
      gated.rollback({ repo: 'r', env: 'production', to: release('9.9.9') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('leaves a non-gated rollback ungated', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { gatedEnvs: PRODUCTION_GATED, ledger: ledger() });

    await gated.rollback({ repo: 'r', env: 'staging', to: release('1.0.0') } as never);
    expect(calls).toHaveLength(1);
  });
});

/**
 * DESIGN §9 decision 11 claims that restoring a release an environment
 * already ran "asks nothing new of HIL-2" — true only if that earlier
 * approval is still findable, no matter which kernel run asks. A
 * `RunState`-scoped ledger would make this false across runs, which is the
 * normal shape of a deploy history — DEP-2's automatic rollback fires in
 * whatever run notices the regression, not the run that confirmed the
 * release.
 */
describe('crossRunLedger', () => {
  function stateWith(inputs: readonly EventInput[]) {
    const log = EventLog.open(MEMORY, {
      registry: kernelRegistry(),
      clock: () => '2026-01-01T00:00:00.000Z',
    });
    try {
      log.appendMany(inputs);
      return fold(log.read());
    } finally {
      log.close();
    }
  }

  const target = { repo: 'r', env: 'production', digest: release('1.0.0').digest };
  const print = deployFingerprint(target);

  it('finds a dry run and confirmation recorded in a different run', () => {
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-a',
        type: 'DryRunRecorded',
        payload: { taskId: KERNEL_TASK, tool: 'deploy', fingerprint: print },
      },
      {
        runId: 'run-a',
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: KERNEL_TASK,
          tool: 'deploy',
          fingerprint: print,
          by: 'macg',
        },
      },
      { runId: 'run-b', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
    ]);
    const gateLedger = crossRunLedger(() => state);

    // Asked of the run that recorded nothing at all — still true, because
    // the ledger reads the whole log, not one run's slice of it.
    expect(state.runs['run-b']?.destructiveCalls[print]).toBeUndefined();
    expect(gateLedger.dryRunSeen(print)).toBe(true);
    expect(gateLedger.confirmed(print)).toBe(true);
  });

  it('does not confirm a fingerprint nothing has ever recorded', () => {
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
    ]);
    const gateLedger = crossRunLedger(() => state);

    expect(gateLedger.dryRunSeen(print)).toBe(false);
    expect(gateLedger.confirmed(print)).toBe(false);
  });

  it('lets rollback in a later run proceed on an earlier run’s confirmation', async () => {
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-a',
        type: 'DryRunRecorded',
        payload: { taskId: KERNEL_TASK, tool: 'deploy', fingerprint: print },
      },
      {
        runId: 'run-a',
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: KERNEL_TASK,
          tool: 'deploy',
          fingerprint: print,
          by: 'macg',
        },
      },
      { runId: 'run-b', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
    ]);
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: crossRunLedger(() => state),
    });

    // `run-b` is the run acting here — DEP-2's automatic rollback, or an
    // operator's confirmation, invoked from a run that never itself saw the
    // original `deliver`'s dry run or confirmation.
    await gated.rollback({ repo: 'r', env: 'production', to: release('1.0.0') } as never);
    expect(calls).toHaveLength(1);
  });
});

describe('deployFingerprint', () => {
  it('is stable for the same target and changes with any field', () => {
    const target = { repo: 'r', env: 'production', digest: 'sha256:aaa' };
    expect(deployFingerprint(target)).toBe(deployFingerprint({ ...target }));
    expect(deployFingerprint(target)).not.toBe(
      deployFingerprint({ ...target, env: 'staging' }),
    );
    expect(deployFingerprint(target)).not.toBe(
      deployFingerprint({ ...target, digest: 'sha256:bbb' }),
    );
    expect(deployFingerprint(target)).not.toBe(
      deployFingerprint({ ...target, repo: 'other' }),
    );
  });

  it('ignores label — a description, never part of what a confirmation covers', () => {
    const target = { repo: 'r', env: 'production', digest: 'sha256:aaa' };
    expect(deployFingerprint(target)).toBe(
      deployFingerprint({ ...target, label: '1.0.0' }),
    );
  });
});
