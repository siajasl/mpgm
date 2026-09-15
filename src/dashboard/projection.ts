import type { Artifact } from '../artifact/store.js';
import type { StoredEvent } from '../event/envelope.js';
import { computeGateRates, type RunGateRates } from '../state/gate-rates.js';
import {
  zeroUsage,
  type ChecksState,
  type DestructiveCallState,
  type EffectState,
  type GateState,
  type GateStatus,
  type KernelState,
  type MergeState,
  type ReviewState,
  type RunControl,
  type RunState,
  type TaskState,
  type TaskStatus,
  type Usage,
  type VoteState,
} from '../state/kernel-state.js';
import { computeRunMetrics, type RunMetrics } from '../state/metrics.js';
import type { Declaration } from '../trace/index-store.js';
import type { TraceIndex } from '../trace/index-store.js';
import type { TraceLink } from '../trace/links.js';

/**
 * Read-only projections over folded kernel state, for the operator dashboard
 * (DESIGN §4.4/§4.5, OBS-3).
 *
 * Every function here is a pure, JSON-serialisable view of a `KernelState`, a
 * `TraceIndex` snapshot, or — for `runProjection` alone — the run's own event
 * slice and the artifact store, which folded state cannot answer from: none
 * here reads a clock or a socket. That is what makes the HTTP layer
 * (`server.ts`) trivial and testable without one: the projection is the same
 * value whether it is inspected directly in a test or served over a request,
 * and it can show an operator nothing the event log does not already say.
 *
 * `runProjection` in particular does not compute anything of its own from
 * `RunState`. `RunState` folds cost onto each task correctly at the run
 * level but wrongly per task (`reduce.ts` zeroes `TaskState.usage` on every
 * `TaskDispatched`, so a repaired or reworked task's usage there is only its
 * last session), and folds away entirely which phase a task's dispatch fell
 * under and how long it took — neither survives the reducer because neither
 * is needed to run the harness. `computeRunMetrics` (OBS-2, T4.2.1) already
 * reads the run's own event slice a second time for exactly this, and
 * `computeGateRates` (OBS-4, T4.2.2a/b) already reads it plus the artifact
 * store for the phase-gate, merge-gate, rework and escaped-defect rates. This
 * module composes those two rather than re-deriving either, so the dashboard
 * (T4.2.6) and `mpgm status --metrics`/`--rates` (T4.2.1/2a/2b) never
 * disagree about the same run.
 */

export interface DashboardTask {
  readonly taskId: string;
  readonly role: string;
  readonly model: string;
  readonly status: TaskStatus;
  /** `status === 'blocked'` — what an operator needs to see without scanning (OBS-3). */
  readonly blocked: boolean;
  readonly checks: ChecksState | null;
  readonly review: ReviewState | null;
  readonly merged: MergeState | null;
  readonly usage: Usage;
}

export interface DashboardGate {
  readonly gateId: string;
  readonly phase: string;
  readonly status: GateStatus;
  readonly decidedBy: string | null;
  readonly reason: string;
  /** `status === 'presented'` — what awaits approval (OBS-3). */
  readonly awaitingApproval: boolean;
}

export interface DashboardRun {
  readonly runId: string;
  readonly project: string;
  readonly control: RunControl;
  readonly currentPhase: string | null;
  readonly phaseHistory: readonly string[];
  readonly usage: Usage;
  readonly interventions: number;
  readonly tasks: readonly DashboardTask[];
  readonly gates: readonly DashboardGate[];
  readonly effects: readonly EffectState[];
  readonly votes: readonly VoteState[];
  /** Destructive calls the kernel knows about, dry run or not (SAF-4, OBS-3). */
  readonly destructiveCalls: readonly DestructiveCallState[];
  /** Cost, latency, retries and success rate — per phase, per role and for
   * the run overall (OBS-2, T4.2.1/T4.2.6). Read from the run's own event
   * slice, not from `RunState` (see module doc). */
  readonly metrics: RunMetrics;
  /** Phase-gate, merge-gate, rework and escaped-defect rates (OBS-4,
   * T4.2.2a/b/T4.2.6). */
  readonly rates: RunGateRates;
}

/** One line per run — the list view an operator scans before drilling in. */
export interface DashboardSummary {
  readonly runId: string;
  readonly project: string;
  readonly control: RunControl;
  readonly currentPhase: string | null;
  readonly usage: Usage;
  readonly blockedTasks: number;
  readonly pendingApprovals: number;
}

export interface TraceGraph {
  readonly nodes: readonly Declaration[];
  readonly links: readonly TraceLink[];
}

/**
 * `usage` comes from `byTaskUsage`, the run's own event slice
 * (`computeRunMetrics(...).byTask`, keyed by `taskId`), not from
 * `task.usage`: `reduce.ts` resets a task's usage to zero on every
 * `TaskDispatched`, so `task.usage` after a repair or rework round holds
 * only that round's spend. A task with no entry (an attested task, which
 * never dispatches and so appears in no `TaskDispatched`) reports
 * `zeroUsage` rather than `task.usage`'s already-correct-by-construction
 * zero, so the two agree either way.
 */
function dashboardTask(
  task: TaskState,
  byTaskUsage: Readonly<Record<string, Usage>>,
): DashboardTask {
  return {
    taskId: task.taskId,
    role: task.role,
    model: task.model,
    status: task.status,
    blocked: task.status === 'blocked',
    checks: task.checks,
    review: task.review,
    merged: task.merged,
    usage: byTaskUsage[task.taskId] ?? zeroUsage,
  };
}

function dashboardGate(gate: GateState): DashboardGate {
  return {
    gateId: gate.gateId,
    phase: gate.phase,
    status: gate.status,
    decidedBy: gate.decidedBy,
    reason: gate.reason,
    awaitingApproval: gate.status === 'presented',
  };
}

/**
 * Everything the console needs for one run: state, approvals, spend, and the
 * per-phase/per-role/per-task metrics and quality rates T4.2.6 adds
 * (DESIGN §4.4, OBS-2, OBS-3, OBS-4).
 *
 * `events` should be the whole log, not pre-filtered to `run.runId`:
 * `computeGateRates`'s escaped-defect figure needs to see a `ChangeMerged`
 * that may belong to a different run than this one (its own doc explains
 * why), and both `computeRunMetrics` and `computeGateRates` already filter
 * to `run.runId` themselves for everything else. `defects` is every Defect
 * artifact the caller has read from the artifact store, defaulted to empty
 * for a caller with nothing to hand in.
 */
export function runProjection(
  run: RunState,
  events: readonly StoredEvent[],
  defects: readonly Artifact[] = [],
): DashboardRun {
  const metrics = computeRunMetrics(run, events);
  const byTaskUsage: Record<string, Usage> = {};
  for (const [taskId, metric] of Object.entries(metrics.byTask)) {
    byTaskUsage[taskId] = {
      costUsd: metric.costUsd,
      inputTokens: metric.inputTokens,
      outputTokens: metric.outputTokens,
    };
  }

  return {
    runId: run.runId,
    project: run.project,
    control: run.control,
    currentPhase: run.currentPhase,
    phaseHistory: run.phaseHistory,
    usage: run.usage,
    interventions: run.interventions,
    tasks: Object.values(run.tasks).map((task) => dashboardTask(task, byTaskUsage)),
    gates: Object.values(run.gates).map(dashboardGate),
    effects: Object.values(run.effects),
    votes: Object.values(run.votes),
    destructiveCalls: Object.values(run.destructiveCalls),
    metrics,
    rates: computeGateRates(run.runId, events, defects),
  };
}

/** The summary row for one run. */
export function summaryOf(run: RunState): DashboardSummary {
  return {
    runId: run.runId,
    project: run.project,
    control: run.control,
    currentPhase: run.currentPhase,
    usage: run.usage,
    blockedTasks: Object.values(run.tasks).filter((task) => task.status === 'blocked')
      .length,
    pendingApprovals: Object.values(run.gates).filter(
      (gate) => gate.status === 'presented',
    ).length,
  };
}

/** Every run the log currently knows about, one summary row each. */
export function allSummaries(state: KernelState): readonly DashboardSummary[] {
  return Object.values(state.runs).map(summaryOf);
}

/**
 * The trace graph the index currently holds (ADR-4).
 *
 * Unscoped by run on purpose: the trace index is a graph over artifacts and
 * commits, not over one run's tasks, so a per-run trace endpoint would either
 * lie about what a requirement traces to or would have to reimplement the
 * index's own queries here. `TraceIndex` already exposes narrower views
 * (`declarationsOf`, `coverage`, `downstreamOf`) for a client that wants one.
 */
export function traceGraph(index: TraceIndex): TraceGraph {
  const snapshot = index.snapshot();
  return { nodes: snapshot.nodes, links: snapshot.links };
}
