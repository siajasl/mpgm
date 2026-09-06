import type { Provider } from '../contract/capability.js';
import { envUpInput } from '../env/provision.js';
import { releaseDeliverInput, releaseRollbackInput } from '../release/deliver.js';
import type { DestructiveCallState, KernelState } from '../state/kernel-state.js';
import { fingerprint } from './destructive.js';

/**
 * The production deploy gate (DESIGN §9 decision 10/11/14, HIL-2, SAF-4).
 *
 * HIL-2 asks that irreversible, outward-facing actions require explicit
 * approval *regardless of gate settings* — a phase gate will not do, because
 * HIL-1 lets a phase gate be auto-approved, and a deploy the kernel makes
 * itself (the way it makes a merge) never passes through the `PreToolUse`
 * hook the destructive guard (`policy/destructive.ts`) relies on to see an
 * agent's tool calls. What this module reuses instead is the guard's *shape*
 * — a stable fingerprint over the call, a dry run that records intent without
 * effect, and a confirmation keyed to that exact fingerprint — applied
 * directly in front of both places an image can reach a gated environment:
 * `release.deliver#deliver`/`#rollback` ({@link gateProductionRelease}), and
 * `env.provision#up` itself ({@link gateProvisionRelease}) — independent of
 * any tool call at all.
 *
 * **Which environments are gated is never a name this module knows.**
 * T4.1.4's first review found `production` hardcoded here, unreachable by a
 * target project whose own manifest calls its production environment
 * something else — silently ungated, which is exactly the CONV-4 failure a
 * security control must not have. `DeployGateOptions.gatedEnvs` is read from
 * that project's own `deploy/environments/environments.yaml` instead
 * (`env/compose-provider.ts`'s `approval: required` marker,
 * `gatedEnvironments`) — a caller builds it from the same manifest
 * `env.provision` itself refuses to guess an environment's name from, so
 * "which call needs an approval event" is answered the same way everywhere
 * it is asked, by the project being deployed, not by this module.
 *
 * **`deliver` and `up` are gated outright:** a call naming a gated
 * environment is refused until an operator has confirmed the exact
 * `{repo, env, digest}` it names. `rollback` is not gated the same way —
 * DESIGN §9 decision 11 — because restoring a release that was itself
 * already confirmed for that environment asks nothing new of the operator;
 * gating it again would keep a bad release serving while someone is found to
 * approve going back to a release that was already approved, which is
 * exactly the delay DEP-2's automatic rollback exists to avoid. What
 * `rollback` *is* refused is restoring something that was never confirmed
 * for this environment in the first place — otherwise `rollback` would be a
 * second door into production that the `deliver` gate never sees.
 *
 * **`env.provision#up` is the same door as `release.deliver`, not a second
 * one.** T4.1.4's first review also found that declaring `production` in the
 * manifest made `env.provision#up` — reachable directly, with an `image`
 * override, no confirmation anywhere in the path — an ungated deploy of an
 * arbitrary digest, one layer beneath the gate this module puts in front of
 * `release.deliver`. The defence tried then ("nothing stops an operator
 * running `docker compose up` by hand") conflated an operator's own shell
 * with a kernel capability the harness invokes programmatically; a future
 * orchestrator effect reaching `env.provision#up` directly would have found
 * no refusal at all. {@link gateProvisionRelease} closes that: it fingerprints
 * an `up` call's `{repo, env, image}` exactly the way {@link deployFingerprint}
 * fingerprints a `deliver`/`rollback`'s `{repo, env, digest}` — the same
 * confirmation satisfies both, so a release already approved through
 * `release.deliver` never has to be approved a second time when
 * `dockerReleaseProvider` hands it to `env.provision#up` underneath, but a
 * caller reaching `env.provision#up` on its own, for a digest nobody
 * approved, is refused exactly as `deliver` would refuse it.
 */

export class DeployGateError extends Error {}

/**
 * A shared identity, not a literal contract#operation name: the same string
 * is folded into a `deliver`/`rollback` call's fingerprint and an `up`
 * call's, on purpose (see {@link deployFingerprint}). Changing it would split
 * one confirmation into two the operator never agreed were different.
 */
const DEPLOY_TOOL = 'deploy';

/**
 * Neither `release.deliver#deliver`/`#rollback` nor `env.provision#up` has a
 * field that puts a call into a dry-run mode — unlike the tool calls
 * `policy/destructive.ts` guards, none of these has a cheaper "describe what
 * would happen" path, so the fingerprint is taken over the whole identity.
 * Passed through to {@link fingerprint} only for parity with that module's
 * signature; since this name is never a key of any of their inputs, nothing
 * is ever excluded by it.
 */
const DRY_RUN_PARAM = '__no_dry_run_field__';

/** What one gated call targets: enough to compute its fingerprint and to
 * describe it to an operator without them reading this module (CONV-3).
 *
 * Identity is `{repo, env, digest}` alone — DESIGN §9 decision 9's own
 * reasoning applied to what this gate is actually approving: a digest is the
 * one immutable name for the image an approval releases, so two `deliver`
 * inputs (or a `deliver` and the `rollback` that later restores it, or the
 * `up` call either one hands to `env.provision`) naming the same digest for
 * the same `{repo, env}` are the same approval question, whatever else
 * differs — a changelog rewritten after the fact, or a bare digest with no
 * release metadata attached at all (`env.provision#up`'s own input, which
 * carries no version or changelog to hash). `label` is never part of the
 * fingerprint for exactly that reason. */
export interface DeployTarget {
  readonly repo: string;
  readonly env: string;
  readonly digest: string;
  /** A human-readable name for `digest` — a release's `version`, typically —
   * shown in messages only (CONV-3). Absent where the caller has nothing but
   * the digest itself (`gateProvisionRelease`'s `up`). */
  readonly label?: string;
}

/** A stable identity for delivering `target.digest` to `target.env` — the
 * same identity whether it arrives via `release.deliver#deliver`, a
 * `#rollback` naming the same release, or `env.provision#up` handed the same
 * digest, so an earlier confirmation of any one satisfies the others
 * (DESIGN §9 decision 11/14). */
export function deployFingerprint(target: DeployTarget): string {
  return fingerprint(
    DEPLOY_TOOL,
    { repo: target.repo, env: target.env, digest: target.digest },
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
 * call — `{repo, env, digest}` — no matter which run's ledger it is found
 * in, so a lookup scoped to one run is scoped by an accident of when the
 * call happens to arrive, not by anything HIL-2 cares about; this makes the
 * gate consult the whole log instead, so a confirmation, once given, is
 * still there for `rollback` (or a later `deliver`/`up` of the identical
 * digest) to find in any run that asks.
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
  /**
   * The environments HIL-2 requires an approval event for, read from the
   * target project's own manifest (`env/compose-provider.ts`'s
   * `gatedEnvironments`, `deploy/environments/environments.yaml`'s
   * `approval: required`) — never a name this module defaults to. Every
   * other `env` passes through both {@link gateProductionRelease} and
   * {@link gateProvisionRelease} ungated — this gate exists for HIL-2's
   * approval-required case specifically, not for an environment
   * `env.provision`/`release.deliver` already gate by declaration alone.
   *
   * Required, not optional: a caller that does not know which environments
   * its target project gates cannot gate any of them, and defaulting to
   * "none" or to a guessed name is the ambiguity CONV-4 asks a security
   * control to refuse rather than paper over.
   */
  readonly gatedEnvs: ReadonlySet<string>;
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
  const id =
    target.label === undefined
      ? target.digest.slice(0, 12)
      : `${target.label} (${target.digest.slice(0, 12)})`;
  return `${id} to '${target.env}'`;
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
 * Wraps a `release.deliver` provider so its gated-environment path is
 * impossible to reach without a matching confirmation event (HIL-2, DESIGN
 * §9 decision 10).
 *
 * Every other operation, and every environment `options.gatedEnvs` does not
 * name, passes straight through unchanged — `assemble` never touches an
 * environment at all, and a non-gated `deliver`/`rollback` is exactly as
 * ungated as it was before this wrapper existed.
 */
export function gateProductionRelease(
  provider: Provider,
  options: DeployGateOptions,
): Provider {
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
      if (!options.gatedEnvs.has(parsed.env)) {
        return deliver(input);
      }
      assertReady(
        {
          repo: parsed.repo,
          env: parsed.env,
          digest: parsed.release.digest,
          label: parsed.release.version,
        },
        options,
      );
      return deliver(input);
    },

    rollback: async (input: never): Promise<unknown> => {
      const parsed = releaseRollbackInput.parse(input);
      if (!options.gatedEnvs.has(parsed.env)) {
        return rollbackOp(input);
      }
      // Deliberately the *same* fingerprint a `deliver` of `to` would have
      // produced (see `deployFingerprint`): restoring a release this
      // environment already had confirmed asks nothing new of an operator
      // (decision 11). What it must not do is let `rollback` hand a gated
      // environment a release that was never confirmed for it at all — that
      // would be a second, ungated door into the same environment `deliver`
      // refuses to open without one.
      assertReady(
        {
          repo: parsed.repo,
          env: parsed.env,
          digest: parsed.to.digest,
          label: parsed.to.version,
        },
        options,
      );
      return rollbackOp(input);
    },
  };
}

/**
 * Wraps an `env.provision` provider so an `image`-carrying `up` cannot reach
 * a gated environment without the same confirmation `gateProductionRelease`
 * requires of `release.deliver` (HIL-2, DESIGN §9 decision 14).
 *
 * This is the door T4.1.4's first review found still open: `env.provision`
 * carries no notion of "production" (`contracts/env.provision.md`) and never
 * should, but that is exactly why binding it unwrapped, anywhere a caller
 * might later hand it an image, leaves a second unguarded path to the same
 * environment `release.deliver`'s gate protects. `env.provision#up` with no
 * `image` is untouched — that is the "stand the IaC up before any release
 * exists" case `env.provision`'s own contract exists to serve, and gating it
 * would gate infrastructure nobody is asking to deploy anything onto.
 *
 * `deployFingerprint`'s identity is shared with `gateProductionRelease`, so
 * a caller that reaches this `up` only via `dockerReleaseProvider`'s already
 * -gated `deliver`/`rollback` (the one path wired into this repository)
 * never sees a second prompt: the confirmation `assertReady` found there is
 * the same fingerprint this wrapper looks up.
 */
export function gateProvisionRelease(
  provider: Provider,
  options: DeployGateOptions,
): Provider {
  const up = provider.up;
  if (up === undefined) {
    throw new DeployGateError(
      "the provider given to 'gateProvisionRelease' does not implement 'up' " +
        '— nothing here can gate an operation that is not there to gate',
    );
  }

  return {
    ...provider,

    up: async (input: never): Promise<unknown> => {
      const parsed = envUpInput.parse(input);
      if (parsed.image === undefined || !options.gatedEnvs.has(parsed.env)) {
        return up(input);
      }
      assertReady({ repo: parsed.repo, env: parsed.env, digest: parsed.image }, options);
      return up(input);
    },
  };
}
