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

export interface RunState {
  readonly runId: string;
  readonly project: string;
  readonly operator: string;
  readonly startedAt: string;
  readonly currentPhase: string | null;
  /** Phases in the order they were entered; a reopen appends again. */
  readonly phaseHistory: readonly string[];
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly gates: Readonly<Record<string, GateState>>;
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
