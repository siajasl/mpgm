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

export type TaskStatus = 'dispatched' | 'completed' | 'blocked';

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

/** Where a task's change ended up (IMP-1). */
export interface MergeState {
  readonly branch: string;
  readonly into: string;
  readonly commit: string;
  readonly reviewTaskId: string;
}

export interface TaskState {
  readonly taskId: string;
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
  readonly usage: Usage;
  readonly interventions: number;
}

export interface KernelState {
  /** Sequence number of the last event folded in. 0 for the empty state. */
  readonly lastSeq: number;
  readonly runs: Readonly<Record<string, RunState>>;
}

export const emptyState: KernelState = { lastSeq: 0, runs: {} };

export const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
