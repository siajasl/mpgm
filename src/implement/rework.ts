import type { z } from 'zod';
import type { codeReviewSchema } from '../schemas.js';
import type { MergeDecision, MergeRefusal } from './merge.js';

/**
 * Review rework (IMP-3, IMP-4, ORC-1, DESIGN section 4.7).
 *
 * A change that fails its merge checks already goes back to its author with
 * the failure attached (`repair.ts`). A change a reviewer refuses did not: the
 * review was written, recorded, and then the task stopped with nobody having
 * read it. An independent review whose findings never reach the author is a
 * cost with no effect — the defect stays, and the next attempt at the task
 * reproduces it, because a fresh session knows nothing about it.
 *
 * This is the same shape as the CI loop and for the same reasons: bounded,
 * with exhaustion an event rather than a shrug, and feedback rendered for the
 * agent that has to act on it.
 */

/**
 * Reviews taken before a change that still cannot merge is escalated.
 *
 * Three rather than two on the evidence of the first self-hosted task: two
 * rounds found two unrelated real defects — a test that could not fail, then
 * a correlation the kernel had and threw away — and exhausted with the second
 * still open. That is a reviewer earning its cost, not a loop going nowhere,
 * and stopping there spends the reviews and keeps neither fix.
 *
 * It stays small for the reason any of these budgets do. Each round costs a
 * rework session and a fresh review, so the price of being wrong about this
 * number is paid every time a task is refused; a change that cannot satisfy a
 * reviewer in three goes is a task for an operator to look at rather than a
 * loop to leave running (NFR-1).
 */
export const DEFAULT_REVIEW_ATTEMPTS = 3;

export type Review = z.infer<typeof codeReviewSchema>;

/**
 * Refusals the author can do something about from its own worktree.
 *
 * The others are not the author's to fix and must not spend an attempt:
 * `reviewer-not-independent` is a dispatch mistake, `review-is-stale` and
 * `checks-are-stale` mean the change moved under its verdict, `no-review`
 * means none was written, and `checks-not-green` belongs to the repair loop.
 * Sending any of those back to the agent asks it to fix something it cannot
 * see.
 */
const REWORKABLE: ReadonlySet<MergeRefusal> = new Set<MergeRefusal>([
  'changes-requested',
  'undeclared-deviation',
]);

export function isReworkable(decision: MergeDecision): boolean {
  // An allowed decision needs no separate test: it carries no refusals, so
  // the length check already excludes it. Restating it would be a condition
  // nothing could ever make false, which reads as a guard and is not one.
  return (
    decision.refusals.length > 0 &&
    decision.refusals.every((refusal) => REWORKABLE.has(refusal))
  );
}

/**
 * What the author is shown.
 *
 * Both honest routes are named, and in the order that matters. A deviation is
 * a decision somebody signs (IMP-4), so declaring one is a legitimate answer —
 * but it is the answer when the departure is right, not the way past the gate.
 * Saying only "declare it" would teach an agent to declare everything, since
 * declaring is cheap and always unblocks the merge; what stops that is the
 * re-review, and the author is told that it is coming.
 */
export function renderReview(request: {
  readonly review: Review;
  readonly undeclared: readonly string[];
  readonly attempt: number;
  readonly attemptsRemaining: number;
}): string {
  const lines = [
    `Your change was reviewed by another agent and cannot merge as it stands.`,
    '',
    `The reviewer's verdict: ${request.review.verdict}.`,
    '',
    request.review.summary.trim(),
  ];

  const blocking = request.review.findings.filter(
    (finding) => finding.severity !== 'minor',
  );
  const shown = blocking.length > 0 ? blocking : request.review.findings;
  if (shown.length > 0) {
    lines.push('', 'Findings:');
    for (const finding of shown) {
      const where =
        finding.line === undefined
          ? finding.file
          : `${finding.file}:${String(finding.line)}`;
      lines.push(
        `- [${finding.severity}] ${where} — ${finding.concern}`,
        `  Remedy: ${finding.remedy}`,
      );
    }
  }

  if (request.undeclared.length > 0) {
    lines.push(
      '',
      'Conventions the reviewer found this change departing from, which your',
      'change did not declare:',
      ...request.undeclared.map((convention) => `- ${convention}`),
      '',
      'Fix each of these. If a departure is deliberate and right, declare it in',
      '`deviations` with the reason instead — a declared deviation is a decision',
      'on the record for an operator to read, not a formality. Declaring one you',
      'have not thought about wastes the attempt: the change is reviewed again',
      'after this, by an agent that is not told what you declared.',
    );
  }

  lines.push(
    '',
    `This is rework attempt ${String(request.attempt)}; ${String(request.attemptsRemaining)} remain after it.`,
    '',
    // The loop adds a commit per round, so it manufactures the very departure
    // from a one-commit-per-change convention that the next review then
    // reports. Saying so here costs nothing and stops an attempt being spent
    // on a finding the process caused. Deliberately phrased about commit
    // structure rather than naming a convention id: which id that is belongs
    // to a project's knowledge base, and another project's would be something
    // else entirely.
    'Your fix will add a commit to a branch that already carries at least one,',
    'because this branch has been through a review already. That is how the',
    'loop works rather than something you did wrong: if a convention about',
    'commit structure is among the departures above, declare it with that as',
    'the reason instead of trying to fix it.',
    '',
    'Do not rewrite history to tidy the branch. It is already published and',
    'under review, and an amended or squashed commit is a different commit —',
    'it discards the approval given to the one it replaced, and the kernel',
    'refuses to merge on a review of a ref that no longer exists.',
    '',
    'Do not delete, skip, weaken or exclude a test to resolve a finding, and do',
    'not relax a lint or type rule to silence one. Report the commit you end at',
    'in `ref`.',
  );

  return lines.join('\n');
}
