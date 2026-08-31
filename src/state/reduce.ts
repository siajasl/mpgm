import type { StoredEvent } from '../event/envelope.js';
import { EventLogError } from '../event/errors.js';
import type { EventDefinition } from '../event/registry.js';
import type {
  budgetExceeded,
  changeMerged,
  changeReviewed,
  checksReported,
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
  runStarted,
  sessionUsage,
  taskAttested,
  taskCompleted,
  taskDispatched,
  toolCallLogged,
  validationFailed,
  voteTallied,
} from '../event/catalog.js';
import {
  emptyState,
  zeroUsage,
  type ChecksState,
  type DestructiveCallState,
  type EffectState,
  type MergeState,
  type ReviewState,
  type RunControl,
  type GateState,
  type KernelState,
  type RunState,
  type TaskState,
  type KbUpdateState,
  type PlanRevisionState,
  type Usage,
  type VoteState,
} from './kernel-state.js';

/**
 * Bumped whenever the reducer's output shape or semantics change. Snapshots
 * record it and are ignored on load when it differs: a snapshot is a cache of
 * *this* reducer's output, and silently reusing one written by a different
 * reducer would resume a run into state the current code would never produce.
 */
export const REDUCER_VERSION = 10;

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

function requireEffect(run: RunState, intentId: string, type: string): EffectState {
  const effect = run.effects[intentId];
  if (effect === undefined) {
    throw new EventLogError(`event '${type}' references unknown intent '${intentId}'`);
  }
  return effect;
}

function withEffect(run: RunState, effect: EffectState): RunState {
  return { ...run, effects: { ...run.effects, [effect.intentId]: effect } };
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
        control: 'running',
        phaseHistory: [],
        tasks: {},
        gates: {},
        votes: {},
        planRevisions: [],
        kbUpdates: [],
        effects: {},
        destructiveCalls: {},
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
        checks: null,
        review: null,
        merged: null,
        usage: zeroUsage,
      };
      return withRun(state, withTask(run, task), seq);
    }

    case 'TaskAttested': {
      const payload = event.payload as PayloadOf<typeof taskAttested>;
      const run = requireRun(state, event.runId, type);
      // An attestation cannot overwrite a task the harness actually ran. The
      // point of the distinction is that one of these is weaker evidence than
      // the other, and allowing it to land on a dispatched task would let a
      // blocked run be reported as done by asserting it.
      const already = run.tasks[payload.taskId];
      if (already !== undefined) {
        throw new EventLogError(
          `cannot attest '${payload.taskId}': this run already ran it ` +
            `(status '${already.status}')`,
        );
      }
      const task: TaskState = {
        taskId: payload.taskId,
        role: '',
        model: '',
        status: 'attested',
        artifactRefs: [],
        validationFailures: 0,
        budgetBreaches: 0,
        toolCalls: 0,
        deniedToolCalls: 0,
        checks: null,
        review: null,
        merged: null,
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
      const existing = run.gates[payload.gateId];

      // A decision already taken is a recorded fact; presenting the gate again
      // does not retract it. Overwriting the status here would silently
      // un-approve the gate on a re-run, and with it release the artifacts
      // that approval froze. Only a rejection or an ORC-6 invalidation moves
      // an approved gate.
      const decided =
        existing !== undefined &&
        (existing.status === 'approved' ||
          existing.status === 'rejected' ||
          existing.status === 'invalidated');

      // The refs are part of the decision, not decoration: an approval attaches
      // to specific artifact versions, and the freeze is derived from them.
      // Replacing them would release the approved artifacts even though the
      // status still said "approved".
      const gate: GateState = {
        gateId: payload.gateId,
        phase: payload.phase,
        status: decided ? existing.status : 'presented',
        decidedBy: decided ? existing.decidedBy : null,
        reason: decided ? existing.reason : '',
        artifactRefs: decided ? existing.artifactRefs : payload.artifactRefs,
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

    case 'VoteTallied': {
      const payload = event.payload as PayloadOf<typeof voteTallied>;
      const run = requireRun(state, event.runId, type);
      const vote: VoteState = {
        taskId: payload.taskId,
        node: payload.node,
        rule: payload.rule,
        carried: payload.carried,
        summary: payload.summary,
      };
      return withRun(
        state,
        { ...run, votes: { ...run.votes, [payload.taskId]: vote } },
        seq,
      );
    }

    case 'PlanRevised': {
      const payload = event.payload as PayloadOf<typeof planRevised>;
      const run = requireRun(state, event.runId, type);
      const revision: PlanRevisionState = {
        fromVersion: payload.fromVersion,
        toVersion: payload.toVersion,
        rationale: payload.rationale,
        deltas: payload.deltas.length,
      };
      return withRun(
        state,
        { ...run, planRevisions: [...run.planRevisions, revision] },
        seq,
      );
    }

    case 'ChecksReported': {
      const payload = event.payload as PayloadOf<typeof checksReported>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      const checks: ChecksState = {
        ref: payload.ref,
        mergeable: payload.mergeable,
        summary: payload.summary,
        blocking: payload.blocking,
      };
      return withRun(state, withTask(run, { ...task, checks }), seq);
    }

    case 'ChangeReviewed': {
      const payload = event.payload as PayloadOf<typeof changeReviewed>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      const review: ReviewState = {
        reviewTaskId: payload.reviewTaskId,
        reviewerRole: payload.reviewerRole,
        ref: payload.ref,
        approved: payload.approved,
        summary: payload.summary,
        undeclaredDeviations: payload.undeclaredDeviations,
      };
      return withRun(state, withTask(run, { ...task, review }), seq);
    }

    case 'ChangeMerged': {
      const payload = event.payload as PayloadOf<typeof changeMerged>;
      const run = requireRun(state, event.runId, type);
      const task = requireTask(run, payload.taskId, type);
      const merged: MergeState = {
        branch: payload.branch,
        into: payload.into,
        commit: payload.commit,
        reviewTaskId: payload.reviewTaskId,
      };
      return withRun(state, withTask(run, { ...task, merged }), seq);
    }

    case 'DryRunRecorded': {
      const payload = event.payload as PayloadOf<typeof dryRunRecorded>;
      const run = requireRun(state, event.runId, type);
      requireTask(run, payload.taskId, type);
      const existing = run.destructiveCalls[payload.fingerprint];
      const call: DestructiveCallState = {
        fingerprint: payload.fingerprint,
        tool: payload.tool,
        taskId: payload.taskId,
        dryRun: true,
        // A repeated dry run does not retract a confirmation already given for
        // the same call; the parameters are identical, so there is nothing new
        // for the operator to decide.
        confirmedBy: existing?.confirmedBy ?? null,
      };
      return withRun(
        state,
        {
          ...run,
          destructiveCalls: { ...run.destructiveCalls, [payload.fingerprint]: call },
        },
        seq,
      );
    }

    case 'DestructiveOpConfirmed': {
      const payload = event.payload as PayloadOf<typeof destructiveOpConfirmed>;
      const run = requireRun(state, event.runId, type);
      requireTask(run, payload.taskId, type);
      const existing = run.destructiveCalls[payload.fingerprint];
      const call: DestructiveCallState = {
        fingerprint: payload.fingerprint,
        tool: payload.tool,
        taskId: payload.taskId,
        // Confirming something never simulated leaves `dryRun` false, and the
        // guard still refuses it. An operator cannot approve their way past
        // the simulation SAF-4 asks for.
        dryRun: existing?.dryRun ?? false,
        confirmedBy: payload.by,
      };
      return withRun(
        state,
        {
          ...run,
          destructiveCalls: { ...run.destructiveCalls, [payload.fingerprint]: call },
        },
        seq,
      );
    }

    case 'KnowledgeBaseUpdated': {
      const payload = event.payload as PayloadOf<typeof knowledgeBaseUpdated>;
      const run = requireRun(state, event.runId, type);
      const update: KbUpdateState = {
        taskId: payload.taskId,
        path: payload.path,
        title: payload.title,
      };
      return withRun(state, { ...run, kbUpdates: [...run.kbUpdates, update] }, seq);
    }

    case 'RoleApproved': {
      // Recorded, and deliberately not folded. An approval is a fact about
      // the project rather than about one run — a role approved during one
      // run is still approved in the next — so the freeze reads it from the
      // log directly. Folding it into run state would make it look like a
      // property of whichever run happened to record it.
      requireRun(state, event.runId, type);
      return { ...state, lastSeq: seq };
    }

    case 'OperatorIntervened': {
      const payload = event.payload as PayloadOf<typeof operatorIntervened>;
      const run = requireRun(state, event.runId, type);
      // A killed run stays killed: resuming it would silently restart work the
      // operator stopped on purpose (HIL-3).
      const control =
        run.control === 'killed'
          ? 'killed'
          : payload.action === 'pause'
            ? 'paused'
            : payload.action === 'resume'
              ? 'running'
              : payload.action === 'kill'
                ? 'killed'
                : run.control;

      return withRun(
        state,
        { ...run, control, interventions: run.interventions + 1 },
        seq,
      );
    }

    case 'EffectIntended': {
      const payload = event.payload as PayloadOf<typeof effectIntended>;
      const run = requireRun(state, event.runId, type);
      const effect: EffectState = {
        intentId: payload.intentId,
        taskId: payload.taskId,
        contract: payload.contract,
        operation: payload.operation,
        params: payload.params,
        status: 'pending',
        detail: '',
      };
      return withRun(state, withEffect(run, effect), seq);
    }

    case 'EffectCompleted': {
      const payload = event.payload as PayloadOf<typeof effectCompleted>;
      const run = requireRun(state, event.runId, type);
      const effect = requireEffect(run, payload.intentId, type);
      return withRun(
        state,
        withEffect(run, { ...effect, status: 'completed', detail: payload.outcome }),
        seq,
      );
    }

    case 'EffectFailed': {
      const payload = event.payload as PayloadOf<typeof effectFailed>;
      const run = requireRun(state, event.runId, type);
      const effect = requireEffect(run, payload.intentId, type);
      return withRun(
        state,
        withEffect(run, { ...effect, status: 'failed', detail: payload.reason }),
        seq,
      );
    }

    case 'EffectEscalated': {
      const payload = event.payload as PayloadOf<typeof effectEscalated>;
      const run = requireRun(state, event.runId, type);
      const effect = requireEffect(run, payload.intentId, type);
      return withRun(
        state,
        withEffect(run, { ...effect, status: 'escalated', detail: payload.reason }),
        seq,
      );
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

/** Effects whose intention was recorded but whose outcome is unknown. */
export function pendingEffects(state: KernelState): EffectState[] {
  return Object.values(state.runs).flatMap((run) =>
    Object.values(run.effects).filter((effect) => effect.status === 'pending'),
  );
}

/** Operator control state for a run, defaulting to running. */
export function runControl(state: KernelState, runId: string): RunControl {
  return state.runs[runId]?.control ?? 'running';
}
