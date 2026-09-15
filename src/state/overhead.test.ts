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
 * A fixed clock, one second per event by default (`logWith`), the same
 * discipline `metrics.test.ts` uses and for the same reason: real
 * millisecond figures below have to be exact, not merely non-null, and a
 * wall clock would make an interval-merge assertion flaky by however long
 * the append itself happens to take. `logWithTimestamps` gives each event an
 * explicit offset instead, for the tests below that need spans of very
 * different sizes to coexist in one log without hundreds of filler events.
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

function logWithTimestamps(
  inputs: readonly EventInput[],
  offsetsMs: readonly number[],
): StoredEvent[] {
  let i = 0;
  const log = EventLog.open(MEMORY, {
    registry: kernelRegistry(),
    clock: () => {
      const offset = offsetsMs[i];
      if (offset === undefined) throw new Error('offsetsMs shorter than inputs');
      const ts = new Date(BASE + offset).toISOString();
      i += 1;
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

describe('computeHarnessOverhead — the numerator is context assembly, and nothing else', () => {
  it('sums only ContextAssembled.durationMs into overheadMs, and keeps session non-API time out of it', () => {
    const events = logWith([
      runStarted(),
      dispatched('T1'), // 1s
      contextAssembled('T1', 50, 'phase'), // 2s
      sessionUsage('T1', 500, 300), // 3s
      completed('T1'), // 4s
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // T1's own span is [dispatch@1000ms, terminal@4000ms) = 3000ms — the
    // ContextAssembled timestamp (2000ms) falls after dispatch here, so it
    // does not move the start (a dedicated test below covers the case where
    // it does).
    expect(overhead.overheadMs).toBe(50);
    expect(overhead.instrumentedSpanMs).toBe(3000);
    expect(overhead.ratio).toBeCloseTo(50 / 3000);
    expect(overhead.components).toEqual({
      contextAssemblyMs: 50,
      contextAssemblyCount: 1,
      instrumentedTaskCount: 1,
      settledTaskCount: 1,
      // The 200ms `durationMs - apiDurationMs` gap is agent tool-execution
      // time (module doc), reported but never folded into `overheadMs`.
      nonApiSessionMs: 200,
      sessionsWithDuration: 1,
    });
    // NFR-3's other two named spans: nothing here ever brackets either.
    expect(overhead.unmeasured).toEqual(['scheduling', 'validation']);
    expect(overhead.unmeasured).toBe(NFR3_UNOBSERVABLE_SPANS);
  });

  it('does not let a session that overran ever contribute a negative non-API component', () => {
    // `apiDurationMs` should never exceed `durationMs`, but the formula
    // floors at 0 rather than trusting that and reporting a negative figure.
    const events = logWith([
      runStarted(),
      dispatched('T1'),
      sessionUsage('T1', 100, 150),
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.components.nonApiSessionMs).toBe(0);
    // No `ContextAssembled` event at all: nothing measured the numerator.
    expect(overhead.overheadMs).toBeNull();
  });

  it("widens an instrumented task's own span to include context assembly appended before its TaskDispatched", () => {
    // Production order (`src/phase/runner.ts`, `src/implement/loop.ts`):
    // `ContextAssembled` is appended *before* `SessionRunner.runTask`'s own
    // `TaskDispatched`. Using `dispatched` alone as the span's start would
    // silently drop that time from the denominator and inflate the ratio.
    const events = logWithTimestamps(
      [
        runStarted(), // 0ms
        contextAssembled('T1', 80), // 0ms — before dispatch
        dispatched('T1'), // 5000ms
        completed('T1'), // 6000ms
      ],
      [0, 0, 5000, 6000],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // Span is [0ms, 6000ms) = 6000ms, not [5000ms, 6000ms) = 1000ms.
    expect(overhead.instrumentedSpanMs).toBe(6000);
    expect(overhead.ratio).toBeCloseTo(80 / 6000);
    // The naive (unfixed) span would have reported 80/1000 = 8%, eight
    // times larger than the correct 1.33%.
    expect(overhead.ratio).not.toBeCloseTo(80 / 1000);
  });
});

describe('computeHarnessOverhead — the ratio is population-matched, not diluted by what it never measured', () => {
  it('reports the instrumented tasks’ own ratio, not a figure diluted by uninstrumented settled tasks', () => {
    // The shape of this repository's own real `run-1`: one instrumented
    // task among many settled-but-uninstrumented ones. A denominator built
    // from *every* settled task's span (an earlier revision's mistake)
    // would divide 100ms of measured overhead by nearly two million
    // milliseconds of unrelated task spans and report ratio ~0.005% — a
    // confident NFR-3 pass manufactured by missing instrumentation.
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        dispatched('T1'), // 1_000
        contextAssembled('T1', 100), // 1_100
        completed('T1'), // 2_000 -> T1 span [1000, 2000) = 1000ms, overhead 100ms -> 10%
        dispatched('T2'), // 3_000
        completed('T2'), // 1_000_000 -> T2 span ~997_000ms, never instrumented
        dispatched('T3'), // 2_000_000
        completed('T3'), // 3_000_000 -> T3 span 1_000_000ms, never instrumented
      ],
      [0, 1_000, 1_100, 2_000, 3_000, 1_000_000, 2_000_000, 3_000_000],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.components.settledTaskCount).toBe(3);
    expect(overhead.components.instrumentedTaskCount).toBe(1);
    expect(overhead.coverage).toBeCloseTo(1 / 3);
    // The population-matched ratio is exactly T1's own 10% — not diluted by
    // T2 and T3's uninstrumented, much larger spans.
    expect(overhead.overheadMs).toBe(100);
    expect(overhead.instrumentedSpanMs).toBe(1000);
    expect(overhead.ratio).toBeCloseTo(0.1);
    // What the earlier (wrong) all-settled-tasks denominator would have
    // reported: overwhelmingly smaller, and a false NFR-3 pass.
    const wrongDenominator = 1000 + 997_000 + 1_000_000;
    expect(overhead.ratio).not.toBeCloseTo(100 / wrongDenominator);
  });
});

describe('computeHarnessOverhead — the denominator is summed, not merged, so concurrency does not multiply the ratio', () => {
  it('reports the same ratio for two concurrent instrumented sessions as either alone', () => {
    // T1: [0, 1000)ms, 100ms overhead -> 10%. T2: [500, 1500)ms, overlapping
    // T1 by 500ms, 100ms overhead -> 10%. Merging their windows (an earlier
    // revision's mistake) gives [0, 1500) = 1500ms, so 200ms / 1500ms =
    // 13.3% — inflated by the overlap the scheduler itself created
    // (`runPhase`'s `DEFAULT_CONCURRENCY`). Summing each task's own span
    // instead keeps the ratio at each session's real 10%.
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        dispatched('T1'), // 0
        contextAssembled('T1', 100), // 50
        dispatched('T2'), // 500
        contextAssembled('T2', 100), // 550
        completed('T1'), // 1000
        completed('T2'), // 1500
      ],
      [0, 0, 50, 500, 550, 1000, 1500],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.overheadMs).toBe(200);
    expect(overhead.instrumentedSpanMs).toBe(2000); // 1000 + 1000, summed
    expect(overhead.ratio).toBeCloseTo(0.1);
    // The merged-window figure a wrong implementation would report instead.
    expect(overhead.ratio).not.toBeCloseTo(200 / 1500);
  });
});

describe('computeHarnessOverhead — observedMs is the run’s own busy span, informational and idle-rule driven', () => {
  it('merges two overlapping task intervals into one window rather than summing their spans', () => {
    // T1 dispatched then T2 dispatched before T1 finishes (runPhase's own
    // concurrency), each a 2-second span, overlapping by 1 second. Neither
    // task is instrumented, so this exercises `observedMs` only.
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
    // Nothing instrumented: `ratio` does not use `observedMs`, so it stays
    // null regardless.
    expect(overhead.ratio).toBeNull();
  });

  it('is a stated idle-gap rule, and observedMs moves when the rule does', () => {
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
  it('reads a run with no ContextAssembled event as unmeasured, not 0%, even with session usage recorded', () => {
    const events = logWith([
      runStarted(),
      dispatched('T1'),
      sessionUsage('T1', 500, 300),
      completed('T1'),
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.overheadMs).toBeNull();
    expect(overhead.instrumentedSpanMs).toBeNull();
    // The denominator is still measurable — the task did settle — so a
    // reader can see this is "nothing observed" and not "no data at all".
    expect(overhead.observedMs).toBe(2000);
    expect(overhead.coverage).toBe(0);
    expect(overhead.ratio).toBeNull();
  });

  it('reads a run with no settled task as unmeasured, even with a ContextAssembled event recorded', () => {
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

    // T1 never settled, so it contributes to no population at all — not to
    // the numerator, not to the denominator, not to coverage.
    expect(overhead.overheadMs).toBeNull();
    expect(overhead.instrumentedSpanMs).toBeNull();
    expect(overhead.observedMs).toBeNull();
    expect(overhead.coverage).toBeNull();
    expect(overhead.ratio).toBeNull();
  });
});

describe('computeHarnessOverhead — two runs at different ratios read differently', () => {
  it('does not report the same figure for a lean run and an overhead-heavy one', () => {
    const lean = logWith([
      runStarted('lean'),
      dispatched('T1', 'lean'), // 1s
      contextAssembled('T1', 10, 'phase', 'lean'), // 2s
      completed('T1', 'lean'), // 3s -> span [1000,3000) = 2000ms, overhead 10ms
    ]);
    const leanRun = fold(lean).runs.lean;
    if (leanRun === undefined) throw new Error('run not folded');
    const leanOverhead = computeHarnessOverhead(leanRun, lean);

    const heavy = logWith([
      runStarted('heavy'),
      dispatched('T1', 'heavy'), // 1s
      contextAssembled('T1', 400, 'implement', 'heavy'), // 2s
      completed('T1', 'heavy'), // 3s -> span [1000,3000) = 2000ms, overhead 400ms
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
