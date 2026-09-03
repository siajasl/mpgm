import { describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import type { ReleaseArtifact } from '../release/deliver.js';
import {
  DeployGateError,
  deployFingerprint,
  gateProductionRelease,
  type DeployGateOptions,
  type DeployLedger,
} from './deploy-gate.js';

/**
 * `gateProductionRelease` returns the same `Provider` type it was given —
 * a bare `Record`, so a caller cannot call `.deliver`/`.rollback` on it
 * without narrowing first. Every real caller reaches these two operations
 * through a `BoundContract`, which does that narrowing for them
 * (`contract/capability.ts`); this test calls the gate directly, so it
 * narrows once here instead of repeating a non-null assertion at every call.
 */
interface GatedProvider {
  readonly deliver: (input: never) => Promise<unknown>;
  readonly rollback: (input: never) => Promise<unknown>;
}

function gate(provider: Provider, options: DeployGateOptions): GatedProvider {
  return gateProductionRelease(provider, options) as unknown as GatedProvider;
}

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

describe('gateProductionRelease — deliver', () => {
  it('refuses production without a recorded dry run', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { ledger: ledger() });

    await expect(
      gated.deliver({ repo: 'r', env: 'production', release: release('1.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('refuses production once simulated but still unconfirmed', async () => {
    const { provider, calls } = fakeProvider();
    const target = { repo: 'r', env: 'production', release: release('1.0.0') };
    const print = deployFingerprint(target);
    const gated = gate(provider, {
      ledger: ledger(new Set([print])),
    });

    await expect(gated.deliver(target as never)).rejects.toThrow(
      /simulated but not confirmed/,
    );
    expect(calls).toEqual([]);
  });

  it('delivers to production once the exact call is dry-run and confirmed', async () => {
    const { provider, calls } = fakeProvider();
    const target = { repo: 'r', env: 'production', release: release('1.0.0') };
    const print = deployFingerprint(target);
    const gated = gate(provider, {
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await expect(gated.deliver(target as never)).resolves.toEqual({
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
      release: release('1.0.0'),
    });
    const gated = gate(provider, {
      ledger: ledger(new Set([confirmed]), new Set([confirmed])),
    });

    await expect(
      gated.deliver({ repo: 'r', env: 'production', release: release('2.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('leaves a non-production environment ungated', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { ledger: ledger() });

    await gated.deliver({
      repo: 'r',
      env: 'staging',
      release: release('1.0.0'),
    } as never);
    expect(calls).toHaveLength(1);
  });

  it('respects a custom production environment name', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, {
      ledger: ledger(),
      productionEnv: 'prod-eu',
    });

    // The default name, unconfigured, passes straight through now.
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
    const target = { repo: 'r', env: 'production', release: release('1.0.0') };
    const print = deployFingerprint(target);

    const gated1 = gate(provider, {
      ledger: ledger(),
      onDryRunNeeded: (record) => dryRunNeeded.push(record.fingerprint),
      onConfirmationNeeded: (record) => confirmationNeeded.push(record.fingerprint),
    });
    await expect(gated1.deliver(target as never)).rejects.toThrow(DeployGateError);
    expect(dryRunNeeded).toEqual([print]);
    expect(confirmationNeeded).toEqual([]);

    const gated2 = gate(provider, {
      ledger: ledger(new Set([print])),
      onDryRunNeeded: (record) => dryRunNeeded.push(record.fingerprint),
      onConfirmationNeeded: (record) => confirmationNeeded.push(record.fingerprint),
    });
    await expect(gated2.deliver(target as never)).rejects.toThrow(DeployGateError);
    expect(confirmationNeeded).toEqual([print]);
  });
});

describe('gateProductionRelease — rollback', () => {
  it('refuses restoring a release production never had confirmed', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { ledger: ledger() });

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
      release: release('1.0.0'),
    });
    const gated = gate(provider, {
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
      release: release('1.0.0'),
    });
    const gated = gate(provider, {
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await expect(
      gated.rollback({ repo: 'r', env: 'production', to: release('9.9.9') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('leaves a non-production rollback ungated', async () => {
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { ledger: ledger() });

    await gated.rollback({ repo: 'r', env: 'staging', to: release('1.0.0') } as never);
    expect(calls).toHaveLength(1);
  });
});

describe('deployFingerprint', () => {
  it('is stable for the same target and changes with any field', () => {
    const target = { repo: 'r', env: 'production', release: release('1.0.0') };
    expect(deployFingerprint(target)).toBe(deployFingerprint({ ...target }));
    expect(deployFingerprint(target)).not.toBe(
      deployFingerprint({ ...target, env: 'staging' }),
    );
    expect(deployFingerprint(target)).not.toBe(
      deployFingerprint({ ...target, release: release('1.0.1') }),
    );
    expect(deployFingerprint(target)).not.toBe(
      deployFingerprint({ ...target, repo: 'other' }),
    );
  });
});
