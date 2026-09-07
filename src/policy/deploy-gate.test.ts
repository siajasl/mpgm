import { describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import type { EventInput } from '../event/envelope.js';
import type { ReleaseArtifact } from '../release/deliver.js';
import { EventLog } from '../event/store.js';
import { fold } from '../state/reduce.js';
import {
  crossRunLedger,
  DeployGateError,
  deployFingerprint,
  gateProductionRelease,
  gateProvisionRelease,
  RECREATE_ON_DEFAULT_DIGEST,
  TEARDOWN_ENV_DIGEST,
  type DeployGateOptions,
  type DeployLedger,
} from './deploy-gate.js';

/**
 * `gateProductionRelease`/`gateProvisionRelease` return the same `Provider`
 * type they were given — a bare `Record`, so a caller cannot call
 * `.deliver`/`.rollback`/`.up` on it without narrowing first. Every real
 * caller reaches these operations through a `BoundContract`, which does that
 * narrowing for them (`contract/capability.ts`); this test calls the gates
 * directly, so it narrows once here instead of repeating a non-null
 * assertion at every call.
 */
interface GatedReleaseProvider {
  readonly deliver: (input: never) => Promise<unknown>;
  readonly rollback: (input: never) => Promise<unknown>;
}

interface GatedProvisionProvider {
  readonly up: (input: never) => Promise<unknown>;
  readonly down: (input: never) => Promise<unknown>;
}

function gate(provider: Provider, options: DeployGateOptions): GatedReleaseProvider {
  return gateProductionRelease(provider, options) as unknown as GatedReleaseProvider;
}

function provisionGate(
  provider: Provider,
  options: DeployGateOptions,
): GatedProvisionProvider {
  return gateProvisionRelease(provider, options) as unknown as GatedProvisionProvider;
}

/** `gatedEnvs` naming only `production` — every test below that does not
 * exercise `gatedEnvs` itself uses this, the same set a caller reading a
 * project's own manifest (`env/compose-provider.ts`'s `gatedEnvironments`)
 * would build for a project that marks only `production` `approval:
 * required` (T4.1.4 rework: this is never a name the gate assumes on its
 * own). */
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

/** A fake `release.deliver` provider that records every call it actually
 * received, so a test can tell "the gate let this through" from "the gate
 * denied it" without a real Docker daemon. */
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

/**
 * A fake `env.provision` provider, the same shape for `gateProvisionRelease`.
 *
 * `alreadyUp` controls what `status` reports before `up` is even called —
 * this is what {@link gateProvisionRelease} asks before letting a no-image
 * `up` through, so a test exercising that check needs a provider that can
 * say "already running" without a real Docker daemon behind it. Defaults to
 * not-up, the case every earlier test here (recorded before that check
 * existed) already assumes.
 */
function fakeProvisionProvider(options: { alreadyUp?: boolean } = {}): {
  provider: Provider;
  calls: string[];
} {
  const calls: string[] = [];
  const status =
    options.alreadyUp === true
      ? {
          env: 'x',
          up: true,
          services: [
            {
              name: 'web',
              state: 'running' as const,
              health: 'none' as const,
              containerId: 'c1',
            },
          ],
        }
      : { env: 'x', up: false, services: [] };
  const provider: Provider = {
    up: (input: never) => {
      calls.push(`up:${JSON.stringify(input)}`);
      return Promise.resolve({
        env: (input as { env: string }).env,
        up: true,
        services: [],
      });
    },
    down: (input: never) => {
      calls.push(`down:${JSON.stringify(input)}`);
      return Promise.resolve({ env: 'x', up: false, services: [] });
    },
    status: () => Promise.resolve(status),
  };
  return { provider, calls };
}

describe('gateProductionRelease — deliver', () => {
  it('refuses production without a recorded dry run', async () => {
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
   * telling them nothing was recorded (T4.1.4 rework).
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

  it('refuses production once simulated but still unconfirmed', async () => {
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

  it('delivers to production once the exact call is dry-run and confirmed', async () => {
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
    // module would otherwise fall back to (T4.1.4 rework, CONV-4).
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
});

describe('gateProductionRelease — rollback', () => {
  it('refuses restoring a release production never had confirmed', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { gatedEnvs: PRODUCTION_GATED, ledger: ledger() });

    await expect(
      gated.rollback({ repo: 'r', env: 'production', to: release('1.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('restores a release production already had confirmed, with no new confirmation', async () => {
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
    // confirmed — rollback must not be a second, ungated door into production.
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
 * DESIGN §9 decision 11 claims that restoring a release production already
 * ran "asks nothing new of HIL-2" — true only if that earlier approval is
 * still findable, no matter which kernel run asks (T4.1.4 rework: a
 * `RunState`-scoped ledger made this false across runs, which is the normal
 * shape of a deploy history — DEP-2's automatic rollback fires in whatever
 * run notices the regression, not the run that confirmed the release).
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

  it('finds a dry run and confirmation, both recorded under one run, when asked from a different run entirely', () => {
    // "Cross-run" is about who is *asking*, not about splitting the pair
    // itself across runs — see the next test for that distinction, which a
    // review found this test's own former title blurred.
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-a',
        type: 'DryRunRecorded',
        payload: { taskId: '', tool: 'deploy', fingerprint: print },
      },
      {
        runId: 'run-a',
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: '',
          tool: 'deploy',
          fingerprint: print,
          by: 'macg',
        },
      },
      { runId: 'run-b', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
    ]);
    const ledger = crossRunLedger(() => state);

    // Asked of the run that recorded nothing at all — still true, because
    // the ledger reads the whole log, not one run's slice of it.
    expect(state.runs['run-b']?.destructiveCalls[print]).toBeUndefined();
    expect(ledger.dryRunSeen(print)).toBe(true);
    expect(ledger.confirmed(print)).toBe(true);
  });

  it('does not pair a dry run and a confirmation recorded under two different runs', () => {
    // The actual boundary of "outlives the run": the *pair* is folded per
    // run (`state/reduce.ts`'s `destructiveCalls`), so a dry run under
    // 'run-a' and a confirmation appended under 'run-b' for the identical
    // fingerprint produce two incomplete entries, neither satisfying
    // `confirmed` — exactly why `mpgm confirm --run <run>` names the run
    // the dry run happened under rather than defaulting to whichever run is
    // asking (`contracts/release.deliver.md`). A review found the previous
    // test's title implying otherwise, with nothing here to say it was
    // wrong (CONV-6).
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-a',
        type: 'DryRunRecorded',
        payload: { taskId: '', tool: 'deploy', fingerprint: print },
      },
      { runId: 'run-b', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-b',
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: '',
          tool: 'deploy',
          fingerprint: print,
          by: 'macg',
        },
      },
    ]);
    const ledger = crossRunLedger(() => state);

    expect(ledger.dryRunSeen(print)).toBe(true);
    expect(ledger.confirmed(print)).toBe(false);
  });

  it('does not confirm a fingerprint nothing has ever recorded', () => {
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
    ]);
    const ledger = crossRunLedger(() => state);

    expect(ledger.dryRunSeen(print)).toBe(false);
    expect(ledger.confirmed(print)).toBe(false);
  });

  it('lets rollback in a later run proceed on an earlier run’s confirmation', async () => {
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-a',
        type: 'DryRunRecorded',
        payload: { taskId: '', tool: 'deploy', fingerprint: print },
      },
      {
        runId: 'run-a',
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: '',
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
    // operator's `mpgm rollback`, invoked from a run that never itself saw
    // the original `deliver`'s dry run or confirmation.
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

/**
 * T4.1.4's first review: `production` declared in a manifest made
 * `env.provision#up` — reached directly, with an `image` override — an
 * ungated deploy of an arbitrary digest, one layer beneath the gate this
 * module puts in front of `release.deliver`. These tests are the ones that
 * fix has to fail without.
 */
describe('gateProvisionRelease', () => {
  it('refuses an image-carrying up for a gated environment without a recorded dry run', async () => {
    const { provider, calls } = fakeProvisionProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(
      gated.up({ repo: 'r', env: 'production', image: 'sha256:aaa' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('refuses an image-carrying up once simulated but still unconfirmed', async () => {
    const { provider, calls } = fakeProvisionProvider();
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: 'sha256:aaa',
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print])),
    });

    await expect(
      gated.up({ repo: 'r', env: 'production', image: 'sha256:aaa' } as never),
    ).rejects.toThrow(/simulated but not confirmed/);
    expect(calls).toEqual([]);
  });

  it('lets an image-carrying up proceed once confirmed', async () => {
    const { provider, calls } = fakeProvisionProvider();
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: 'sha256:aaa',
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await gated.up({ repo: 'r', env: 'production', image: 'sha256:aaa' } as never);
    expect(calls).toHaveLength(1);
  });

  it('leaves an up with no image untouched, even for a gated environment', async () => {
    // Standing up the declared IaC before any release exists to point it at
    // is `env.provision`'s own reason to exist (`contracts/env.provision.md`)
    // — gating it would gate infrastructure nobody is asking to deploy
    // anything onto.
    const { provider, calls } = fakeProvisionProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await gated.up({ repo: 'r', env: 'production' } as never);
    expect(calls).toHaveLength(1);
  });

  it('refuses a no-image up for a gated environment that is already up', async () => {
    // The second review's own gap: a no-image `up` recreates the stack on
    // the compose default, which for an environment already serving a
    // confirmed release is an unapproved change to what production serves
    // (T4.1.4 third rework). Refused until an operator confirms recreating
    // this exact `{repo, env}` onto its default.
    const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      DeployGateError,
    );
    expect(calls).toEqual([]);
  });

  it('lets a no-image up for an already-up gated environment proceed once confirmed', async () => {
    const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: RECREATE_ON_DEFAULT_DIGEST,
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await gated.up({ repo: 'r', env: 'production' } as never);
    expect(calls).toHaveLength(1);
  });

  it('refuses a no-image up for a gated environment when the provider cannot report status', async () => {
    // Fail closed (CONV-4): a provider this gate cannot ask is never assumed
    // fresh.
    const calls: string[] = [];
    const provider: Provider = {
      up: (input: never) => {
        calls.push(`up:${JSON.stringify(input)}`);
        return Promise.resolve({ env: 'x', up: true, services: [] });
      },
    };
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      DeployGateError,
    );
    expect(calls).toEqual([]);
  });

  it('leaves an image-carrying up for a non-gated environment untouched', async () => {
    const { provider, calls } = fakeProvisionProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await gated.up({ repo: 'r', env: 'staging', image: 'sha256:aaa' } as never);
    expect(calls).toHaveLength(1);
  });

  it('shares its fingerprint identity with gateProductionRelease — one confirmation satisfies both', async () => {
    // The confirmation on record is for `release.deliver#deliver`'s
    // fingerprint of this exact `{repo, env, digest}` — the same identity
    // `dockerReleaseProvider.deliverTo` hands to `env.provision#up`
    // underneath an already-gated `deliver`. No second prompt.
    const deliverPrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: release('1.0.0').digest,
    });
    const { provider, calls } = fakeProvisionProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([deliverPrint]), new Set([deliverPrint])),
    });

    await gated.up({
      repo: 'r',
      env: 'production',
      image: release('1.0.0').digest,
    } as never);
    expect(calls).toHaveLength(1);
  });

  it('refuses to wrap a provider that does not implement up', () => {
    expect(() =>
      gateProvisionRelease(
        { down: () => Promise.resolve({}) },
        {
          gatedEnvs: PRODUCTION_GATED,
          ledger: ledger(),
        },
      ),
    ).toThrow(DeployGateError);
  });

  describe('down', () => {
    it('leaves a down for a gated environment that is not up untouched', async () => {
      // Nothing is being torn down — the same "nothing to replace yet"
      // reasoning the no-image `up` case makes.
      const { provider, calls } = fakeProvisionProvider();
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await gated.down({ repo: 'r', env: 'production' } as never);
      expect(calls).toEqual(['down:{"repo":"r","env":"production"}']);
    });

    it('refuses to tear a gated environment down while it is up, without a recorded dry run', async () => {
      // A fourth review's own gap: an ungated `down` was both a newly
      // reachable route to production and a way to defeat the no-image `up`
      // check above (see the regression test below).
      const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await expect(gated.down({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
        DeployGateError,
      );
      expect(calls).toEqual([]);
    });

    it('refuses a down for an up gated environment once simulated but still unconfirmed', async () => {
      const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
      const print = deployFingerprint({
        repo: 'r',
        env: 'production',
        digest: TEARDOWN_ENV_DIGEST,
      });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(new Set([print])),
      });

      await expect(gated.down({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
        /simulated but not confirmed/,
      );
      expect(calls).toEqual([]);
    });

    it('lets a down for an up gated environment proceed once confirmed', async () => {
      const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
      const print = deployFingerprint({
        repo: 'r',
        env: 'production',
        digest: TEARDOWN_ENV_DIGEST,
      });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(new Set([print]), new Set([print])),
      });

      await gated.down({ repo: 'r', env: 'production' } as never);
      expect(calls).toHaveLength(1);
    });

    it('refuses a down for a gated environment when the provider cannot report status', async () => {
      // Fail closed (CONV-4): a provider this gate cannot ask is never
      // assumed already down.
      const calls: string[] = [];
      const provider: Provider = {
        up: (input: never) => {
          calls.push(`up:${JSON.stringify(input)}`);
          return Promise.resolve({ env: 'x', up: true, services: [] });
        },
        down: (input: never) => {
          calls.push(`down:${JSON.stringify(input)}`);
          return Promise.resolve({ env: 'x', up: false, services: [] });
        },
      };
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await expect(gated.down({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
        DeployGateError,
      );
      expect(calls).toEqual([]);
    });

    it('leaves a down for a non-gated environment untouched even while it is up', async () => {
      const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await gated.down({ repo: 'r', env: 'staging' } as never);
      expect(calls).toEqual(['down:{"repo":"r","env":"staging"}']);
    });

    it('leaves a provider with no down as-is, nothing here to gate', () => {
      const calls: string[] = [];
      const provider: Provider = {
        up: (input: never) => {
          calls.push(`up:${JSON.stringify(input)}`);
          return Promise.resolve({ env: 'x', up: true, services: [] });
        },
      };
      const gated = gateProvisionRelease(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      expect((gated as unknown as { down?: unknown }).down).toBeUndefined();
    });

    it("does not defeat the no-image 'up' check by tearing the environment down first (T4.1.4 fourth rework)", async () => {
      // The exact end-to-end regression the fourth review demonstrated: an
      // ungated `down` left production not-up, so the identical no-image
      // `up` that must be gated while a confirmed release is running found
      // nothing running and passed too — zero approval events, production
      // recreated on the compose default. With `down` gated, the first
      // step is refused, so the environment is still reported up when the
      // no-image `up` is attempted, and that is refused as well.
      const { provider, calls } = fakeProvisionProvider({ alreadyUp: true });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await expect(gated.down({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
        DeployGateError,
      );
      await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
        DeployGateError,
      );
      expect(calls).toEqual([]);
    });
  });
});
