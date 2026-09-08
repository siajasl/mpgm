import type { Provider } from '../contract/capability.js';
import {
  envRequestInput,
  envStatusOutput,
  envUpInput,
  type ServiceStatus,
} from '../env/provision.js';
import { releaseDeliverInput, releaseRollbackInput } from '../release/deliver.js';
import type { DestructiveCallState, KernelState } from '../state/kernel-state.js';
import { fingerprint } from './destructive.js';

/**
 * The deploy gate — release path and environment path alike (DESIGN §9
 * decision 10/11/14, HIL-2, SAF-4).
 *
 * HIL-2 asks that irreversible, outward-facing actions require explicit
 * approval *regardless of gate settings* — a phase gate will not do, because
 * HIL-1 lets a phase gate be auto-approved, and a deploy the kernel makes
 * itself (the way it makes a merge) never passes through the `PreToolUse`
 * hook the destructive guard (`policy/destructive.ts`) relies on to see an
 * agent's tool calls. What this module reuses instead is the guard's *shape*
 * — a stable fingerprint over the call, a dry run that records intent
 * without effect, and a confirmation keyed to that exact fingerprint —
 * applied directly in front of `release.deliver#deliver`/`#rollback`
 * ({@link gateProductionRelease}) and, since T4.1.4b, in front of
 * `env.provision#up`/`#down` ({@link gateProvisionRelease}).
 *
 * **Which environments are gated is never a name this module knows.** A
 * caller reads `gatedEnvs` from the target project's own
 * `deploy/environments/environments.yaml` (`env/compose-provider.ts`'s
 * `approval: required` marker, `gatedEnvironments`) — this module refuses to
 * default or guess one, the same reasoning `env.provision` already applies
 * to an environment name it does not recognise at all (CONV-4).
 *
 * **`deliver` is gated outright:** a call naming a gated environment is
 * refused until an operator has confirmed the exact `{repo, env, digest}` it
 * names. `rollback` is not gated the same way — DESIGN §9 decision 11 —
 * because restoring a release that was itself already confirmed for that
 * environment asks nothing new of the operator; gating it again would keep a
 * bad release serving while someone is found to approve going back to a
 * release that was already approved, which is exactly the delay DEP-2's
 * automatic rollback exists to avoid. What `rollback` *is* refused is
 * restoring something that was never confirmed for this environment in the
 * first place — otherwise `rollback` would be a second, ungated door into a
 * gated environment that the `deliver` gate never sees.
 *
 * **`env.provision` is the other door to the same environment, and T4.1.4a
 * left it open.** `release.deliver#deliver`/`#rollback` delegate to
 * `env.provision#up` underneath (`../release/docker-provider.ts`), but a
 * caller reaching `env.provision#up` directly — with an `image` override,
 * bypassing `release.deliver` entirely — was not gated by anything in this
 * module until now, and neither was `env.provision#down`, which can change
 * what a gated environment serves just as surely: tearing it down and
 * letting a later no-image `up` recreate it on the compose default replaces
 * a confirmed release with an unconfirmed one in two calls, neither of which
 * named an image at all. {@link gateProvisionRelease} closes both: an
 * `up` carrying an `image` is checked under the identical fingerprint
 * `deliver` would compute for the same `{repo, env, digest}` (decision 9/11
 * — a digest is a digest, whichever contract asks to run it, so a
 * confirmation given to one satisfies the other and neither asks twice); an
 * `up` with no `image`, or a `down`, against an environment already serving
 * something is checked under a fingerprint fixed for that act alone (see
 * {@link RECREATE_ON_DEFAULT_DIGEST}, {@link TEARDOWN_ENV_DIGEST}) — neither
 * is a real digest, because neither call names one, but both are exactly as
 * capable of changing what a gated environment serves as a `deliver` is. An
 * `up`/`down` against an environment `status` reports no service at all for
 * is left untouched: there is nothing yet for either call to change (see
 * {@link gateProvisionRelease}'s own doc for the fail-closed reasoning behind
 * asking `status` first, and for why that question is "any service at all",
 * not "is everything healthy").
 */

export class DeployGateError extends Error {}

/**
 * A shared identity, not a literal contract#operation name: `deliver` and
 * `rollback` fold the same string into their fingerprint on purpose (see
 * {@link deployFingerprint}), so a confirmation of one is found by the
 * other.
 */
const DEPLOY_TOOL = 'deploy';

/**
 * Neither `release.deliver#deliver` nor `#rollback` has a field that puts a
 * call into a dry-run mode — unlike the tool calls `policy/destructive.ts`
 * guards, neither has a cheaper "describe what would happen" path, so the
 * fingerprint is taken over the whole identity. Passed through to
 * {@link fingerprint} only for parity with that module's signature; since
 * this name is never a key of either input, nothing is ever excluded by it.
 */
const DRY_RUN_PARAM = '__no_dry_run_field__';

/**
 * What one gated call targets: enough to compute its fingerprint and to
 * describe it to an operator without them reading this module (CONV-3).
 *
 * Identity is `{repo, env, digest}` alone — DESIGN §9 decision 9's own
 * reasoning applied to what this gate is actually approving: a digest is the
 * one immutable name for the image an approval releases, so a `deliver`
 * input and the `rollback` that later restores it are the same approval
 * question, whatever else differs — a changelog rewritten after the fact,
 * say. `label` is never part of the fingerprint for exactly that reason.
 */
export interface DeployTarget {
  readonly repo: string;
  readonly env: string;
  readonly digest: string;
  /**
   * A human-readable name for `digest` — a release's `version`, typically —
   * shown in messages only (CONV-3).
   */
  readonly label?: string;
}

/**
 * A stable identity for delivering `target.digest` to `target.env` — the
 * same identity whether it arrives via `release.deliver#deliver` or a
 * `#rollback` naming the same release, so an earlier confirmation of one
 * satisfies the other (DESIGN §9 decision 11).
 */
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
 * destructive tool call is what confirms a gated deploy; the gate does not
 * mint a second event vocabulary. What the gate does not reuse as-is is
 * *how* that state gets read: `stateLedger` (`policy/destructive.ts`) reads
 * one run, right for a tool call that lives inside a session, and wrong for
 * a deploy confirmation that has to outlive it. See {@link crossRunLedger}.
 */
export interface DeployLedger {
  readonly dryRunSeen: (print: string) => boolean;
  readonly confirmed: (print: string) => boolean;
}

/**
 * A {@link DeployLedger} that reads every run in {@link KernelState}, not one
 * caller-chosen run — what decision 11 actually needs.
 *
 * `stateLedger` is scoped to a single `RunState`, which is right for SAF-4's
 * ordinary destructive-tool guard: a confirmation only ever has to outlive
 * the one session an agent's tool call happened in. A gated deploy's
 * confirmation has to outlive more than that. DEP-2's automatic rollback
 * fires in whatever kernel run notices the regression, which is never
 * guaranteed to be the run that first delivered the release and got it
 * confirmed — an operator approving a digest does not stop approving it
 * because the kernel process that asked was later restarted, or a new run
 * began. `deployFingerprint` already names the same call — `{repo, env,
 * digest}` — no matter which run's ledger it is found in, so a lookup
 * scoped to one run is scoped by an accident of when the call happens to
 * arrive, not by anything HIL-2 cares about; this makes the gate consult the
 * whole log instead, so a confirmation, once given, is still there for
 * `rollback` (or a later `deliver` of the identical digest) to find in any
 * run that asks.
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
   * `gatedEnvironmentNames`/`gatedEnvironments`,
   * `deploy/environments/environments.yaml`'s `approval: required`) — never
   * a name this module defaults to. Every other `env` passes through
   * {@link gateProductionRelease} ungated — this gate exists for HIL-2's
   * approval-required case specifically, not for an environment
   * `release.deliver` already gates by declaration alone.
   *
   * Required, not optional: a caller that does not know which environments
   * its target project gates cannot gate any of them, and defaulting to
   * "none" or to a guessed name is the ambiguity CONV-4 asks a security
   * control to refuse rather than paper over.
   *
   * A function of `repo`, not a set fixed once — `repo` arrives on every
   * `deliver`/`rollback` call (`env/compose-provider.ts`'s `composeProvider`
   * reads its manifest the same way, per call, for the same reason: a
   * provider bound to one checkout at construction would let a caller name
   * one repo and silently act against another's tree, exactly what
   * `docker-provider.ts`'s own module doc says this provider refuses). A
   * `ReadonlySet` fixed at construction would tie the gated set to whichever
   * repo built it, so a single long-lived instance handed a *different*
   * repo's call would judge that call against the wrong project's manifest
   * — gating it by a name repo A happens to use, or leaving it ungated
   * because repo A's manifest never mentions it, either way not reading it
   * from the environment's own project (CONV-4). Wiring this straight to
   * `gatedEnvironments` (`../env/compose-provider.js`) — which already takes
   * `repo` and re-reads that repo's manifest — is what every caller in this
   * repository does.
   */
  readonly gatedEnvs: (repo: string) => ReadonlySet<string>;
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
 * A compact, human-readable rendering of what a provider's `status` actually
 * reported — folded into a {@link gateProvisionRelease} refusal's `label` so
 * an operator can see *why* the gate believes there is something to protect
 * (CONV-3): the answer no longer follows from `envStatusOutput.up`, so a
 * message that only said "already up" would describe a verdict this module
 * does not compute, and would leave "why did it think that" only answerable
 * by reading the code.
 */
function describeServices(services: readonly ServiceStatus[]): string {
  if (services.length === 0) {
    return 'no services reported';
  }
  return services
    .map((service) => `${service.name}:${service.state}/${service.health}`)
    .join(', ');
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
    // here, not left for the operator to guess (CONV-3): a caller that
    // wired 'onDryRunNeeded' has already recorded it by the time this
    // throws, so the next command really is 'mpgm confirm'; a caller that
    // did not wire it is told that instead of being handed instructions
    // that would fail.
    const recorded = options.onDryRunNeeded !== undefined;
    throw new DeployGateError(
      `deploying ${describe(target)} has not been simulated. This call's ` +
        `fingerprint is ${print}. ` +
        (recorded
          ? `This refusal has recorded it as a dry run, in whichever run this ` +
            `call happened under, so an operator can confirm it now with ` +
            `'mpgm confirm ${print} --by <who> --run <that run>' (HIL-2, ` +
            `SAF-4) — 'mpgm confirm' checks one run, defaulting to 'run-1' ` +
            `when '--run' is omitted, so naming the run this call actually ` +
            `ran under matters if it was not 'run-1'.`
          : `Nothing recorded it — this caller did not wire 'onDryRunNeeded' — ` +
            `so there is nothing yet for 'mpgm confirm ${print} --by <who> ` +
            `--run <that run>' to find; a 'DryRunRecorded' event for this ` +
            `fingerprint must exist in that run before it can be confirmed ` +
            `(HIL-2, SAF-4).`),
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
    throw new DeployGateError(
      `${reason} Confirm with: mpgm confirm ${print} --by <who> --run <the ` +
        `run this call's dry run was recorded under — 'run-1' only if that ` +
        `is where it actually ran>`,
    );
  }
}

/**
 * Wraps a `release.deliver` provider so its gated-environment path is
 * impossible to reach without a matching confirmation event (HIL-2, DESIGN
 * §9 decision 10).
 *
 * Every other operation, and every environment `options.gatedEnvs(repo)` does
 * not name for the `repo` the call itself names, passes straight through
 * unchanged — `assemble` never touches an environment at all, and a
 * non-gated `deliver`/`rollback` is exactly as ungated as it was before this
 * wrapper existed.
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
      if (!options.gatedEnvs(parsed.repo).has(parsed.env)) {
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
      if (!options.gatedEnvs(parsed.repo).has(parsed.env)) {
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
 * A fingerprint identity for an `env.provision#up` call that carries no
 * `image`, against an environment {@link gateProvisionRelease} finds `status`
 * reporting any service at all, whatever state or health it is in. Not a real
 * digest — no such call ever names one — but a stable identity for the one
 * question this act actually asks an operator: "may this environment be
 * recreated on whatever its compose file defaults to, replacing what it
 * currently serves?" Distinct from {@link TEARDOWN_ENV_DIGEST} so confirming
 * one never silently confirms the other, even though neither names a real
 * digest either.
 */
export const RECREATE_ON_DEFAULT_DIGEST = 'env-provision:recreate-on-default';

/**
 * A fingerprint identity for an `env.provision#down` call against an
 * environment {@link gateProvisionRelease} finds `status` reporting any
 * service at all. See {@link RECREATE_ON_DEFAULT_DIGEST} for why this is a
 * fixed sentinel rather than a digest, and why the two are kept apart.
 */
export const TEARDOWN_ENV_DIGEST = 'env-provision:teardown';

/**
 * Wraps an `env.provision` provider so `up` and `down` cannot change what a
 * gated environment serves without the same confirmation
 * {@link gateProductionRelease} requires of `release.deliver` (HIL-2, DESIGN
 * §9 decision 14).
 *
 * `env.provision` carries no notion of "production" (`contracts/env.provision.md`)
 * and never should — the same reasoning `gateProductionRelease` already
 * applies, restated here because this is the second, independent place it
 * has to hold: binding this contract unwrapped, anywhere a target project
 * might mark an environment `approval: required`, is exactly the ungated
 * route this decision closes. `env/compose-provider.ts`'s `composeProvider`
 * takes `gate` as a required constructor option and always returns the
 * result of this wrapper, the same structural guarantee
 * `dockerReleaseProvider` gives `release.deliver` (decision 10) — there is no
 * code path in this repository that produces an `env.provision` provider
 * this wrapper has not already seen.
 *
 * Three cases, all keyed off `options.gatedEnvs(repo)` exactly as
 * `gateProductionRelease` is:
 *
 * - **`up` carrying an `image`.** Gated outright, under `deployFingerprint`
 *   — the identical fingerprint a `release.deliver#deliver` of the same
 *   `{repo, env, digest}` would compute (decision 9/11's own reasoning: a
 *   digest names one build, whichever contract asks to run it, so a
 *   confirmation given through either path satisfies both and neither asks
 *   twice for the same digest).
 * - **`up` with no `image`.** Absent any image, this call can only ever
 *   replace what is running with the environment's own compose default — a
 *   question with a knowable answer *before* running it: is anything a gate
 *   would need to protect running there already? `status` is asked first.
 *   Nothing reported at all: there is nothing to replace, and standing up the
 *   declared IaC before any release exists to point it at is `env.provision`'s
 *   own reason to exist (`contracts/env.provision.md`), so the call proceeds
 *   untouched. Anything reported — refused under
 *   {@link RECREATE_ON_DEFAULT_DIGEST} until an operator confirms recreating
 *   this exact `{repo, env}` on its default.
 * - **`down`.** The same `status` question, for the same reason: tearing
 *   down infrastructure nothing is serving asks nothing of an operator, so a
 *   `down` against an environment `status` reports nothing running in at all
 *   proceeds untouched. Anything reported, it is refused under
 *   {@link TEARDOWN_ENV_DIGEST} until an operator confirms tearing this exact
 *   `{repo, env}` down — otherwise `down` followed by a no-image `up` would
 *   be a two-call way to reach the identical "recreated on the default,
 *   unconfirmed" state the case above already refuses, just split across two
 *   calls that individually look harmless: an ungated `down` leaves the
 *   environment reporting nothing, so the no-image `up` that follows would
 *   find nothing to protect and proceed too.
 *
 * **The question asked of `status` is "is anything there at all", never "is
 * it healthy".** `envStatusOutput.up` — {@link environmentUp}'s verdict —
 * fails closed for a service still `starting`, `unhealthy`, `exited` or
 * otherwise not cleanly `running`/`healthy` (`src/env/provision.ts`): exactly
 * right for "may this be trusted to serve traffic", and exactly wrong for
 * "is this environment a gate must protect", because it reads all four of
 * those states — a confirmed release mid-`start_period`, failing its
 * healthcheck, or whose container exited — as indistinguishable from an
 * environment with nothing running in it at all, which is precisely the
 * ambiguity CONV-4 asks a control to refuse rather than resolve in its own
 * favour. What decides "nothing here to protect" is the presence of any
 * reported service (`services.length > 0`), never `up`; only a provider
 * reporting no services whatsoever reads as nothing to protect.
 *
 * `status` is never gated — asking costs nothing and changes nothing
 * (`contracts/env.provision.md`).
 *
 * A provider with no `status` is refused outright, fail closed (CONV-4):
 * neither the no-image `up` case nor `down` can tell "nothing to protect yet"
 * from "this would replace a confirmed release" without asking, and assuming
 * "nothing there" for a provider that cannot answer is exactly the ambiguity
 * a security control must refuse rather than paper over. A provider with no
 * `up` has nothing here to gate at all and is refused at construction, the
 * same as `gateProductionRelease` refuses a provider missing `deliver`. A
 * provider with no `down` is left as it is — there is no operation there to
 * wrap.
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
  const status = provider.status;
  const down = provider.down;

  /**
   * Whether `env` has anything at all for a gate to protect, per the wrapped
   * provider's own `status` — the only way either the no-image `up` case or
   * `down` can tell "nothing to replace or tear down yet" from "this would
   * change what a gated environment serves" without inventing a notion of
   * "confirmed release" `env.provision` does not have.
   *
   * Answered from the presence of any reported service
   * (`current.services.length > 0`), never from `current.up`. `up` is
   * {@link environmentUp}'s verdict, and it fails closed for a service still
   * `starting`, `unhealthy`, `exited` or otherwise short of cleanly
   * `running`/healthy — exactly right for "may this be trusted to serve
   * traffic", and exactly wrong for this question: a confirmed release
   * failing its healthcheck, mid-`start_period`, or whose container exited is
   * still something a `down` or a no-image `up` would replace, and reading
   * `up: false` there as "nothing to protect" would let either reach the
   * provider with no approval — the fail-closed default `environmentUp`
   * documents becomes, read in this polarity, the gate's fail-*open* default
   * (CONV-4). Only a provider reporting no services whatsoever reads as
   * nothing to protect.
   *
   * Fails closed on the provider itself too: a provider with no `status` is
   * never assumed fresh, and `caller` names which operation is asking, with
   * the services actually found summarised in the returned `summary`, so a
   * refusal built from either can tell an operator what the gate saw without
   * their reading this module (CONV-3).
   */
  async function servingAnything(
    repo: string,
    env: string,
    caller: string,
  ): Promise<{ readonly anything: boolean; readonly summary: string }> {
    if (status === undefined) {
      throw new DeployGateError(
        `'${caller}' on '${env}' cannot be confirmed safe: the provider given ` +
          "to 'gateProvisionRelease' does not implement 'status', so whether " +
          'this environment is already serving something a gate would need ' +
          'to protect cannot be checked first (HIL-2, CONV-4).',
      );
    }
    const current = envStatusOutput.parse(await status({ repo, env } as never));
    return {
      anything: current.services.length > 0,
      summary: describeServices(current.services),
    };
  }

  return {
    ...provider,

    up: async (input: never): Promise<unknown> => {
      const parsed = envUpInput.parse(input);
      if (!options.gatedEnvs(parsed.repo).has(parsed.env)) {
        return up(input);
      }
      if (parsed.image !== undefined) {
        assertReady(
          { repo: parsed.repo, env: parsed.env, digest: parsed.image },
          options,
        );
        return up(input);
      }
      // No image: this call can only ever recreate the environment on its
      // own compose default, so whether it needs an operator's approval
      // turns on whether the provider reports anything at all there to
      // replace — asked, not assumed, and never from health (see
      // `servingAnything`'s own doc for why `up: false` is not "nothing
      // there").
      const serving = await servingAnything(parsed.repo, parsed.env, 'up with no image');
      if (!serving.anything) {
        return up(input);
      }
      assertReady(
        {
          repo: parsed.repo,
          env: parsed.env,
          digest: RECREATE_ON_DEFAULT_DIGEST,
          label: `recreate on the compose default (currently: ${serving.summary})`,
        },
        options,
      );
      return up(input);
    },

    ...(down === undefined
      ? {}
      : {
          down: async (input: never): Promise<unknown> => {
            const parsed = envRequestInput.parse(input);
            if (!options.gatedEnvs(parsed.repo).has(parsed.env)) {
              return down(input);
            }
            const serving = await servingAnything(parsed.repo, parsed.env, 'down');
            if (!serving.anything) {
              return down(input);
            }
            assertReady(
              {
                repo: parsed.repo,
                env: parsed.env,
                digest: TEARDOWN_ENV_DIGEST,
                label: `torn down (currently: ${serving.summary})`,
              },
              options,
            );
            return down(input);
          },
        }),
  };
}
