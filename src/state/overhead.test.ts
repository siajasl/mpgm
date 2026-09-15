import { describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import type { EventInput, StoredEvent } from '../event/envelope.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { computeHarnessOverhead, NFR3_UNOBSERVABLE_SPANS } from './overhead.js';
import { fold } from './reduce.js';

/**
 * `computeHarnessOverhead` (T4.2.9, NFR-3, OBS-2).
 *
 * A fixed clock, one second per event, the same discipline `metrics.test.ts`
 * uses and for the same reason: real millisecond figures below have to be
 * exact, not merely non-null, and a wall clock would make an interval-merge
 * assertion flaky by however long the append itself happens to take.
 */

const RUN = 'run-1';
const BASE = 2026_01_01_00_00_00;

function logWith(inputs: readonly EventInput[]): StoredEvent[] {
  let seconds = 0;
  const log = EventLog.open(MEMORY, {
    registry: kernelRegistry(),
    clock: () => {
      const ts = new Date(BASE + seconds * 1000).toISOString();
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

function runStarted(runId: string = RUN): EventInput {
  return {
    runId,
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'operator' },
  };
}

function dispatched(taskId: string, runId: string = RUN): EventInput {
  return {
    runId,
    type: 'TaskDispatched',
    payload: { taskId, role: 'implementer', model: 'claude' },
  };
}

function completed(taskId: string, runId: string = RUN): EventInput {
  return { runId, type: 'TaskCompleted', payload: { taskId, artifactRefs: [] } };
}

function contextAssembled(
  taskId: string,
  durationMs: number,
  site: 'phase' | 'implement' = 'phase',
  runId: string = RUN,
): EventInput {
  return { runId, type: 'ContextAssembled', payload: { taskId, site, durationMs } };
}

function sessionUsage(
  taskId: string,
  durationMs: number | null,
  apiDurationMs: number | null,
  runId: string = RUN,
): EventInput {
  return {
    runId,
    type: 'SessionUsage',
    payload: {
      taskId,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      durationMs,
      apiDurationMs,
    },
  };
}

describe('computeHarnessOverhead — the numerator formula', () => {
  it('sums context-assembly duration and in-session overhead (duration minus api-duration), and names what it cannot see', () => {
    const events = logWith([
      runStarted(),
      dispatched('T1'),
      contextAssembled('T1', 50, 'phase'),
      sessionUsage('T1', 500, 300),
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // 50ms context assembly + (500 - 300)ms in-session overhead = 250ms.
    expect(overhead.overheadMs).toBe(250);
    expect(overhead.components).toEqual({
      contextAssemblyMs: 50,
      contextAssemblyCount: 1,
      sessionOverheadMs: 200,
      sessionsWithDuration: 1,
    });
    // NFR-3's other two named spans: nothing here ever brackets either.
    expect(overhead.unmeasured).toEqual(['scheduling', 'validation']);
    expect(overhead.unmeasured).toBe(NFR3_UNOBSERVABLE_SPANS);
  });

  it('does not let a session that overran ever contribute a negative in-session component', () => {
    // `apiDurationMs` should never exceed `durationMs`, but the formula
    // floors at 0 rather than trusting that and reporting overhead a
    // session's own harness work could not actually have been negative.
    const events = logWith([
      runStarted(),
      dispatched('T1'),
      sessionUsage('T1', 100, 150),
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.components.sessionOverheadMs).toBe(0);
  });
});

describe('computeHarnessOverhead — the denominator is a merged busy span, not a sum', () => {
  it('merges two overlapping task intervals into one window rather than summing their spans', () => {
    // T1 dispatched then T2 dispatched before T1 finishes (runPhase's own
    // concurrency), each a 2-second span, overlapping by 1 second.
    const events = logWith([
      runStarted(), // seconds 0
      dispatched('T1'), // seconds 1
      dispatched('T2'), // seconds 2
      completed('T1'), // seconds 3 -> T1 span [1s, 3s]
      completed('T2'), // seconds 4 -> T2 span [2s, 4s]
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // Union of [1000,3000] and [2000,4000] is [1000,4000]: 3000ms, not the
    // 4000ms a naive sum of the two 2000ms spans would report.
    expect(overhead.observedMs).toBe(3000);
  });

  it('is a stated idle-gap rule, and the figure moves when the rule does', () => {
    // T1 settles at [1s,3s]... [4s? wait: seconds increment on every event.
    // T1: dispatched@1s, completed@2s -> [1000,2000] (1000ms span).
    // T2: dispatched much later, at 6s, completed@7s -> [6000,7000].
    // Gap between the two windows is 6000 - 2000 = 4000ms.
    const events = logWith([
      runStarted(), // 0s
      dispatched('T1'), // 1s
      completed('T1'), // 2s
      dispatched('filler-a'), // 3s — never settles, contributes no interval
      dispatched('filler-b'), // 4s — never settles either
      dispatched('T2'), // 5s
      completed('T2'), // 6s
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    // Default idle rule (0ms): the 3000ms gap between T1's window ending at
    // 2000ms and T2's starting at 5000ms is idle time, excluded — two
    // separate windows, summing to 1000 + 1000 = 2000ms.
    const strict = computeHarnessOverhead(run, events);
    expect(strict.observedMs).toBe(2000);

    // A caller stating a wider idle rule — short gaps between dispatches
    // count as the same busy period — bridges that gap instead, merging the
    // two windows into one [1000,6000]: 5000ms, not 2000ms. Same events,
    // same code, a different answer, because the rule changed and the events
    // did not.
    const lenient = computeHarnessOverhead(run, events, { idleGapMs: 3000 });
    expect(lenient.observedMs).toBe(5000);
    expect(lenient.observedMs).not.toBe(strict.observedMs);
  });
});

describe('computeHarnessOverhead — null discipline (CONV-6)', () => {
  it('reads a session with no recorded duration as unmeasured, not 0%', () => {
    // A pre-T4.2.8 log, replayed: `SessionUsage` exists but both durations
    // upcast to null, and no `ContextAssembled` event exists either, because
    // that instrumentation is this task's own.
    const events = logWith([
      runStarted(),
      dispatched('T1'),
      sessionUsage('T1', null, null),
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.overheadMs).toBeNull();
    // The denominator is still measurable — the task did settle — so a
    // reader can see this is "nothing observed" and not "no data at all".
    expect(overhead.observedMs).toBe(2000);
    expect(overhead.ratio).toBeNull();
  });

  it('reads a run with no settled task as unmeasured, even with overhead recorded', () => {
    const events = logWith([
      runStarted(),
      dispatched('T1'),
      contextAssembled('T1', 20),
      sessionUsage('T1', 500, 300),
      // No TaskCompleted/TaskBlocked: still in flight.
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.overheadMs).toBe(220);
    expect(overhead.observedMs).toBeNull();
    expect(overhead.ratio).toBeNull();
  });
});

describe('computeHarnessOverhead — two runs at different ratios read differently', () => {
  it('does not report the same figure for a lean run and an overhead-heavy one', () => {
    const lean = logWith([
      runStarted('lean'),
      dispatched('T1', 'lean'),
      contextAssembled('T1', 10, 'phase', 'lean'),
      sessionUsage('T1', 1000, 990, 'lean'),
      completed('T1', 'lean'),
    ]);
    const leanRun = fold(lean).runs.lean;
    if (leanRun === undefined) throw new Error('run not folded');
    const leanOverhead = computeHarnessOverhead(leanRun, lean);

    const heavy = logWith([
      runStarted('heavy'),
      dispatched('T1', 'heavy'),
      contextAssembled('T1', 400, 'implement', 'heavy'),
      sessionUsage('T1', 1000, 200, 'heavy'),
      completed('T1', 'heavy'),
    ]);
    const heavyRun = fold(heavy).runs.heavy;
    if (heavyRun === undefined) throw new Error('run not folded');
    const heavyOverhead = computeHarnessOverhead(heavyRun, heavy);

    if (leanOverhead.ratio === null || heavyOverhead.ratio === null) {
      throw new Error('expected both ratios to be measured');
    }
    expect(heavyOverhead.ratio).toBeGreaterThan(leanOverhead.ratio);
  });
});
