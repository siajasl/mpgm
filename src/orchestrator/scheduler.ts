/**
 * Bounded-concurrency scheduler (ORC-3, DESIGN §4.1).
 *
 * Dispatches steps whose dependencies have completed, never more than the
 * configured limit at once. It knows nothing about sessions, artifacts or the
 * event log: it takes a dependency graph and a function that runs one step,
 * which is what makes the concurrency bound testable without a model call.
 *
 * The limit is configuration, not an architectural ceiling (NFR-3).
 */

export interface SchedulableStep {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export type StepOutcome<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'blocked'; readonly reason: string };

/** Why the scheduler stopped dispatching, when something asked it to. */
export type DispatchDecision =
  { readonly proceed: true } | { readonly proceed: false; readonly reason: string };

export interface ScheduleRequest<S extends SchedulableStep, T> {
  readonly steps: readonly S[];
  /** Maximum steps in flight at once. At least 1. */
  readonly concurrency: number;
  readonly run: (step: S) => Promise<StepOutcome<T>>;
  /**
   * Consulted immediately before each dispatch. Returning `proceed: false`
   * stops new work; steps already in flight are allowed to finish, because
   * abandoning a session that has already been paid for buys nothing.
   */
  readonly shouldDispatch?: () => DispatchDecision;
}

export interface BlockedStep {
  readonly id: string;
  readonly reason: string;
}

export interface ScheduleReport<T> {
  /**
   * `completed` — every step ran and succeeded. `blocked` — at least one step
   * blocked. `stopped` — `shouldDispatch` halted the schedule.
   */
  readonly status: 'completed' | 'blocked' | 'stopped';
  /** Step id → its value, for steps that completed. */
  readonly results: ReadonlyMap<string, T>;
  readonly blocked: readonly BlockedStep[];
  /** Set when the status is `stopped`. */
  readonly stoppedReason?: string;
  /** Steps that never ran, in declaration order. */
  readonly skipped: readonly string[];
  /** The greatest number of steps in flight at any moment. */
  readonly peakInFlight: number;
}

export class SchedulerError extends Error {}

/**
 * Run a dependency graph with bounded concurrency.
 *
 * On the first blocked step the scheduler stops dispatching new work. Its
 * dependants can never run, and dispatching *other* branches after a phase is
 * already going to the operator blocked spends money on a result nobody will
 * act on before the block is resolved. Steps already in flight still finish.
 */
export async function schedule<S extends SchedulableStep, T>(
  request: ScheduleRequest<S, T>,
): Promise<ScheduleReport<T>> {
  const { steps, concurrency, run } = request;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new SchedulerError(
      `concurrency must be an integer of at least 1, got ${String(concurrency)}`,
    );
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) {
    throw new SchedulerError('steps contain duplicate ids');
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        throw new SchedulerError(
          `step '${step.id}' depends on '${dependency}', which is not in the graph`,
        );
      }
    }
  }

  const results = new Map<string, T>();
  const blocked: BlockedStep[] = [];
  const pending = new Set(steps.map((step) => step.id));
  const inFlight = new Map<string, Promise<string>>();
  let peakInFlight = 0;
  let halted = false;
  let stoppedReason: string | undefined;

  const ready = (): S[] =>
    // Declaration order, so that which steps go first is a property of the
    // playbook rather than of Map iteration or of how fast the last batch ran.
    steps.filter(
      (step) =>
        pending.has(step.id) &&
        step.dependsOn.every((dependency) => results.has(dependency)),
    );

  while (pending.size > 0 || inFlight.size > 0) {
    while (!halted && inFlight.size < concurrency) {
      const next = ready()[0];
      if (next === undefined) {
        break;
      }

      const decision = request.shouldDispatch?.() ?? { proceed: true };
      if (!decision.proceed) {
        halted = true;
        stoppedReason = decision.reason;
        break;
      }

      pending.delete(next.id);
      const settled = run(next).then(
        (outcome) => {
          if (outcome.status === 'completed') {
            results.set(next.id, outcome.value);
          } else {
            blocked.push({ id: next.id, reason: outcome.reason });
            halted = true;
          }
          return next.id;
        },
        (cause: unknown) => {
          // A throwing runner is a defect in the runner, not a blocked task,
          // but the schedule must still wind down rather than hang on it.
          blocked.push({
            id: next.id,
            reason: `step runner threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
          halted = true;
          return next.id;
        },
      );
      inFlight.set(next.id, settled);
      peakInFlight = Math.max(peakInFlight, inFlight.size);
    }

    if (inFlight.size === 0) {
      break;
    }

    const finished = await Promise.race(inFlight.values());
    inFlight.delete(finished);
  }

  const skipped = steps.filter((step) => pending.has(step.id)).map((step) => step.id);

  const status =
    blocked.length > 0 ? 'blocked' : skipped.length > 0 ? 'stopped' : 'completed';

  return {
    status,
    results,
    blocked,
    ...(stoppedReason === undefined ? {} : { stoppedReason }),
    skipped,
    peakInFlight,
  };
}
