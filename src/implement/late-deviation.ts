import { conventionIdOf } from '../context/conventions.js';
import type { MergeDecision } from './merge.js';

/**
 * The one refusal the author was never given a chance to answer (IMP-4).
 *
 * A deviation must be declared, and an undeclared one blocks the merge. That
 * is the rule working: declaring is cheap and legitimate, and what makes a
 * declaration mean anything is that another reviewer sees it.
 *
 * But a deviation reported for the first time in the *final* review round
 * cannot be declared, because there is no round left in which to declare it.
 * The author never saw it. T3.2.6 hit this and so did T4.1.6, where the
 * reviewer approved the change, called its remaining points "minor […] none of
 * which I think should hold the merge", and the gate refused anyway over a
 * CONV-1 that first appeared in round three of three.
 *
 * So the loop grants one extra round, once, and only when the refusal is
 * exactly that shape. This is not `maxReviewAttempts` becoming elastic: a
 * change the reviewer still wants altered gets the budget it was given, and a
 * deviation the author was already shown and chose not to declare gets no
 * second chance either. What it buys is the difference between a rule the
 * author broke and a rule nobody told them about.
 */

/** The convention a deviation names, for comparing one report against another. */
function key(entry: string): string {
  return conventionIdOf(entry) ?? entry.trim();
}

export interface LateDeviationInput {
  /** The gate's verdict on the final round. */
  readonly decision: MergeDecision;
  /** Did the reviewer approve the change itself? */
  readonly approved: boolean;
  /** Undeclared deviations this round reported. */
  readonly undeclared: readonly string[];
  /** Deviations the author was sent back with in an earlier round. */
  readonly shown: ReadonlySet<string>;
}

/**
 * Whether the final round's refusal earns one more attempt.
 *
 * Every condition is necessary, and each removes a way the grace could be
 * abused or wasted:
 *
 * - **the reviewer approved** — the change is otherwise ready, and the only
 *   thing between it and the trunk is a signature. A reviewer still asking for
 *   changes has given the author work, and work is what the budget bounds.
 * - **every refusal is an undeclared deviation** — a stale verdict or a
 *   reviewer sharing the author's role is not something another round fixes.
 * - **at least one was never shown** — a deviation the author saw in round two
 *   and did not declare in round three was answered by silence, which is an
 *   answer. The grace is for what nobody said, not for what was ignored.
 */
export function earnsAnotherRound(input: LateDeviationInput): boolean {
  if (input.decision.allowed || !input.approved) {
    return false;
  }
  if (
    input.decision.refusals.length === 0 ||
    !input.decision.refusals.every((refusal) => refusal === 'undeclared-deviation')
  ) {
    return false;
  }
  return input.undeclared.some((entry) => !input.shown.has(key(entry)));
}

/** The deviations in `undeclared` that no earlier round put in front of the author. */
export function unseenDeviations(
  undeclared: readonly string[],
  shown: ReadonlySet<string>,
): string[] {
  return undeclared.filter((entry) => !shown.has(key(entry)));
}

/** Records that these deviations have now been sent to the author. */
export function markShown(shown: Set<string>, undeclared: readonly string[]): void {
  for (const entry of undeclared) {
    shown.add(key(entry));
  }
}

/**
 * What the author is told when the grace round is granted.
 *
 * Deliberately narrow. The change is approved; the only thing being asked for
 * is a declaration, and inviting anything else would spend a round meant to
 * close the task on reopening it.
 */
export function renderLateDeviation(unseen: readonly string[]): string {
  return [
    'The reviewer approved this change. One thing stands between it and the',
    'trunk: a deviation it reported for the first time in what would have been',
    'the last round, so you were never given the chance to declare it.',
    '',
    'Reported, and not declared by you:',
    ...unseen.map((entry) => `- ${entry}`),
    '',
    'You have one round, and it is for this alone. Declare the deviation if you',
    'stand behind it — that is a legitimate answer (IMP-4), and it is what makes',
    'the departure a decision somebody signed rather than something that slipped',
    'through. Fix it instead if you think the reviewer is right and the fix is',
    'small.',
    '',
    'Do not take this round as an invitation to improve anything else. The change',
    'is approved; every line you add is a line the next review has to look at,',
    'and a round granted to close the task is not one to reopen it with.',
  ].join('\n');
}
