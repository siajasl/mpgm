import type { StoredEvent } from '../event/envelope.js';
import type { RunState, TaskStatus } from './kernel-state.js';

/**
 * Metrics projections (DESIGN §4.5, OBS-2).
 *
 * `RunState` already folds cost and retry counts onto each task
 * (`usage.costUsd`, `validationFailures`), but it folds away two things a
 * metrics report needs and a scheduling decision does not: which phase was
 * current when a task was dispatched, and how long the task took. Neither
 * survives the reducer, because neither is needed to run the harness — only
 * to report on it. So this reads the run's own event slice a second time,
 * against the timestamps the store already stamped on every event, rather
 * than growing `TaskState` with fields the kernel itself never asks.
 */

/** One bucket's counted result — a phase, a role, or a whole run. */
export interface AggregateMetric {
  readonly tasks: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Summed cache-read input tokens across every session in the bucket that
   * recorded one (T4.3.15, OBS-2) — cheaper than an uncached input token,
   * and reported alongside it rather than folded into it so the breakdown
   * survives into `mpgm status --metrics`.
   *
   * Null only when *no* session in the bucket recorded the field — the same
   * "nothing to report yet" reading `successRate`/`avgLatencyMs` already
   * give a bucket with nothing settled. A bucket with a mix of sessions that
   * did and did not (a run spanning this task's own landing, say) is not
   * tainted to null by the ones that did not: this is deliberately *not*
   * the null-wins discipline `Usage.cacheReadInputTokens`
   * (`src/state/kernel-state.ts`) uses for folding one session's own usage
   * onto a task — there, null means *that session's* value is unknown, and
   * nothing recorded can fill it in. Here, a bucket is many sessions, most
   * of which usually did record it, and reading the whole bucket as unknown
   * because one did not throws away a real number the bucket after this
   * change will always recover from. {@link cacheReadUnrecordedSessions}
   * says how many sessions contributed nothing to the sum, so a reader can
   * tell a fully-measured bucket from a partly-measured one even though
   * both render a number.
   */
  readonly cacheReadInputTokens: number | null;
  /**
   * Count of sessions folded into this bucket that predate T4.3.15 (or
   * folded a v2 `SessionUsage` the upcaster mapped to null) and so
   * contributed nothing to {@link cacheReadInputTokens}. Zero does not mean
   * the bucket is fully measured by itself — pair it with `tasks`/session
   * counts elsewhere on this metric if that matters — it means no session
   * in the bucket was *known* to be missing the field.
   */
  readonly cacheReadUnrecordedSessions: number;
  /** Same discipline as {@link AggregateMetric.cacheReadInputTokens}. */
  readonly cacheCreationInputTokens: number | null;
  /** Same discipline as {@link AggregateMetric.cacheReadUnrecordedSessions}. */
  readonly cacheCreationUnrecordedSessions: number;
  /**
   * `validationFailures` (AGT-3 retries inside a session's own structured-
   * output loop) plus every re-dispatch of the task's own `taskId` beyond
   * its first — a CI repair round or a review-rework round, each of which
   * `implement/loop.ts` sends back through `sessions.runTask` under the same
   * `taskId` and so appends its own `TaskDispatched`. A task repaired three
   * times and reworked twice reports 5, not 0: those rounds are retries an
   * operator means by the word even though no session inside them failed to
   * produce usable structured output.
   */
  readonly retries: number;
  readonly completed: number;
  readonly blocked: number;
  /** Attested outside the harness — neither a success nor a failure of it. */
  readonly attested: number;
  /** Dispatched, with no terminal event yet. */
  readonly dispatched: number;
  /**
   * The gated Plan artifact no longer declares this id (T4.3.7, PLN-4) — the
   * work is real and its cost (below) is still counted, but the id itself
   * can never become `completed`, so it is excluded from `successRate`'s
   * denominator the same way `attested` already is, rather than sitting
   * there as a permanent failure `aggregate()` can never settle.
   */
  readonly superseded: number;
  /**
   * `completed / (completed + blocked)`. Null when neither has happened yet,
   * so an empty bucket reads as "nothing to report" rather than as 0%.
   */
  readonly successRate: number | null;
  /**
   * Mean of `end - firstDispatch` over tasks that reached a terminal status,
   * where `firstDispatch` is the *earliest* `TaskDispatched` a task's own
   * `taskId` carries, not the latest. `implement/loop.ts` re-dispatches the
   * same `taskId` for every CI repair round and every review-rework round,
   * so the latest dispatch is only the final session — using it would report
   * a four-session task's latency as the duration of its last session alone.
   * Null when none have, for the same reason `successRate` is nullable.
   */
  readonly avgLatencyMs: number | null;
}

export interface RunMetrics {
  readonly runId: string;
  readonly overall: AggregateMetric;
  /** Phase the task's dispatch fell under. Never empty-keyed: a task
   * dispatched before any `PhaseEntered` is grouped under `'(none)'` rather
   * than silently dropped. */
  readonly byPhase: Readonly<Record<string, AggregateMetric>>;
  readonly byRole: Readonly<Record<string, AggregateMetric>>;
  /**
   * One task per bucket, keyed by `taskId` — the run's own event slice is
   * the only place a repaired or reworked task's *total* spend survives
   * (see `usageByTask` in `collectFacts`). The dashboard's per-task spend
   * column reads `costUsd` from here rather than `TaskState.usage`, which
   * `reduce.ts` resets to zero on every `TaskDispatched` and so holds only
   * the task's last session.
   */
  readonly byTask: Readonly<Record<string, AggregateMetric>>;
}

const NO_PHASE = '(none)';

/**
 * One cache-token field's running total across however many sessions have
 * been folded into it so far (T4.3.15) — the sum of every session that
 * recorded the field, plus a count of the sessions that did not, kept apart
 * rather than collapsed into a single nullable number until the very last
 * step (`settleTally` below). Keeping the two separate through every fold in
 * this module (a task's own sessions in `collectFacts`, then tasks into a
 * bucket in `aggregate`) is what lets a bucket mixing recorded and
 * unrecorded sessions still report the recorded sum instead of tainting to
 * null the moment one session in it did not record the field.
 */
interface CacheTally {
  readonly tokens: number;
  readonly recordedSessions: number;
  readonly unrecordedSessions: number;
}

const EMPTY_CACHE_TALLY: CacheTally = {
  tokens: 0,
  recordedSessions: 0,
  unrecordedSessions: 0,
};

/** Folds one `SessionUsage` payload's cache field into a running tally. */
function tallySession(tally: CacheTally, value: number | null): CacheTally {
  return value === null
    ? { ...tally, unrecordedSessions: tally.unrecordedSessions + 1 }
    : {
        tokens: tally.tokens + value,
        recordedSessions: tally.recordedSessions + 1,
        unrecordedSessions: tally.unrecordedSessions,
      };
}

/** Folds one task's (or bucket's) tally into another at the same grain. */
function combineTally(a: CacheTally, b: CacheTally): CacheTally {
  return {
    tokens: a.tokens + b.tokens,
    recordedSessions: a.recordedSessions + b.recordedSessions,
    unrecordedSessions: a.unrecordedSessions + b.unrecordedSessions,
  };
}

/** The final nullable public shape: null only when nothing was recorded. */
function settleTally(tally: CacheTally): {
  tokens: number | null;
  unrecordedSessions: number;
} {
  return {
    tokens: tally.recordedSessions === 0 ? null : tally.tokens,
    unrecordedSessions: tally.unrecordedSessions,
  };
}

interface TaskFacts {
  readonly taskId: string;
  readonly role: string;
  readonly phase: string;
  readonly status: TaskStatus;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: CacheTally;
  readonly cacheCreation: CacheTally;
  readonly retries: number;
  readonly latencyMs: number | null;
}

function collectFacts(run: RunState, events: readonly StoredEvent[]): TaskFacts[] {
  let phase: string = NO_PHASE;
  // First dispatch only (see `avgLatencyMs`): a later `TaskDispatched` for a
  // taskId already in this map is a repair or rework round, not a new task.
  const dispatchedAt = new Map<string, string>();
  const dispatchedPhase = new Map<string, string>();
  // Every `TaskDispatched` a taskId carries, including the first — one
  // dispatch is a task that ran once; a fifth is four rounds of repair or
  // rework, which is what `retries` on `AggregateMetric` counts beyond it.
  const dispatchCount = new Map<string, number>();
  const completedAt = new Map<string, string>();
  // Latest of `TaskBlocked`/`BudgetExceeded`, either of which can be what
  // actually put a task into `blocked` (§4.5, `../state/reduce.ts`).
  const blockedAt = new Map<string, string>();
  // Summed across every `SessionUsage` a taskId carries, not read off
  // `task.usage`: `reduce.ts` rebuilds `TaskState` with `usage: zeroUsage`
  // on every `TaskDispatched`, so a repaired or reworked task's `usage`
  // holds only its last session's spend. `implement/loop.ts` re-dispatches
  // the same `taskId` for each repair and rework round, so the run's own
  // event slice — this loop's second pass, per DESIGN §4.5 — is the only
  // place the full spend survives.
  const usageByTask = new Map<
    string,
    {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheRead: CacheTally;
      cacheCreation: CacheTally;
    }
  >();

  for (const event of events) {
    if (event.runId !== run.runId) {
      continue;
    }
    switch (event.type) {
      case 'PhaseEntered':
      case 'PhaseReopened': {
        const payload = event.payload as { readonly phase: string };
        phase = payload.phase;
        break;
      }
      case 'TaskDispatched': {
        const payload = event.payload as { readonly taskId: string };
        if (!dispatchedAt.has(payload.taskId)) {
          dispatchedAt.set(payload.taskId, event.ts);
        }
        dispatchedPhase.set(payload.taskId, phase);
        dispatchCount.set(payload.taskId, (dispatchCount.get(payload.taskId) ?? 0) + 1);
        break;
      }
      case 'TaskAttested': {
        const payload = event.payload as { readonly taskId: string };
        dispatchedPhase.set(payload.taskId, phase);
        break;
      }
      case 'TaskCompleted': {
        const payload = event.payload as { readonly taskId: string };
        completedAt.set(payload.taskId, event.ts);
        break;
      }
      case 'TaskBlocked':
      case 'BudgetExceeded': {
        const payload = event.payload as { readonly taskId: string };
        blockedAt.set(payload.taskId, event.ts);
        break;
      }
      case 'SessionUsage': {
        const payload = event.payload as {
          readonly taskId: string;
          readonly costUsd: number;
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly cacheReadInputTokens: number | null;
          readonly cacheCreationInputTokens: number | null;
        };
        const prior = usageByTask.get(payload.taskId) ?? {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: EMPTY_CACHE_TALLY,
          cacheCreation: EMPTY_CACHE_TALLY,
        };
        usageByTask.set(payload.taskId, {
          costUsd: prior.costUsd + payload.costUsd,
          inputTokens: prior.inputTokens + payload.inputTokens,
          outputTokens: prior.outputTokens + payload.outputTokens,
          cacheRead: tallySession(prior.cacheRead, payload.cacheReadInputTokens),
          cacheCreation: tallySession(
            prior.cacheCreation,
            payload.cacheCreationInputTokens,
          ),
        });
        break;
      }
      default:
        break;
    }
  }

  const facts: TaskFacts[] = [];
  for (const task of Object.values(run.tasks)) {
    const start = dispatchedAt.get(task.taskId);
    // `superseded` reads `blockedAt`, never `TaskSuperseded`'s own `ts`
    // (T4.3.7, §6): the log is append-only, so superseding a task weeks
    // after it stopped cannot be backdated to sit beside whatever it last
    // did, and reading that later `ts` as `end` would report the gap since
    // real work stopped as how long the task took — replacing one wrong
    // latency with another instead of fixing it. This is where the two
    // shapes T4.3.7 names actually differ: a task that reached
    // `TaskBlocked`/`BudgetExceeded` before being superseded (T4.1.4's own
    // shape) has a `blockedAt` entry and keeps the latency that terminal
    // event already measured, unchanged by what later retired its id; a
    // task superseded straight out of `dispatched`, with no terminal event
    // ever (T4.1.4-review-2's shape), has none, and reads null exactly as
    // it did before — nothing here invents a duration `TaskBlocked` was
    // never appended to measure.
    const end =
      task.status === 'completed'
        ? completedAt.get(task.taskId)
        : task.status === 'blocked' || task.status === 'superseded'
          ? blockedAt.get(task.taskId)
          : undefined;
    const latencyMs =
      start !== undefined && end !== undefined
        ? Date.parse(end) - Date.parse(start)
        : null;

    // A task an operator recorded merged by hand (T4.2.15) reads `blocked`
    // here — that is the harness's own outcome, and `latencyMs` above still
    // measures how long it took to reach it — but counting it against
    // `successRate` below would count a change that is on the trunk as a
    // failure of the implementer that wrote it, which is exactly the wrong
    // figure this task exists to fix. Only `blocked` is remapped: a task
    // still `dispatched` or genuinely `blocked` with no merge stays exactly
    // that.
    const status: TaskStatus =
      task.status === 'blocked' && task.merged !== null ? 'completed' : task.status;

    // `dispatchCount - 1`: the first dispatch is the task running once, not
    // a retry of itself. An attested task never dispatches at all, so this
    // floors at 0 rather than reading -1.
    const redispatches = Math.max((dispatchCount.get(task.taskId) ?? 0) - 1, 0);
    const usage = usageByTask.get(task.taskId) ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: EMPTY_CACHE_TALLY,
      cacheCreation: EMPTY_CACHE_TALLY,
    };

    facts.push({
      taskId: task.taskId,
      role: task.role === '' ? '(attested)' : task.role,
      phase: dispatchedPhase.get(task.taskId) ?? NO_PHASE,
      status,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheCreation,
      retries: task.validationFailures + redispatches,
      latencyMs,
    });
  }
  return facts;
}

function aggregate(facts: readonly TaskFacts[]): AggregateMetric {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: CacheTally = EMPTY_CACHE_TALLY;
  let cacheCreation: CacheTally = EMPTY_CACHE_TALLY;
  let retries = 0;
  let completed = 0;
  let blocked = 0;
  let attested = 0;
  let dispatched = 0;
  let superseded = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const fact of facts) {
    costUsd += fact.costUsd;
    inputTokens += fact.inputTokens;
    outputTokens += fact.outputTokens;
    cacheRead = combineTally(cacheRead, fact.cacheRead);
    cacheCreation = combineTally(cacheCreation, fact.cacheCreation);
    retries += fact.retries;
    if (fact.latencyMs !== null) {
      latencySum += fact.latencyMs;
      latencyCount += 1;
    }
    switch (fact.status) {
      case 'completed':
        completed += 1;
        break;
      case 'blocked':
        blocked += 1;
        break;
      case 'attested':
        attested += 1;
        break;
      case 'dispatched':
        dispatched += 1;
        break;
      case 'superseded':
        superseded += 1;
        break;
    }
  }

  const settled = completed + blocked;
  const read = settleTally(cacheRead);
  const creation = settleTally(cacheCreation);
  return {
    tasks: facts.length,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: read.tokens,
    cacheReadUnrecordedSessions: read.unrecordedSessions,
    cacheCreationInputTokens: creation.tokens,
    cacheCreationUnrecordedSessions: creation.unrecordedSessions,
    retries,
    completed,
    blocked,
    attested,
    dispatched,
    superseded,
    successRate: settled === 0 ? null : completed / settled,
    avgLatencyMs: latencyCount === 0 ? null : latencySum / latencyCount,
  };
}

function groupBy(
  facts: readonly TaskFacts[],
  key: (fact: TaskFacts) => string,
): Record<string, AggregateMetric> {
  const buckets = new Map<string, TaskFacts[]>();
  for (const fact of facts) {
    const bucketKey = key(fact);
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, [fact]);
    } else {
      bucket.push(fact);
    }
  }
  const result: Record<string, AggregateMetric> = {};
  for (const [bucketKey, bucket] of buckets) {
    result[bucketKey] = aggregate(bucket);
  }
  return result;
}

/**
 * Cost, latency, retry and success metrics for one run, by phase and by
 * role (OBS-2).
 *
 * `events` must be that run's own slice of the log — `EventLog.read({
 * runId })` — in `seq` order; a caller handing in every run's events would
 * see phases and dispatches from whichever run's `PhaseEntered` last set
 * `phase` before each task, not this run's own.
 */
export function computeRunMetrics(
  run: RunState,
  events: readonly StoredEvent[],
): RunMetrics {
  const facts = collectFacts(run, events);
  return {
    runId: run.runId,
    overall: aggregate(facts),
    byPhase: groupBy(facts, (fact) => fact.phase),
    byRole: groupBy(facts, (fact) => fact.role),
    byTask: groupBy(facts, (fact) => fact.taskId),
  };
}
