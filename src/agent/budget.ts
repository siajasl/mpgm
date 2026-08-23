import type { Budget } from '../role/definition.js';
import type { SessionResult, SessionUsageReport } from './session.js';

/**
 * Budget enforcement (AGT-4, DESIGN §4.1).
 *
 * The SDK enforces per-session cost and turn limits of its own, but a task may
 * run several sessions when output fails validation. Only the kernel sees the
 * total, so the kernel is where the task-level bound lives.
 */

export type BudgetKind = 'tokens' | 'cost' | 'steps' | 'wallClock';

export interface BudgetBreach {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly observed: number;
}

/** Milliseconds since some fixed origin. Injectable so elapsed time is testable. */
export type Now = () => number;

export class BudgetLedger {
  readonly #budget: Budget;
  readonly #now: Now;
  readonly #startedAtMs: number;

  #tokens = 0;
  #costUsd = 0;
  #steps = 0;

  constructor(budget: Budget, now: Now = () => Date.now()) {
    this.#budget = budget;
    this.#now = now;
    this.#startedAtMs = now();
  }

  record(usage: SessionUsageReport, turns: number): void {
    this.#tokens += usage.inputTokens + usage.outputTokens;
    this.#costUsd += usage.costUsd;
    this.#steps += turns;
  }

  get elapsedSeconds(): number {
    return (this.#now() - this.#startedAtMs) / 1000;
  }

  /** The first bound exceeded, or null. Checked in the order that matters most. */
  breach(): BudgetBreach | null {
    if (this.#costUsd > this.#budget.costUsd) {
      return { kind: 'cost', limit: this.#budget.costUsd, observed: this.#costUsd };
    }
    if (this.#tokens > this.#budget.tokens) {
      return { kind: 'tokens', limit: this.#budget.tokens, observed: this.#tokens };
    }
    if (this.#steps > this.#budget.steps) {
      return { kind: 'steps', limit: this.#budget.steps, observed: this.#steps };
    }
    const elapsed = this.elapsedSeconds;
    if (elapsed > this.#budget.wallClockSeconds) {
      return {
        kind: 'wallClock',
        limit: this.#budget.wallClockSeconds,
        observed: elapsed,
      };
    }
    return null;
  }

  /** Budget left for the next session, never negative. */
  get remainingCostUsd(): number {
    return Math.max(0, this.#budget.costUsd - this.#costUsd);
  }

  get remainingSteps(): number {
    return Math.max(0, this.#budget.steps - this.#steps);
  }

  get remainingSeconds(): number {
    return Math.max(0, this.#budget.wallClockSeconds - this.elapsedSeconds);
  }
}

/**
 * Run a session under a kernel-side wall-clock bound.
 *
 * The timer does not trust the session to honour its abort signal. A provider
 * that hangs -- a wedged subprocess, a socket that never closes -- would
 * otherwise stall the whole run, so the kernel stops waiting on its own
 * schedule and reports `wall_clock` regardless of what the session does next.
 */
export async function runWithWallClock(
  run: (signal: AbortSignal) => Promise<SessionResult>,
  seconds: number,
): Promise<SessionResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const expiry = new Promise<SessionResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        termination: 'wall_clock',
        structuredOutput: undefined,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        turns: 0,
        denials: [],
        errorMessage: `session exceeded its wall-clock budget of ${String(seconds)}s`,
      });
    }, seconds * 1000);
  });

  try {
    return await Promise.race([run(controller.signal), expiry]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
