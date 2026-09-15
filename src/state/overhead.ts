import type { StoredEvent } from '../event/envelope.js';
import type { RunState } from './kernel-state.js';

/**
 * Harness overhead, against a denominator that means something (T4.2.9,
 * NFR-3, OBS-2).
 *
 * NFR-3 bounds three spans: **scheduling**, **context assembly** and
 * **validation**. This module measures the one of those the log can show a
 * span for, at all, and says plainly that it cannot see the other two:
 *
 * - **Context assembly** is `ContextAssembled.durationMs`, per task
 *   (`src/event/catalog.ts`) — timed at both its call sites,
 *   `src/phase/runner.ts`'s `runSession` and `src/implement/loop.ts`, both
 *   of which call `assembleContext` before `SessionRunner.runTask` and so
 *   outside the span `SessionUsage.durationMs` covers (T4.2.8). This is the
 *   *only* component `overheadMs`/`ratio` below are built from.
 * - **Scheduling** (`runPhase`'s own dispatch loop, `src/orchestrator/
 *   scheduler.ts`) and **validation** (the structured-output retry loop in
 *   `SessionRunner.runTask` — schema `safeParse` plus a caller's own
 *   `validate`) are never bracketed by a start/end pair anywhere in the
 *   catalog. {@link NFR3_UNOBSERVABLE_SPANS} names both, on every result, so
 *   a reader of {@link HarnessOverhead.ratio} sees what it does not cover
 *   rather than inferring NFR-3 is fully measured because a number came back
 *   (CONV-6).
 *
 * `SessionUsage.durationMs - SessionUsage.apiDurationMs` — an earlier
 * revision of this module summed that difference into the ratio as
 * "in-session harness work". It is not: those two fields come straight off
 * the SDK's own result message (`durationsOf`, `src/agent/claude-
 * provider.ts`), so the difference is *every* non-API second of a session —
 * every `Bash` command, `npm test` run, `git` operation and file read the
 * agent performs — which is agent tool-execution time, not harness code
 * running, and NFR-3 does not bound it. It is still recorded and reported,
 * as {@link HarnessOverheadComponents.nonApiSessionMs}, because it is real
 * data a reader may want — but it is named for what it is, kept out of
 * `overheadMs`, and never compared against the 10% threshold.
 *
 * **The numerator is population-matched to what produced it.** `overheadMs`
 * is `Σ ContextAssembled.durationMs` over exactly the settled tasks that
 * have at least one such event — never over tasks this log cannot show a
 * span for, and never diluted by tasks the numerator says nothing about. An
 * earlier revision divided that sum by the busy span of *every* settled
 * task, regardless of how few of them were actually instrumented: over this
 * repository's own `run-1`, where exactly one of 230 sessions carries a
 * recorded duration, that produced `ratio: 0.0000617` — a confident NFR-3
 * pass manufactured by 229 tasks the numerator never measured, while the one
 * task that *was* measured ran at 4.7% overhead by this same formula. That
 * is the "unmeasured, not 0%" discipline turned upside down: a mostly-
 * uninstrumented log must not read as a mostly-lean one. {@link
 * HarnessOverhead.coverage} — instrumented tasks over settled tasks — is
 * reported alongside the ratio for exactly this reason: a reader comparing
 * `ratio` to the 10% threshold can also see how much of the run it actually
 * rests on.
 *
 * **The denominator is the merged union of the instrumented tasks' own
 * spans — not summed.** A prior revision of this module summed each
 * instrumented task's own span instead, reasoning that four sessions each
 * genuinely running at 10% overhead, concurrently, would otherwise merge
 * into one wall-clock window a quarter the combined span's length and
 * report ratio 40% — a per-session average, not what NFR-3 names. That
 * reasoning does not survive contact with `assembleContext`
 * (`src/context/assembler.ts`): it is synchronous, so two concurrently
 * scheduled sessions' context assembly cannot itself run at the same time —
 * it serialises inside the one Node process the harness runs in, however
 * many *session* spans overlap around it. NFR-3 bounds overhead as a
 * fraction of the run's own wall-clock time (REQUIREMENTS.md), and summing
 * rather than merging understates exactly that fraction by up to the
 * concurrency factor: two sessions each spending 100ms in synchronous
 * context assembly inside a 1500ms overlapping busy window are 200ms of
 * harness CPU inside 1500ms of wall clock — 13.3%, an NFR-3 breach reachable
 * at a concurrency of two, well under `DEFAULT_CONCURRENCY`'s 4 — while a
 * summed denominator divides by 1000+1000 and reports 10.0%, a pass built by
 * treating the one overlapping window as if it were two separate ones. So
 * the denominator paired with the numerator is `mergeIntervals` (used for
 * `observedMs`
 * below, and reused here) applied to each instrumented task's own
 * `[min(firstDispatch, firstContextAssembled), terminalEvent)` interval,
 * under the same stated idle rule as `observedMs`: `{@link
 * HarnessOverhead.instrumentedSpanMs}`. It is smaller than the sum whenever
 * instrumented tasks' intervals overlap — concurrency correctly *shrinks*
 * the wall-clock denominator it divides into, rather than the numerator
 * growing to match it — and equal to the sum whenever they do not overlap
 * at all. The span's start is `min`, not `firstDispatch` alone, because both
 * call sites append `ContextAssembled` *before* `SessionRunner.runTask`'s
 * own `TaskDispatched` (`src/state/reduce.ts`) — the context-assembly time
 * this module measures would otherwise fall outside the very window it is
 * divided by.
 *
 * **The numerator and denominator are computed together, and null
 * together, not by three independent conditions that have to be kept in
 * step by hand (CONV-5).** `overheadMs`, `instrumentedSpanMs` and `ratio`
 * all come from one local value that is either a single populated
 * measurement or `null` — never a state where one of the three is a real
 * number and another is not, which three separately-evaluated ternaries
 * over slightly different conditions could otherwise drift into (the
 * instrumented-population check alone does not rule out a merged window
 * summing to zero).
 *
 * This is a different span from the run's own busy time, and that is kept
 * too, as {@link HarnessOverhead.observedMs} — informational, not the
 * ratio's denominator. It is deliberately not the run's raw `startedAt`-to-
 * last-event span: `--run` defaults to `run-1` (`src/cli/main.ts`) and every
 * verb appends `RunStarted` only when the run does not already exist, so one
 * run id accumulates across however many separate CLI invocations an
 * operator makes over however many days — this repository's own log, self-
 * hosted, holds a single run spanning weeks, almost all of it the operator
 * away from the keyboard. Nor is it the sum of *every* settled task's span:
 * with concurrency and overlapping CLI invocations against one run id, that
 * sum is more than twice this repository's own run's actual elapsed time.
 * Instead it is the union of every settled task's own interval (same start
 * rule as above), merged by a stated idle rule
 * ({@link HarnessOverheadOptions.idleGapMs}): two intervals separated by a
 * gap no larger than `idleGapMs` count as one continuous busy window; a
 * larger gap is idle time and excluded. The default, `0`, merges only
 * intervals that literally overlap or touch; raising it pulls short
 * between-dispatch gaps into the window instead, and `observedMs` moves when
 * it does, because the window it sums changed and the events did not.
 *
 * `overheadMs`, `instrumentedSpanMs`, `ratio` and `coverage` are each null
 * whenever their own inputs have nothing to report — the same null
 * discipline `computeRunMetrics`'s `successRate`/`avgLatencyMs` and
 * `computeGateRates`'s gate rates already hold (CONV-6): a run with no
 * `ContextAssembled` event anywhere (a pre-T4.2.9 log, replayed) reads as
 * unmeasured, not as 0% overhead, and a run with no settled task reads the
 * same way for the same reason.
 *
 * **T4.2.1 already claims NFR-3** (`PLAN.md`'s own row, `tracesTo: NFR-3`)
 * without measuring it: its completion criterion is that `mpgm status
 * --metrics` reports cost, latency, retries and success — and `latency`
 * there is `AggregateMetric.avgLatencyMs`, a task's own dispatch-to-
 * completion span, not harness overhead. A slow model call inflates that
 * figure exactly as much as a slow scheduler would; the two are not the
 * same measurement, and reading T4.2.1's latency as NFR-3 coverage would
 * show the trace index NFR-3 covered twice, with one of the two claims
 * false. This module is what actually measures it.
 *
 * DESIGN's only mention of NFR-3 is ADR-1, in service of a different
 * decision (TypeScript over Rust): "the harness is I/O-bound around model
 * calls (NFR-3 is trivially met in any mainstream language)". Run against a
 * copy of this repository's own self-hosted `run-1` this function reports
 * `ratio: null` — every `ContextAssembled` event in this codebase is new
 * with this task, and the long-running process behind that log predates it,
 * so nothing yet brackets context assembly for it. `observedMs` alone is
 * already informative: merging that run's settled-task intervals (idle rule
 * at its default) gives a busy span of about 13 days inside a run whose raw
 * `startedAt`-to-last-event span is about 19 days — most of the run,
 * correctly excluded, was exactly the operator-absence gaps this module's
 * doc above says the raw span would wrongly charge to the harness. Because
 * `overheadMs` is null, this real run cannot yet be compared to the 10%
 * threshold, and so neither confirms nor contradicts ADR-1's claim — that
 * comparison becomes possible only once a run proceeds under this task's
 * code. ADR-1 is cited here either way: nothing this module has measured so
 * far is evidence against it, and nothing in this module is exempt from
 * being evidence against it the first time a real ratio comes back over
 * threshold, with enough coverage to trust. PLAN.md's own T4.2.9 row says so
 * explicitly: the 10%-threshold comparison against a self-hosted run is
 * deferred to the first run this instrumentation actually observes, rather
 * than left as a criterion this change silently could not meet — starting
 * that run is an operator action this change does not itself take.
 */

export const NFR3_OVERHEAD_THRESHOLD = 0.1;

/**
 * NFR-3's named spans this module has no event to bracket at all (see module
 * doc). Always both, on every result: nothing this module reads ever makes
 * either observable.
 */
export const NFR3_UNOBSERVABLE_SPANS: readonly string[] = ['scheduling', 'validation'];

const DEFAULT_IDLE_GAP_MS = 0;

export interface HarnessOverheadComponents {
  /**
   * Σ `ContextAssembled.durationMs` over exactly the settled, instrumented
   * tasks {@link HarnessOverhead.overheadMs} is built from (module doc) —
   * not a run-wide total including tasks the ratio never counted.
   */
  readonly contextAssemblyMs: number;
  readonly contextAssemblyCount: number;
  /** Settled tasks with at least one `ContextAssembled` event. */
  readonly instrumentedTaskCount: number;
  /** Every settled task this run, instrumented or not — coverage's denominator. */
  readonly settledTaskCount: number;
  /**
   * Σ `max(SessionUsage.durationMs - SessionUsage.apiDurationMs, 0)` over
   * every session this run where both are recorded. Agent tool-execution
   * time, not harness code (module doc) — reported for whoever wants it, but
   * never part of `overheadMs`/`ratio` and never compared against NFR-3's
   * threshold.
   */
  readonly nonApiSessionMs: number;
  /** Sessions this run with both `durationMs` and `apiDurationMs` recorded. */
  readonly sessionsWithDuration: number;
}

export interface HarnessOverhead {
  readonly runId: string;
  /** The numerator formula's total (module doc). Null when nothing measured it. */
  readonly overheadMs: number | null;
  /**
   * The ratio's own denominator (module doc): the merged union of each
   * instrumented task's own span, under the same idle rule as `observedMs`,
   * population-matched to `overheadMs` — never summed (module doc: summing
   * understates NFR-3's own wall-clock fraction by up to the concurrency
   * factor, because `assembleContext` is synchronous). Null when no task was
   * instrumented. Computed together with `overheadMs` and `ratio` from one
   * value that is null for all three at once (CONV-5, module doc).
   */
  readonly instrumentedSpanMs: number | null;
  /**
   * `overheadMs / instrumentedSpanMs`. Null whenever either side is null;
   * computed alongside them from the same value, not by an independent
   * zero/null check (CONV-5, module doc).
   */
  readonly ratio: number | null;
  /**
   * The run's own busy span (module doc) — the merged union of every
   * settled task's interval under the stated idle rule, instrumented or
   * not. Informational: not the ratio's denominator, because it is not
   * population-matched to `overheadMs` (see module doc for why an earlier
   * revision that divided by this was wrong). Null when no task settled.
   */
  readonly observedMs: number | null;
  /**
   * `components.instrumentedTaskCount / components.settledTaskCount` — how
   * much of this run's settled work `ratio` actually rests on. Null when no
   * task settled. Report `ratio` next to this, not alone: a low coverage
   * figure means a comfortable-looking ratio may rest on very little.
   */
  readonly coverage: number | null;
  readonly components: HarnessOverheadComponents;
  /** NFR-3 spans this figure names rather than silently omits (module doc). */
  readonly unmeasured: readonly string[];
}

export interface HarnessOverheadOptions {
  /**
   * The idle rule for `observedMs` (module doc): two busy intervals no more
   * than this far apart merge into one continuous window; a larger gap is
   * idle and excluded. Defaults to `0` — only literally overlapping or
   * touching intervals merge. Does not affect `ratio`, which never merges
   * (module doc).
   */
  readonly idleGapMs?: number;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * Merges overlapping or near-enough intervals into disjoint busy windows.
 * `idleGapMs` is the idle rule: a gap this size or smaller is bridged, a
 * larger one splits the windows apart (module doc).
 */
function mergeIntervals(
  intervals: readonly Interval[],
  idleGapMs: number,
): readonly Interval[] {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (first === undefined) {
    return [];
  }
  const merged: Interval[] = [{ ...first }];
  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && current.start <= last.end + idleGapMs) {
      if (current.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: current.end };
      }
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

interface ContextAssembledPayload {
  readonly taskId: string;
  readonly durationMs: number;
}

interface SessionUsageOverheadPayload {
  readonly taskId: string;
  readonly durationMs: number | null;
  readonly apiDurationMs: number | null;
}

interface TaskIdPayload {
  readonly taskId: string;
}

/**
 * Harness overhead for one run (T4.2.9, NFR-3, OBS-2). See the module doc
 * for the numerator formula, why the denominator is population-matched and
 * summed rather than merged, and what this cannot see.
 *
 * `events` need not already be filtered to `run.runId` — every case below
 * checks it, the same guard `computeRunMetrics` and `computeGateRates`
 * apply — but a caller handing in every run's events gets exactly this
 * run's figure back either way.
 */
export function computeHarnessOverhead(
  run: RunState,
  events: readonly StoredEvent[],
  options: HarnessOverheadOptions = {},
): HarnessOverhead {
  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;

  // First `TaskDispatched` only, mirroring `computeRunMetrics`'s
  // `avgLatencyMs`: a later dispatch of the same `taskId` is a CI repair or
  // review-rework round, not a new busy interval starting from scratch.
  const dispatchedAt = new Map<string, string>();
  const completedAt = new Map<string, string>();
  const blockedAt = new Map<string, string>();
  // First `ContextAssembled` per task only: both call sites append it before
  // that task's own `TaskDispatched`, so only the very first one can fall
  // before `dispatchedAt` — a rework round's context assembly happens well
  // inside the window a later dispatch already opened (module doc).
  const contextAssembledFirstAt = new Map<string, string>();
  const contextAssemblyMsByTask = new Map<string, number>();
  const contextAssemblyCountByTask = new Map<string, number>();

  let nonApiSessionMs = 0;
  let sessionsWithDuration = 0;

  for (const event of events) {
    if (event.runId !== run.runId) {
      continue;
    }
    switch (event.type) {
      case 'TaskDispatched': {
        const payload = event.payload as TaskIdPayload;
        if (!dispatchedAt.has(payload.taskId)) {
          dispatchedAt.set(payload.taskId, event.ts);
        }
        break;
      }
      case 'TaskCompleted': {
        const payload = event.payload as TaskIdPayload;
        completedAt.set(payload.taskId, event.ts);
        break;
      }
      case 'TaskBlocked':
      case 'BudgetExceeded': {
        const payload = event.payload as TaskIdPayload;
        blockedAt.set(payload.taskId, event.ts);
        break;
      }
      case 'ContextAssembled': {
        const payload = event.payload as ContextAssembledPayload;
        if (!contextAssembledFirstAt.has(payload.taskId)) {
          contextAssembledFirstAt.set(payload.taskId, event.ts);
        }
        contextAssemblyMsByTask.set(
          payload.taskId,
          (contextAssemblyMsByTask.get(payload.taskId) ?? 0) + payload.durationMs,
        );
        contextAssemblyCountByTask.set(
          payload.taskId,
          (contextAssemblyCountByTask.get(payload.taskId) ?? 0) + 1,
        );
        break;
      }
      case 'SessionUsage': {
        const payload = event.payload as SessionUsageOverheadPayload;
        if (payload.durationMs !== null && payload.apiDurationMs !== null) {
          nonApiSessionMs += Math.max(payload.durationMs - payload.apiDurationMs, 0);
          sessionsWithDuration += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  const settledIntervals: Interval[] = [];
  const instrumentedIntervals: Interval[] = [];
  let settledTaskCount = 0;
  let instrumentedTaskCount = 0;
  let contextAssemblyMs = 0;
  let contextAssemblyCount = 0;

  for (const task of Object.values(run.tasks)) {
    const dispatched = dispatchedAt.get(task.taskId);
    const terminal =
      task.status === 'completed'
        ? completedAt.get(task.taskId)
        : task.status === 'blocked'
          ? blockedAt.get(task.taskId)
          : undefined;
    if (dispatched === undefined || terminal === undefined) {
      // Not settled (or attested, with no dispatch at all): no firm end to
      // close a busy interval with, the same reason `avgLatencyMs` skips it.
      continue;
    }

    const contextFirst = contextAssembledFirstAt.get(task.taskId);
    const start =
      contextFirst !== undefined && Date.parse(contextFirst) < Date.parse(dispatched)
        ? contextFirst
        : dispatched;
    const interval: Interval = { start: Date.parse(start), end: Date.parse(terminal) };

    settledTaskCount += 1;
    settledIntervals.push(interval);

    const taskContextMs = contextAssemblyMsByTask.get(task.taskId);
    const taskContextCount = contextAssemblyCountByTask.get(task.taskId);
    if (taskContextMs !== undefined && taskContextCount !== undefined) {
      instrumentedTaskCount += 1;
      instrumentedIntervals.push(interval);
      contextAssemblyMs += taskContextMs;
      contextAssemblyCount += taskContextCount;
    }
  }

  const observedWindows = mergeIntervals(settledIntervals, idleGapMs);
  const observedMs =
    observedWindows.length === 0
      ? null
      : observedWindows.reduce((sum, window) => sum + (window.end - window.start), 0);

  // Merged, not summed (module doc): assembleContext is synchronous, so
  // concurrently scheduled sessions' context assembly cannot itself overlap
  // in wall clock, and NFR-3 bounds a fraction of wall-clock time. The same
  // idle rule as observedMs applies, so raising idleGapMs widens both
  // windows consistently rather than moving one and not the other.
  const instrumentedWindows = mergeIntervals(instrumentedIntervals, idleGapMs);
  const instrumentedSpanMsRaw = instrumentedWindows.reduce(
    (sum, window) => sum + Math.max(window.end - window.start, 0),
    0,
  );

  // overheadMs, instrumentedSpanMs and ratio come from one value that is
  // null for all three together (CONV-5, module doc) — not three
  // independent ternaries a later edit could let disagree, e.g. an
  // instrumented population whose merged window happens to sum to zero.
  const measured =
    instrumentedTaskCount === 0 || instrumentedSpanMsRaw === 0
      ? null
      : {
          overheadMs: contextAssemblyMs,
          instrumentedSpanMs: instrumentedSpanMsRaw,
          ratio: contextAssemblyMs / instrumentedSpanMsRaw,
        };

  const overheadMs = measured === null ? null : measured.overheadMs;
  const instrumentedSpanMs = measured === null ? null : measured.instrumentedSpanMs;
  const ratio = measured === null ? null : measured.ratio;

  const coverage =
    settledTaskCount === 0 ? null : instrumentedTaskCount / settledTaskCount;

  return {
    runId: run.runId,
    overheadMs,
    instrumentedSpanMs,
    ratio,
    observedMs,
    coverage,
    components: {
      contextAssemblyMs,
      contextAssemblyCount,
      instrumentedTaskCount,
      settledTaskCount,
      nonApiSessionMs,
      sessionsWithDuration,
    },
    unmeasured: NFR3_UNOBSERVABLE_SPANS,
  };
}
