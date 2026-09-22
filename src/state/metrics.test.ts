import { describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import type { EventInput, StoredEvent } from '../event/envelope.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { computeRunMetrics } from './metrics.js';
import { fold } from './reduce.js';

const RUN = 'run-1';

/**
 * Appends `inputs` with a clock that advances one second per event, so
 * latency is computable and asserted against an exact value rather than
 * merely "not null" — every real clock in the other state tests is fixed
 * (`reduce.test.ts`), which would make every latency here zero and the
 * average-latency assertion pass whether or not the computation is right.
 */
function logWith(inputs: readonly EventInput[]): StoredEvent[] {
  let seconds = 0;
  const log = EventLog.open(MEMORY, {
    registry: kernelRegistry(),
    clock: () => {
      const ts = new Date(2026_01_01_00_00_00 + seconds * 1000).toISOString();
      seconds += 1;
      return ts;
    },
  });
  try {
    log.appendMany(inputs);
    return log.read();
  } finally {
    log.close();
  }
}

const runStarted: EventInput = {
  runId: RUN,
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'operator' },
};

function dispatched(taskId: string, role: string): EventInput {
  return {
    runId: RUN,
    type: 'TaskDispatched',
    payload: { taskId, role, model: 'claude' },
  };
}

function usage(taskId: string, costUsd: number): EventInput {
  return {
    runId: RUN,
    type: 'SessionUsage',
    payload: {
      taskId,
      inputTokens: 10,
      outputTokens: 10,
      costUsd,
      durationMs: 1000,
      apiDurationMs: 800,
    },
  };
}

function completed(taskId: string): EventInput {
  return { runId: RUN, type: 'TaskCompleted', payload: { taskId, artifactRefs: [] } };
}

function blocked(taskId: string, reason: string): EventInput {
  return { runId: RUN, type: 'TaskBlocked', payload: { taskId, reason } };
}

function validationFailed(taskId: string): EventInput {
  return {
    runId: RUN,
    type: 'ValidationFailed',
    payload: { taskId, attempt: 1, issues: ['x'] },
  };
}

describe('computeRunMetrics', () => {
  it('reports cost, latency, retries and success by phase and role', () => {
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'),
      validationFailed('T1'),
      usage('T1', 0.5),
      completed('T1'),
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'review' } },
      dispatched('T2', 'reviewer'),
      usage('T2', 0.25),
      blocked('T2', 'CI red'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.runId).toBe(RUN);
    expect(report.overall).toEqual({
      tasks: 2,
      costUsd: 0.75,
      inputTokens: 20,
      outputTokens: 20,
      retries: 1,
      completed: 1,
      blocked: 1,
      attested: 0,
      dispatched: 0,
      superseded: 0,
      successRate: 0.5,
      avgLatencyMs: 2500,
    });

    expect(Object.keys(report.byPhase).sort()).toEqual(['implement', 'review']);
    expect(report.byPhase.implement).toEqual({
      tasks: 1,
      costUsd: 0.5,
      inputTokens: 10,
      outputTokens: 10,
      retries: 1,
      completed: 1,
      blocked: 0,
      attested: 0,
      dispatched: 0,
      superseded: 0,
      successRate: 1,
      avgLatencyMs: 3000,
    });
    expect(report.byPhase.review).toEqual({
      tasks: 1,
      costUsd: 0.25,
      inputTokens: 10,
      outputTokens: 10,
      retries: 0,
      completed: 0,
      blocked: 1,
      attested: 0,
      dispatched: 0,
      superseded: 0,
      successRate: 0,
      avgLatencyMs: 2000,
    });

    expect(Object.keys(report.byRole).sort()).toEqual(['implementer', 'reviewer']);
    expect(report.byRole.implementer?.costUsd).toBe(0.5);
    expect(report.byRole.reviewer?.blocked).toBe(1);
  });

  it('a task with no terminal event yet has no latency and no success verdict', () => {
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.overall.dispatched).toBe(1);
    expect(report.overall.avgLatencyMs).toBeNull();
    expect(report.overall.successRate).toBeNull();
  });

  it('an attested task is neither a success nor a failure, and carries no cost', () => {
    const events = logWith([
      runStarted,
      {
        runId: RUN,
        type: 'TaskAttested',
        payload: {
          taskId: 'T0',
          by: 'operator',
          evidence: 'merged as abc1234',
          note: 'built before the harness could run it',
        },
      },
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.overall.attested).toBe(1);
    expect(report.overall.successRate).toBeNull();
    expect(report.byPhase['(none)']?.attested).toBe(1);
    expect(report.byRole['(attested)']?.attested).toBe(1);
  });

  it('a task blocked by a budget breach, not a TaskBlocked event, still gets a latency', () => {
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'),
      {
        runId: RUN,
        type: 'BudgetExceeded',
        payload: { taskId: 'T1', kind: 'cost', limit: 1, observed: 2 },
      },
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.overall.blocked).toBe(1);
    expect(report.overall.avgLatencyMs).toBe(1000);
  });

  // T4.2.15: `BudgetExceeded{kind: 'reviews'}` really did stop the loop, and
  // a task that then reads blocked forever misreports a run whose work is
  // on the trunk. An operator recording the hand-merge afterwards is what
  // this asserts stops counting it as a failed implementer session.
  it('counts a task an operator merged by hand as a success, not a failure', () => {
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'),
      usage('T1', 0.5),
      completed('T1'),
      {
        runId: RUN,
        type: 'BudgetExceeded',
        payload: { taskId: 'T1', kind: 'reviews', limit: 3, observed: 3 },
      },
      blocked('T1', 'the review still refuses the change'),
      {
        runId: RUN,
        type: 'ChangeMergedByOperator',
        payload: {
          taskId: 'T1',
          branch: 'mpgm/T1',
          into: 'main',
          commit: 'def5678',
          by: 'macg',
          reason: 'merged pull request #135 by hand',
          lastReviewApproved: false,
          lastReviewTaskId: 'T1-review-3',
        },
      },
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    // The harness's own outcome is unchanged: it really did give up here.
    expect(run.tasks.T1?.status).toBe('blocked');

    const report = computeRunMetrics(run, events);

    expect(report.overall.completed).toBe(1);
    expect(report.overall.blocked).toBe(0);
    expect(report.overall.successRate).toBe(1);
  });

  it('latency spans every round of a task, not just its last dispatch', () => {
    // `implement/loop.ts` re-dispatches the same taskId for a CI repair round
    // and again for a review-rework round, appending a fresh `TaskDispatched`
    // each time. Measuring from the *latest* one — the bug this fixture
    // catches — would report only the final round's duration (1000ms here);
    // measuring from the first reports the whole task's span (2000ms).
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'), // the implementing session
      dispatched('T1', 'implementer'), // a CI repair round, same taskId
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.overall.avgLatencyMs).toBe(2000);
  });

  it('retries counts re-dispatches of a taskId, not only structured-output validation failures', () => {
    // One session-internal retry (`ValidationFailed`) plus two loop-level
    // re-dispatches of the same taskId — a repair round and a rework round —
    // should both count: an operator's "retries" means both, and a task that
    // went through repair and rework rounds with no `ValidationFailed` must
    // not report 0.
    //
    // The `ValidationFailed` sits after the *last* `TaskDispatched`
    // deliberately: `reduce.ts`'s `TaskDispatched` case starts a task's
    // `validationFailures` fresh at 0 on every dispatch (each dispatch is a
    // new session with its own structured-output retry loop), so one placed
    // before a later dispatch would be reset before this reads it — a
    // pre-existing property of the fold this task does not change, and
    // orthogonal to what this test is pinning down: that re-dispatches
    // themselves are counted at all.
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'), // the implementing session
      dispatched('T1', 'implementer'), // a CI repair round
      dispatched('T1', 'implementer'), // a review-rework round
      validationFailed('T1'), // a schema retry inside the rework session
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.overall.retries).toBe(3);
  });

  it('cost and tokens sum every round of a task, not only its last dispatch', () => {
    // `reduce.ts` rebuilds `TaskState` with `usage: zeroUsage` on every
    // `TaskDispatched`, so `task.usage` after a repair round holds only that
    // round's spend. Reading `task.usage` instead of summing `SessionUsage`
    // over the run's own event slice would report this task's cost as
    // $0.25/20 tokens (the rework round alone) rather than $1.25/220 (both
    // rounds) — and would silently disagree with `run.usage`, which already
    // sums every `SessionUsage` regardless of which dispatch it followed.
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'), // the implementing session
      {
        runId: RUN,
        type: 'SessionUsage',
        payload: {
          taskId: 'T1',
          inputTokens: 200,
          outputTokens: 0,
          costUsd: 1.0,
          durationMs: 1000,
          apiDurationMs: 800,
        },
      },
      dispatched('T1', 'implementer'), // a review-rework round, same taskId
      {
        runId: RUN,
        type: 'SessionUsage',
        payload: {
          taskId: 'T1',
          inputTokens: 20,
          outputTokens: 0,
          costUsd: 0.25,
          durationMs: 1000,
          apiDurationMs: 800,
        },
      },
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.overall.costUsd).toBeCloseTo(1.25);
    expect(report.overall.inputTokens).toBe(220);
    expect(report.overall.costUsd).toBeCloseTo(run.usage.costUsd);
    expect(report.overall.inputTokens).toBe(run.usage.inputTokens);
  });

  it('byTask sums a repaired or reworked task across every round, unlike TaskState.usage', () => {
    // `run.tasks.T1.usage` after this fixture holds only the rework round's
    // $0.25 (`reduce.ts` resets it to `zeroUsage` on every `TaskDispatched`).
    // `byTask` must report the task's whole spend, $1.25, which is what a
    // dashboard's per-task column is supposed to show — this is the
    // computation `src/dashboard/render.ts` reads instead of `task.usage`.
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      dispatched('T1', 'implementer'), // the implementing session
      {
        runId: RUN,
        type: 'SessionUsage',
        payload: {
          taskId: 'T1',
          inputTokens: 200,
          outputTokens: 0,
          costUsd: 1.0,
          durationMs: 1000,
          apiDurationMs: 800,
        },
      },
      dispatched('T1', 'implementer'), // a review-rework round, same taskId
      {
        runId: RUN,
        type: 'SessionUsage',
        payload: {
          taskId: 'T1',
          inputTokens: 20,
          outputTokens: 0,
          costUsd: 0.25,
          durationMs: 1000,
          apiDurationMs: 800,
        },
      },
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.byTask.T1?.costUsd).toBeCloseTo(1.25);
    expect(run.tasks.T1?.usage.costUsd).toBeCloseTo(0.25);
  });

  it('a task dispatched after PhaseReopened is grouped under the reopened phase', () => {
    // Distinct from a `PhaseEntered` fixture: if the `PhaseReopened` case
    // were dropped from the switch, `phase` would stay at 'implement' and T1
    // would land there instead of 'review'.
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      { runId: RUN, type: 'PhaseReopened', payload: { phase: 'review' } },
      dispatched('T1', 'implementer'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(Object.keys(report.byPhase)).toEqual(['review']);
    expect(report.byPhase.review?.tasks).toBe(1);
  });

  it('an attested task takes the phase current at attestation, not (none)', () => {
    // Distinct from the earlier attested-task test, which attests with no
    // `PhaseEntered` at all and so cannot tell a working `TaskAttested` case
    // from a deleted one — both read '(none)'. Here a phase is already
    // current, so dropping the `TaskAttested` case would leave T0 in
    // '(none)' instead of 'implement'.
    const events = logWith([
      runStarted,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      {
        runId: RUN,
        type: 'TaskAttested',
        payload: {
          taskId: 'T0',
          by: 'operator',
          evidence: 'merged as abc1234',
          note: 'built before the harness could run it',
        },
      },
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const report = computeRunMetrics(run, events);

    expect(report.byPhase.implement?.attested).toBe(1);
    expect(report.byPhase['(none)']).toBeUndefined();
  });
});
