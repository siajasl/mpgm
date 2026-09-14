import { describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import type { EventInput, StoredEvent } from '../event/envelope.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { computeGateRates, UNOBSERVABLE_MERGE_REFUSALS } from './gate-rates.js';
import { computeRunMetrics } from './metrics.js';
import { fold } from './reduce.js';

/**
 * `computeGateRates` (T4.2.2a, OBS-4).
 *
 * `EventLog.append` validates payload *shape* against the registered schema
 * but never folds a consistent `RunState` from it (`store.ts`), so these
 * fixtures append exactly the events a rate needs and nothing that would
 * make a real `implementTask` run — the same latitude `metrics.test.ts`
 * takes for the same reason.
 */

function logWith(inputs: readonly EventInput[]): StoredEvent[] {
  const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
  try {
    log.appendMany(inputs);
    return log.read();
  } finally {
    log.close();
  }
}

const runStarted = (runId: string): EventInput => ({
  runId,
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'operator' },
});

function gatePresented(runId: string, gateId: string): EventInput {
  return {
    runId,
    type: 'GatePresented',
    payload: { gateId, phase: 'plan', artifactRefs: [] },
  };
}

function gateApproved(runId: string, gateId: string): EventInput {
  return { runId, type: 'GateApproved', payload: { gateId, by: 'operator' } };
}

function gateRejected(runId: string, gateId: string): EventInput {
  return {
    runId,
    type: 'GateRejected',
    payload: { gateId, by: 'operator', reason: 'not ready' },
  };
}

function checksReported(runId: string, taskId: string, mergeable: boolean): EventInput {
  return {
    runId,
    type: 'ChecksReported',
    payload: {
      taskId,
      ref: 'abc123',
      mergeable,
      summary: mergeable ? 'green' : 'red',
      blocking: mergeable ? [] : ['test failed'],
    },
  };
}

function budgetExceeded(
  runId: string,
  taskId: string,
  kind: 'tokens' | 'cost' | 'steps' | 'wallClock' | 'repairs' | 'reviews',
): EventInput {
  return {
    runId,
    type: 'BudgetExceeded',
    payload: { taskId, kind, limit: 3, observed: 4 },
  };
}

function changeReviewed(
  runId: string,
  taskId: string,
  approved: boolean,
  undeclaredDeviations: readonly string[] = [],
): EventInput {
  return {
    runId,
    type: 'ChangeReviewed',
    payload: {
      taskId,
      reviewTaskId: `${taskId}-review`,
      reviewerRole: 'code-reviewer',
      ref: 'abc123',
      approved,
      summary: approved ? 'looks good' : 'needs work',
      findings: approved ? 0 : 1,
      deviations: undeclaredDeviations,
      declaredDeviations: [],
      undeclaredDeviations,
    },
  };
}

describe('computeGateRates — phase gate', () => {
  it('divides by gates decided, not gates presented', () => {
    const events = logWith([
      runStarted('r1'),
      gatePresented('r1', 'gate-plan'),
      gateApproved('r1', 'gate-plan'),
      gatePresented('r1', 'gate-scope'),
      gateRejected('r1', 'gate-scope'),
      // Still waiting on an operator: not a rejection that has yet to
      // happen, and must not shrink the rate by inflating the denominator.
      gatePresented('r1', 'gate-design'),
    ]);

    const rates = computeGateRates('r1', events);

    expect(rates.phaseGate.decided).toBe(2);
    expect(rates.phaseGate.rejected).toBe(1);
    expect(rates.phaseGate.rate).toBe(0.5);
  });

  it('is null when nothing has been decided yet', () => {
    const events = logWith([runStarted('r1'), gatePresented('r1', 'gate-plan')]);

    const rates = computeGateRates('r1', events);

    expect(rates.phaseGate.decided).toBe(0);
    expect(rates.phaseGate.rate).toBeNull();
  });
});

describe('computeGateRates — merge gate', () => {
  it('reconstructs refusals from ChecksReported and ChangeReviewed, and names what it cannot see', () => {
    const events = logWith([
      runStarted('r1'),
      checksReported('r1', 'T1', false), // checks-not-green
      checksReported('r1', 'T1', true),
      changeReviewed('r1', 'T1', false), // changes-requested
      changeReviewed('r1', 'T1', true), // clean approval, not a refusal
    ]);

    const rates = computeGateRates('r1', events);

    expect(rates.mergeGate.attempts).toBe(4);
    expect(rates.mergeGate.refusals).toBe(2);
    expect(rates.mergeGate.rate).toBe(0.5);
    expect(rates.mergeGate.unobservable).toEqual(UNOBSERVABLE_MERGE_REFUSALS);
    expect(rates.mergeGate.unobservable).toContain('no-review');
    expect(rates.mergeGate.unobservable).toContain('reviewer-not-independent');
  });

  it('is null when the merge gate has never been asked anything', () => {
    const events = logWith([runStarted('r1')]);

    const rates = computeGateRates('r1', events);

    expect(rates.mergeGate.attempts).toBe(0);
    expect(rates.mergeGate.rate).toBeNull();
  });

  it('counts BudgetExceeded{repairs|reviews} as budgetExhausted, without doubling refusals', () => {
    const events = logWith([
      runStarted('r1'),
      checksReported('r1', 'T1', false), // checks-not-green
      budgetExceeded('r1', 'T1', 'repairs'), // gave up after the refusal above
      changeReviewed('r1', 'T2', false), // changes-requested
      budgetExceeded('r1', 'T2', 'reviews'), // gave up after the refusal above
      // Not counted: a budget kind this reconstruction has no stake in.
      budgetExceeded('r1', 'T3', 'tokens'),
    ]);

    const rates = computeGateRates('r1', events);

    // Both refusals already came from ChecksReported/ChangeReviewed above;
    // the BudgetExceeded events that followed must not add to that count.
    expect(rates.mergeGate.attempts).toBe(2);
    expect(rates.mergeGate.refusals).toBe(2);
    expect(rates.mergeGate.budgetExhausted).toBe(2);
  });
});

describe('computeGateRates — rework, distinct from AggregateMetric.retries', () => {
  it('a task repaired for CI and never sent back by a reviewer: retries and rework differ', () => {
    // One re-dispatch (a CI repair round), no rework: the reviewer approves
    // outright, with nothing undeclared. `retries` (T4.2.1) folds the repair
    // round in; `rework` (T4.2.2a) must not, or the two numbers would be
    // reporting the same thing under different names.
    const events = logWith([
      runStarted('r1'),
      { runId: 'r1', type: 'PhaseEntered', payload: { phase: 'implement' } },
      {
        runId: 'r1',
        type: 'TaskDispatched',
        payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
      },
      checksReported('r1', 'T1', false),
      {
        // the repair round: same taskId, a fresh dispatch
        runId: 'r1',
        type: 'TaskDispatched',
        payload: { taskId: 'T1', role: 'implementer', model: 'claude' },
      },
      checksReported('r1', 'T1', true),
      changeReviewed('r1', 'T1', true),
      { runId: 'r1', type: 'TaskCompleted', payload: { taskId: 'T1', artifactRefs: [] } },
    ]);
    const run = fold(events).runs.r1;
    if (run === undefined) {
      throw new Error('fixture did not fold a run');
    }

    const metrics = computeRunMetrics(run, events);
    const rates = computeGateRates('r1', events);

    expect(metrics.overall.retries).toBe(1);
    expect(rates.rework.reviewed).toBe(1);
    expect(rates.rework.reworked).toBe(0);
    expect(rates.rework.rate).toBe(0);
    expect(rates.rework.rate).not.toBe(metrics.overall.retries);
  });

  it('an approving review that still names an undeclared deviation counts as rework', () => {
    // T4.2.4: `implement/loop.ts` sends a fresh session back on exactly this
    // shape (`earnsDeclarationRound`) — approved, but one signature short of
    // the trunk. A rate computed from `approved` alone would read this round
    // as success and report 0 here, which is the bug this pins down.
    const events = logWith([
      runStarted('r1'),
      changeReviewed('r1', 'T1', true, ['CONV-6']),
    ]);

    const rates = computeGateRates('r1', events);

    expect(rates.rework.reviewed).toBe(1);
    expect(rates.rework.reworked).toBe(1);
    expect(rates.rework.rate).toBe(1);
  });
});

describe('computeGateRates — longitudinal, per run and in order (CONV-6)', () => {
  it('three runs with deliberately different rates read three different figures', () => {
    const events = logWith([
      runStarted('r1'),
      gatePresented('r1', 'g1'),
      gateApproved('r1', 'g1'),

      runStarted('r2'),
      gatePresented('r2', 'g1'),
      gateApproved('r2', 'g1'),
      gatePresented('r2', 'g2'),
      gateRejected('r2', 'g2'),

      runStarted('r3'),
      gatePresented('r3', 'g1'),
      gateRejected('r3', 'g1'),
      gatePresented('r3', 'g2'),
      gateRejected('r3', 'g2'),
      gatePresented('r3', 'g3'),
      gateRejected('r3', 'g3'),
    ]);

    const inLogOrder = ['r1', 'r2', 'r3'].map((runId) => computeGateRates(runId, events));

    expect(inLogOrder.map((rate) => rate.phaseGate.rate)).toEqual([0, 0.5, 1]);
    // Not merely three entries: three genuinely different figures, so an
    // implementation that averaged them or emitted a constant fails here.
    expect(new Set(inLogOrder.map((rate) => rate.phaseGate.rate)).size).toBe(3);
  });
});
