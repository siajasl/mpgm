import type { EventInput } from '../event/envelope.js';
import { canEscalate, escalateModel } from '../agent/models.js';
import { blockingReasons, type MergeVerdict } from './checks.js';

/**
 * The CI repair loop (IMP-2, NFR-1, DESIGN §4.7).
 *
 * A change that fails its merge checks goes back to the agent that wrote it,
 * with the failure attached, for a bounded number of attempts. Three things
 * make this more than a `while` loop:
 *
 * - the budget is bounded and its exhaustion is an event, not a shrug: a task
 *   that cannot be repaired is blocked and escalated, never silently dropped
 *   (NFR-1);
 * - the last attempt runs one model tier up (PLAN §3), because the cheapest
 *   thing to try before giving up is a better model, and the model is a
 *   dispatch-time parameter so this is not a role change (AGT-5);
 * - failures the agent cannot have caused do not consume the budget.
 */

export const DEFAULT_REPAIR_ATTEMPTS = 3;

export interface RepairRequest {
  readonly taskId: string;
  /** 1-based. */
  readonly attempt: number;
  readonly attemptsRemaining: number;
  /** Model this attempt runs on — one tier up on the last attempt. */
  readonly model: string;
  readonly escalated: boolean;
  /** The ref that failed. */
  readonly ref: string;
  readonly verdict: MergeVerdict;
  /** Rendered failure, ready to put in front of the agent. */
  readonly feedback: string;
}

export interface RepairOutcome {
  /** The new head ref after the fix. */
  readonly ref: string;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly model: string;
  readonly escalated: boolean;
  /** Ref the attempt started from. */
  readonly from: string;
  /** Ref it produced. */
  readonly to: string;
  readonly mergeable: boolean;
  readonly summary: string;
}

export type RepairStatus =
  /** Every required check passed. */
  | 'green'
  /** The budget ran out with checks still red. */
  | 'exhausted'
  /** Something no agent could fix from its worktree. */
  | 'unrepairable'
  /** CI never finished. */
  | 'unsettled';

export interface RepairReport {
  readonly taskId: string;
  readonly status: RepairStatus;
  readonly ref: string;
  readonly verdict: MergeVerdict;
  readonly attempts: readonly AttemptRecord[];
  /** Why it stopped, when it did not stop green. Empty when green. */
  readonly reason: string;
}

export interface RepairOptions {
  readonly runId: string;
  readonly taskId: string;
  /** Head ref of the change as first submitted. */
  readonly ref: string;
  /** Model the task was dispatched on (DESIGN §4.2). */
  readonly model: string;
  readonly maxAttempts?: number;
  /**
   * Read the verdict for a ref. Must return a *settled* verdict — see
   * `awaitChecks`. A verdict read mid-run is not an answer, and the loop
   * refuses to spend an attempt on one.
   */
  readonly checks: (ref: string) => Promise<MergeVerdict>;
  /** Run a session that tries to fix the failure and returns the new ref. */
  readonly repair: (request: RepairRequest) => Promise<RepairOutcome>;
  /** Logs of a failing check, for the feedback. Empty text is fine. */
  readonly logsFor?: (check: string, ref: string) => Promise<string>;
  /** Lines of each check's log to feed back. */
  readonly logLines?: number;
  /** Where the loop's events go. */
  readonly emit?: (event: EventInput) => Promise<void> | void;
}

export const DEFAULT_LOG_LINES = 60;

/**
 * The last lines of a log.
 *
 * The tail, because a check reports its failure at the end — a head-truncated
 * log is the setup and none of the problem.
 */
export function tail(text: string, lines: number): string {
  // `trimEnd` rather than /\s+$/: an end-anchored greedy whitespace class
  // backtracks quadratically on a long run of spaces, and CI logs are long
  // (CodeQL js/polynomial-redos).
  const all = text.trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : all.slice(-lines).join('\n');
}

/**
 * What the agent is shown.
 *
 * The instruction not to weaken the checks is not decoration: an agent told
 * only "make CI green" has an easy and catastrophic solution available to it,
 * and the review that would catch it (IMP-3) happens after this loop.
 */
export function renderFeedback(request: {
  readonly verdict: MergeVerdict;
  readonly attempt: number;
  readonly attemptsRemaining: number;
  readonly logs: ReadonlyMap<string, string>;
  readonly logLines: number;
}): string {
  const lines = [
    `The merge checks for ${request.verdict.ref} did not pass.`,
    '',
    'Blocking:',
    ...blockingReasons(request.verdict).map((reason) => `- ${reason}`),
  ];

  for (const [check, text] of request.logs) {
    if (text.trim() === '') {
      continue;
    }
    lines.push(
      '',
      `--- ${check} (last ${String(request.logLines)} lines) ---`,
      tail(text, request.logLines),
    );
  }

  lines.push(
    '',
    `This is repair attempt ${String(request.attempt)}; ${String(request.attemptsRemaining)} remain after it.`,
    '',
    'Fix the cause. Do not delete, skip, weaken or exclude a test or a check to',
    'make it pass, and do not relax a lint or type rule to silence it — if a',
    'check is itself wrong, say so in your output and leave it failing, so that',
    'a person decides rather than discovering it later in review.',
  );

  return lines.join('\n');
}

function checksReported(
  runId: string,
  taskId: string,
  verdict: MergeVerdict,
): EventInput {
  return {
    runId,
    type: 'ChecksReported',
    payload: {
      taskId,
      ref: verdict.ref,
      mergeable: verdict.mergeable,
      summary: verdict.summary,
      blocking: blockingReasons(verdict),
    },
  };
}

/**
 * Feed CI failures back to the implementing agent until they stop, the budget
 * runs out, or the failure turns out not to be the agent's to fix.
 */
export async function repairUntilGreen(options: RepairOptions): Promise<RepairReport> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  const logLines = options.logLines ?? DEFAULT_LOG_LINES;
  const emit = options.emit ?? ((): void => undefined);
  const attempts: AttemptRecord[] = [];

  let ref = options.ref;
  let verdict = await options.checks(ref);
  await emit(checksReported(options.runId, options.taskId, verdict));

  const stop = (status: RepairStatus, reason: string): RepairReport => ({
    taskId: options.taskId,
    status,
    ref,
    verdict,
    attempts,
    reason,
  });

  for (let attempt = 1; ; attempt += 1) {
    if (verdict.mergeable) {
      return stop('green', '');
    }

    // A check still running is not a failure, and repairing against one would
    // spend an attempt on a build that had not finished. The caller is meant
    // to have waited (`awaitChecks`); if it did not, stopping is right —
    // guessing at a verdict that is about to change is worse than escalating.
    if (verdict.kinds.some((kind) => kind.problem === 'pending')) {
      return stop('unsettled', `checks were still running: ${verdict.summary}`);
    }

    // Nothing failed; a required kind simply never reported. That is a CI
    // configuration the agent cannot fix from inside its worktree, and three
    // sessions spent discovering so would cost real money to produce plausible
    // nonsense. Escalate at once, naming the kinds.
    if (verdict.failing.length === 0) {
      const missing = verdict.kinds
        .filter((kind) => !kind.satisfied)
        .map((kind) => kind.kind)
        .join(', ');
      return stop(
        'unrepairable',
        `no check reported a result for: ${missing} — CI configuration, not a code failure`,
      );
    }

    if (attempt > maxAttempts) {
      await emit({
        runId: options.runId,
        type: 'BudgetExceeded',
        payload: {
          taskId: options.taskId,
          kind: 'repairs',
          limit: maxAttempts,
          observed: attempts.length,
        },
      });
      return stop(
        'exhausted',
        `retry budget of ${String(maxAttempts)} attempts exhausted`,
      );
    }

    // The final attempt runs one tier up (PLAN §3). If the model is already at
    // the top — or is one this build cannot rank — nothing moves, and the
    // record says so rather than claiming an escalation that did not happen.
    const isFinal = attempt === maxAttempts;
    const escalated = isFinal && canEscalate(options.model);
    const model = escalated ? escalateModel(options.model) : options.model;

    const logs = new Map<string, string>();
    if (options.logsFor !== undefined) {
      for (const check of verdict.failing) {
        logs.set(check, await options.logsFor(check, ref));
      }
    }

    const from = ref;
    const outcome = await options.repair({
      taskId: options.taskId,
      attempt,
      attemptsRemaining: maxAttempts - attempt,
      model,
      escalated,
      ref,
      verdict,
      feedback: renderFeedback({
        verdict,
        attempt,
        attemptsRemaining: maxAttempts - attempt,
        logs,
        logLines,
      }),
    });

    ref = outcome.ref;
    verdict = await options.checks(ref);
    await emit(checksReported(options.runId, options.taskId, verdict));
    attempts.push({
      attempt,
      model,
      escalated,
      from,
      to: ref,
      mergeable: verdict.mergeable,
      summary: verdict.summary,
    });
  }
}
