import type { StoredEvent } from '../event/envelope.js';
import type { RunState } from './kernel-state.js';

/**
 * Harness overhead, against a denominator that means something (T4.2.9,
 * NFR-3, OBS-2).
 *
 * NFR-3 bounds three spans: **scheduling**, **context assembly** and
 * **validation**. This module measures the two of those the log can show a
 * span for, at all, and says plainly that it cannot see the third:
 *
 * - **Context assembly** is `ContextAssembled.durationMs`, summed
 *   (`src/event/catalog.ts`) — timed at both its call sites,
 *   `src/phase/runner.ts`'s `runSession` and `src/implement/loop.ts`, both
 *   of which call `assembleContext` before `SessionRunner.runTask` and so
 *   outside the span `SessionUsage.durationMs` covers (T4.2.8).
 * - **In-session harness work** — the `PreToolUse` policy gate, secret
 *   substitution, and the `ToolCallLogged` append made on every tool call —
 *   is `SessionUsage.durationMs - SessionUsage.apiDurationMs`, summed over
 *   every session where both are recorded. This is not one of NFR-3's three
 *   named spans; it is harness work that happens to run *inside* a session
 *   rather than around one, and it is kept as its own component
 *   ({@link HarnessOverheadComponents.sessionOverheadMs}) rather than folded
 *   silently into a total that would read as if it were "validation".
 * - **Scheduling** (`runPhase`'s own dispatch loop, `src/orchestrator/
 *   scheduler.ts`) and **validation** (the structured-output retry loop in
 *   `SessionRunner.runTask` — schema `safeParse` plus a caller's own
 *   `validate`) are never bracketed by a start/end pair anywhere in the
 *   catalog. {@link NFR3_UNOBSERVABLE_SPANS} names both, on every result,
 *   so a reader of {@link HarnessOverhead.ratio} sees what it does not cover
 *   rather than inferring NFR-3 is fully measured because a number came
 *   back (CONV-6).
 *
 * `overheadMs` is therefore `Σ ContextAssembled.durationMs + Σ
 * max(SessionUsage.durationMs - SessionUsage.apiDurationMs, 0)` — stated as
 * that formula before anything is reported, per the two spans above, and it
 * does not report a single figure that implies scheduling or validation are
 * in it.
 *
 * The denominator is deliberately not the run's own `startedAt`-to-last-
 * event span: `--run` defaults to `run-1` (`src/cli/main.ts`) and every verb
 * appends `RunStarted` only when the run does not already exist, so one run
 * id accumulates across however many separate CLI invocations an operator
 * makes over however many days — this repository's own log, self-hosted,
 * holds a single run spanning weeks, almost all of it the operator away from
 * the keyboard. Dividing overhead by that span would measure operator
 * absence, not the harness.
 *
 * Nor is it the sum of task spans (`TaskDispatched` to `TaskCompleted`/
 * `TaskBlocked`): `runPhase` schedules up to `DEFAULT_CONCURRENCY` (4,
 * `src/phase/runner.ts`) tasks at once, and separate CLI invocations against
 * the same run id can overlap in wall-clock time too, so summing spans
 * double- (or many-times-) counts the same stretch of wall-clock time. Over
 * this repository's own log that sum is more than twice the run's actual
 * span, which would make the reported overhead go negative once real
 * overhead is subtracted from it.
 *
 * Instead, the denominator is the union of every settled task's own
 * `[firstDispatch, terminalEvent)` interval — the same interval
 * `computeRunMetrics`'s `avgLatencyMs` uses per task (`./metrics.ts`) — with
 * overlapping or touching intervals merged into one continuous busy window.
 * That merge is the **idle rule**, and it is a parameter
 * ({@link HarnessOverheadOptions.idleGapMs}) rather than an assumption baked
 * into one number: two intervals separated by a gap no larger than
 * `idleGapMs` count as one continuous busy window; a larger gap — the days
 * between one CLI invocation and the next, or the concurrency-driven
 * overlap `runPhase` produces — is idle time and is excluded. The default,
 * `0`, merges only intervals that literally overlap or touch; raising it
 * pulls short between-dispatch gaps into the busy window instead, and the
 * reported ratio moves when it does, because the denominator it divides by
 * changed and the numerator did not.
 *
 * `ratio` is null whenever either side has nothing to report — no measured
 * overhead component, or no settled task interval — the same null
 * discipline `computeRunMetrics`'s `successRate`/`avgLatencyMs` and
 * `computeGateRates`'s gate rates already hold (CONV-6): a run whose
 * sessions carry no recorded duration (a pre-T4.2.8 log, replayed) reads as
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
 * copy of this repository's own self-hosted `run-1` (`.mpgm/state.db`, read
 * at 12,749 events, 2026-09-15) this function reports `ratio: null` —
 * unmeasured, not 0%, per the null discipline above — because that log
 * holds zero `ContextAssembled` events and zero `SessionUsage` entries with
 * both durations recorded: the long-running process driving that run
 * started before this task's instrumentation existed, and, for
 * `durationMs`/`apiDurationMs`, before T4.2.8's did too, so nothing yet
 * brackets either overhead component for it. The denominator alone is
 * already informative: merging that run's settled-task intervals (idle rule
 * at its default) gives a busy span of about 12.97 days inside a run whose
 * raw `startedAt`-to-last-event span is about 19 days — most of the run,
 * correctly excluded, was exactly the operator-absence gaps this module's
 * doc above says the raw span would wrongly charge to the harness. Because
 * the numerator is null, this real run cannot yet be compared to the 10%
 * threshold, and so neither confirms nor contradicts ADR-1's claim — that
 * comparison becomes possible only once a run proceeds under this task's
 * and T4.2.8's code together. ADR-1 is cited here either way: nothing this
 * module has measured so far is evidence against it, and nothing in this
 * module is exempt from being evidence against it the first time a real
 * ratio comes back over threshold.
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
  /** Σ `ContextAssembled.durationMs`, both call sites, this run. */
  readonly contextAssemblyMs: number;
  readonly contextAssemblyCount: number;
  /**
   * Σ `max(SessionUsage.durationMs - SessionUsage.apiDurationMs, 0)` over
   * every session this run where both are recorded. Not one of NFR-3's
   * three named spans (module doc) — kept apart so it is never mistaken for
   * "validation".
   */
  readonly sessionOverheadMs: number;
  /** Sessions this run with both `durationMs` and `apiDurationMs` recorded. */
  readonly sessionsWithDuration: number;
}

export interface HarnessOverhead {
  readonly runId: string;
  /** The numerator formula's total (module doc). Null when nothing measured it. */
  readonly overheadMs: number | null;
  /** The merged busy-window denominator (module doc). Null when no task settled. */
  readonly observedMs: number | null;
  /** `overheadMs / observedMs`. Null whenever either side is null or zero. */
  readonly ratio: number | null;
  readonly components: HarnessOverheadComponents;
  /** NFR-3 spans this figure names rather than silently omits (module doc). */
  readonly unmeasured: readonly string[];
}

export interface HarnessOverheadOptions {
  /**
   * The idle rule (module doc): two busy intervals no more than this far
   * apart merge into one continuous window; a larger gap is idle and
   * excluded from the denominator. Defaults to `0` — only literally
   * overlapping or touching intervals merge.
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
  readonly durationMs: number;
}

interface SessionUsageOverheadPayload {
  readonly durationMs: number | null;
  readonly apiDurationMs: number | null;
}

interface TaskIdPayload {
  readonly taskId: string;
}

/**
 * Harness overhead for one run (T4.2.9, NFR-3, OBS-2). See the module doc
 * for the numerator formula, the denominator's idle rule, and what this
 * cannot see.
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

  let contextAssemblyMs = 0;
  let contextAssemblyCount = 0;
  let sessionOverheadMs = 0;
  let sessionsWithDuration = 0;

  // First `TaskDispatched` only, mirroring `computeRunMetrics`'s
  // `avgLatencyMs`: a later dispatch of the same `taskId` is a CI repair or
  // review-rework round, not a new busy interval starting from scratch.
  const dispatchedAt = new Map<string, string>();
  const completedAt = new Map<string, string>();
  const blockedAt = new Map<string, string>();

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
        contextAssemblyMs += payload.durationMs;
        contextAssemblyCount += 1;
        break;
      }
      case 'SessionUsage': {
        const payload = event.payload as SessionUsageOverheadPayload;
        if (payload.durationMs !== null && payload.apiDurationMs !== null) {
          sessionOverheadMs += Math.max(payload.durationMs - payload.apiDurationMs, 0);
          sessionsWithDuration += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  const intervals: Interval[] = [];
  for (const task of Object.values(run.tasks)) {
    const start = dispatchedAt.get(task.taskId);
    const end =
      task.status === 'completed'
        ? completedAt.get(task.taskId)
        : task.status === 'blocked'
          ? blockedAt.get(task.taskId)
          : undefined;
    if (start === undefined || end === undefined) {
      // Not settled (or attested, with no dispatch at all): no firm end to
      // close a busy interval with, the same reason `avgLatencyMs` skips it.
      continue;
    }
    intervals.push({ start: Date.parse(start), end: Date.parse(end) });
  }

  const busyWindows = mergeIntervals(intervals, idleGapMs);
  const observedMs =
    busyWindows.length === 0
      ? null
      : busyWindows.reduce((sum, window) => sum + (window.end - window.start), 0);

  const measuredCount = contextAssemblyCount + sessionsWithDuration;
  const overheadMs = measuredCount === 0 ? null : contextAssemblyMs + sessionOverheadMs;

  const ratio =
    overheadMs === null || observedMs === null || observedMs === 0
      ? null
      : overheadMs / observedMs;

  return {
    runId: run.runId,
    overheadMs,
    observedMs,
    ratio,
    components: {
      contextAssemblyMs,
      contextAssemblyCount,
      sessionOverheadMs,
      sessionsWithDuration,
    },
    unmeasured: NFR3_UNOBSERVABLE_SPANS,
  };
}
