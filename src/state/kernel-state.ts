import type { ArtifactRef } from '../event/catalog.js';

/**
 * Folded kernel state (DESIGN §5, "derived (rebuildable) tables").
 *
 * Everything here is derived from the event log and nothing else, so it is
 * always safe to throw away and rebuild. State is plain JSON so that a
 * snapshot is just `JSON.stringify` of this value.
 */

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * `attested` is work an operator vouched for rather than work the harness
 * ran (see `TaskAttested`). It counts as done for scheduling, and stays
 * distinguishable everywhere else — a task nobody dispatched has no session,
 * no usage and no review, and reading it as `completed` would claim
 * otherwise.
 *
 * `superseded` is a folded id the gated Plan artifact no longer declares,
 * retired by an operator's `TaskSuperseded` (T4.3.7, PLN-4) rather than left
 * on `blocked` or `dispatched` forever. Distinct from both of those it can
 * follow: unlike `blocked`, it is excluded from `successRate`'s denominator
 * (`state/metrics.ts`) rather than counted as a failure whose work is
 * nowhere; unlike `attested`, the sessions behind it ran inside the harness
 * and their cost is already in the ledger, only the id they ran under
 * stopped being the plan's.
 */
export type TaskStatus =
  'dispatched' | 'completed' | 'blocked' | 'attested' | 'superseded';

/**
 * What retired a folded task id the gated Plan artifact no longer declares
 * (T4.3.7, HIL-5). `null` until a `TaskSuperseded` lands; set once and never
 * cleared, the same discipline `merged` already keeps.
 */
export interface SupersededState {
  /** Who decided the id is retired. */
  readonly by: string;
  /** Why the id no longer appears in the gated Plan, e.g. a PLN-4 split. */
  readonly reason: string;
  /** The task ids that now carry this task's work. */
  readonly supersededBy: readonly string[];
}

/**
 * The last merge verdict CI produced for a task's change (IMP-2).
 *
 * Only the latest is kept: earlier verdicts are in the log, and what the
 * scheduler and the operator console need to know is whether this change can
 * merge *now*.
 */
export interface ChecksState {
  readonly ref: string;
  readonly mergeable: boolean;
  readonly summary: string;
  readonly blocking: readonly string[];
}

/** An independent review of a task's change (IMP-3). */
export interface ReviewState {
  readonly reviewTaskId: string;
  readonly reviewerRole: string;
  /** The commit reviewed — approval is of a state, not of a branch. */
  readonly ref: string;
  readonly approved: boolean;
  readonly summary: string;
  /** Convention ids the reviewer found broken and the author never declared. */
  readonly undeclaredDeviations: readonly string[];
}

/**
 * A destructive call the kernel knows about (SAF-4).
 *
 * Keyed by fingerprint, so the record is about one exact call rather than
 * about a capability. `confirmedBy` is null until an operator has seen what
 * the dry run did.
 */
export interface DestructiveCallState {
  readonly fingerprint: string;
  readonly tool: string;
  readonly taskId: string;
  readonly dryRun: boolean;
  readonly confirmedBy: string | null;
  /**
   * Sequence number of the `DestructiveOpConfirmed` event that set
   * `confirmedBy`, or null alongside it before one has arrived (T4.1.4c).
   *
   * What a single-use fingerprint's ledger answer needs and `confirmedBy`
   * alone cannot give it: whether *this* confirmation is more recent than
   * the last `DeployConfirmationSpent` recorded for the same fingerprint
   * (`KernelState.spentConfirmations`), which a boolean cannot express and a
   * plain "has this ever been confirmed" answers wrongly for a fingerprint
   * that was confirmed, spent, and never confirmed again.
   */
  readonly confirmedSeq: number | null;
}

/** Where a task's change ended up (IMP-1). */
export interface MergeState {
  readonly branch: string;
  readonly into: string;
  readonly commit: string;
  readonly reviewTaskId: string;
  /**
   * `''` for a kernel-authorised merge (`ChangeMerged`); the operator's name
   * for one they performed by hand and recorded afterwards
   * (`ChangeMergedByOperator`, T4.2.15) — so a reader can tell which merge
   * produced this state without going back to the log to find the event
   * type.
   */
  readonly by: string;
  /**
   * What the task's last review found at the moment an operator recorded a
   * hand-merge: `true` approved, `false` rejected, `null` no review at all.
   * Always `null` for a kernel-authorised merge, which by construction never
   * happens without an approving review (`decideMerge`) — this exists for
   * the case that is not that, so "the operator overrode a refusal" reads
   * differently from "no refusal happened" (T4.2.15, HIL-5).
   */
  readonly lastReviewApproved: boolean | null;
}

export interface TaskState {
  readonly taskId: string;
  /** Empty for an attested task: nothing ran, so no role executed it. */
  readonly role: string;
  /** Model resolved at dispatch time (DESIGN §4.2). */
  readonly model: string;
  readonly status: TaskStatus;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly validationFailures: number;
  readonly budgetBreaches: number;
  readonly toolCalls: number;
  readonly deniedToolCalls: number;
  /** Null until CI has reported on this task's change. */
  readonly checks: ChecksState | null;
  /** The latest review of this task's change, or null if none. */
  readonly review: ReviewState | null;
  /** Null until the change has been merged. */
  readonly merged: MergeState | null;
  /** Null unless the gated Plan no longer declares this id (T4.3.7). */
  readonly superseded: SupersededState | null;
  readonly usage: Usage;
}

export type GateStatus = 'presented' | 'approved' | 'rejected' | 'invalidated';

export interface GateState {
  readonly gateId: string;
  readonly phase: string;
  readonly status: GateStatus;
  /** Who decided, for the audit trail (HIL-5). Null until decided. */
  readonly decidedBy: string | null;
  readonly reason: string;
  readonly artifactRefs: readonly ArtifactRef[];
}

/**
 * A panel's counted result (ORC-4).
 *
 * Kept in folded state so `status` and the gate can read a panel's outcome
 * without re-reading every judge's session.
 */
export interface VoteState {
  /** The tally step that counted it. */
  readonly taskId: string;
  /** The panel node it belongs to. */
  readonly node: string;
  readonly rule: string;
  readonly carried: boolean;
  readonly summary: string;
}

/** A plan revision applied without an operator (PLN-4). */
export interface PlanRevisionState {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly rationale: string;
  readonly deltas: number;
}

/** A knowledge-base document a task wrote (CTX-4). */
export interface KbUpdateState {
  readonly taskId: string;
  readonly path: string;
  readonly title: string;
}

export type EffectStatus = 'pending' | 'completed' | 'failed' | 'escalated';

/**
 * A side effect whose intention was recorded before it was attempted
 * (DESIGN §6). A `pending` effect after a restart is exactly the dangerous
 * case: the kernel knows it meant to act, but not whether it did.
 */
export interface EffectState {
  readonly intentId: string;
  readonly taskId: string;
  readonly contract: string;
  readonly operation: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly status: EffectStatus;
  /** Outcome, failure reason, or escalation reason once resolved. */
  readonly detail: string;
}

/**
 * Operator control over a run (HIL-3).
 *
 * Derived from the log like everything else, so a restart resumes a paused
 * run still paused rather than charging ahead.
 */
export type RunControl = 'running' | 'paused' | 'killed';

export interface RunState {
  readonly runId: string;
  readonly project: string;
  readonly operator: string;
  readonly startedAt: string;
  readonly currentPhase: string | null;
  readonly control: RunControl;
  /** Phases in the order they were entered; a reopen appends again. */
  readonly phaseHistory: readonly string[];
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly gates: Readonly<Record<string, GateState>>;
  /** Tally step id → what the kernel counted (ORC-4). */
  readonly votes: Readonly<Record<string, VoteState>>;
  /** Autonomous plan revisions, oldest first (PLN-4). */
  readonly planRevisions: readonly PlanRevisionState[];
  /** Knowledge-base documents written by tasks, oldest first (CTX-4). */
  readonly kbUpdates: readonly KbUpdateState[];
  readonly effects: Readonly<Record<string, EffectState>>;
  /** Fingerprint → what is known about that destructive call (SAF-4). */
  readonly destructiveCalls: Readonly<Record<string, DestructiveCallState>>;
  readonly usage: Usage;
  readonly interventions: number;
  /**
   * Task id → the latest operator redirection note aimed at it (HIL-3,
   * HIL-5). Only the latest is kept, the same as `checks` and `review`
   * above: what the implement loop's next session needs is the current
   * instruction, not the history of ones it has superseded.
   */
  readonly redirects: Readonly<Record<string, string>>;
}

export interface KernelState {
  /** Sequence number of the last event folded in. 0 for the empty state. */
  readonly lastSeq: number;
  readonly runs: Readonly<Record<string, RunState>>;
  /**
   * Fingerprint → sequence number of the last `DeployConfirmationSpent`
   * recorded for it (T4.1.4c, HIL-2, DEP-2, DESIGN §9 decision 14).
   *
   * Kept outside any one `RunState` rather than folded into
   * `destructiveCalls` there, on purpose: a single-use fingerprint's
   * confirmation is spent by whichever run's call actually proceeds on it,
   * which — the same as the confirmation itself (`crossRunLedger`) — is
   * never guaranteed to be the run that recorded the original dry run or
   * confirmation. Scoping "spent" to one run's table would let a spend
   * recorded in run B leave run A's own record looking untouched, and a
   * ledger that read only one run's record would answer "still confirmed"
   * from the wrong place. This table is global for the same reason
   * `crossRunLedger` reads every run rather than one.
   */
  readonly spentConfirmations: Readonly<Record<string, number>>;
}

export const emptyState: KernelState = { lastSeq: 0, runs: {}, spentConfirmations: {} };

export const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
