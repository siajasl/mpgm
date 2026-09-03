import type { Provider } from '../contract/capability.js';
import {
  releaseDeliverInput,
  releaseRollbackInput,
  type ReleaseArtifact,
} from '../release/deliver.js';
import type { DestructiveCallState, KernelState } from '../state/kernel-state.js';
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
 * recorded. `destructiveCalls` — the folded state both `DryRunRecorded` and
 * `DestructiveOpConfirmed` write to — is the same table SAF-4's guard reads,
 * so the *same* `mpgm confirm <fingerprint>` an operator uses for a
 * destructive tool call is what confirms a production deploy; the gate does
 * not mint a second event vocabulary for deploys. What the gate does not
 * reuse as-is is *how* that state gets read: `stateLedger` reads one run,
 * right for a tool call that lives inside a session, and wrong for a
 * production confirmation that has to outlive it. See {@link crossRunLedger}.
 */
export interface DeployLedger {
  readonly dryRunSeen: (print: string) => boolean;
  readonly confirmed: (print: string) => boolean;
}

/**
 * A {@link DeployLedger} that reads every run in {@link KernelState}, not one
 * caller-chosen run — what decision 11 actually needs.
 *
 * `stateLedger` (`policy/destructive.ts`) is scoped to a single `RunState`,
 * which is right for SAF-4's ordinary destructive-tool guard: a confirmation
 * only ever has to outlive the one session an agent's tool call happened in.
 * A production deploy's confirmation has to outlive more than that. DEP-2's
 * automatic rollback fires in whatever kernel run notices the regression,
 * which is never guaranteed to be the run that first delivered the release
 * and got it confirmed — an operator approving a digest for production does
 * not stop approving it because the kernel process that asked was later
 * restarted, or a new run began. `deployFingerprint` already names the same
 * call — `{repo, env, release}` — no matter which run's ledger it is found
 * in, so a lookup scoped to one run is scoped by an accident of when the
 * call happens to arrive, not by anything HIL-2 cares about; this makes the
 * gate consult the whole log instead, so a confirmation, once given, is
 * still there for `rollback` (or a later `deliver` of the identical digest)
 * to find in any run that asks.
 */
export function crossRunLedger(state: () => KernelState): DeployLedger {
  const calls = (print: string): readonly DestructiveCallState[] =>
    Object.values(state().runs)
      .map((run) => run.destructiveCalls[print])
      .filter((call): call is DestructiveCallState => call !== undefined);

  return {
    dryRunSeen: (print) => calls(print).some((call) => call.dryRun),
    confirmed: (print) =>
      // Both, not either, on some run's record of it — the same rule
      // `stateLedger` applies within one run: an operator cannot approve
      // their way past a simulation SAF-4/HIL-2 both require to have
      // actually happened somewhere.
      calls(print).some((call) => call.dryRun && call.confirmedBy !== null),
  };
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
    // Whether this refusal itself made the fingerprint confirmable is known
    // here, not left for the operator to guess (CONV-3): a caller that wired
    // 'onDryRunNeeded' — `mpgm rollback` does, since T4.1.4 — has already
    // recorded it by the time this throws, so the next command really is
    // 'mpgm confirm'; a caller that did not wire it is told that instead of
    // being handed instructions that would fail.
    const recorded = options.onDryRunNeeded !== undefined;
    throw new DeployGateError(
      `deploying ${describe(target)} has not been simulated. This call's ` +
        `fingerprint is ${print}. ` +
        (recorded
          ? `This refusal has recorded it as a dry run for this run, so an ` +
            `operator can confirm it now with 'mpgm confirm ${print} --by ` +
            `<who>' (HIL-2, SAF-4).`
          : `Nothing recorded it — this caller did not wire 'onDryRunNeeded' — ` +
            `so there is nothing yet for 'mpgm confirm ${print} --by <who>' to ` +
            `find; a 'DryRunRecorded' event for this fingerprint must exist in ` +
            `this run before it can be confirmed (HIL-2, SAF-4).`),
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
