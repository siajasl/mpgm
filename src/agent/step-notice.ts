import type { ToolDecision, ToolGate } from './session.js';

/**
 * Tell a session it is running out of steps, while it can still act on it.
 *
 * A role's step budget is enforced by the SDK, which terminates the session
 * the moment it is reached: no final turn, no structured output, and whatever
 * the session had edited left uncommitted in its worktree. The implementer
 * role already says what to do about that — "if you cannot finish, commit what
 * you have and say in your output what remains" — but a session has no way to
 * know it is near the end, so the instruction was one it could not follow.
 * T4.1.4b's fifth session spent 121 turns and $4.92 and left 415 lines of
 * finished work uncommitted, because nothing told it to stop at 100.
 *
 * The count here is of tool calls, which is not the unit `maxTurns` bounds —
 * the two counters are different, and the kernel must not pretend otherwise
 * (see the comment on `maxTurns` in the runner). What makes a tool-call count
 * usable anyway is that it can only run *behind* the turn count, never ahead:
 * every tool call needs an assistant turn to issue it, and turns that call
 * nothing are counted by the SDK and not here. So the notice can fire late in
 * absolute terms but never later than the fraction of the budget it names,
 * and the number it reports is the one thing the kernel can defend — how many
 * calls the session has actually made.
 */
export class StepNotice {
  readonly #limit: number;
  readonly #threshold: number;
  #calls = 0;
  #given = false;

  constructor(steps: number) {
    this.#limit = steps;
    this.#threshold = thresholdFor(steps);
  }

  gate(inner: ToolGate): ToolGate {
    return async (
      tool: string,
      input: Record<string, unknown>,
    ): Promise<ToolDecision> => {
      const decision = await inner(tool, input);
      this.#calls += 1;
      if (this.#given || this.#calls < this.#threshold) {
        return decision;
      }
      this.#given = true;
      return { ...decision, notice: stepNoticeText(this.#calls, this.#limit) };
    };
  }
}

/**
 * When to speak up.
 *
 * Late enough that a session doing ordinary work is not told to wind up while
 * it still has room — the implementer sessions that finished T4.1.4b's earlier
 * rounds made 70, 91 and 109 calls against a budget of 120 — and early enough
 * that what is left covers landing the work rather than only announcing it.
 * A fifth of the budget is a dozen calls at the smallest budget any role has
 * and two dozen at the implementer's, which is a commit and a result either
 * way, with enough margin to cut scope rather than merely stop.
 */
export function thresholdFor(steps: number): number {
  return Math.max(1, Math.ceil(steps * 0.8));
}

/**
 * What the session is told.
 *
 * It names the count rather than a remainder, because the remainder is in the
 * SDK's units and this count is not — a subtraction between them would be a
 * number the kernel could not defend (CONV-3, and the same reason the runner
 * refuses to compute a step remainder across attempts). It says what happens
 * at the wall, because a session that does not know the termination is abrupt
 * has no reason to treat the warning as one.
 */
export function stepNoticeText(calls: number, limit: number): string {
  return [
    `Budget notice from the kernel, not from the tool you just called: you have made ${String(calls)} tool calls, and this session is stopped at ${String(limit)} steps.`,
    'Reaching that limit ends the session immediately — there is no closing turn, nothing you return is recorded, and edits you have not committed are left in the worktree for someone else to make sense of.',
    'Land what you have now rather than starting anything new: commit it, and return your result saying what is done and what remains. A partial change with an honest account of it is recoverable; work that stops mid-edit is not.',
  ].join(' ');
}
