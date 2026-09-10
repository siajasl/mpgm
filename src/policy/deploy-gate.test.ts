import { describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import { MEMORY } from '../database.js';
import { KERNEL_TASK, kernelRegistry } from '../event/catalog.js';
import type { EventInput } from '../event/envelope.js';
import { environmentUp, type ServiceStatus } from '../env/provision.js';
import type { ReleaseArtifact } from '../release/deliver.js';
import { EventLog } from '../event/store.js';
import { fold } from '../state/reduce.js';
import {
  crossRunLedger,
  DeployGateError,
  deployFingerprint,
  gateProductionRelease,
  gateProvisionRelease,
  recreateOnDefaultDigest,
  teardownDigest,
  type DeployGateOptions,
  type DeployLedger,
  type ProvisionGateOptions,
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
 * `gatedEnvs` naming only `production`, for every `repo` — every test below
 * that does not exercise `gatedEnvs` itself uses this. `gatedEnvs` is a
 * function of `repo` (`DeployGateOptions.gatedEnvs`), the same shape a
 * caller reading a project's own manifest (`env/compose-provider.ts`'s
 * `gatedEnvironments`) would wire in for a project that marks that
 * environment `approval: required` (this repository's own manifest marks
 * `staging`, never a name this module assumes on its own) — these tests
 * ignore `repo` because none of them exercises resolving a different set per
 * repo; `docker-provider.test.ts` covers that.
 */
function fixedGate(envs: ReadonlySet<string>): (repo: string) => ReadonlySet<string> {
  return () => envs;
}
const PRODUCTION_GATED: (repo: string) => ReadonlySet<string> = fixedGate(
  new Set(['production']),
);

/**
 * A stand-in digest actually shaped like one — exactly 64 lowercase hex
 * characters, what `docker build --iidfile` writes (`isDigestShaped`,
 * `./deploy-gate.ts`) — for tests below that exercise a gated call's own
 * behaviour rather than the shape check itself (T4.1.4b review 7). `'aaa'`
 * alone no longer passes that check now that it is exact-length, and a test
 * using it where the value is meant to be *some* digest, not *the* shape
 * under test, would fail for the wrong reason.
 */
const DIGEST_A = `sha256:${'a'.repeat(64)}`;

/** A ledger over in-memory sets, mirroring `stateLedger`'s shape. */
function ledger(seen = new Set<string>(), confirmed = new Set<string>()): DeployLedger {
  return {
    dryRunSeen: (print) => seen.has(print),
    confirmed: (print) => confirmed.has(print),
  };
}

/**
 * `digest` defaults to a value actually shaped like one (T4.1.4b review 6):
 * `gateProductionRelease` now refuses a non-digest-shaped `release.digest`/
 * `to.digest` outright (`isDigestShaped`), so a default of `sha256:1.0.0` —
 * `.` is not hex — would trip that check before any test naming `release`
 * without a `digest` override ever reached the behaviour it means to
 * exercise. Hex-encoding `version` keeps the old property tests below rely
 * on — a distinct `digest` for a distinct `version` — without hand-picking
 * one per call site; padding to exactly 64 hex characters (rather than
 * whatever length `version`'s own UTF-8 encoding happens to be) keeps that
 * default passing `isDigestShaped`'s exact-length check too, now that it is
 * exact (T4.1.4b review 7, CONV-4) — a short `version` no longer produces a
 * default `digest` this suite's own subject would refuse.
 */
function release(
  version: string,
  digest = `sha256:${Buffer.from(version, 'utf8').toString('hex').padEnd(64, '0')}`,
): ReleaseArtifact {
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
   * T4.1.4b review 6: `releaseArtifactSchema.digest` (`../release/deliver.ts`)
   * is `z.string().min(1)`, with no shape of its own — before this check, a
   * tag-shaped `release.digest` reaching a gated `deliver` would be
   * confirmed by an operator at this outer door and only *then* refused by
   * `gateProvisionRelease`'s inner `up` gate underneath, with a message
   * telling the caller to "deliver this through `release.deliver` instead" —
   * advice it had already followed. Refused here, before the ledger is
   * consulted at all, the same shape `gateProvisionRelease`'s own tag check
   * already gives `up` (T4.1.4b review 5).
   */
  it('refuses a tag-shaped release.digest before the ledger is consulted at all', async () => {
    const { provider, calls } = fakeProvider();
    let ledgerAsked = false;
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: {
        dryRunSeen: () => {
          ledgerAsked = true;
          return true;
        },
        confirmed: () => {
          ledgerAsked = true;
          return true;
        },
      },
    });

    await expect(
      gated.deliver({
        repo: 'r',
        env: 'production',
        release: release('1.0.0', 'sample:1.0.0'),
      } as never),
    ).rejects.toThrow(/not shaped like a digest/);
    expect(calls).toEqual([]);
    expect(ledgerAsked).toBe(false);
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
      gatedEnvs: fixedGate(new Set(['prod-eu'])),
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

  /**
   * `gatedEnvs` is resolved against the `repo` *the call itself names*, not
   * a set fixed once at construction — a regression to reading `repo` at
   * construction time (or ignoring it altogether) would make this gate judge
   * every call by whichever repo happened to be at hand when it was built,
   * which is criterion 2 ("read from project configuration") failing for
   * any repo other than that one (the major finding this test closes:
   * `docker-provider.test.ts` covers the same property through the real
   * provider).
   */
  it('resolves gatedEnvs from the repo named on each call, not a repo fixed at construction', async () => {
    const { provider, calls } = fakeProvider();
    const seenRepos: string[] = [];
    const gated = gate(provider, {
      gatedEnvs: (repo) => {
        seenRepos.push(repo);
        return repo === 'repo-a' ? new Set(['prod']) : new Set();
      },
      ledger: ledger(),
    });

    // 'repo-a' marks 'prod' gated; 'repo-b' does not. The same gate instance
    // answers each call by the repo that call names.
    await expect(
      gated.deliver({ repo: 'repo-a', env: 'prod', release: release('1.0.0') } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);

    await gated.deliver({
      repo: 'repo-b',
      env: 'prod',
      release: release('1.0.0'),
    } as never);
    expect(calls).toHaveLength(1);
    expect(seenRepos).toEqual(['repo-a', 'repo-b']);
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

  /** See `deliver`'s identical test above (T4.1.4b review 6) — the same
   * fail-closed shape check applies to `to.digest`. */
  it('refuses a tag-shaped to.digest before the ledger is consulted at all', async () => {
    const { provider, calls } = fakeProvider();
    let ledgerAsked = false;
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: {
        dryRunSeen: () => {
          ledgerAsked = true;
          return true;
        },
        confirmed: () => {
          ledgerAsked = true;
          return true;
        },
      },
    });

    await expect(
      gated.rollback({
        repo: 'r',
        env: 'production',
        to: release('1.0.0', 'sample:1.0.0'),
      } as never),
    ).rejects.toThrow(/not shaped like a digest/);
    expect(calls).toEqual([]);
    expect(ledgerAsked).toBe(false);
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
 * `gateProvisionRelease`'s own `Provider`, the same narrowing reasoning
 * `GatedReleaseProvider`/`gate` above give for `gateProductionRelease` — a
 * bare `Record`, narrowed once here rather than at every call. `down` stays
 * optional: one of these tests wraps a provider that does not implement it
 * at all (T4.1.4b's own "left as-is" case).
 */
interface GatedProvisionProvider {
  readonly up: (input: never) => Promise<unknown>;
  readonly down?: (input: never) => Promise<unknown>;
  readonly status?: (input: never) => Promise<unknown>;
}

/**
 * `options` stays the wider `DeployGateOptions`, `onConfirmationSpent`
 * included, so a test below can still construct one that omits it — the
 * fail-closed refusal `assertReady` raises for exactly that case (T4.1.4c,
 * CONV-4) has to stay reachable from a test, even though
 * `gateProvisionRelease`'s own signature now requires
 * {@link ProvisionGateOptions} so no real caller in this repository can.
 * Casting here is deliberately the same thing a JS caller unaware of
 * `ProvisionGateOptions` would do — `gateProvisionRelease`'s own doc
 * describes that caller as the one this cast stands in for.
 */
function provisionGate(
  provider: Provider,
  options: DeployGateOptions,
): GatedProvisionProvider {
  return gateProvisionRelease(
    provider,
    options as ProvisionGateOptions,
  ) as unknown as GatedProvisionProvider;
}

/**
 * `down`, on `GatedProvisionProvider`, is optional the way `Provider`'s own
 * handlers all are — a test asserting on it needs the same non-undefined
 * check `operation` gives `../env/compose-provider.test.ts`, with a message
 * naming which operation vanished rather than "possibly undefined".
 */
function requireDown(
  provider: GatedProvisionProvider,
): (input: never) => Promise<unknown> {
  const fn = provider.down;
  if (fn === undefined) {
    throw new Error("gateProvisionRelease's result does not implement 'down'");
  }
  return fn;
}

/**
 * A fake `env.provision` provider — records every call it actually
 * received (CONV-6: so a test can tell "the gate let this through" from "the
 * gate refused it" without a real Docker daemon) and answers `status` from
 * mutable in-memory state, so a test can move an environment between up and
 * down the way `up`/`down` themselves would.
 */
function fakeEnvProvider(startUp = false): {
  provider: Provider;
  calls: string[];
} {
  const calls: string[] = [];
  let up = startUp;
  const services = () =>
    up
      ? [{ name: 'service', state: 'running', health: 'healthy', containerId: 'c1' }]
      : [];
  const provider: Provider = {
    up: (input: never) => {
      calls.push(`up:${JSON.stringify(input)}`);
      up = true;
      return Promise.resolve({
        env: (input as { env: string }).env,
        up: true,
        services: services(),
      });
    },
    down: (input: never) => {
      calls.push(`down:${JSON.stringify(input)}`);
      up = false;
      return Promise.resolve({
        env: (input as { env: string }).env,
        up: false,
        services: [],
      });
    },
    status: (input: never) => {
      calls.push(`status:${JSON.stringify(input)}`);
      return Promise.resolve({
        env: (input as { env: string }).env,
        up,
        services: services(),
      });
    },
  };
  return { provider, calls };
}

/**
 * A fake `env.provision` provider whose `status`/`up`/`down` all report a
 * fixed, caller-supplied set of services, `up`/`down`'s own claim computed
 * from the same `environmentUp` the real schema requires (`envStatusOutput`)
 * — so a service that is `running` but `unhealthy`, `starting`, or `exited`
 * can be handed to the gate directly, rather than only the fully-healthy or
 * fully-empty extremes {@link fakeEnvProvider} covers.
 *
 * Exists for the T4.1.4b rework finding: `gateProvisionRelease` decided
 * "anything here to protect" from this same `environmentUp` verdict, which
 * reads a `starting`/`unhealthy`/`exited` service as indistinguishable from
 * no service at all — this is what lets a test put the gate in front of
 * exactly that ambiguity (CONV-4, CONV-6).
 */
function fakeEnvProviderServing(services: ServiceStatus[]): {
  provider: Provider;
  calls: string[];
} {
  const calls: string[] = [];
  const status = (input: never) => {
    return Promise.resolve({
      env: (input as { env: string }).env,
      up: environmentUp(services),
      services,
    });
  };
  const provider: Provider = {
    up: (input: never) => {
      calls.push(`up:${JSON.stringify(input)}`);
      return status(input);
    },
    down: (input: never) => {
      calls.push(`down:${JSON.stringify(input)}`);
      return Promise.resolve({
        env: (input as { env: string }).env,
        up: false,
        services: [],
      });
    },
    status: (input: never) => {
      calls.push(`status:${JSON.stringify(input)}`);
      return status(input);
    },
  };
  return { provider, calls };
}

describe('gateProvisionRelease — up', () => {
  it('refuses an image-carrying up on a gated environment without a recorded dry run', async () => {
    const { provider, calls } = fakeEnvProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(
      gated.up({ repo: 'r', env: 'production', image: DIGEST_A } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([]);
  });

  it('shares its fingerprint with the {repo, env, digest} gateProductionRelease/deployFingerprint would compute for the same digest', async () => {
    const { provider, calls } = fakeEnvProvider();
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: DIGEST_A,
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await gated.up({ repo: 'r', env: 'production', image: DIGEST_A } as never);
    expect(calls).toHaveLength(1);
  });

  it('leaves an image-carrying up on a non-gated environment ungated', async () => {
    const { provider, calls } = fakeEnvProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await gated.up({ repo: 'r', env: 'staging', image: 'sha256:aaa' } as never);
    expect(calls).toHaveLength(1);
  });

  /**
   * T4.1.4b review 7: `isDigestShaped` (`./deploy-gate.ts`) requires exactly
   * 64 lowercase hex characters — the length and case `docker build
   * --iidfile` actually writes — not merely a `sha256:` prefix followed by
   * *some* hex. A shorter hex string is a live, mutable reference: it is a
   * valid (truncated) Docker image id, and which image it resolves to
   * depends on what exists on the host when the call finally runs, so a
   * confirmation keyed on it is the same confirmation-over-a-mutable-name
   * this check exists to refuse (CONV-4). This is the case the prior,
   * length-unbounded regex let through.
   */
  it('refuses a truncated (but validly-hex) digest on a gated environment', async () => {
    const { provider, calls } = fakeEnvProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(
      gated.up({
        repo: 'r',
        env: 'production',
        image: 'sha256:e8983ff7edad',
      } as never),
    ).rejects.toThrow(/not shaped like a digest/);
    expect(calls).toEqual([]);
  });

  /**
   * T4.1.4b review 5: `image` is documented as overriding the compose
   * default (`envUpInput`, `../env/provision.ts`) and carries no shape of its
   * own — a tag, in every demo and in this repository's own build naming
   * (`docker-provider.ts`'s `buildImage` tags `${image}:${version}` before it
   * ever records a digest) — but this gate used to fingerprint whatever
   * string arrived, tag included, so one confirmation of `up {image:
   * 'app:1.0.0'}` stood as a standing authorisation for every later `up`
   * naming that same tag, however many times it had since been rebuilt to
   * point at a different tree. A tag is now refused outright, and — the point
   * of this test — refused *before* the provider's `up` is ever reached and
   * before the ledger is consulted at all: unlike an unconfirmed digest,
   * there is no confirmation that would ever let this call through, so it
   * must never be offered one to reach for.
   */
  it('refuses an up carrying a tag rather than a digest, on a gated environment, before the ledger is consulted at all', async () => {
    const { provider, calls } = fakeEnvProvider();
    let ledgerAsked = false;
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: {
        dryRunSeen: () => {
          ledgerAsked = true;
          return true;
        },
        confirmed: () => {
          ledgerAsked = true;
          return true;
        },
      },
    });

    await expect(
      gated.up({ repo: 'r', env: 'production', image: 'registry/app:7' } as never),
    ).rejects.toThrow(/not shaped like a digest/);
    expect(calls).toEqual([]);
    expect(ledgerAsked).toBe(false);
  });

  it('leaves an up carrying a tag on a non-gated environment untouched — the shape check applies only where this gate applies at all', async () => {
    const { provider, calls } = fakeEnvProvider();
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await gated.up({ repo: 'r', env: 'staging', image: 'registry/app:7' } as never);
    expect(calls).toHaveLength(1);
  });

  /**
   * T4.1.4b review 2: the first version of this gate asked `status` first
   * and let a no-image `up` through untouched whenever nothing was reported
   * — reasoning that standing up infrastructure nothing is serving asks
   * nothing of an operator. The review found that reachable, not
   * theoretical: `production` is declared in this same task and has never
   * been stood up, so its only reachable state *was* exactly this one,
   * meaning any caller could stand it up on the compose default — an
   * outward-facing production deploy — with no approval anywhere in the
   * path (HIL-2). A no-image `up` against a gated environment must now be
   * refused whatever `status` reports, nothing included.
   */
  it('refuses a no-image up on a gated environment with nothing serving yet — a first bring-up needs approval too', async () => {
    const { provider, calls } = fakeEnvProvider(false);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      DeployGateError,
    );
    expect(calls).toEqual([`status:${JSON.stringify({ repo: 'r', env: 'production' })}`]);
  });

  it('lets a no-image up through once its first bring-up — nothing serving yet — is confirmed', async () => {
    const { provider, calls } = fakeEnvProvider(false);
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
      // The empty-state identity is `singleUse` (T4.1.4c): wired here purely
      // so this call has somewhere to record the spend and is not itself
      // refused for lacking it — `assertReady` fails closed on a `singleUse`
      // target with no `onConfirmationSpent` wired, the same as it fails
      // closed on anything else unconfirmed. Whether the spend itself sticks
      // is a different test's concern (below).
      onConfirmationSpent: () => {
        // No-op: this test's own concern is the confirmation, not the spend.
      },
    });

    await gated.up({ repo: 'r', env: 'production' } as never);
    expect(calls).toEqual([
      `status:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
    ]);
  });

  /**
   * T4.1.4b review 4, finding 2: `servingIdentity([])` is the fixed string
   * `'none'`, so every empty state folds to the same identity — a
   * confirmation given to *one* occurrence of "nothing serving" would,
   * necessarily, be a confirmation good for *any* later no-image `up` this
   * environment is found in the same empty state for, whether that is the
   * environment's true first bring-up or a later one found empty again
   * after an intervening teardown, unless something spends it. DESIGN §9
   * decision 14's fourth review accepted that rather than closing it;
   * T4.1.4c withdrew the acceptance and closes it here: `assertReady` fires
   * `onConfirmationSpent` for exactly this identity the moment it lets a
   * call through, so a caller that wires that callback to actually retract
   * the confirmation sees the *next* identical sighting refused again. A
   * test that let the second sighting through unconfirmed would be
   * asserting the behaviour this task withdrew.
   */
  it('spends the empty-state confirmation the moment a no-image up proceeds on it, refusing an identical later sighting', async () => {
    const emptyStatePrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    // A minimal ledger standing in for a real one backed by the event log
    // (`crossRunLedger` is covered end-to-end below): `confirmed` reads a
    // mutable flag that `onConfirmationSpent` — wired the way a real caller
    // would wire it to record a `DeployConfirmationSpent` event — flips off,
    // exactly the shape `assertReady` requires nothing more of a caller than.
    let confirmed = true;
    const spent: string[] = [];
    const options: DeployGateOptions = {
      gatedEnvs: PRODUCTION_GATED,
      ledger: {
        dryRunSeen: (print) => print === emptyStatePrint,
        confirmed: (print) => print === emptyStatePrint && confirmed,
      },
      onConfirmationSpent: (record) => {
        spent.push(record.fingerprint);
        confirmed = false;
      },
    };

    const first = fakeEnvProvider(false);
    await provisionGate(first.provider, options).up({
      repo: 'r',
      env: 'production',
    } as never);
    expect(spent).toEqual([emptyStatePrint]);
    expect(first.calls).toContain(
      `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
    );

    // A distinct sighting of the same empty state — a different provider
    // instance, standing in for a later run that finds this environment
    // empty again — computes the identical fingerprint, and finds it spent.
    const second = fakeEnvProvider(false);
    await expect(
      provisionGate(second.provider, options).up({
        repo: 'r',
        env: 'production',
      } as never),
    ).rejects.toThrow(DeployGateError);
    expect(second.calls).not.toContain(
      `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
    );
  });

  /**
   * `ProvisionGateOptions` makes this unreachable for any caller
   * `gateProvisionRelease`'s own TypeScript signature admits — its
   * `onConfirmationSpent` is required, not optional (T4.1.4c, CONV-5) — so
   * this test reaches `assertReady`'s runtime refusal the same way a
   * plain-JS caller unaware of that type would: by casting an options
   * object that omits the field past it (`provisionGate`'s own doc). Before
   * this refusal existed, a `singleUse` target reaching here with the
   * callback unwired passed the gate silently, leaving the confirmation
   * standing for every later identical call — exactly the
   * standing-authorisation gap this task exists to close, left open again by
   * an unwired caller instead of by the fingerprint (CONV-4). Confirming the
   * real, wrapped `up` is never invoked proves the refusal happens before
   * any effect, not merely that a rejection surfaces eventually.
   */
  it('refuses a singleUse call outright when the caller has wired nowhere to record the spend, rather than letting it through unspent', async () => {
    const emptyStatePrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    const { provider, calls } = fakeEnvProvider(false);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([emptyStatePrint]), new Set([emptyStatePrint])),
      // Deliberately omitted — see this test's own doc.
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      /has not wired 'onConfirmationSpent'/,
    );
    expect(calls).not.toContain(`up:${JSON.stringify({ repo: 'r', env: 'production' })}`);
  });

  it('does not spend a confirmation for a reported (non-empty) state — its fingerprint already changes with what it approves', async () => {
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([
        { name: 'service', state: 'exited', health: 'none', containerId: 'c1' },
      ]),
    });
    let onConfirmationSpentCalled = false;
    const { provider, calls } = fakeEnvProviderServing([
      { name: 'service', state: 'exited', health: 'none', containerId: 'c1' },
    ]);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
      onConfirmationSpent: () => {
        onConfirmationSpentCalled = true;
      },
    });

    await gated.up({ repo: 'r', env: 'production' } as never);
    expect(calls).toContain(`up:${JSON.stringify({ repo: 'r', env: 'production' })}`);
    expect(onConfirmationSpentCalled).toBe(false);
  });

  it('tells the operator the empty state is a single recurring identity, not a fresh one, when refusing a first bring-up', async () => {
    const { provider } = fakeEnvProvider(false);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      /single recurring identity/,
    );
  });

  const ONE_SERVICE_UP: ServiceStatus[] = [
    { name: 'service', state: 'running', health: 'healthy', containerId: 'c1' },
  ];

  it('refuses a no-image up on a gated environment that is already up, under recreateOnDefaultDigest, without ever calling the real up', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      DeployGateError,
    );
    expect(calls).toEqual([`status:${JSON.stringify({ repo: 'r', env: 'production' })}`]);
  });

  /**
   * CONV-3: an operator reading this refusal must be able to tell, without
   * reading this module, that confirming it only authorises *this* reported
   * state — not a standing "recreate on default whenever" for the
   * environment. The message text is the only place that fact reaches them.
   */
  it('tells the operator a no-image up refusal is bound to the reported state, not a standing authorisation', async () => {
    const { provider } = fakeEnvProvider(true);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      /covers only this exact reported state/,
    );
  });

  it('lets a no-image up on an already-up gated environment through once "recreate on default" is confirmed', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest(ONE_SERVICE_UP),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await gated.up({ repo: 'r', env: 'production' } as never);
    expect(calls).toHaveLength(2);
  });

  /**
   * T4.1.4b review 2: confirming a recreate over one reported state must not
   * stand as a standing authorisation to recreate over a *different* one —
   * a confirmation of the empty, first-bring-up state must not satisfy a
   * later call that finds something already serving, and vice versa.
   */
  it('does not confirm a recreate over one reported state against a recreate over a different one', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const firstBringUpPrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([firstBringUpPrint]), new Set([firstBringUpPrint])),
    });

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      DeployGateError,
    );
    expect(calls).toEqual([`status:${JSON.stringify({ repo: 'r', env: 'production' })}`]);
  });

  it('does not confirm "recreate on default" and a specific digest against each other — distinct identities', () => {
    const recreate = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    const specific = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: 'sha256:aaa',
    });
    expect(recreate).not.toBe(specific);
  });

  it('fails closed on a no-image up against a gated environment when the provider has no status to ask', async () => {
    const gated = provisionGate(
      { up: () => Promise.resolve({}) },
      { gatedEnvs: PRODUCTION_GATED, ledger: ledger() },
    );

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      /does not implement 'status'/,
    );
  });

  it('refuses to wrap a provider that does not implement up', () => {
    expect(() =>
      gateProvisionRelease(
        { status: () => Promise.resolve({ up: false, services: [] }) },
        {
          gatedEnvs: PRODUCTION_GATED,
          ledger: ledger(),
          onConfirmationSpent: () => {
            // No-op: this call never reaches `assertReady` — it is refused
            // at construction, for lacking `up`, before any target exists.
          },
        },
      ),
    ).toThrow(DeployGateError);
  });
});

describe('gateProvisionRelease — down', () => {
  it('leaves down on a non-gated environment ungated', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await requireDown(gated)({ repo: 'r', env: 'staging' } as never);
    expect(calls).toHaveLength(1);
  });

  it('lets down through untouched while the gated environment is not already up', async () => {
    const { provider, calls } = fakeEnvProvider(false);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await requireDown(gated)({ repo: 'r', env: 'production' } as never);
    expect(calls).toEqual([
      `status:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      `down:${JSON.stringify({ repo: 'r', env: 'production' })}`,
    ]);
  });

  it('refuses down on a gated environment that is up, under teardownDigest, without ever calling the real down', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(
      requireDown(gated)({ repo: 'r', env: 'production' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([`status:${JSON.stringify({ repo: 'r', env: 'production' })}`]);
  });

  const ONE_SERVICE_UP: ServiceStatus[] = [
    { name: 'service', state: 'running', health: 'healthy', containerId: 'c1' },
  ];

  it('tells the operator a down refusal is bound to the reported state, not a standing authorisation', async () => {
    const { provider } = fakeEnvProvider(true);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    await expect(
      requireDown(gated)({ repo: 'r', env: 'production' } as never),
    ).rejects.toThrow(/covers only this exact reported state/);
  });

  /**
   * T4.1.4b review 4, finding 3: the review-3 caveat was once appended
   * directly onto `label`, which `describe()` splices into
   * `${label} (${digest.slice(0, 12)}) to '${env}'` — landing the caveat
   * sentence mid-clause, ahead of a truncated fragment of
   * `teardownDigest`'s value (not a real digest, so its first twelve
   * characters name nothing), and reading as approving a deploy rather than
   * a teardown. `describe()`'s clause — "torn down — currently: ... to
   * '<env>'" — must therefore read as one contiguous, ungarbled phrase, with
   * the caveat trailing it as its own sentence and no fragment of a
   * non-digest identity anywhere in the message a confirming operator reads.
   */
  it('renders a down refusal as one ungarbled clause, with the caveat trailing it rather than spliced inside it', async () => {
    const { provider } = fakeEnvProvider(true);
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(),
    });

    const message = await requireDown(gated)({
      repo: 'r',
      env: 'production',
    } as never).catch((cause: unknown) =>
      cause instanceof Error ? cause.message : String(cause),
    );

    expect(message).toMatch(
      /deploying torn down — currently: service:running\/healthy to 'production' has not been simulated\. This confirmation covers only this exact reported state/,
    );
    // `teardownDigest`'s value is not a digest — no fragment of it belongs
    // in a message an operator reads.
    expect(message).not.toContain('env-provisio');
  });

  it('lets down on an already-up gated environment through once "torn down" is confirmed', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const print = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: teardownDigest(ONE_SERVICE_UP),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([print]), new Set([print])),
    });

    await requireDown(gated)({ repo: 'r', env: 'production' } as never);
    expect(calls).toHaveLength(2);
  });

  /**
   * T4.1.4b review 2: a fixed `TEARDOWN_ENV_DIGEST` sentinel made one
   * confirmed teardown a standing authorisation to tear the same
   * environment down again in every later run, whatever it happened to be
   * serving by then — each teardown destroys whatever is currently there,
   * which is a different question every time. Confirming a teardown of one
   * reported state must not satisfy a later teardown of a different one.
   */
  it('does not confirm a teardown of one reported state against a teardown of a different one', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const differentStatePrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: teardownDigest([
        {
          name: 'service',
          state: 'running',
          health: 'healthy',
          containerId: 'some-other-id',
        },
      ]),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([differentStatePrint]), new Set([differentStatePrint])),
    });

    await expect(
      requireDown(gated)({ repo: 'r', env: 'production' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toEqual([`status:${JSON.stringify({ repo: 'r', env: 'production' })}`]);
  });

  it('leaves a provider with no down untouched — there is no operation here to gate', () => {
    const gated = provisionGate(
      {
        up: () => Promise.resolve({}),
        status: () => Promise.resolve({ up: false, services: [] }),
      },
      { gatedEnvs: PRODUCTION_GATED, ledger: ledger() },
    );
    expect(gated.down).toBeUndefined();
  });

  /**
   * The fourth-review finding the abandoned pre-split T4.1.4 attempt
   * recorded (`f6c7157`), and T4.1.4b review 2's blocker finding both bear
   * on this: a confirmed `down` leaves the environment reporting nothing, so
   * a *following* no-image `up` must not read that as "nothing to protect,
   * proceed" — that would make one teardown confirmation buy an unconfirmed
   * recreate for free. Since review 2, the no-image `up` case no longer
   * trusts "nothing reported" at all: it is gated unconditionally, so this
   * route is closed structurally, not because `down` happens to leave the
   * right state behind.
   */
  it('does not leave a two-call route to an unapproved recreate: a confirmed down does not also authorise the up that follows', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const downPrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: teardownDigest(ONE_SERVICE_UP),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([downPrint]), new Set([downPrint])),
    });

    await requireDown(gated)({ repo: 'r', env: 'production' } as never);
    calls.length = 0;

    await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
      DeployGateError,
    );
    expect(calls).toEqual([`status:${JSON.stringify({ repo: 'r', env: 'production' })}`]);
  });

  it('lets the up that follows a confirmed down through once its own first-bring-up state is separately confirmed', async () => {
    const { provider, calls } = fakeEnvProvider(true);
    const downPrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: teardownDigest(ONE_SERVICE_UP),
    });
    const upPrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    const gated = provisionGate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: ledger(new Set([downPrint, upPrint]), new Set([downPrint, upPrint])),
      // The `up` below finds the environment `down` just left empty, so it
      // is checked against the `singleUse` empty-state identity (T4.1.4c) —
      // wired so that call has somewhere to record its spend rather than
      // being refused for lacking it.
      onConfirmationSpent: () => {
        // No-op: this test's own concern is the up/down sequencing, not the
        // spend.
      },
    });

    await requireDown(gated)({ repo: 'r', env: 'production' } as never);
    calls.length = 0;

    await gated.up({ repo: 'r', env: 'production' } as never);
    expect(calls).toEqual([
      `status:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
    ]);
  });
});

/**
 * T4.1.4b rework 1: `gateProvisionRelease` decided "is there anything here to
 * protect" from `envStatusOutput.up` (`environmentUp`'s verdict), which fails
 * closed for a service still `starting`, `unhealthy`, or `exited` — read as
 * "not up", indistinguishable from an environment with nothing running at
 * all. Against a gated environment serving a confirmed release whose
 * healthcheck was failing, or mid-`start_period`, or whose container had
 * exited, both a no-image `up` and a `down` read "not up" as "nothing to
 * protect" and reached the provider with no approval — replacing a confirmed
 * release with the compose default, or tearing it down, during exactly the
 * ordinary operating conditions a deploy passes through (CONV-4). Each of
 * these must refuse, under {@link RECREATE_ON_DEFAULT_DIGEST}/
 * {@link TEARDOWN_ENV_DIGEST} same as a cleanly-`running`/`healthy` service
 * does, and neither may reach the wrapped provider until confirmed.
 */
describe.each<[string, ServiceStatus]>([
  [
    'starting',
    { name: 'service', state: 'running', health: 'starting', containerId: 'c1' },
  ],
  [
    'unhealthy',
    { name: 'service', state: 'running', health: 'unhealthy', containerId: 'c1' },
  ],
  ['exited', { name: 'service', state: 'exited', health: 'none', containerId: 'c1' }],
  [
    'restarting',
    { name: 'service', state: 'restarting', health: 'none', containerId: 'c1' },
  ],
])(
  'gateProvisionRelease fails closed on a gated environment reporting one %s service',
  (label, service) => {
    it(`refuses a no-image up (${label}) without ever calling the real up`, async () => {
      const { provider, calls } = fakeEnvProviderServing([service]);
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await expect(gated.up({ repo: 'r', env: 'production' } as never)).rejects.toThrow(
        DeployGateError,
      );
      expect(calls).toEqual([
        `status:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      ]);
    });

    it(`refuses down (${label}) without ever calling the real down`, async () => {
      const { provider, calls } = fakeEnvProviderServing([service]);
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(),
      });

      await expect(
        requireDown(gated)({ repo: 'r', env: 'production' } as never),
      ).rejects.toThrow(DeployGateError);
      expect(calls).toEqual([
        `status:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      ]);
    });

    it(`lets a no-image up (${label}) through once "recreate on default" is confirmed`, async () => {
      const { provider, calls } = fakeEnvProviderServing([service]);
      const print = deployFingerprint({
        repo: 'r',
        env: 'production',
        digest: recreateOnDefaultDigest([service]),
      });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(new Set([print]), new Set([print])),
      });

      await gated.up({ repo: 'r', env: 'production' } as never);
      expect(calls).toHaveLength(2);
    });

    it(`lets down (${label}) through once "torn down" is confirmed`, async () => {
      const { provider, calls } = fakeEnvProviderServing([service]);
      const print = deployFingerprint({
        repo: 'r',
        env: 'production',
        digest: teardownDigest([service]),
      });
      const gated = provisionGate(provider, {
        gatedEnvs: PRODUCTION_GATED,
        ledger: ledger(new Set([print]), new Set([print])),
      });

      await requireDown(gated)({ repo: 'r', env: 'production' } as never);
      expect(calls).toHaveLength(2);
    });
  },
);

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

  it('does not confirm a dry run in one run against a confirmation recorded in another with no dry run of its own', async () => {
    // The scenario `confirmed`'s "both, not either" comment defends against:
    // a dry run folds in run-a, and — because an operator forgot `--run` or
    // named the wrong one — a confirmation for the identical fingerprint
    // folds into run-b instead, where nothing else ever recorded a dry run.
    // Cross-run `dryRunSeen` is true (run-a saw one) and a naive cross-run
    // `confirmed` reading either flag on either run's record would be true
    // too (run-b has `confirmedBy`), but neither run's own record carries
    // *both* flags, so an operator has not actually confirmed a call that
    // was ever simulated — `confirmed` must stay false and `deliver` must
    // still refuse.
    const state = stateWith([
      { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-a',
        type: 'DryRunRecorded',
        payload: { taskId: KERNEL_TASK, tool: 'deploy', fingerprint: print },
      },
      { runId: 'run-b', type: 'RunStarted', payload: { project: 'p', operator: 'macg' } },
      {
        runId: 'run-b',
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: KERNEL_TASK,
          tool: 'deploy',
          fingerprint: print,
          by: 'macg',
        },
      },
    ]);
    const gateLedger = crossRunLedger(() => state);

    expect(gateLedger.dryRunSeen(print)).toBe(true);
    expect(gateLedger.confirmed(print)).toBe(false);

    const { provider, calls } = fakeProvider();
    const gated = gate(provider, { gatedEnvs: PRODUCTION_GATED, ledger: gateLedger });
    await expect(
      gated.deliver({
        repo: target.repo,
        env: target.env,
        release: release('1.0.0'),
      } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toHaveLength(0);
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

  /**
   * T4.1.4c, end to end: a no-image `up` against an environment reporting
   * nothing proceeds once confirmed, is refused again on the next identical
   * sighting because that confirmation is spent the moment it is used, and
   * proceeds once more once an operator gives a fresh confirmation of the
   * same (unchanged) fingerprint — closing DESIGN §9 decision 14's fourth
   * review without ever making the empty-state identity unconfirmable
   * outright.
   */
  it('spends a single-use empty-state confirmation across runs, and lets a fresh confirmation of the identical fingerprint through again', async () => {
    const emptyStatePrint = deployFingerprint({
      repo: 'r',
      env: 'production',
      digest: recreateOnDefaultDigest([]),
    });
    const log = EventLog.open(MEMORY, {
      registry: kernelRegistry(),
      clock: () => '2026-01-01T00:00:00.000Z',
    });
    try {
      log.appendMany([
        {
          runId: 'run-a',
          type: 'RunStarted',
          payload: { project: 'p', operator: 'macg' },
        },
        {
          runId: 'run-a',
          type: 'DryRunRecorded',
          payload: { taskId: KERNEL_TASK, tool: 'deploy', fingerprint: emptyStatePrint },
        },
        {
          runId: 'run-a',
          type: 'DestructiveOpConfirmed',
          payload: {
            taskId: KERNEL_TASK,
            tool: 'deploy',
            fingerprint: emptyStatePrint,
            by: 'macg',
          },
        },
        {
          runId: 'run-b',
          type: 'RunStarted',
          payload: { project: 'p', operator: 'macg' },
        },
      ]);
      let state = fold(log.read());
      const options: DeployGateOptions = {
        gatedEnvs: PRODUCTION_GATED,
        ledger: crossRunLedger(() => state),
        onConfirmationSpent: (record) => {
          log.appendMany([
            {
              runId: 'run-b',
              type: 'DeployConfirmationSpent',
              payload: {
                taskId: KERNEL_TASK,
                tool: record.tool,
                fingerprint: record.fingerprint,
              },
            },
          ]);
          state = fold(log.read());
        },
      };

      // `run-b` never itself saw the dry run or confirmation — the same
      // cross-run reuse decision 11 already covers on the release path.
      const first = fakeEnvProvider(false);
      await provisionGate(first.provider, options).up({
        repo: 'r',
        env: 'production',
      } as never);
      expect(first.calls).toContain(
        `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      );

      // A later run finds the environment empty again — a later confirmed
      // teardown, or containers removed outside this gate entirely, are
      // indistinguishable from here — and computes the identical
      // fingerprint. It is refused: the confirmation above was spent.
      const second = fakeEnvProvider(false);
      await expect(
        provisionGate(second.provider, options).up({
          repo: 'r',
          env: 'production',
        } as never),
      ).rejects.toThrow(DeployGateError);
      expect(second.calls).not.toContain(
        `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      );

      // An operator gives a fresh confirmation of the same fingerprint —
      // `mpgm confirm <fingerprint> --run run-a`, the run the refusal above
      // still names as where this fingerprint's dry run was recorded
      // (`assertReady`'s own refusal message points an operator back there).
      log.appendMany([
        {
          runId: 'run-a',
          type: 'DestructiveOpConfirmed',
          payload: {
            taskId: KERNEL_TASK,
            tool: 'deploy',
            fingerprint: emptyStatePrint,
            by: 'macg',
          },
        },
      ]);
      state = fold(log.read());

      const third = fakeEnvProvider(false);
      await provisionGate(third.provider, options).up({
        repo: 'r',
        env: 'production',
      } as never);
      expect(third.calls).toContain(
        `up:${JSON.stringify({ repo: 'r', env: 'production' })}`,
      );
    } finally {
      log.close();
    }
  });

  /**
   * Decision 11's own reuse — the reason a rollback firing in a run other
   * than its deliver still finds a `{repo, env, digest}` confirmation
   * waiting — is untouched by T4.1.4c: nothing on the release path is ever
   * `singleUse`, so `assertReady` never fires `onConfirmationSpent` for it,
   * and `deliver` of the identical digest proceeds a second time on the
   * same confirmation with no fresh approval, exactly as before this task.
   */
  it('does not spend a {repo, env, digest} confirmation — deliver proceeds a second time on the same confirmation', async () => {
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
        payload: { taskId: KERNEL_TASK, tool: 'deploy', fingerprint: print, by: 'macg' },
      },
    ]);
    const { provider, calls } = fakeProvider();
    const gated = gate(provider, {
      gatedEnvs: PRODUCTION_GATED,
      ledger: crossRunLedger(() => state),
    });

    await gated.deliver({
      repo: target.repo,
      env: target.env,
      release: release('1.0.0'),
    } as never);
    await gated.deliver({
      repo: target.repo,
      env: target.env,
      release: release('1.0.0'),
    } as never);
    expect(calls).toHaveLength(2);
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
 * T4.1.4b review 2: `RECREATE_ON_DEFAULT_DIGEST`/`TEARDOWN_ENV_DIGEST` used
 * to be the whole digest, so one confirmation of "recreate on default" or
 * "tear this down" stood as a standing authorisation to do the same thing
 * again in every later run, whatever the environment happened to be serving
 * by then. `recreateOnDefaultDigest`/`teardownDigest` fold the reported
 * services in instead, so the identity itself — not just what the gate asks
 * about — depends on the current state.
 */
describe('recreateOnDefaultDigest / teardownDigest', () => {
  const service = (containerId: string): ServiceStatus => ({
    name: 'service',
    state: 'running',
    health: 'healthy',
    containerId,
  });

  it('is stable for the same reported services', () => {
    expect(recreateOnDefaultDigest([service('c1')])).toBe(
      recreateOnDefaultDigest([service('c1')]),
    );
    expect(teardownDigest([service('c1')])).toBe(teardownDigest([service('c1')]));
  });

  it('changes when the reported containerId changes — a replacement container is a different state', () => {
    expect(recreateOnDefaultDigest([service('c1')])).not.toBe(
      recreateOnDefaultDigest([service('c2')]),
    );
    expect(teardownDigest([service('c1')])).not.toBe(teardownDigest([service('c2')]));
  });

  it('distinguishes "nothing reported" from any reported service', () => {
    expect(recreateOnDefaultDigest([])).not.toBe(
      recreateOnDefaultDigest([service('c1')]),
    );
    expect(teardownDigest([])).not.toBe(teardownDigest([service('c1')]));
  });

  it('keeps "recreate on default" and "torn down" apart for the identical reported state', () => {
    expect(recreateOnDefaultDigest([service('c1')])).not.toBe(
      teardownDigest([service('c1')]),
    );
    expect(recreateOnDefaultDigest([])).not.toBe(teardownDigest([]));
  });
});
