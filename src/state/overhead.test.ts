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

function toolCallLogged(taskId: string, runId: string = RUN): EventInput {
  return {
    runId,
    type: 'ToolCallLogged',
    payload: { taskId, tool: 'Bash', decision: 'allowed', detail: '', outputBlob: null },
  };
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
      contextAssembled('T1', 50, 'phase'), // 1s — both call sites append this
      // before their own TaskDispatched (module doc); a dedicated test below
      // covers exactly how far that widens the round's start.
      dispatched('T1'), // 2s
      sessionUsage('T1', 500, 300), // 3s
      completed('T1'), // 4s
    ]);
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // T1's own span is [contextAssembled@1000ms, terminal@4000ms) = 3000ms.
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
        contextAssembled('T1', 100), // 1_000 — precedes its own TaskDispatched
        dispatched('T1'), // 1_100
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

  it('matches the population at round granularity too: an uninstrumented round of an instrumented task does not dilute the ratio', () => {
    // The first measurable run on this repository's own run-1 is exactly
    // this shape: a task with many pre-instrumentation rounds (no
    // ContextAssembled at all, because the log predates T4.2.9) plus one new
    // round that carries one. Pushing every round of an "instrumented task"
    // into the denominator — the task-level population match alone — would
    // divide that one round's context-assembly time by a dozen rounds'
    // spans and understate the ratio by roughly the round count, the same
    // dilution the module doc already rejects at task granularity (the
    // 1-of-230 example) left open one level down.
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        // 11 uninstrumented rounds, 1000ms each, no ContextAssembled.
        ...Array.from({ length: 11 }, () => [dispatched('T1'), completed('T1')]).flat(),
        // The 12th round is instrumented: 100ms of context assembly inside
        // a 1000ms round.
        contextAssembled('T1', 100),
        dispatched('T1'),
        completed('T1'),
      ],
      [
        0,
        ...Array.from({ length: 11 }, (_unused, i) => [
          i * 2_000,
          i * 2_000 + 1_000,
        ]).flat(),
        22_000,
        22_100,
        23_000,
      ],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // Only the 12th round's own 1000ms span is the denominator — not the
    // union of all 12 rounds' spans, which a task-level-only population
    // match would report instead (12,000ms, understating the ratio twelvefold).
    expect(overhead.overheadMs).toBe(100);
    expect(overhead.instrumentedSpanMs).toBe(1000);
    expect(overhead.ratio).toBeCloseTo(0.1);
    const taskLevelWrongDenominator = 11 * 1000 + 1000;
    expect(overhead.ratio).not.toBeCloseTo(100 / taskLevelWrongDenominator);
    // observedMs, by contrast, is not population-matched — it is every
    // settled round, instrumented or not — so it does include all 12.
    expect(overhead.observedMs).toBe(12 * 1000);
  });
});

describe('computeHarnessOverhead — the denominator is merged, not summed, so concurrency does not hide it', () => {
  it('reports a higher ratio for two concurrent instrumented sessions than a summed denominator would', () => {
    // T1: [0, 1000)ms, 100ms of synchronous context-assembly overhead.
    // T2: [500, 1500)ms, overlapping T1 by 500ms, 100ms overhead. Both
    // sessions' context assembly is synchronous (`assembleContext`), so it
    // cannot itself run concurrently — 200ms of harness CPU sits inside a
    // 1500ms wall-clock busy window (the merged union of [0,1000) and
    // [500,1500)), which is 13.3%: an NFR-3 breach at a concurrency of two.
    // A denominator that summed each task's own span instead (an earlier
    // revision's mistake) would divide by 1000+1000=2000 and report 10.0%,
    // a pass manufactured by double-counting the overlapping window as if
    // it were two separate ones.
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        contextAssembled('T1', 100), // 0
        dispatched('T1'), // 50
        contextAssembled('T2', 100), // 500
        dispatched('T2'), // 550
        completed('T1'), // 1000
        completed('T2'), // 1500
      ],
      [0, 0, 50, 500, 550, 1000, 1500],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.overheadMs).toBe(200);
    expect(overhead.instrumentedSpanMs).toBe(1500); // merged [0,1500), not 1000+1000
    expect(overhead.ratio).toBeCloseTo(200 / 1500);
    // The summed-denominator figure a wrong implementation would report
    // instead — smaller than the true wall-clock fraction, an NFR-3 breach
    // read as a pass.
    expect(overhead.ratio).not.toBeCloseTo(0.1);
  });

  it('reports proportionally less overhead for the same total when the instrumented tasks do not overlap', () => {
    // Same total overhead (200ms) and same two-task shape as above, but T1
    // and T2 now run one after another with a gap between them instead of
    // concurrently: [0,1000) and [2000,3000). Nothing to merge — the
    // busy windows stay disjoint — so the denominator is the sum, 2000ms,
    // and the ratio is each session's own 10%, not the 13.3% the
    // overlapping case above reports for the identical 200ms of overhead.
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        contextAssembled('T1', 100), // 0
        dispatched('T1'), // 50
        completed('T1'), // 1000
        contextAssembled('T2', 100), // 2000
        dispatched('T2'), // 2050
        completed('T2'), // 3000
      ],
      [0, 0, 50, 1000, 2000, 2050, 3000],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.overheadMs).toBe(200);
    expect(overhead.instrumentedSpanMs).toBe(2000); // disjoint: [0,1000) + [2000,3000)
    expect(overhead.ratio).toBeCloseTo(0.1);
    expect(overhead.ratio).toBeLessThan(200 / 1500);
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

describe('computeHarnessOverhead — a redispatched task contributes one interval per round, not one spanning every round', () => {
  it("does not fold a CI-repair or review-rework round's own idle gap into the task's busy span", () => {
    // This repository's own log, shrunk: T3.2.1 closes a round with
    // `TaskCompleted` at 2026-08-27T16:44:50Z and opens its next round's
    // `TaskDispatched` 70 hours later, at 2026-08-30T14:32:18Z — both under
    // the same taskId. A single [firstDispatch, lastTerminal) interval per
    // task (an earlier revision of this module) would put that 70-hour
    // operator-absence gap inside the very window `idleGapMs` is meant to
    // keep out, because merging only ever widens a window *between*
    // intervals and a single task-wide interval already has none to widen
    // with. Round 1: [0, 1000). Round 2, after a 10-hour gap far past the
    // default idleGapMs of 0: [37_200_000, 37_201_000).
    const GAP_MS = 10 * 60 * 60 * 1000;
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        contextAssembled('T1', 40), // 0 — round 1's own context assembly, before its dispatch
        dispatched('T1'), // 100
        completed('T1'), // 1_000 — round 1 closes cleanly, terminal event first
        contextAssembled('T1', 60), // 1_000 + GAP_MS — round 2 opens, well past the gap
        dispatched('T1'), // 1_000 + GAP_MS + 100 — round 2's own dispatch
        completed('T1'), // 1_000 + GAP_MS + 1_000 — round 2 closes
      ],
      [0, 0, 100, 1_000, 1_000 + GAP_MS, 1_000 + GAP_MS + 100, 1_000 + GAP_MS + 1_000],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // Two 1000ms rounds, not one interval spanning the 10-hour gap between
    // them: observedMs is 2000ms. The bug this test catches would report
    // 1_000 + GAP_MS + 1_000 instead — the gap counted as busy time.
    expect(overhead.observedMs).toBe(2000);
    expect(overhead.observedMs).not.toBe(1_000 + GAP_MS + 1_000);

    // Both rounds carry their own ContextAssembled, so overheadMs sums both
    // (40 + 60 = 100) and instrumentedSpanMs is the same 2000ms busy span —
    // never the gap-inflated span a single task-wide interval would divide
    // by, which would report a false NFR-3 pass built from operator absence.
    expect(overhead.overheadMs).toBe(100);
    expect(overhead.instrumentedSpanMs).toBe(2000);
    expect(overhead.ratio).toBeCloseTo(100 / 2000);
    expect(overhead.ratio).not.toBeCloseTo(100 / (1_000 + GAP_MS + 1_000));

    // A caller stating an idle rule wider than the gap merges the two rounds
    // back into one window — the rule is stated and the figure moves with
    // it, rather than the gap being silently absorbed by default.
    const lenient = computeHarnessOverhead(run, events, { idleGapMs: GAP_MS });
    expect(lenient.observedMs).toBe(1_000 + GAP_MS + 1_000);
    expect(lenient.instrumentedSpanMs).toBe(1_000 + GAP_MS + 1_000);
    expect(lenient.ratio).toBeCloseTo(100 / (1_000 + GAP_MS + 1_000));
  });

  it('splits a round abandoned before its terminal event at its own last activity, not at the redispatch that follows it', () => {
    // This repository's own log, shrunk to the same shape: T3.2.1's round
    // opens with `TaskDispatched` at seq 398 (2026-08-30T14:32:18.781Z),
    // produces `ToolCallLogged` activity ending at 14:32:49.793Z, and then
    // never reaches a terminal event — the process died. A second
    // `TaskDispatched` for the same `taskId` arrives 20.1 hours later at seq
    // 407 (2026-08-31T10:38:05.683Z), and only *that* round reaches
    // `TaskCompleted`, 125 seconds after it opens. `openRound`'s original
    // no-op on a `taskId` that already had a round open let the entire 20.1
    // hours land inside the interval that eventually closed. Modelled here
    // at a smaller scale: round 1 opens at 0, its last `ToolCallLogged` is
    // at 31_000ms, and the redispatch arrives 20 hours later.
    const REDISPATCH_GAP_MS = 20 * 60 * 60 * 1000;
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        dispatched('T1'), // 0 — round 1 opens
        toolCallLogged('T1'), // 4_000 — activity inside round 1
        toolCallLogged('T1'), // 19_000 — round 1's last observed activity
        toolCallLogged('T1'), // 31_000 — round 1's last observed activity
        dispatched('T1'), // 31_000 + REDISPATCH_GAP_MS — round 1 abandoned,
        // no terminal event ever closed it; this is a fresh round for the
        // same taskId
        completed('T1'), // 31_000 + REDISPATCH_GAP_MS + 125_000 — round 2 closes
      ],
      [
        0,
        0,
        4_000,
        19_000,
        31_000,
        31_000 + REDISPATCH_GAP_MS,
        31_000 + REDISPATCH_GAP_MS + 125_000,
      ],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // Round 1: [0, 31_000) = 31_000ms — closed at its last observed
    // activity, not at the redispatch 20 hours later. Round 2:
    // [31_000 + REDISPATCH_GAP_MS, 31_000 + REDISPATCH_GAP_MS + 125_000) =
    // 125_000ms. Neither round is instrumented (no ContextAssembled at all,
    // the same as this repository's real pre-T4.2.9 log), so only
    // observedMs is exercised — the bug this test catches would report one
    // interval spanning the entire 20-hour gap instead of two short ones.
    expect(overhead.observedMs).toBe(31_000 + 125_000);
    expect(overhead.observedMs).not.toBe(31_000 + REDISPATCH_GAP_MS + 125_000);
  });

  it('splits a round abandoned before its own TaskDispatched at its own last activity, not at the redispatch that follows it', () => {
    // The mirror image of the previous test, and the case that fix left
    // open: a round opened by `ContextAssembled` that never reaches its own
    // `TaskDispatched` at all — the process dies (or `track` returns blocked
    // without dispatching) in the window between the two. The old rule only
    // split on `open.dispatched`, so a round with no dispatch of its own
    // stayed open across the next invocation's `ContextAssembled` for the
    // same taskId, and the entire gap between invocations landed inside
    // whatever round eventually closed — this time inside
    // `instrumentedSpanMs`, the ratio's own denominator, one step earlier
    // than the case above. Round 1: a lone `ContextAssembled` at 0, nothing
    // else ever names T1 again for it — closes at its own timestamp, 0ms
    // long. Round 2 opens 3 days later with its own `ContextAssembled`,
    // dispatches 100ms after that, and completes 1000ms after the dispatch.
    const REDISPATCH_GAP_MS = 3 * 24 * 60 * 60 * 1000;
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        contextAssembled('T1', 40), // 0 — round 1 opens, never dispatches
        contextAssembled('T1', 60), // 0 + REDISPATCH_GAP_MS — round 1 abandoned,
        // this is round 2's own opening ContextAssembled, not an extension
        dispatched('T1'), // 0 + REDISPATCH_GAP_MS + 100 — round 2's own dispatch
        completed('T1'), // 0 + REDISPATCH_GAP_MS + 1_100 — round 2 closes
      ],
      [0, 0, REDISPATCH_GAP_MS, REDISPATCH_GAP_MS + 100, REDISPATCH_GAP_MS + 1_100],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    // Round 1: [0, 0) — 0ms, closed at its own last activity (its own
    // ContextAssembled, nothing else ever touched it) rather than 3 days
    // later. Round 2: [REDISPATCH_GAP_MS, REDISPATCH_GAP_MS + 1_100) —
    // 1_100ms. Both rounds are instrumented, so instrumentedSpanMs is their
    // sum, 1_100ms — not the 3-day gap the unfixed (dispatched-only) split
    // rule would have folded into a single round's span.
    expect(overhead.overheadMs).toBe(100);
    expect(overhead.instrumentedSpanMs).toBe(1_100);
    expect(overhead.instrumentedSpanMs).not.toBe(REDISPATCH_GAP_MS + 1_100);
    expect(overhead.ratio).toBeCloseTo(100 / 1_100);
    expect(overhead.ratio).not.toBeCloseTo(100 / (REDISPATCH_GAP_MS + 1_100));
  });
});

describe('computeHarnessOverhead — overheadMs, instrumentedSpanMs and ratio are null together (CONV-5)', () => {
  it('does not report a real overheadMs alongside a null ratio when the instrumented span merges to zero', () => {
    // T1 is instrumented (a real ContextAssembled event) but its own
    // dispatch-to-terminal interval has zero length — dispatched and
    // completed at the same timestamp. overheadMs/instrumentedSpanMs/ratio
    // come from one value that is null for all three together, so this
    // cannot surface as a real overheadMs number next to a null ratio —
    // the exact drift three independently-evaluated conditions could let
    // through (module doc).
    const events = logWithTimestamps(
      [
        runStarted(), // 0
        contextAssembled('T1', 50), // 1000 — opens the round
        dispatched('T1'), // 1000 — same instant, extends without moving the start
        completed('T1'), // 1000 — same instant again: zero-length interval
      ],
      [0, 1000, 1000, 1000],
    );
    const run = fold(events).runs[RUN];
    if (run === undefined) throw new Error('run not folded');

    const overhead = computeHarnessOverhead(run, events);

    expect(overhead.components.instrumentedTaskCount).toBe(1);
    expect(overhead.components.contextAssemblyMs).toBe(50);
    // The instrumented population is non-empty, but its merged span is
    // zero, so nothing is reported — not a 50ms overheadMs with no
    // denominator to divide it by.
    expect(overhead.overheadMs).toBeNull();
    expect(overhead.instrumentedSpanMs).toBeNull();
    expect(overhead.ratio).toBeNull();
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
      contextAssembled('T1', 20),
      dispatched('T1'),
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
      contextAssembled('T1', 10, 'phase', 'lean'), // 1s
      dispatched('T1', 'lean'), // 2s
      completed('T1', 'lean'), // 3s -> span [1000,3000) = 2000ms, overhead 10ms
    ]);
    const leanRun = fold(lean).runs.lean;
    if (leanRun === undefined) throw new Error('run not folded');
    const leanOverhead = computeHarnessOverhead(leanRun, lean);

    const heavy = logWith([
      runStarted('heavy'),
      contextAssembled('T1', 400, 'implement', 'heavy'), // 1s
      dispatched('T1', 'heavy'), // 2s
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
