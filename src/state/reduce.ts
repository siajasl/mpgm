import type { StoredEvent } from '../event/envelope.js';
import { EventLogError } from '../event/errors.js';
import type { EventDefinition } from '../event/registry.js';
import type {
  budgetExceeded,
  gateApproved,
  gateInvalidated,
  gatePresented,
  gateRejected,
  operatorIntervened,
  phaseEntered,
  phaseReopened,
  runStarted,
  sessionUsage,
  taskCompleted,
  taskDispatched,
  toolCallLogged,
  validationFailed,
} from '../event/catalog.js';
import {
  emptyState,
  zeroUsage,
  type GateState,
  type KernelState,
  type RunState,
  type TaskState,
  type Usage,
} from './kernel-state.js';

/**
 * Bumped whenever the reducer's output shape or semantics change. Snapshots
 * record it and are ignored on load when it differs: a snapshot is a cache of
 * *this* reducer's output, and silently reusing one written by a different
 * reducer would resume a run into state the current code would never produce.
 */
export const REDUCER_VERSION = 1;

/** Payload type of an event definition. */
export type PayloadOf<D> = D extends EventDefinition<infer T> ? T : never;

/** An event arrived that the reducer has no case for. */
export class UnhandledEventError extends EventLogError {
  constructor(type: string) {
    super(
      `no reducer case for event type '${type}'. Every catalog event must be folded, ` +
        `or state silently diverges from the log.`,
    );
  }
}

/** An event referenced a run that no RunStarted event has opened. */
export class UnknownRunError extends EventLogError {
  constructor(runId: string, type: string) {
    super(`event '${type}' references unknown run '${runId}'`);
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function requireRun(state: KernelState, runId: string, type: string): RunState {
  const run = state.runs[runId];
  if (run === undefined) {
    throw new UnknownRunError(runId, type);
  }
  return run;
}

function withRun(state: KernelState, run: RunState, seq: number): KernelState {
  return { lastSeq: seq, runs: { ...state.runs, [run.runId]: run } };
}

function requireTask(run: RunState, taskId: string, type: string): TaskState {
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new EventLogError(`event '${type}' references unknown task '${taskId}'`);
  }
  return task;
}

function withTask(run: RunState, task: TaskState): RunState {
  return { ...run, tasks: { ...run.tasks, [task.taskId]: task } };
}

function requireGate(run: RunState, gateId: string, type: string): GateState {
  const gate = run.gates[gateId];
  if (gate === undefined) {
    throw new EventLogError(`event '${type}' references unknown gate '${gateId}'`);
  }
  return gate;
}

function withGate(run: RunState, gate: GateState): RunState {
  return { ...run, gates: { ...run.gates, [gate.gateId]: gate } };
}

/**
 * Fold one event into state.
 *
 * Pure: no clock, no randomness, no I/O. Replay depends on this — the same log
 * must produce the same state on every machine, forever (ORC-3).
 */
export function reduce(state: KernelState, event: StoredEvent): KernelState {
  // The read path validated this payload against the registry schema before it
  // reached the reducer, so each case narrows to its declared payload type.
  const { seq, type } = event;

  switch (type) {
    case 'RunStarted': {
      const payload = event.payload as PayloadOf<typeof runStarted>;
      const run: RunState = {
        runId: event.runId,
        project: payload.project,
        operator: payload.operator,
        startedAt: event.ts,
        currentPhase: null,
        phaseHistory: [],
        tasks: {},
        gates: {},
        usage: zeroUsage,
        interventions: 0,
      };
      return withRun(state, run, seq);
    }

    case 'PhaseEntered': {
      const payload = event.payload as PayloadOf<typeof phaseEntered>;
      const run = requireRun(state, event.runId, type);
      return withRun(
        state,
        {
          ...run,
          currentPhase: payload.phase,
          phaseHistory: [...run.phaseHistory, payload.phase],
        },
        seq,
      );
    }

    case 'PhaseReopened': {
      const payload = event.payload as PayloadOf<typeof phaseReopened>;
      const run = requireRun(state, event.runId, type);
      return withRun(
        state,
        {
          ...run,
          currentPhase: payload.phase,
          phaseHistory: [...run.phaseHistory, payload.phase],
        },
        seq,
      );
    }

    case 'TaskDispatched': {
      const payload = event.payload as PayloadOf<typeof taskDispatched>;
      const run = requireRun(state, event.runId, type);
      const task: TaskState = {
        taskId: payload.taskId,
        role: payload.role,
        model: payload.model,
        status: 'dispatched',
        artifactRefs: [],
        validationFailures: 0,
        budgetBreaches: 0,
        toolCalls: 0,
        deniedToolCalls: 0,
        usage: zeroUsage,
      };
      return withRun(state, withTask(run, task), seq);
    }

    case 'SessionUsage': {
      const payload = event.payload as PayloadOf<typeof sessionUsage>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      const delta: Usage = {
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        costUsd: payload.costUsd,
      };
      const updated = withTask(run, { ...task, usage: addUsage(task.usage, delta) });
      return withRun(state, { ...updated, usage: addUsage(run.usage, delta) }, seq);
    }

    case 'ToolCallLogged': {
      const payload = event.payload as PayloadOf<typeof toolCallLogged>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      return withRun(
        state,
        withTask(run, {
          ...task,
          toolCalls: task.toolCalls + 1,
          deniedToolCalls: task.deniedToolCalls + (payload.decision === 'denied' ? 1 : 0),
        }),
        seq,
      );
    }

    case 'TaskCompleted': {
      const payload = event.payload as PayloadOf<typeof taskCompleted>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      return withRun(
        state,
        withTask(run, {
          ...task,
          status: 'completed',
          artifactRefs: payload.artifactRefs,
        }),
        seq,
      );
    }

    case 'ValidationFailed': {
      const payload = event.payload as PayloadOf<typeof validationFailed>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      return withRun(
        state,
        withTask(run, { ...task, validationFailures: task.validationFailures + 1 }),
        seq,
      );
    }

    case 'BudgetExceeded': {
      const payload = event.payload as PayloadOf<typeof budgetExceeded>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      return withRun(
        state,
        withTask(run, {
          ...task,
          status: 'blocked',
          budgetBreaches: task.budgetBreaches + 1,
        }),
        seq,
      );
    }

    case 'GatePresented': {
      const payload = event.payload as PayloadOf<typeof gatePresented>;
      const run = requireRun(state, event.runId, type);
      const gate: GateState = {
        gateId: payload.gateId,
        phase: payload.phase,
        status: 'presented',
        decidedBy: null,
        reason: '',
        artifactRefs: payload.artifactRefs,
      };
      return withRun(state, withGate(run, gate), seq);
    }

    case 'GateApproved': {
      const payload = event.payload as PayloadOf<typeof gateApproved>;
      const run = requireRun(state, event.runId, type);
      const gate = requireGate(run, payload.gateId, type);
      return withRun(
        state,
        withGate(run, { ...gate, status: 'approved', decidedBy: payload.by }),
        seq,
      );
    }

    case 'GateRejected': {
      const payload = event.payload as PayloadOf<typeof gateRejected>;
      const run = requireRun(state, event.runId, type);
      const gate = requireGate(run, payload.gateId, type);
      return withRun(
        state,
        withGate(run, {
          ...gate,
          status: 'rejected',
          decidedBy: payload.by,
          reason: payload.reason,
        }),
        seq,
      );
    }

    case 'GateInvalidated': {
      const payload = event.payload as PayloadOf<typeof gateInvalidated>;
      const run = requireRun(state, event.runId, type);
      const gate = requireGate(run, payload.gateId, type);
      return withRun(
        state,
        withGate(run, { ...gate, status: 'invalidated', reason: payload.cause }),
        seq,
      );
    }

    case 'OperatorIntervened': {
      const payload = event.payload as PayloadOf<typeof operatorIntervened>;
      void payload;
      const run = requireRun(state, event.runId, type);
      return withRun(state, { ...run, interventions: run.interventions + 1 }, seq);
    }

    default:
      throw new UnhandledEventError(type);
  }
}

/** Fold a sequence of events, starting from `initial` (the empty state by default). */
export function fold(
  events: Iterable<StoredEvent>,
  initial: KernelState = emptyState,
): KernelState {
  let state = initial;
  for (const event of events) {
    state = reduce(state, event);
  }
  return state;
}
