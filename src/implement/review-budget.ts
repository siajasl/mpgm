import type { StoredEvent } from '../event/envelope.js';
import { conventionIdOf } from '../context/conventions.js';

/**
 * A task's review budget, read back off the event log it already wrote
 * (T4.3.17).
 *
 * `implementTask` (`loop.ts`) used to initialise its round count, its
 * declared-deviations set and its one-time declaration extension
 * (`late-deviation.ts`) as locals at the top of the review loop, next to a
 * comment claiming "both live outside the loop because both are facts about
 * the task, not about a round" — true of where they lived, not of what reset
 * them, because they lived inside the *invocation*, which starts over every
 * time this function is called again. A task re-invoked after it blocked — a
 * crash, an accidental kill, an operator simply running `mpgm implement`
 * again — got a fresh three rounds every time: T4.3.16 merged only because
 * three successive invocations each granted and exhausted one on its own, and
 * a re-invocation made a final round's escalation guard (T4.3.8) see a round
 * that was not final at all, because nothing it read said otherwise.
 *
 * None of the three needs a second store (ADR-4). `ChangeReviewed` is
 * appended once per round, keyed by the task id, and already carries
 * everything a round decided: whether the reviewer approved, which
 * conventions it found broken, and — the part that matters here — the full
 * declared set as it stood *after* that round (`declaredDeviations`), not
 * merely what that round added to it. Replaying every such event in order
 * answers how many rounds the task has already spent, what it has already
 * declared, and whether the once-per-task declaration grace has already been
 * granted — the same answers `implementTask` itself would give if it had
 * never stopped.
 *
 * Scoped twice over, deliberately, because "re-invocation" means a specific
 * thing (T4.3.17 review): the same run picking the same task back up, not
 * every run that ever dispatched it. First, by `runId` — a `ChangeReviewed`
 * from a different run is about a different attempt, possibly on a branch an
 * operator has since reset and rebuilt from scratch, and carrying its rounds
 * in would make a deliberately restarted task look like a continuation of
 * one. Second, per declaration, by whether the commit its round reviewed is
 * still reachable from the branch tip the caller hands in — an ancestor of it
 * or equal to it, the same ancestry `lastReviewOf` (`prior-review.ts`) checks
 * before carrying a review's findings forward, generalised from equality
 * (lastReviewOf only ever carries the *last* round, which should name the
 * tip exactly) to ancestry (this carries every round, most of which name a
 * commit the tip has since grown past rather than one it still equals). A
 * declaration whose commit the branch no longer contains is about work this
 * run may have rewritten; carrying it forward would let a convention
 * declared against discarded code satisfy `decideMerge`'s undeclared-
 * deviation refusal for code nobody in this invocation ever declared
 * anything about.
 */

export interface PriorReviewBudget {
  /** Review rounds already recorded for this task, across every invocation. */
  readonly roundsSoFar: number;
  /**
   * Convention ids ever declared against this task, keyed by id and valued
   * by the label they were first declared under — the same shape
   * `implementTask`'s own `declaredSoFar` accumulates round by round.
   */
  readonly declared: ReadonlyMap<string, string>;
  /** Whether the one-time declaration extension has already been granted. */
  readonly extensionSpent: boolean;
  /**
   * How many rounds this task may take in total, the extension already
   * folded in if it was granted.
   */
  readonly attempts: number;
  /**
   * Whether the *last* recorded round was approved with nothing left
   * undeclared — the one shape `decideMerge` (`merge.ts`) would have allowed,
   * given the other three refusals it can report are already excluded by
   * construction here (see below). This is what tells a caller apart a task
   * whose budget is genuinely exhausted from one whose last round actually
   * cleared the gate, so that a checkout left behind after a merge (`cleanUp:
   * false`, or a merge `mergeChange` itself went on to refuse for some
   * reason unrelated to the review) is not reported as out of budget merely
   * because it has no round left to spend.
   */
  readonly lastRoundAllowed: boolean;
  /**
   * The log sequence number of the last recorded round, so a caller can tell
   * an operator redirect recorded *after* the budget was exhausted apart from
   * one left over from while it was still running (T4.3.17). `undefined`
   * exactly when `roundsSoFar` is `0`, since there is no round to be after.
   */
  readonly lastRoundSeq: number | undefined;
}

/** `ChangeReviewed`'s payload shape, the fields this reads. */
interface ChangeReviewedPayload {
  readonly taskId: string;
  readonly ref: string;
  readonly approved: boolean;
  readonly declaredDeviations?: readonly string[];
  readonly undeclaredDeviations?: readonly string[];
}

/**
 * Replay every `ChangeReviewed` this task has ever recorded, in order, and
 * answer where it actually stands — not where a fresh invocation would guess.
 *
 * `maxReviewAttempts` is this invocation's own configured bound, used as the
 * baseline every earlier round's grant is measured against — the same bound
 * the round that first ran would have used. This assumes every earlier
 * invocation of this task ran under the same bound: nothing recorded on the
 * log says whether an operator changed `--max-review-attempts` between two
 * invocations, and nothing here tries to detect it. The scenario this exists
 * for is a crash or a kill, not a deliberately reconfigured retry; if the
 * bound genuinely changed, the round this answers with may disagree with what
 * actually happened, same as it would for any fact this harness infers rather
 * than stores.
 *
 * Only the refusal `decideMerge` (`merge.ts`) can report besides an
 * undeclared deviation is excluded here by construction, not by re-deriving
 * `decideMerge` itself: a round only reaches `ChangeReviewed` at all once CI
 * is green and the review is of the commit the merge request names, so
 * `checks-not-green`, `checks-are-stale` and `review-is-stale` cannot be true
 * of a round this function is replaying, and `reviewer-not-independent` is
 * refused once for the whole task before any round runs (`implementTask`'s
 * own check at the top of that function). So an approved round reporting
 * something undeclared is exactly `earnsDeclarationRound`
 * (`late-deviation.ts`)'s condition, and the stored `undeclaredDeviations` —
 * already computed once, at append time (`changeReviewed`, `merge.ts`) — is
 * read back rather than recomputed.
 *
 * `isDeclarationReachable` decides, for a round's own `ref`, whether that
 * commit is still an ancestor of (or equal to) the branch this invocation is
 * resuming onto — the caller's job, not this function's, since answering it
 * means asking git something a pure replay of the log cannot (`WorktreeManager
 * .mergeBase`). A round that fails it still counts toward `roundsSoFar`,
 * `attempts` and `extensionSpent`: the session ran and the budget it spent is
 * real regardless of what later happened to its commit. Only what it
 * declared is at risk, for the reason above the type.
 */
export function priorReviewBudgetOf(
  events: readonly StoredEvent[],
  runId: string,
  taskId: string,
  maxReviewAttempts: number,
  isDeclarationReachable: (ref: string) => boolean,
): PriorReviewBudget {
  const declared = new Map<string, string>();
  let attempts = maxReviewAttempts;
  let extensionSpent = false;
  let round = 0;
  let lastRoundAllowed = false;
  let lastRoundSeq: number | undefined;

  for (const event of events) {
    if (event.type !== 'ChangeReviewed' || event.runId !== runId) {
      continue;
    }
    const payload = event.payload as ChangeReviewedPayload;
    if (payload.taskId !== taskId) {
      continue;
    }

    round += 1;
    lastRoundSeq = event.seq;
    if (isDeclarationReachable(payload.ref)) {
      for (const entry of payload.declaredDeviations ?? []) {
        declared.set(conventionIdOf(entry) ?? entry.trim(), entry);
      }
    }

    const undeclaredCount = (payload.undeclaredDeviations ?? []).length;
    lastRoundAllowed = payload.approved && undeclaredCount === 0;

    // The same test `implementTask`'s own loop applies, replayed rather than
    // re-dispatched: an approved round reporting something undeclared earns a
    // declaration round, which is a grant rather than ordinary rework only
    // once per task, spent at the cap and never refunded.
    const earnsDeclaration = payload.approved && undeclaredCount > 0;
    const declarationRound = earnsDeclaration && (round < attempts || !extensionSpent);
    if (declarationRound && round === attempts) {
      extensionSpent = true;
      attempts += 1;
    }
  }

  return {
    roundsSoFar: round,
    declared,
    extensionSpent,
    attempts,
    lastRoundAllowed,
    lastRoundSeq,
  };
}

/** `OperatorIntervened`'s payload shape, the fields this reads. */
interface OperatorIntervenedPayload {
  readonly action: string;
  readonly taskId?: string;
}

/** `TaskDispatched`'s payload shape, the field this reads. */
interface TaskDispatchedPayload {
  readonly taskId: string;
}

/**
 * The log sequence number of the most recent `TaskDispatched` this run
 * recorded under `taskId` itself — never under a review's own suffixed id
 * (`${taskId}-review[-n]`), which is a different session entirely — or
 * `undefined` if none has.
 *
 * What a redirect's authorization is consumed against (below): a dispatch,
 * not a completed round, because a granted round can block before it ever
 * reaches `ChangeReviewed` (CI not green, the session itself blocked, a
 * conflict refused), and the redirect that authorized it must not still read
 * as fresh on the invocation after that.
 */
function lastTaskDispatchedSeq(
  events: readonly StoredEvent[],
  runId: string,
  taskId: string,
): number | undefined {
  let last: number | undefined;
  for (const event of events) {
    if (
      event.type === 'TaskDispatched' &&
      event.runId === runId &&
      (event.payload as TaskDispatchedPayload).taskId === taskId
    ) {
      last = event.seq;
    }
  }
  return last;
}

/**
 * Whether an operator redirected this task after its budget's last recorded
 * activity, authorising exactly one more round (T4.3.17).
 *
 * A task whose review budget is exhausted is not permanently unstartable
 * (ORC-5): an operator who judges the outstanding finding settled can say so
 * with `mpgm redirect <task> --note <why> --run <runId>` and re-run, and the
 * pre-dispatch refusal in `implementTask` (`loop.ts`) reads this back before
 * refusing again, rather than promising a lever (`mpgm redirect`) that a
 * refusal before any dispatch could never actually reach — the regression a
 * review of this task caught: the guard returned before `track` ever read a
 * redirect note, so the two existing at-the-cap messages that tell an
 * operator to redirect and re-run (`loop.ts`, the "held for want of a
 * declaration" and "still refuses the change" refusals) dead-ended on a
 * resumed invocation that reached this guard first.
 *
 * Scoped to the redirect's own `runId`, the same scope `OperatorIntervened`
 * itself is folded under (`reduce.ts`) — a redirect is an instruction to a
 * run, not to a task across every run that might ever dispatch it.
 *
 * "After its budget's last recorded activity" is `afterSeq` —
 * `PriorReviewBudget.lastRoundSeq`, the last completed round — joined with
 * {@link lastTaskDispatchedSeq}, the later of the two. The join is what makes
 * the authorization genuinely single-use: without it, a redirect that
 * granted a round which then blocked before completing (`ChangeReviewed`
 * never appended) would still read as "after" `lastRoundSeq` on every later
 * re-invocation, handing out the same one grant again each time — a paid
 * session per invocation, from one redirect, forever (the review finding
 * this closes). A dispatch under the task's own id always happens the moment
 * the granted round actually starts, whatever becomes of it afterwards, so
 * consuming the grant there bounds it to the one round it was for. `undefined`
 * when neither has happened, since nothing can be "after" what has not
 * occurred.
 */
export function redirectAuthorizesContinuation(
  events: readonly StoredEvent[],
  runId: string,
  taskId: string,
  afterSeq: number | undefined,
): boolean {
  const dispatchSeq = lastTaskDispatchedSeq(events, runId, taskId);
  const boundary =
    afterSeq === undefined
      ? dispatchSeq
      : dispatchSeq === undefined
        ? afterSeq
        : Math.max(afterSeq, dispatchSeq);
  if (boundary === undefined) {
    return false;
  }
  return events.some((event) => {
    if (
      event.type !== 'OperatorIntervened' ||
      event.runId !== runId ||
      event.seq <= boundary
    ) {
      return false;
    }
    const payload = event.payload as OperatorIntervenedPayload;
    return payload.action === 'redirect' && payload.taskId === taskId;
  });
}
