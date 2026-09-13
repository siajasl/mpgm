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
    payload: { taskId, inputTokens: 10, outputTokens: 10, costUsd },
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
      retries: 1,
      completed: 1,
      blocked: 1,
      attested: 0,
      dispatched: 0,
      successRate: 0.5,
      avgLatencyMs: 2500,
    });

    expect(Object.keys(report.byPhase).sort()).toEqual(['implement', 'review']);
    expect(report.byPhase.implement).toEqual({
      tasks: 1,
      costUsd: 0.5,
      retries: 1,
      completed: 1,
      blocked: 0,
      attested: 0,
      dispatched: 0,
      successRate: 1,
      avgLatencyMs: 3000,
    });
    expect(report.byPhase.review).toEqual({
      tasks: 1,
      costUsd: 0.25,
      retries: 0,
      completed: 0,
      blocked: 1,
      attested: 0,
      dispatched: 0,
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
});
