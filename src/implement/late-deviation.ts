import { conventionIdOf } from '../context/conventions.js';
import type { MergeDecision } from './merge.js';

/**
 * When an approved change is one signature short of the trunk (IMP-4).
 *
 * A deviation must be declared, and an undeclared one blocks the merge. That
 * is the rule working: declaring is cheap and legitimate, and what makes a
 * declaration mean anything is that another reviewer sees it.
 *
 * What the rule cannot ask for is a declaration made before the review that
 * reports the deviation exists. The author writes `deviations` and *then* is
 * reviewed, so it can only ever declare what an earlier round reported, while
 * every round's new work draws new reports. On the last round there is no
 * later round at all, which makes anything that round reports undeclarable by
 * construction.
 *
 * So when a reviewer approves and the only thing refusing the change is a
 * declaration, the loop asks for the declaration instead of asking for more
 * work. Once per task, with a prompt that invites nothing else.
 *
 * This used to fire only at the cap, and only for a deviation no earlier round
 * had shown the author — on the reasoning that a deviation shown in round two
 * and not declared in round three "was answered by silence, which is an
 * answer". T4.1.4b showed that premise is wrong. The rework prompt tells an
 * author to *fix* a reported departure and to declare only if the departure is
 * deliberate; its round-three session fixed, the reviewer approved, and
 * reported the same conventions anyway. Nothing in the loop can tell that
 * apart from ignoring it, because the reviewer reports departures either way
 * and is deliberately not told what was declared.
 *
 * Waiting for the cap was the other half of the cost. Five reviews across
 * T4.1.4b's four runs approved the change; every one was refused for a
 * declaration, and the two rework rounds each approval bought produced the
 * later reports that refused it again. A loop that spends rounds reworking
 * what a reviewer has passed manufactures the failure it dies of.
 */

export interface LateDeviationInput {
  /** The gate's verdict on this round. */
  readonly decision: MergeDecision;
  /** Did the reviewer approve the change itself? */
  readonly approved: boolean;
}

/**
 * Whether this round should ask for a declaration rather than for rework.
 *
 * Both conditions are necessary:
 *
 * - **the reviewer approved** — the change is otherwise ready, and the only
 *   thing between it and the trunk is a signature. A reviewer still asking for
 *   changes has given the author work, and work is what the budget bounds.
 * - **every refusal is an undeclared deviation** — a stale verdict, or a
 *   reviewer sharing the author's role, is not something a declaration fixes.
 *
 * Nothing here asks whether the author was shown the deviation before. It is
 * the caller that holds this to once per task, which is what stops a round
 * being spent on a declaration the author has already declined to make.
 */
export function earnsDeclarationRound(input: LateDeviationInput): boolean {
  if (input.decision.allowed || !input.approved) {
    return false;
  }
  return (
    input.decision.refusals.length > 0 &&
    input.decision.refusals.every((refusal) => refusal === 'undeclared-deviation')
  );
}

/**
 * What the author is told when the declaration round is granted.
 *
 * Deliberately narrow. The change is approved; the only thing being asked for
 * is a declaration, and inviting anything else would spend a round meant to
 * close the task on reopening it.
 *
 * It says outright that fixing a departure does not stop the reviewer
 * reporting it, because an author that has just fixed one has every reason to
 * believe otherwise — and believing otherwise is how this round gets wasted.
 */
export function renderDeclarationRound(undeclared: readonly string[]): string {
  return [
    'The reviewer approved this change. One thing stands between it and the',
    'trunk: a convention it reports the change departing from, which your',
    'result does not declare.',
    '',
    'Reported, and not declared by you:',
    ...undeclared.map((entry) => `- ${entry}`),
    '',
    'This round is for the declaration and nothing else. Declaring means the',
    '`deviations` field of the result you return, naming the convention in',
    '`convention` and your reason in `why`. A commit message is not a',
    'declaration, and neither is an argument in a design document, a contract,',
    'a code comment or `summary` — the merge reads the field.',
    '',
    'If you already fixed the departure in an earlier round, declare it anyway.',
    'The reviewer reports what it finds the change departing from whether or',
    'not you answered it, and is deliberately not told what you declared, so a',
    'fix does not stop the report. Declaring costs nothing here: the review is',
    'done and approved, and the declaration is read by an operator, not judged',
    'again.',
    '',
    'Do not take this round as an invitation to improve anything else. The',
    'change is approved; every line you add is a line the next review has to',
    'look at, and a round granted to close the task is not one to reopen it',
    'with.',
  ].join('\n');
}

/**
 * The entries in a deviation list that name no registered convention
 * (T4.3.13).
 *
 * `conventionIdOf` reads a leading `CONV-1`-shaped id; an entry with none is
 * a rule the reviewer describes in its own words because there is nowhere
 * for it to point — most often one stated only in CLAUDE.md, which `kb/`
 * does not carry (IMP-4 puts binding conventions there).
 *
 * Three ways to close that were open, and this took the first two together
 * rather than the third alone:
 *
 * - **Give the rule an id.** `kb/conventions.md` now registers this
 *   project's two live CLAUDE.md-only rules — the trace-trailer paragraph
 *   rule and `Verifies:` semantics — as CONV-8 and CONV-9, the same move
 *   `81bac97` made for CONV-7. This is the real fix for a *known* rule: once
 *   registered, it is exactly as declarable as CONV-1 always was, and
 *   nothing below has to run for it again.
 * - **Constrain the reviewer to cite only registered conventions.** Refused.
 *   That would not close the gap, it would hide it: a reviewer that found a
 *   real CLAUDE.md-only departure and could not name it would either say
 *   nothing — the silent introduction IMP-4 forbids — or fall back to
 *   `request-changes` prose the author cannot act on by declaring, which
 *   only relabels today's failure. A rule not yet in the knowledge base does
 *   not stop being binding for want of an id.
 * - **Treat a finding repeated unchanged after a declaration round as
 *   declared, in general.** Refused alone, for the reason `earnsAnotherRound`
 *   is capped in the first place: it is the elasticity a per-task grace must
 *   not become, and it would let any undeclared deviation through on
 *   sufficient repetition, id or no id. Taken narrowly instead —
 *   `carriedDeclarations` below only ever excuses an *id-less* entry, and
 *   only the exact wording the one grace round already showed the author, for
 *   one round. That price is what makes it safe to combine with the first
 *   two rather than a replacement for them: a *new* CLAUDE.md-only rule, or
 *   any other prose a reviewer surfaces without a number, is still possible
 *   the moment it is written, and this is what covers the round it takes to
 *   register or fix it.
 */
export function idlessUndeclared(entries: readonly string[]): string[] {
  return entries.filter((entry) => conventionIdOf(entry) === undefined);
}

/**
 * An id-less finding the last declaration round already showed the author,
 * reported again with the same wording (T4.3.13).
 *
 * `undeclaredDeviations` (`src/context/conventions.ts`) matches an id-less
 * entry to a declaration only by exact text, because there is no id to key
 * on. That is fine the first time: `earnsDeclarationRound` grants a round for
 * exactly this, and the round hands the author the reviewer's own wording
 * (`renderDeclarationRound`) to declare verbatim. It stops being fine the
 * second time, because the author's declaration is written *before* the next
 * review runs, and that next review is a fresh session describing what it
 * finds in its own words — words that need not match the first review's,
 * however carefully the author copied them. A rule stated only in CLAUDE.md
 * then has no wording the author could have pinned down twice, which is what
 * T4.3.5 spent 16 sessions and $37.12 discovering: `BudgetExceeded{kind:
 * 'reviews'}` on an approved change, with the sole refusal an id-less
 * deviation the loop had already spent its one grace round asking about.
 *
 * So when the *same* id-less wording survives the round meant to close it,
 * this treats it as answered rather than asking a second time for a
 * signature that round already tried to collect. Deliberately narrow, so it
 * is not the general "repetition excuses silence" grace `earnsDeclarationRound`'s
 * own comment refuses to become:
 *
 * - **id-less only.** A numbered convention (`CONV-1`) is exactly as typeable
 *   on the second round as the first, so it keeps needing an explicit
 *   declaration every time it is the sole thing refusing — this is what
 *   `rework.test.ts`'s "does not grant it twice" already holds the loop to,
 *   and nothing here weakens it.
 * - **exact text, not "close enough".** A reworded finding is a new finding;
 *   deciding two different sentences describe the same rule is the judgement
 *   call the id scheme exists to keep out of this path; it does not sneak
 *   back in as a fuzzy match.
 * - **one round's worth.** `shown` is whatever the *immediately preceding*
 *   granted round put in front of the author, not everything ever reported,
 *   so this cannot silently absolve a deviation that first appeared several
 *   rounds ago and was simply never picked up by a grant.
 * - **conditional on the author having tried.** `attempted` is what the grace
 *   round's own rework session put in its `deviations` field — the answer the
 *   round asked for. Rework attempt 1 found this reading only the reviewer's
 *   wording: an author that let the grace round pass with `deviations: []`,
 *   never signing anything, merged exactly as if it had. That is the silent
 *   introduction IMP-4 forbids, not a fix for an undeclarable one — the round
 *   asked for a signature and none was given. So this only ever carries
 *   forward a wording the author *tried* to declare against: at least one
 *   id-less entry present in `attempted`, whether or not its text happens to
 *   match `shown` (a paraphrase is exactly T4.3.5's scenario). No id-less
 *   entry at all in `attempted` means no attempt was made, and nothing here
 *   substitutes for one.
 */
export function carriedDeclarations(
  shown: ReadonlySet<string>,
  reported: readonly string[],
  attempted: readonly string[],
): string[] {
  if (idlessUndeclared(attempted).length === 0) {
    return [];
  }
  return idlessUndeclared(reported).filter((entry) => shown.has(entry.trim()));
}
