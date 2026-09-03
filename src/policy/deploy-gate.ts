import type { Provider } from '../contract/capability.js';
import {
  releaseDeliverInput,
  releaseRollbackInput,
  type ReleaseArtifact,
} from '../release/deliver.js';
import { fingerprint } from './destructive.js';

/**
 * The production deploy gate (DESIGN §9 decision 10/11, HIL-2, SAF-4).
 *
 * HIL-2 asks that irreversible, outward-facing actions require explicit
 * approval *regardless of gate settings* — a phase gate will not do, because
 * HIL-1 lets a phase gate be auto-approved, and a deploy the kernel makes
 * itself (the way it makes a merge) never passes through the `PreToolUse`
 * hook the destructive guard (`policy/destructive.ts`) relies on to see an
 * agent's tool calls. What this module reuses instead is the guard's *shape*
 * — a stable fingerprint over the call, a dry run that records intent without
 * effect, and a confirmation keyed to that exact fingerprint — applied
 * directly in front of `release.deliver#deliver`/`#rollback`, independent of
 * any tool call at all.
 *
 * `deliver` is gated outright: a call naming the production environment is
 * refused until an operator has confirmed the exact `{repo, env, release}`
 * it names. `rollback` is not gated the same way — DESIGN §9 decision 11 —
 * because restoring a release that was itself already confirmed for
 * production asks nothing new of the operator; gating it again would keep a
 * bad release serving while someone is found to approve going back to a
 * release that was already approved, which is exactly the delay DEP-2's
 * automatic rollback exists to avoid. What `rollback` *is* refused is
 * restoring something that was never confirmed for this environment in the
 * first place — otherwise `rollback` would be a second door into production
 * that the `deliver` gate never sees, and "impossible without an approval
 * event" would only be true of one of the two ways to change what production
 * runs.
 */

export class DeployGateError extends Error {}

/** `release.deliver`'s production path, named once so every message and every
 * fingerprint agree on what call is being gated. */
const DEPLOY_TOOL = 'release.deliver#deliver';

/**
 * There is no field on {@link ReleaseDeliverInput} that puts a delivery into a
 * dry-run mode — unlike the tool calls `policy/destructive.ts` guards,
 * `release.deliver#deliver` has no cheaper "describe what would happen"
 * path, so the fingerprint is taken over the whole input. Passed through to
 * {@link fingerprint} only for parity with that module's signature; since this
 * name is never a key of `ReleaseDeliverInput`, nothing is ever excluded by
 * it.
 */
const DRY_RUN_PARAM = '__no_dry_run_field__';

export const DEFAULT_PRODUCTION_ENV = 'production';

/** What one gated call targets: enough to compute its fingerprint and to
 * describe it to an operator without them reading this module (CONV-3). */
export interface DeployTarget {
  readonly repo: string;
  readonly env: string;
  readonly release: ReleaseArtifact;
}

/** A stable identity for delivering `target.release` to `target.env` — the
 * same identity whether it arrives via `deliver` or via a `rollback` naming
 * the same release, so an earlier confirmation of one satisfies the other
 * (DESIGN §9 decision 11). */
export function deployFingerprint(target: DeployTarget): string {
  return fingerprint(
    DEPLOY_TOOL,
    { repo: target.repo, env: target.env, release: target.release },
    DRY_RUN_PARAM,
  );
}

/**
 * The two predicates the gate needs, read from wherever confirmations are
 * recorded. `stateLedger` in `policy/destructive.ts` already reads both from
 * folded kernel state and satisfies this shape exactly — the gate does not
 * mint a second ledger for deploys, it reuses the one SAF-4 already has, so
 * the *same* `mpgm confirm <fingerprint>` an operator uses for a destructive
 * tool call is what confirms a production deploy.
 */
export interface DeployLedger {
  readonly dryRunSeen: (print: string) => boolean;
  readonly confirmed: (print: string) => boolean;
}

export interface DryRunNeeded {
  readonly tool: string;
  readonly fingerprint: string;
  readonly target: DeployTarget;
}

export interface ConfirmationNeeded {
  readonly tool: string;
  readonly fingerprint: string;
  readonly target: DeployTarget;
  readonly reason: string;
}

export interface DeployGateOptions {
  /** Defaults to {@link DEFAULT_PRODUCTION_ENV}. Every other `env` passes
   * through both operations ungated — this gate exists for HIL-2's
   * production case specifically, not for staging or test deliveries
   * `env.provision` and `release.deliver` already gate by declaration alone
   * (`deploy/environments/environments.yaml`). */
  readonly productionEnv?: string;
  readonly ledger: DeployLedger;
  /**
   * A call was refused for want of a dry run. The gate itself performs no
   * side effect and records nothing — it has no log to write to — so a
   * caller that wants the refused fingerprint to become confirmable wires
   * this to actually record the intent (e.g. a `DryRunRecorded` event); a
   * caller that does not is choosing an operator has to reproduce the
   * fingerprint by hand, which the error message alone would still make
   * possible, just less convenient (CONV-3).
   */
  readonly onDryRunNeeded?: (record: DryRunNeeded) => void;
  /** A call was refused for want of a confirmation, after a dry run. */
  readonly onConfirmationNeeded?: (record: ConfirmationNeeded) => void;
}

function describe(target: DeployTarget): string {
  return (
    `${target.release.version} (${target.release.digest.slice(0, 12)}) to ` +
    `'${target.env}'`
  );
}

/**
 * Refuses `target` unless it has been recorded and confirmed. Fails closed
 * (CONV-4): an unrecognised or absent ledger answer refuses the call, never
 * allows it.
 */
function assertReady(target: DeployTarget, options: DeployGateOptions): void {
  const print = deployFingerprint(target);

  if (!options.ledger.dryRunSeen(print)) {
    options.onDryRunNeeded?.({ tool: DEPLOY_TOOL, fingerprint: print, target });
    throw new DeployGateError(
      `deploying ${describe(target)} has not been simulated. This call's ` +
        `fingerprint is ${print} — record it (as a 'DryRunRecorded' event for ` +
        `this run) and an operator can then confirm it with 'mpgm confirm ` +
        `${print} --by <who>' (HIL-2, SAF-4). Whether this refusal recorded it ` +
        `for you depends on how the caller wired 'onDryRunNeeded' — this ` +
        `message gives you the fingerprint either way, so nothing here has to ` +
        `be reproduced by hand.`,
    );
  }

  if (!options.ledger.confirmed(print)) {
    const reason =
      `deploying ${describe(target)} has been simulated but not confirmed. ` +
      `An operator decides whether this exact call may proceed (HIL-2, SAF-4).`;
    options.onConfirmationNeeded?.({
      tool: DEPLOY_TOOL,
      fingerprint: print,
      target,
      reason,
    });
    throw new DeployGateError(`${reason} Confirm with: mpgm confirm ${print} --by <who>`);
  }
}

/**
 * Wraps a `release.deliver` provider so its production path is impossible to
 * reach without a matching confirmation event (HIL-2, DESIGN §9 decision 10).
 *
 * Every other operation, and every other environment, passes straight
 * through unchanged — `assemble` never touches an environment at all, and a
 * non-production `deliver`/`rollback` is exactly as ungated as it was before
 * this wrapper existed.
 */
export function gateProductionRelease(
  provider: Provider,
  options: DeployGateOptions,
): Provider {
  const productionEnv = options.productionEnv ?? DEFAULT_PRODUCTION_ENV;

  // Read once, and checked here rather than trusted at every call: `Provider`
  // is a bare `Record`, so nothing before `BoundContract`'s own construction
  // check otherwise guarantees these exist. Wrapping a provider that does not
  // implement one is refused now, not the first time an operator's confirm
  // finally reaches a call that was never callable (CONV-4).
  const deliver = provider.deliver;
  const rollbackOp = provider.rollback;
  if (deliver === undefined || rollbackOp === undefined) {
    throw new DeployGateError(
      "the provider given to 'gateProductionRelease' does not implement both " +
        "'deliver' and 'rollback' — nothing here can gate an operation that " +
        'is not there to gate',
    );
  }

  return {
    ...provider,

    deliver: async (input: never): Promise<unknown> => {
      const parsed = releaseDeliverInput.parse(input);
      if (parsed.env !== productionEnv) {
        return deliver(input);
      }
      assertReady(
        { repo: parsed.repo, env: parsed.env, release: parsed.release },
        options,
      );
      return deliver(input);
    },

    rollback: async (input: never): Promise<unknown> => {
      const parsed = releaseRollbackInput.parse(input);
      if (parsed.env !== productionEnv) {
        return rollbackOp(input);
      }
      // Deliberately the *same* fingerprint a `deliver` of `to` would have
      // produced (see `deployFingerprint`): restoring a release this
      // environment already had confirmed asks nothing new of an operator
      // (decision 11). What it must not do is let `rollback` hand production
      // a release that was never confirmed for it at all — that would be a
      // second, ungated door into the same environment `deliver` refuses to
      // open without one.
      assertReady({ repo: parsed.repo, env: parsed.env, release: parsed.to }, options);
      return rollbackOp(input);
    },
  };
}
