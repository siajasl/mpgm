import { z } from 'zod';
import { defineEvent, EventRegistry } from './registry.js';

/**
 * The kernel event catalog (DESIGN §5).
 *
 * Every type starts at schema version 1. Payloads are deliberately narrow:
 * schema growth is what the upcaster machinery in {@link EventRegistry} exists
 * to absorb (ADR-2), so it is cheaper to add fields with an upcaster later than
 * to speculate about them now.
 */

/**
 * A reference to an artifact in git. The log stores the reference, never the
 * content — artifacts live in git only (ADR-3, DESIGN §5).
 */
export const artifactRefSchema = z.object({
  /** Artifact id, when the reference names one the playbook declared. */
  id: z.string().min(1).optional(),
  path: z.string().min(1),
  /**
   * Commit the artifact was recorded at, or null before it has been
   * committed. Nullable rather than an empty string so "not yet in git" is
   * stated rather than encoded, and so the field cannot quietly hold a
   * placeholder that reads like a hash.
   */
  commit: z.string().min(1).nullable(),
  /** Artifact version (ART-1), when the reference names a specific one. */
  version: z.number().int().positive().optional(),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/**
 * A reference to content in the blob store (ADR-2). Large tool outputs and
 * session transcripts are offloaded there so the log stays small while replay
 * still has the full bytes available.
 */
export const blobRefSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
  size: z.number().int().nonnegative(),
});

const nonEmpty = z.string().min(1);

export const runStarted = defineEvent(
  'RunStarted',
  z.object({ project: nonEmpty, operator: nonEmpty }),
);

export const phaseEntered = defineEvent('PhaseEntered', z.object({ phase: nonEmpty }));

export const taskDispatched = defineEvent(
  'TaskDispatched',
  z.object({
    taskId: nonEmpty,
    role: nonEmpty,
    /**
     * Model resolved for this session. The model is a dispatch-time parameter
     * (DESIGN §4.2): role default, overridden by the task-class routing table.
     * Recording it here is what makes replay and eval attribution possible.
     */
    model: nonEmpty,
  }),
);

export const sessionUsage = defineEvent(
  'SessionUsage',
  z.object({
    taskId: nonEmpty,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
);

export const toolCallLogged = defineEvent(
  'ToolCallLogged',
  z.object({
    taskId: nonEmpty,
    tool: nonEmpty,
    /** Denials are logged, not just blocked (SAF-1, PLAN T1.2.4). */
    decision: z.enum(['allowed', 'denied']),
    detail: z.string().default(''),
    /**
     * Full tool output, offloaded to the blob store. Null when the output was
     * small enough to keep in `detail`.
     */
    outputBlob: blobRefSchema.nullable(),
  }),
  // v1 predates the blob store; those events carry no offloaded output.
  [(payload) => ({ ...(payload as object), outputBlob: null })],
);

export const taskCompleted = defineEvent(
  'TaskCompleted',
  z.object({ taskId: nonEmpty, artifactRefs: z.array(artifactRefSchema) }),
);

/**
 * A plan task completed outside the harness, attested by an operator.
 *
 * mpgm's own P1-M3.1 were built by operator-driven sessions before the
 * harness could run them, and the scheduler gates each milestone behind the
 * previous one's tasks — so without a record of that work the plan graph
 * offers to build what already exists. The log is the authoritative account
 * of how a project reached its current state (ADR-1), and the bootstrap is
 * part of that account.
 *
 * Distinct from {@link taskCompleted} on purpose. This says a person claims
 * the work is done and points at what shows it; that is a weaker and
 * differently-sourced fact than a task the kernel dispatched, validated and
 * merged, and folding the two together would make the difference
 * unrecoverable. `evidence` is required because an attestation nobody can
 * check is an assertion.
 */
export const taskAttested = defineEvent(
  'TaskAttested',
  z.object({
    taskId: nonEmpty,
    /** Who is making the claim. */
    by: nonEmpty,
    /** What shows the work was done: a commit, a tag, a demo, a PR. */
    evidence: nonEmpty,
    /** Why it was done outside the harness. */
    note: z.string().default(''),
  }),
);

/**
 * An operator approved a role definition by digest (AGT-6, PLAN section 1).
 *
 * The freeze manifest names who approved an exemption and why, and an agent
 * that can edit that file can write any name into it — one already wrote an
 * operator's, for a role that operator had never seen. No schema can tell a
 * person's approval from an agent's assertion of one, because both are the
 * same string in the same file.
 *
 * So the approval is kept where a task cannot write: here. A manifest
 * exemption proposes a role; this event is what makes it count.
 */
export const roleApproved = defineEvent(
  'RoleApproved',
  z.object({
    role: nonEmpty,
    /** sha256 of the role file, exactly as approved. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    by: nonEmpty,
    /** Why this definition is acceptable. */
    reason: nonEmpty,
  }),
);

export const validationFailed = defineEvent(
  'ValidationFailed',
  z.object({
    taskId: nonEmpty,
    attempt: z.number().int().positive(),
    issues: z.array(z.string()),
  }),
);

export const gatePresented = defineEvent(
  'GatePresented',
  z.object({
    gateId: nonEmpty,
    phase: nonEmpty,
    artifactRefs: z.array(artifactRefSchema),
  }),
);

export const gateApproved = defineEvent(
  'GateApproved',
  z.object({ gateId: nonEmpty, by: nonEmpty }),
);

export const gateRejected = defineEvent(
  'GateRejected',
  z.object({ gateId: nonEmpty, by: nonEmpty, reason: z.string().default('') }),
);

export const phaseReopened = defineEvent(
  'PhaseReopened',
  z.object({ phase: nonEmpty, reason: z.string().default('') }),
);

export const gateInvalidated = defineEvent(
  'GateInvalidated',
  z.object({ gateId: nonEmpty, cause: nonEmpty }),
);

export const budgetExceeded = defineEvent(
  'BudgetExceeded',
  z.object({
    taskId: nonEmpty,
    /**
     * `repairs` is the CI repair loop's bounded retry budget (T3.1.2b) and
     * `reviews` the review-rework loop's: exhausting either blocks the task
     * exactly as any other budget breach does, so a change that cannot be
     * repaired or cannot satisfy a reviewer escalates to the operator rather
     * than being quietly abandoned (NFR-1).
     */
    kind: z.enum(['tokens', 'cost', 'steps', 'wallClock', 'repairs', 'reviews']),
    limit: z.number().nonnegative(),
    observed: z.number().nonnegative(),
  }),
);

/**
 * A task stopped without finishing, and why.
 *
 * The fold had no way to record this. A task became `blocked` only through
 * {@link budgetExceeded}, so the many other ways the implement loop gives up
 * — an unusable change, a review session that died, a merge the gate refused
 * — left the log saying `dispatched`, indistinguishable from a task still
 * running. Success rates cannot be computed from a log that cannot tell a
 * failure from work in progress (OBS-4), and the log is the authority (ADR-1).
 *
 * Recorded alongside {@link budgetExceeded} rather than instead of it, when
 * the cause is a budget: that one says which limit was hit, this one says the
 * task stopped. Nothing double-counts, because what a metric counts is a task
 * left in the blocked state, not the events that put it there.
 *
 * `reason` is free text on purpose. Every place the loop gives up already
 * writes a sentence for the operator, and a category enum would mean
 * classifying thirteen call sites — thirteen chances to file a failure under
 * the wrong heading, which is worse for a metric than no heading at all.
 */
export const taskBlocked = defineEvent(
  'TaskBlocked',
  z.object({ taskId: nonEmpty, reason: nonEmpty }),
);

/**
 * Intent-before-effect (DESIGN §6).
 *
 * A side-effectful step records its intention *before* acting, so a crash
 * between the two leaves evidence. On resume each pending intent is resolved
 * through its contract rather than blindly retried — the failure mode this
 * exists to prevent is deploying, pushing or paying twice.
 */
export const effectIntended = defineEvent(
  'EffectIntended',
  z.object({
    intentId: nonEmpty,
    taskId: nonEmpty,
    /** Capability contract, e.g. `pm.github` (ADR-7). */
    contract: nonEmpty,
    operation: nonEmpty,
    params: z.record(z.string(), z.unknown()),
  }),
);

export const effectCompleted = defineEvent(
  'EffectCompleted',
  z.object({ intentId: nonEmpty, outcome: nonEmpty }),
);

export const effectFailed = defineEvent(
  'EffectFailed',
  z.object({ intentId: nonEmpty, reason: z.string().default('') }),
);

/** Resume could not determine whether the effect landed; an operator must say. */
export const effectEscalated = defineEvent(
  'EffectEscalated',
  z.object({ intentId: nonEmpty, reason: nonEmpty }),
);

/**
 * A panel's ballots, counted by the kernel (ORC-4).
 *
 * Logged rather than left to be recomputed because `TaskCompleted` does not
 * carry a task's output: without this the individual judges' votes exist only
 * in the sessions that cast them, and the panel's decision could not be
 * reconstructed from the log (ORC-3).
 */
export const voteTallied = defineEvent(
  'VoteTallied',
  z.object({
    /** The tally step. */
    taskId: nonEmpty,
    /** The panel node it counts for. */
    node: nonEmpty,
    rule: z.enum(['majority', 'unanimous', 'plurality']),
    carried: z.boolean(),
    summary: nonEmpty,
    ballots: z.array(
      z.object({
        judge: nonEmpty,
        /** Null when the judge abstained or spoiled its ballot. */
        value: z.union([z.boolean(), z.string()]).nullable(),
      }),
    ),
  }),
);

/**
 * A plan revision that was applied without an operator (PLN-4).
 *
 * Only autonomous revisions are recorded here: a revision that needs the Plan
 * gate is not applied, so there is nothing yet to record beyond the operator's
 * own decision when they take it. Logging the deltas means an autonomous
 * change is reconstructable later without diffing two artifact versions by
 * hand.
 */
export const planRevised = defineEvent(
  'PlanRevised',
  z.object({
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
    rationale: nonEmpty,
    deltas: z.array(z.object({ kind: nonEmpty, at: nonEmpty })),
  }),
);

/**
 * A task changed the knowledge base (CTX-4).
 *
 * Recorded because it is a change to the repository that no artifact version
 * captures: the knowledge base is not versioned per file, so without this the
 * log could not say which task wrote a convention or why.
 */
export const knowledgeBaseUpdated = defineEvent(
  'KnowledgeBaseUpdated',
  z.object({
    taskId: nonEmpty,
    path: nonEmpty,
    title: nonEmpty,
    rationale: nonEmpty,
  }),
);

/**
 * What CI reported for a task's change, and the merge decision taken from it
 * (IMP-2, SAF-5).
 *
 * The verdict is logged and not merely the raw check runs, because the verdict
 * is what the kernel acted on. Replay must be able to say *why* a merge was
 * refused without asking a CI provider what it thinks today — by then the
 * checks may have been re-run, or the branch deleted.
 */
export const checksReported = defineEvent(
  'ChecksReported',
  z.object({
    taskId: nonEmpty,
    /** Commit the checks belong to. */
    ref: nonEmpty,
    mergeable: z.boolean(),
    summary: nonEmpty,
    /** One line per reason the merge was refused; empty when it was not. */
    blocking: z.array(nonEmpty).default([]),
  }),
);

/**
 * An agent reviewed a change it did not write (IMP-3).
 *
 * The reviewer's role is in the payload because independence is a property of
 * the review, and it has to be checkable afterwards from the log alone — not
 * re-derived by looking up which role happened to be configured for a task id
 * whose playbook may since have changed.
 *
 * `ref` is the commit reviewed. Approval is of a state, not of a branch: a
 * change that moves on after its review has not been reviewed.
 */
export const changeReviewed = defineEvent(
  'ChangeReviewed',
  z.object({
    /** The task whose change was reviewed. */
    taskId: nonEmpty,
    /** The task that did the reviewing. */
    reviewTaskId: nonEmpty,
    reviewerRole: nonEmpty,
    ref: nonEmpty,
    approved: z.boolean(),
    summary: nonEmpty,
    findings: z.number().int().nonnegative().default(0),
    /** Convention ids the reviewer found broken (IMP-4). */
    deviations: z.array(nonEmpty).default([]),
    /**
     * Convention ids the change declared it departs from.
     *
     * Recorded because the gate's decision is a comparison of these two
     * lists, and without both an operator can only infer what the author
     * said from whether the merge was refused. Diagnosing why a declared
     * deviation failed to match then means guessing, which is exactly the
     * position a mismatch in this comparison once left one in.
     */
    declaredDeviations: z.array(nonEmpty).default([]),
    /** Of those the reviewer found, the ones no declaration covered. */
    undeclaredDeviations: z.array(nonEmpty).default([]),
  }),
);

/** A change reached the trunk, and what authorised it (IMP-1, IMP-3). */
export const changeMerged = defineEvent(
  'ChangeMerged',
  z.object({
    taskId: nonEmpty,
    branch: nonEmpty,
    into: nonEmpty,
    /** The merge commit. */
    commit: nonEmpty,
    /** Empty only for a merge no review authorised, which the kernel refuses. */
    reviewTaskId: z.string().default(''),
  }),
);

/**
 * The `taskId` a destructive-call event carries when no task made the call.
 *
 * The release-path deploy gate guards a call the kernel makes itself, so
 * there is no task to name and `requireTask` is not applied to it. Reserved:
 * it is not a plan task id and the colon keeps it from ever colliding with
 * one.
 */
export const KERNEL_TASK = 'kernel:deploy-gate';

/**
 * A destructive operation was simulated (SAF-4).
 *
 * The fingerprint covers every parameter except the dry-run flag, so a
 * confirmation is for the call that was simulated rather than for the
 * operation in general — otherwise one approved deploy would approve every
 * later one.
 *
 * `taskId` names the task whose tool call this was, or {@link KERNEL_TASK}
 * for the release-path deploy gate (`policy/deploy-gate.ts`, HIL-2), which
 * guards a call the kernel makes itself rather than a tool call inside a
 * task — the same reason `OperatorIntervened` carries no `taskId` either.
 *
 * A reserved name rather than an empty string, and still `nonEmpty`
 * (CONV-5). An empty sentinel would mean a caller that computed a task id
 * and got nothing lands silently on the kernel's own attribution: the field
 * would say "no task" for a call that has one and lost it, which is
 * precisely the ambiguity the schema is there to make unrepresentable. A
 * caller that means the kernel says so.
 */
export const dryRunRecorded = defineEvent(
  'DryRunRecorded',
  z.object({
    taskId: nonEmpty,
    tool: nonEmpty,
    fingerprint: nonEmpty,
    summary: z.string().default(''),
  }),
);

/**
 * An operator confirmed a simulated destructive call may proceed (SAF-4,
 * HIL-2). `taskId` echoes the `DryRunRecorded` it confirms (see above), and
 * is {@link KERNEL_TASK} for the same calls and the same reason.
 */
export const destructiveOpConfirmed = defineEvent(
  'DestructiveOpConfirmed',
  z.object({
    taskId: nonEmpty,
    tool: nonEmpty,
    fingerprint: nonEmpty,
    by: nonEmpty,
    reason: z.string().default(''),
  }),
);

/**
 * A single-use confirmation was spent by the call it authorised (T4.1.4c,
 * HIL-2, DEP-2, DESIGN §9 decision 14).
 *
 * `env.provision#up` (no `image`) and `#down`, gated against a `{repo, env}`
 * `status` reports no service running in at all, fold to the single fixed
 * identity `servingIdentity([])` (`'none'`, via `recreateOnDefaultDigest`/
 * `teardownDigest`, `policy/deploy-gate.ts`) — an environment reporting
 * nothing is one recurring state, not a fresh one each time it recurs, so it
 * cannot be told apart from itself by folding more of `status` into the
 * fingerprint the way every other reported state already is. Left as an
 * ordinary confirmation, one operator approval of a first bring-up would
 * silently authorise every later no-image `up` this environment is later
 * found empty for — after a confirmed teardown, or after whatever was
 * running is removed by something outside this gate entirely — with no
 * fresh approval, however different the intervening history. This event
 * closes that without minting a new identity per empty sighting (which
 * would just be the timestamp `RECREATE_ON_DEFAULT_DIGEST`/
 * `TEARDOWN_ENV_DIGEST` were deliberately kept clear of, DESIGN §9 decision
 * 14): the fingerprint stays the single recurring identity, and this event
 * records that *this* confirmation of it has now been used, so the ledger
 * that answers "is this call confirmed" stops saying yes for it until a
 * fresh `DestructiveOpConfirmed` for the same fingerprint arrives.
 *
 * `taskId` is {@link KERNEL_TASK} for the same reason `DryRunRecorded`'s and
 * `DestructiveOpConfirmed`'s are: `env.provision`'s gated calls are made by
 * the kernel itself, not by a task's tool call.
 *
 * Deliberately narrower than "every confirmation is single-use": a `{repo,
 * env, digest}` confirmation on the release path is a digest naming one
 * already-approved build, and DESIGN §9 decision 11 already lets `rollback`
 * reuse a `deliver` confirmed in an earlier run for exactly that reason — an
 * automatic rollback (DEP-2) firing in a run other than the one that
 * delivered depends on that confirmation still being there to find. Nothing
 * in this module spends one of those; only the two fixed empty-state
 * identities above ever do.
 */
export const deployConfirmationSpent = defineEvent(
  'DeployConfirmationSpent',
  z.object({
    taskId: nonEmpty,
    tool: nonEmpty,
    fingerprint: nonEmpty,
  }),
);

export const operatorIntervened = defineEvent(
  'OperatorIntervened',
  z.object({ action: nonEmpty, detail: z.string().default('') }),
);

/** Every kernel event type currently defined. */
export const kernelEvents = [
  budgetExceeded,
  changeMerged,
  changeReviewed,
  checksReported,
  deployConfirmationSpent,
  destructiveOpConfirmed,
  dryRunRecorded,
  effectCompleted,
  effectEscalated,
  effectFailed,
  effectIntended,
  gateApproved,
  gateInvalidated,
  gatePresented,
  gateRejected,
  knowledgeBaseUpdated,
  operatorIntervened,
  phaseEntered,
  phaseReopened,
  planRevised,
  roleApproved,
  runStarted,
  sessionUsage,
  taskAttested,
  taskBlocked,
  taskCompleted,
  taskDispatched,
  toolCallLogged,
  validationFailed,
  voteTallied,
];

/** Registry over the full kernel catalog. */
export function kernelRegistry(): EventRegistry {
  return new EventRegistry(kernelEvents);
}
