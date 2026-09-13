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
  /** Sum of `validationFailures` (AGT-3 retries inside the session loop). */
  readonly retries: number;
  readonly completed: number;
  readonly blocked: number;
  /** Attested outside the harness — neither a success nor a failure of it. */
  readonly attested: number;
  /** Dispatched, with no terminal event yet. */
  readonly dispatched: number;
  /**
   * `completed / (completed + blocked)`. Null when neither has happened yet,
   * so an empty bucket reads as "nothing to report" rather than as 0%.
   */
  readonly successRate: number | null;
  /**
   * Mean of `end - dispatch` over tasks that reached a terminal status.
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
}

const NO_PHASE = '(none)';

interface TaskFacts {
  readonly taskId: string;
  readonly role: string;
  readonly phase: string;
  readonly status: TaskStatus;
  readonly costUsd: number;
  readonly retries: number;
  readonly latencyMs: number | null;
}

function collectFacts(run: RunState, events: readonly StoredEvent[]): TaskFacts[] {
  let phase: string = NO_PHASE;
  const dispatchedAt = new Map<string, string>();
  const dispatchedPhase = new Map<string, string>();
  const completedAt = new Map<string, string>();
  // Latest of `TaskBlocked`/`BudgetExceeded`, either of which can be what
  // actually put a task into `blocked` (§4.5, `../state/reduce.ts`).
  const blockedAt = new Map<string, string>();

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
        dispatchedAt.set(payload.taskId, event.ts);
        dispatchedPhase.set(payload.taskId, phase);
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
      default:
        break;
    }
  }

  const facts: TaskFacts[] = [];
  for (const task of Object.values(run.tasks)) {
    const start = dispatchedAt.get(task.taskId);
    const end =
      task.status === 'completed'
        ? completedAt.get(task.taskId)
        : task.status === 'blocked'
          ? blockedAt.get(task.taskId)
          : undefined;
    const latencyMs =
      start !== undefined && end !== undefined
        ? Date.parse(end) - Date.parse(start)
        : null;

    facts.push({
      taskId: task.taskId,
      role: task.role === '' ? '(attested)' : task.role,
      phase: dispatchedPhase.get(task.taskId) ?? NO_PHASE,
      status: task.status,
      costUsd: task.usage.costUsd,
      retries: task.validationFailures,
      latencyMs,
    });
  }
  return facts;
}

function aggregate(facts: readonly TaskFacts[]): AggregateMetric {
  let costUsd = 0;
  let retries = 0;
  let completed = 0;
  let blocked = 0;
  let attested = 0;
  let dispatched = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const fact of facts) {
    costUsd += fact.costUsd;
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
    }
  }

  const settled = completed + blocked;
  return {
    tasks: facts.length,
    costUsd,
    retries,
    completed,
    blocked,
    attested,
    dispatched,
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
  };
}
