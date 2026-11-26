/**
 * Which commit a session said it was talking about.
 *
 * Every ref in the loop used to be a string a model typed. The author reported
 * the commit it had made, the reviewer reported the commit it had read, and the
 * merge gate compared the two — so `review-is-stale` compared one model's prose
 * against another's, and nothing in the comparison was anything git knew.
 *
 * Models abbreviate. Of T4.1.6's seven recorded reviews, four named a commit in
 * seven characters and three in forty, for the same branch in the same run. The
 * gate survived that because both sides came from the same string; the carried
 * review (`lastReviewOf`) did not, because its other side is a real
 * `rev-parse HEAD`. It compared `ed8541d` against
 * `ed8541d047f6c088dc6704bfc931bf71d17badea`, found no match, and silently told
 * the resuming author nothing — on the one task the carry was built for.
 *
 * So a reported ref is reconciled against what the checkout actually holds
 * before it is recorded or compared. Reconciling is not trusting: a ref that
 * names the commit becomes that commit, and a ref that names something else is
 * left exactly as the session wrote it, which is what lets the staleness
 * refusal still fire.
 */

/** The shortest abbreviation git itself will resolve. */
const MIN_ABBREVIATION = 7;
const SHA_LENGTH = 40;
const HEX = /^[0-9a-f]+$/;

function normalise(ref: string): string {
  return ref.trim().toLowerCase();
}

/**
 * Whether `reported` names the commit `actual`.
 *
 * `actual` must be a full object name — the answer comes from `rev-parse`, and
 * accepting an abbreviation on that side would let two abbreviations of
 * different commits agree with each other.
 *
 * Anything shorter than git's own minimum is refused rather than matched on a
 * prefix: at four characters a match says almost nothing, and a ref this code
 * cannot place is exactly the case the gate must not wave through (CONV-4).
 */
export function namesCommit(reported: string, actual: string): boolean {
  const commit = normalise(actual);
  if (commit.length !== SHA_LENGTH || !HEX.test(commit)) {
    return false;
  }
  const named = normalise(reported);
  if (named.length < MIN_ABBREVIATION || named.length > SHA_LENGTH) {
    return false;
  }
  return HEX.test(named) && commit.startsWith(named);
}

/**
 * `actual` when `reported` names it, and `reported` untouched when it does not.
 *
 * The untouched half is the point. A reviewer that reports a commit the branch
 * is no longer on has reviewed something else, and returning the real head here
 * would erase the only evidence of that and merge the change anyway.
 */
export function reconcileRef(reported: string, actual: string): string {
  return namesCommit(reported, actual) ? normalise(actual) : reported;
}

/**
 * Whether two refs name the same commit, without knowing which is the full one.
 *
 * The merge gate compares a CI verdict's ref against the commit being merged,
 * and CI is asked about whatever ref the loop had at the time — which may be an
 * abbreviation a session wrote. Exact equality is kept as the first answer so
 * that a project whose refs are not object names at all still compares them the
 * only way it can.
 */
export function refsAgree(one: string, other: string): boolean {
  const a = normalise(one);
  const b = normalise(other);
  return a === b || namesCommit(a, b) || namesCommit(b, a);
}

/**
 * Thrown when a ref the loop is about to ask CI about cannot be placed on the
 * branch it is said to describe (T4.3.26).
 *
 * The reviewer's ref has always gone through `reconcileRef` before it was
 * recorded or compared — a mismatch there is kept exactly as written, so the
 * staleness refusal downstream can still fire on it. The implementer's never
 * did: `change.data.ref` and `fixed.data.ref` reached `checks(ref)` as
 * written, so a session that reported its commit with surrounding prose
 * (T4.3.22's implementing session: `5925262 (branch mpgm/T4.3.22) --
 * "..."`) reached the provider unexamined, which answered "no commit found"
 * and was read as CI being unreachable — the wrong cause, pointing an
 * operator at CI when CI was never actually asked.
 *
 * This is the other half: a caller that reads the worktree's actual tip
 * before asking CI anything throws this instead of asking, and instead of
 * quietly substituting the tip for a ref that does not name it — a session
 * that describes a different commit than the one it left is evidence the
 * review must not lose, the same reasoning `reconcileRef`'s own doc gives.
 */
export class UnplacedRefError extends Error {
  /** What the session claimed. */
  readonly reported: string;
  /** The worktree's actual tip, or `undefined` when it could not be read. */
  readonly tip: string | undefined;
  /**
   * Where the refused ref came from, as a phrase a refusal can name without
   * guessing — `the implementing session's output`, `repair attempt 2's
   * output`, and so on.
   *
   * Carried rather than assumed because a loop asks CI about a ref more than
   * once per round: the first poll's ref is the implementing session's, and
   * every poll after a repair attempt has a different author. A refusal that
   * always said "the implementing session" blamed the wrong session as soon
   * as a repair ran, which is a wrong diagnosis in an error that stops work
   * (CONV-3) — the operator it sends to the implementing commit finds a
   * commit the branch really is on.
   */
  readonly source: string;

  constructor(reported: string, tip: string | undefined, source: string) {
    super(
      tip === undefined
        ? `could not read the commit the worktree is on, so the reported ref '${reported}' (from ${source}) cannot be checked against it`
        : `the reported ref '${reported}' (from ${source}) does not name the worktree's tip (${tip})`,
    );
    this.reported = reported;
    this.tip = tip;
    this.source = source;
  }
}
