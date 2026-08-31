import type {
  ChecksState,
  EffectState,
  GateState,
  GateStatus,
  KernelState,
  MergeState,
  ReviewState,
  RunControl,
  RunState,
  TaskState,
  TaskStatus,
  Usage,
  VoteState,
} from '../state/kernel-state.js';
import type { Declaration } from '../trace/index-store.js';
import type { TraceIndex } from '../trace/index-store.js';
import type { TraceLink } from '../trace/links.js';

/**
 * Read-only projections over folded kernel state, for the operator dashboard
 * (DESIGN §4.4/§4.5, OBS-3).
 *
 * Every function here is a pure, JSON-serialisable view of a `KernelState` or
 * a `TraceIndex` snapshot — nothing here reads a clock or a socket. That is
 * what makes the HTTP layer (`server.ts`) trivial and testable without one:
 * the projection is the same value whether it is inspected directly in a
 * test or served over a request, and it can show an operator nothing the
 * event log does not already say.
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

function dashboardTask(task: TaskState): DashboardTask {
  return {
    taskId: task.taskId,
    role: task.role,
    model: task.model,
    status: task.status,
    blocked: task.status === 'blocked',
    checks: task.checks,
    review: task.review,
    merged: task.merged,
    usage: task.usage,
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

/** Everything the console needs for one run: state, approvals, spend (DESIGN §4.4). */
export function runProjection(run: RunState): DashboardRun {
  return {
    runId: run.runId,
    project: run.project,
    control: run.control,
    currentPhase: run.currentPhase,
    phaseHistory: run.phaseHistory,
    usage: run.usage,
    interventions: run.interventions,
    tasks: Object.values(run.tasks).map(dashboardTask),
    gates: Object.values(run.gates).map(dashboardGate),
    effects: Object.values(run.effects),
    votes: Object.values(run.votes),
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
