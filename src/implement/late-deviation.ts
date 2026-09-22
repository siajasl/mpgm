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
