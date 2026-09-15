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
 * **The numerator is population-matched to what produced it — at round
 * granularity, not just task granularity.** `overheadMs` is `Σ
 * ContextAssembled.durationMs` over exactly the settled *rounds* that carry
 * at least one such event — never over tasks, or rounds of a task, this log
 * cannot show a span for, and never diluted by rounds the numerator says
 * nothing about. An earlier revision divided that sum by the busy span of
 * *every* settled task, regardless of how few of them were actually
 * instrumented: over this repository's own `run-1`, where exactly one of 230
 * sessions carries a recorded duration, that produced `ratio: 0.0000617` — a
 * confident NFR-3 pass manufactured by 229 tasks the numerator never
 * measured, while the one task that *was* measured ran at 4.7% overhead by
 * this same formula. That is the "unmeasured, not 0%" discipline turned
 * upside down: a mostly-uninstrumented log must not read as a mostly-lean
 * one. A second, narrower revision matched the population at task
 * granularity but still summed every *round* of an instrumented task into
 * the denominator, including rounds that carried no `ContextAssembled` of
 * their own — the first measurable run on this repository's own `run-1` is
 * exactly that shape, a task with a dozen pre-instrumentation rounds plus
 * one new, instrumented one, and dividing one round's context-assembly time
 * by all thirteen rounds' spans would understate the ratio by roughly the
 * round count on the very first comparison against the 10% threshold. Only
 * rounds that themselves carry a `ContextAssembled` go into the numerator
 * and {@link HarnessOverhead.instrumentedSpanMs} now (see the function
 * body's own comment). {@link HarnessOverhead.coverage} — instrumented tasks
 * over settled tasks — is reported alongside the ratio for exactly this
 * reason: a reader comparing `ratio` to the 10% threshold can also see how
 * much of the run it actually rests on.
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
 * `observedMs` below, and reused here) applied to only the instrumented
 * rounds' own intervals — one `[min(dispatch, contextAssembled), close)`
 * pair per round that carries a `ContextAssembled`, `close` being that
 * round's terminal event or, for a round abandoned before it ever reaches
 * one, the last timestamp any event named its `taskId` (see below) — not one
 * interval spanning a task's first dispatch to its last terminal, and not
 * every round of an instrumented task, only the ones the numerator actually
 * measured — under the same stated idle rule as `observedMs`: {@link
 * HarnessOverhead.instrumentedSpanMs}. It is smaller than the sum whenever
 * instrumented rounds' intervals overlap — concurrency correctly *shrinks*
 * the wall-clock denominator it divides into, rather than the numerator
 * growing to match it — and equal to the sum whenever they do not overlap
 * at all. Each round's start is `min`, not `dispatch` alone, because both
 * call sites append `ContextAssembled` *before* `SessionRunner.runTask`'s
 * own `TaskDispatched` (`src/state/reduce.ts`) — the context-assembly time
 * this module measures would otherwise fall outside the very window it is
 * divided by.
 *
 * **Rounds, not tasks, are the unit `mergeIntervals` is given — see the
 * function body's own comment for why.** `implement/loop.ts` redispatches
 * the same `taskId` for a CI-repair or review-rework round, sometimes from a
 * fresh `mpgm implement` invocation days after the previous round's own
 * terminal event ended it. A single `[firstDispatch, lastTerminal)` interval
 * per task — this module's own first shape — would put that gap *inside*
 * the interval `idleGapMs` is applied to, where merging can only ever widen
 * a window between separate intervals and has nothing to act on inside one
 * that was never split to begin with. This repository's own log has a real
 * case: `T3.2.1` carries 12 rounds; its second closes with `TaskCompleted`
 * at 2026-08-27T16:44:50Z and its third opens with `TaskDispatched` 70 hours
 * later, at 2026-08-30T14:32:18Z. A few hundred milliseconds of context
 * assembly divided by a denominator that swallowed those 70 hours is a false
 * NFR-3 pass built from exactly the operator-absence contamination this
 * module exists to keep out of `observedMs` (below) — round-level intervals
 * keep it out of `instrumentedSpanMs` for the same reason.
 *
 * **A round can also die without ever reaching a terminal event, and that
 * gap has to be kept out too — round-level intervals alone are not enough.**
 * This repository's own log has that case as well, inside the same task:
 * `T3.2.1`'s round opens with `TaskDispatched` at 2026-08-30T14:32:18.781Z,
 * its last logged activity (`ToolCallLogged`) is at 14:32:49.793Z, and the
 * next event for that `taskId` — another `TaskDispatched`, no terminal event
 * in between — arrives 2026-08-31T10:38:05.683Z, 20.1 hours later. A round
 * that only opens on `TaskDispatched`/`ContextAssembled` and closes on a
 * terminal event has no way to end this one before the redispatch, so the
 * entire 20.1-hour gap would land inside it. The fix does not use a gap
 * threshold to detect this: within one round, `ContextAssembled` always
 * precedes that round's own `TaskDispatched` (never the reverse, both call
 * sites), and a round carries at most one of each, so once a round has
 * recorded its own `TaskDispatched` *or* its own `ContextAssembled`, any
 * further occurrence of *either* for that `taskId` cannot belong to it — it
 * can only open the next round. The rule is symmetric on purpose: a round
 * opened by `ContextAssembled` that never reaches its own `TaskDispatched`
 * (the process dies first, or `track` returns blocked without dispatching)
 * would otherwise stay open across a later invocation's `ContextAssembled`
 * for the same `taskId`, landing that gap inside `instrumentedSpanMs` — the
 * ratio's own denominator — rather than in `observedMs`. That round is
 * closed right there, at the last timestamp *any* event actually named this
 * `taskId` (not only the ones this module otherwise switches on —
 * `ToolCallLogged` included), so `T3.2.1`'s stale round closes at
 * 14:32:49.793Z, 31 seconds long, and the 20.1-hour gap falls between two
 * intervals, where `idleGapMs` can act on it. See the function body's own
 * comment for the full argument, including why a gap-size threshold was
 * deliberately not used instead.
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
 * Instead it is the union of every settled task's own *round* intervals
 * (same start rule and same per-round shape as `instrumentedSpanMs` above —
 * not one interval per task spanning every round, for the same reason),
 * merged by a stated idle rule ({@link HarnessOverheadOptions.idleGapMs}):
 * two intervals separated by a gap no larger than `idleGapMs` count as one
 * continuous busy window; a larger gap is idle time and excluded. The
 * default, `0`, merges only intervals that literally overlap or touch;
 * raising it pulls short between-round gaps into the window instead — the
 * time between one round's `TaskCompleted`/`TaskBlocked` and the next
 * round's `TaskDispatched` for the same taskId, as much as the gap between
 * two different tasks — and `observedMs` moves when it does, because the
 * window it sums changed and the events did not.
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
 * copy of this repository's own self-hosted `run-1` (13,263 events,
 * 2026-08-27T12:50:35Z to 2026-09-15T20:54:05Z) this function reports
 * `ratio: null` — every `ContextAssembled` event in this codebase is new
 * with this task, and the long-running process behind that log predates it,
 * so nothing yet brackets context assembly for it. `observedMs` alone is
 * already informative: merging that run's settled tasks' own *round*
 * intervals (idle rule at its default, mid-round abandonment splits applied)
 * gives a busy span of ~101,519,318ms, about 1.17 days, inside a run whose
 * raw `startedAt`-to-last-event span is about 19.3 days.
 *
 * Two coarser shapes were checked against the same real log and rejected,
 * in order. One interval per task spanning its first dispatch to its last
 * terminal — this module's very first shape — reported ~1,121,386,912ms,
 * about 13.0 days, because several of this run's own tasks (`T3.2.1` among
 * them) are redispatched across separate `mpgm implement` invocations days
 * apart and a task-wide interval folds the gap between those invocations
 * into its own span. Splitting into round-level intervals but only ever
 * opening a new one on a terminal event closing the last — the shape before
 * the mid-round-abandonment fix above — reported ~178,074,567ms, about 2.06
 * days: smaller, but still contaminated by every round a process died in
 * before reaching a terminal event, `T3.2.1`'s own 20.1-hour gap among them.
 * Verified directly against this repository's own log with the fix in
 * place: no round interval exceeds 1,516,879ms (about 25 minutes), and none
 * of this run's 241 rounds is longer than an hour — the multi-hour and
 * multi-day gaps this log actually contains now all fall *between* rounds,
 * where `idleGapMs` can act on them, rather than inside one. Most of even
 * the smallest figure is genuine concurrent/sequential busy work, not
 * operator absence; the two coarser shapes overstated it by counting first
 * days, then hours, of idle time as busy.
 *
 * Because `overheadMs` is null — this log predates the instrumentation
 * that would populate it — this real run cannot be compared to the 10%
 * threshold, and so neither confirms nor contradicts ADR-1's claim.
 * **That comparison is not completed by this change.** It requires a run
 * that dispatches at least one task under this task's own code, which is an
 * operator action (starting `mpgm implement`) this change does not itself
 * take; the criterion is reported here as met for every log inspectable
 * today and open against the one that is not, rather than declared met by
 * relaxing the wording that asks for it. ADR-1 is cited here either way:
 * nothing this module has measured so far is evidence against it, and
 * nothing in this module is exempt from being evidence against it the first
 * time a real ratio comes back over threshold, with enough coverage to
 * trust.
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
   * *rounds* {@link HarnessOverhead.overheadMs} is built from (module doc) —
   * not a run-wide total including tasks or rounds the ratio never counted,
   * and not diluted by an instrumented task's own uninstrumented rounds.
   */
  readonly contextAssemblyMs: number;
  readonly contextAssemblyCount: number;
  /** Settled tasks with at least one round that carries a `ContextAssembled` event. */
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
   * The ratio's own denominator (module doc): the merged union of only the
   * *instrumented rounds'* own intervals — one per round that carries a
   * `ContextAssembled`, not one per dispatch-to-terminal round a taskId
   * carries and not one spanning every round of a task — under the same
   * idle rule as `observedMs`, population-matched to `overheadMs` at round
   * granularity — never summed (module doc: summing understates NFR-3's own
   * wall-clock fraction by up to the concurrency factor, because
   * `assembleContext` is synchronous). A round's interval ends at its
   * terminal event, or, if the round was abandoned before reaching one, at
   * the last timestamp any event named its `taskId` (module doc, function
   * body). Null when no round was instrumented. Computed together with
   * `overheadMs` and `ratio` from one value that is null for all three at
   * once (CONV-5, module doc).
   */
  readonly instrumentedSpanMs: number | null;
  /**
   * `overheadMs / instrumentedSpanMs`. Null whenever either side is null;
   * computed alongside them from the same value, not by an independent
   * zero/null check (CONV-5, module doc).
   */
  readonly ratio: number | null;
  /**
   * The run's own busy span (module doc) — the merged union of every settled
   * task's own *round* intervals (one per dispatch-to-terminal round, or per
   * round abandoned before a terminal event, not one spanning every round a
   * redispatched task ran) under the stated idle rule, instrumented or not.
   * Informational: not the ratio's denominator, because it is not
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
   * The idle rule `observedMs` *and* `instrumentedSpanMs` both merge their
   * round intervals under (module doc): two busy intervals no more than this
   * far apart merge into one continuous window; a larger gap is idle and
   * excluded. Defaults to `0` — only literally overlapping or touching
   * intervals merge. Raising it can move `ratio` as well as `observedMs`:
   * `instrumentedSpanMs` merges under the same rule, so a wider `idleGapMs`
   * can pull two of an instrumented task's own rounds together and change
   * the denominator `ratio` divides by.
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
 * merged (by round, not by task) rather than summed, and what this cannot
 * see.
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

  // One interval per dispatch-to-terminal *round*, not one interval per task
  // spanning every round it ever ran. `implement/loop.ts` redispatches the
  // same `taskId` under its own key for a CI-repair or review-rework round —
  // sometimes from a fresh `mpgm implement` invocation days after the
  // previous round's own terminal event (this repository's own log: T3.2.1's
  // `TaskCompleted` at 2026-08-27T16:44:50Z, its next `TaskDispatched` at
  // 2026-08-30T14:32:18Z, 70 hours later, both under `taskId: T3.2.1`).
  // Collapsing to `[firstDispatch, lastTerminal]` — an earlier revision's
  // mistake — would put that gap inside the very denominator `idleGapMs` is
  // meant to keep out: merging only ever widens a window *between*
  // intervals, and a single task-wide interval already has nothing outside
  // itself to be merged with, so `idleGapMs` could never split it back out.
  //
  // A round opens on whichever of `ContextAssembled` or `TaskDispatched`
  // comes first (both call sites append the former before the latter,
  // module doc) and closes on the next terminal event for that `taskId`.
  // But a round can also die without ever reaching a terminal event — the
  // process is killed, the machine sleeps, the operator walks away mid
  // session — and this repository's own log has exactly that case: T3.2.1's
  // round opened by `TaskDispatched` at 2026-08-30T14:32:18.781Z, its last
  // `ToolCallLogged` at 14:32:49.793Z, then *another* `TaskDispatched` for
  // the same `taskId` at 2026-08-31T10:38:05.683Z with no terminal event in
  // between. `openRound` used to no-op on that second dispatch — a round
  // already open for this `taskId` was treated as "nothing to do" — so the
  // 20.1-hour gap stayed inside the one interval that eventually closed,
  // exactly the operator-absence contamination this module exists to keep
  // out, just moved one level down from task to round.
  //
  // The fix does not use a gap threshold to decide this, because ordering
  // alone already gives an unambiguous signal: within one round,
  // `ContextAssembled` always precedes that round's own `TaskDispatched`
  // (module doc), never the reverse, and a round carries at most one of each
  // — one `TaskDispatched` and one `ContextAssembled` per call-site
  // invocation. So once an open round has recorded its own `TaskDispatched`
  // *or* its own `ContextAssembled`, any further occurrence of *either* for
  // that same `taskId` cannot belong to it — it can only be the opening
  // event of the next round. This has to hold for both halves of the pair,
  // not just the dispatched half: a round opened by `ContextAssembled` that
  // never reaches its own `TaskDispatched` (the process dies before
  // `SessionRunner.runTask` is ever called, or `track` returns blocked
  // without dispatching because the run is paused or killed) would otherwise
  // stay open indefinitely, and a later invocation's `ContextAssembled` for
  // the same `taskId` would merely extend it — landing the entire gap
  // between the two invocations inside `instrumentedSpanMs`, the numerator's
  // own denominator, rather than in `observedMs` where the dispatched-side
  // split already keeps it out. The stale round is closed right there, not
  // at the new event's own timestamp but at the last timestamp any event
  // actually named this `taskId` (`lastActivityTs`, updated by every event
  // carrying this `taskId`, not only the ones this module otherwise switches
  // on — `ToolCallLogged` included, which is what T3.2.1's real gap is
  // bounded by) — so the interval that closes is `[start, 14:32:49.793Z)`,
  // 31 seconds, and the 20.1-hour gap to the next `TaskDispatched` falls
  // *between* two intervals, where `idleGapMs` can act on it, rather than
  // inside one that was never split to begin with. A gap-size threshold was
  // deliberately not used for this decision: this same log has a normal
  // round where `ContextAssembled` precedes its own `TaskDispatched` by five
  // real seconds (T4.2.8's own instrumentation timing this call before
  // `SessionRunner.runTask`), and a threshold at or below `idleGapMs`'s
  // default of `0` would have split that round in two as well, which would
  // be wrong — the ordering rule tells the difference where a gap size
  // cannot.
  interface OpenRound {
    readonly start: number;
    lastActivityTs: number;
    dispatched: boolean;
    contextMs: number;
    contextCount: number;
  }
  interface RoundRecord {
    readonly interval: Interval;
    readonly contextMs: number;
    readonly contextCount: number;
  }

  const openRounds = new Map<string, OpenRound>();
  const roundsByTask = new Map<string, RoundRecord[]>();

  const pushRound = (taskId: string, round: OpenRound, endTs: number): void => {
    const record: RoundRecord = {
      interval: { start: round.start, end: endTs },
      contextMs: round.contextMs,
      contextCount: round.contextCount,
    };
    const existing = roundsByTask.get(taskId);
    if (existing === undefined) {
      roundsByTask.set(taskId, [record]);
    } else {
      existing.push(record);
    }
  };

  // Touches every open round's `lastActivityTs` — called for every event
  // that names this `taskId`, not only `TaskDispatched`/`ContextAssembled`/
  // the terminal events, so a round abandoned mid-session is split at the
  // last real activity it produced (e.g. `ToolCallLogged`) rather than at
  // its own opening timestamp.
  const touch = (taskId: string, ts: string): void => {
    const open = openRounds.get(taskId);
    if (open !== undefined) {
      open.lastActivityTs = Date.parse(ts);
    }
  };

  // Opens a round for a `TaskDispatched` or `ContextAssembled` event. If a
  // round is already open for this `taskId` and has *not yet* recorded its
  // own `TaskDispatched`, this is that round's own opening pair (whichever
  // of the two arrives second) — extend it, do not split. If a round is
  // already open and already dispatched, this event cannot belong to it
  // (see the ordering argument above) — close the stale round at its own
  // `lastActivityTs` and open a fresh one here.
  const openOrSplitRound = (
    taskId: string,
    ts: string,
    marksDispatch: boolean,
  ): OpenRound => {
    const tsMs = Date.parse(ts);
    const open = openRounds.get(taskId);
    if (open === undefined) {
      const fresh: OpenRound = {
        start: tsMs,
        lastActivityTs: tsMs,
        dispatched: marksDispatch,
        contextMs: 0,
        contextCount: 0,
      };
      openRounds.set(taskId, fresh);
      return fresh;
    }
    // Split on either half of the ordering argument, not just the dispatch
    // half: a round already carries at most one `TaskDispatched` *or* one
    // `ContextAssembled` of its own (module doc), so a further occurrence of
    // *either* for this taskId cannot belong to the open round — it can only
    // open the next one. Splitting only on `open.dispatched` left a round
    // opened by `ContextAssembled` that never reaches its own
    // `TaskDispatched` (the process dies, or `track` returns blocked without
    // dispatching) open indefinitely: a later invocation's `ContextAssembled`
    // for the same taskId merely extended it, and the whole gap between the
    // two invocations landed inside `instrumentedSpanMs` — the same
    // contamination the dispatched-side split fixes, one step earlier and
    // inside the ratio's own denominator rather than in `observedMs`.
    if (open.dispatched || (!marksDispatch && open.contextCount > 0)) {
      pushRound(taskId, open, open.lastActivityTs);
      const fresh: OpenRound = {
        start: tsMs,
        lastActivityTs: tsMs,
        dispatched: marksDispatch,
        contextMs: 0,
        contextCount: 0,
      };
      openRounds.set(taskId, fresh);
      return fresh;
    }
    open.lastActivityTs = tsMs;
    if (marksDispatch) {
      open.dispatched = true;
    }
    return open;
  };

  const closeRound = (taskId: string, ts: string): void => {
    const open = openRounds.get(taskId);
    if (open === undefined) {
      // No round open for this taskId: `BudgetExceeded` fires twice in
      // `src/agent/runner.ts` — once as a round's *only* terminal event
      // (the ledger is exhausted before any attempt), once immediately
      // before a `TaskCompleted` that already closed this same round a
      // moment earlier. This is the second case; nothing to close.
      return;
    }
    pushRound(taskId, open, Date.parse(ts));
    openRounds.delete(taskId);
  };

  let nonApiSessionMs = 0;
  let sessionsWithDuration = 0;

  for (const event of events) {
    if (event.runId !== run.runId) {
      continue;
    }
    switch (event.type) {
      case 'TaskDispatched': {
        const payload = event.payload as TaskIdPayload;
        openOrSplitRound(payload.taskId, event.ts, true);
        break;
      }
      case 'TaskCompleted': {
        const payload = event.payload as TaskIdPayload;
        closeRound(payload.taskId, event.ts);
        break;
      }
      case 'TaskBlocked':
      case 'BudgetExceeded': {
        const payload = event.payload as TaskIdPayload;
        closeRound(payload.taskId, event.ts);
        break;
      }
      case 'ContextAssembled': {
        const payload = event.payload as ContextAssembledPayload;
        // Appended before this round's own `TaskDispatched` at both call
        // sites (module doc) — opens (or extends) the round here so the
        // span it measures falls inside the window it is divided by.
        const round = openOrSplitRound(payload.taskId, event.ts, false);
        round.contextMs += payload.durationMs;
        round.contextCount += 1;
        break;
      }
      case 'SessionUsage': {
        const payload = event.payload as SessionUsageOverheadPayload;
        if (payload.durationMs !== null && payload.apiDurationMs !== null) {
          nonApiSessionMs += Math.max(payload.durationMs - payload.apiDurationMs, 0);
          sessionsWithDuration += 1;
        }
        touch(payload.taskId, event.ts);
        break;
      }
      default: {
        // Any other event that names a taskId — ToolCallLogged chief among
        // them — extends the currently open round's last-activity mark, so
        // a round abandoned mid-session splits at real activity rather than
        // at its own opening timestamp (see the block comment above).
        const payload = event.payload as Partial<TaskIdPayload>;
        if (typeof payload.taskId === 'string') {
          touch(payload.taskId, event.ts);
        }
        break;
      }
    }
  }

  const settledIntervals: Interval[] = [];
  const instrumentedIntervals: Interval[] = [];
  let settledTaskCount = 0;
  let instrumentedTaskCount = 0;
  let contextAssemblyMs = 0;
  let contextAssemblyCount = 0;

  for (const task of Object.values(run.tasks)) {
    if (task.status !== 'completed' && task.status !== 'blocked') {
      // Not settled (or attested, with no dispatch at all): no firm end to
      // close a busy interval with, the same reason `avgLatencyMs` skips it.
      continue;
    }
    const rounds = roundsByTask.get(task.taskId);
    if (rounds === undefined || rounds.length === 0) {
      // The fold says settled but no round of this taskId closed cleanly in
      // this event slice (e.g. events filtered to a window that cuts a
      // round off mid-way) — nothing this module can time.
      continue;
    }

    settledTaskCount += 1;
    settledIntervals.push(...rounds.map((round) => round.interval));

    // Population-matched at *round* granularity, not just task granularity:
    // only the rounds that themselves carry a `ContextAssembled` go into
    // `instrumentedIntervals` and the numerator. A task with a dozen
    // pre-instrumentation rounds and one new, instrumented one must not have
    // that one round's context-assembly time divided by all thirteen
    // rounds' spans — the same dilution this module's own doc already
    // rejects at task granularity (the 1-of-230 example), left uncaught one
    // level down would understate the ratio by roughly the round count on
    // the very first comparison against the 10% threshold.
    const instrumentedRounds = rounds.filter((round) => round.contextCount > 0);
    if (instrumentedRounds.length > 0) {
      instrumentedTaskCount += 1;
      instrumentedIntervals.push(...instrumentedRounds.map((round) => round.interval));
      for (const round of instrumentedRounds) {
        contextAssemblyMs += round.contextMs;
        contextAssemblyCount += round.contextCount;
      }
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
