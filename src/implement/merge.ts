import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { z } from 'zod';
import type { EffectJournal } from '../effect/journal.js';
import type { EffectContract, EffectIntent } from '../effect/contract.js';
import type { EventInput } from '../event/envelope.js';
import { undeclaredDeviations } from '../context/conventions.js';
import type { codeReviewSchema } from '../schemas.js';
import { blockingReasons, type MergeVerdict } from './checks.js';
import { refsAgree } from './commit-ref.js';

/** One finding from a review, matching `codeReviewSchema`'s shape. */
export type ReviewFinding = z.infer<typeof codeReviewSchema>['findings'][number];

/**
 * Reviewed merge (IMP-1, IMP-3, IMP-5, DESIGN §4.1/§4.7).
 *
 * A change reaches the trunk only when two independent things say so: CI, and
 * an agent that did not write it. Both are recorded as events before the merge
 * happens, so the audit trail answers "who approved this" without anybody
 * having to remember (HIL-5, OBS-1).
 *
 * Every refusal here is about something that could otherwise be true by
 * accident — a review of an older commit, a green verdict for a different one,
 * a reviewer that turns out to be the author. None of those look wrong at the
 * moment they happen.
 */

const run = promisify(execFile);

export class MergeError extends Error {}

export type MergeRefusal =
  /** CI did not clear the change. */
  | 'checks-not-green'
  /** The verdict is about a different commit than the one being merged. */
  | 'checks-are-stale'
  /** Nobody reviewed it. */
  | 'no-review'
  /** The reviewer asked for changes. */
  | 'changes-requested'
  /** The reviewer shares the author's role (IMP-3). */
  | 'reviewer-not-independent'
  /** The reviewer found a convention broken that the change never declared. */
  | 'undeclared-deviation'
  /** The review is of an earlier commit than the one being merged. */
  | 'review-is-stale';

export interface ReviewRecord {
  readonly reviewTaskId: string;
  readonly reviewerRole: string;
  /**
   * The commit that was reviewed.
   *
   * Recorded because approval is of a state, not of a branch. Without it, a
   * repair pushed after the review would ride into the trunk on an approval
   * nobody gave it — the review would still be "there", and it would be for
   * code that no longer exists.
   */
  readonly ref: string;
  readonly approved: boolean;
  readonly summary: string;
  /** Convention ids the reviewer found the change departing from (IMP-4). */
  readonly deviations?: readonly string[];
}

export interface MergeDecisionRequest {
  readonly taskId: string;
  /** Role of the agent that wrote the change. */
  readonly authorRole: string;
  /** Head of the change as it stands now. */
  readonly ref: string;
  readonly verdict: MergeVerdict;
  readonly review?: ReviewRecord;
  /** Convention ids the change declared it departs from (IMP-4). */
  readonly declaredDeviations?: readonly string[];
}

export interface MergeDecision {
  readonly allowed: boolean;
  /** Every reason it was refused, not merely the first. */
  readonly refusals: readonly MergeRefusal[];
  readonly reasons: readonly string[];
}

/**
 * May this change merge?
 *
 * Pure, and reports *all* the reasons it may not. One reason at a time turns a
 * blocked merge into a guessing game in which each fix reveals the next
 * problem.
 */
export function decideMerge(request: MergeDecisionRequest): MergeDecision {
  const refusals: MergeRefusal[] = [];
  const reasons: string[] = [];

  const refuse = (refusal: MergeRefusal, reason: string): void => {
    refusals.push(refusal);
    reasons.push(reason);
  };

  if (!refsAgree(request.verdict.ref, request.ref)) {
    refuse(
      'checks-are-stale',
      `checks were reported for ${request.verdict.ref}, not ${request.ref}`,
    );
  }
  if (!request.verdict.mergeable) {
    refuse('checks-not-green', `CI: ${blockingReasons(request.verdict).join('; ')}`);
  }

  const { review } = request;
  if (review === undefined) {
    refuse('no-review', 'no independent review has been recorded (IMP-3)');
    return { allowed: false, refusals, reasons };
  }

  if (review.reviewerRole === request.authorRole) {
    refuse(
      'reviewer-not-independent',
      `reviewer role '${review.reviewerRole}' is the author's own (IMP-3)`,
    );
  }
  if (!refsAgree(review.ref, request.ref)) {
    refuse(
      'review-is-stale',
      `the review approved ${review.ref}; the change is now ${request.ref}`,
    );
  }
  if (!review.approved) {
    refuse('changes-requested', `reviewer requested changes: ${review.summary}`);
  }

  // IMP-4. A convention the reviewer found broken and the author never
  // mentioned was introduced silently, and "flagged, not silently introduced"
  // has to bite somewhere or it is a preference. Declaring one does not excuse
  // it — the reviewer still judges it — it only makes it a decision somebody
  // took rather than one nobody noticed.
  const undeclared = undeclaredDeviations(
    review.deviations ?? [],
    request.declaredDeviations ?? [],
  );
  if (undeclared.length > 0) {
    refuse(
      'undeclared-deviation',
      `the change departs from ${undeclared.join(', ')} without declaring it (IMP-4)`,
    );
  }

  return { allowed: refusals.length === 0, refusals, reasons };
}

export function changeReviewed(
  runId: string,
  taskId: string,
  review: ReviewRecord,
  findings: readonly ReviewFinding[],
  declaredDeviations: readonly string[] = [],
): EventInput {
  const deviations = review.deviations ?? [];
  return {
    runId,
    type: 'ChangeReviewed',
    payload: {
      taskId,
      reviewTaskId: review.reviewTaskId,
      reviewerRole: review.reviewerRole,
      ref: review.ref,
      approved: review.approved,
      summary: review.summary,
      findings: findings.length,
      // Full detail (T4.2.14, OBS-1): a count alone left a blocked task's
      // refusal unreconstructable from the log, readable only in the rework
      // prompt of the session that happened to receive it.
      findingDetails: [...findings],
      deviations: [...deviations],
      declaredDeviations: [...declaredDeviations],
      undeclaredDeviations: undeclaredDeviations(deviations, declaredDeviations),
    },
  };
}

export interface MergeChangeOptions {
  readonly runId: string;
  readonly repo: string;
  /** The task's branch, from the worktree manager. */
  readonly branch: string;
  /** Trunk. Defaults to `main` (IMP-5). */
  readonly into?: string;
  readonly request: MergeDecisionRequest;
  /**
   * Records the intent before the merge and its outcome afterwards
   * (DESIGN §6). Optional only so that the decision can be exercised without
   * a log; a real run passes one.
   */
  readonly journal?: EffectJournal;
  readonly emit?: (event: EventInput) => Promise<void> | void;
  /**
   * Where the trunk is pushed once the local `--no-ff` merge lands, so the
   * commit `ChangeMerged` records is one a fresh clone can resolve rather
   * than one that exists only on the machine that made it (T4.2.12).
   *
   * Defaults to `origin` and is used only when a remote by that name is
   * actually configured — a project with nothing to push to (this module's
   * own tests that build a bare local repo, or a genuinely local-only
   * project) keeps exactly today's local-only behaviour. Where a remote
   * *is* configured, though, the push is not optional: it is what this task
   * decided between two different claims about where truth lives. Pushing
   * makes the kernel's local merge the fact and the pull request's closing a
   * consequence of that push landing — which is what happens: GitHub marks a
   * pull request merged once it can see the head commit is now an ancestor
   * of the base branch, no separate API call required. Recording the sha
   * GitHub's own merge produced instead would make GitHub the fact and the
   * kernel's merge a rehearsal — but nothing in this codebase calls the
   * GitHub merge API, so that would mean either adding one, or waiting on an
   * operator to merge the pull request by hand and reading the result back.
   * Either way it would silently drop the `--no-ff` shape and the
   * `Closes-Task`/`Reviewed-By` trailers `mergeMessage` writes the moment a
   * human squashes or rebases the pull request instead of merging it — the
   * trace index (ADR-4) reads `Closes-Task` off exactly the commit this
   * function makes, not off whatever GitHub produces. Pushing keeps the
   * kernel's own merge as the one everybody, including a fresh clone, agrees
   * happened, and it is also what ends the operator ritual of resetting a
   * diverged local `main` back to `origin/main` by hand after every pull
   * request merge: once the kernel pushes, there is nothing left to diverge.
   */
  readonly remote?: string;
}

export interface MergeResult {
  readonly merged: boolean;
  readonly decision: MergeDecision;
  /** The merge commit, when one was made. */
  readonly commit?: string;
  readonly reason?: string;
}

async function git(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd: repo, encoding: 'utf8' });
  return stdout.trim();
}

/** Whether `repo` has a remote by this name configured at all. */
async function remoteExists(repo: string, remote: string): Promise<boolean> {
  try {
    await git(repo, ['remote', 'get-url', remote]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The merge commit's message.
 *
 * `Closes-Task` is a trailer the trace index reads (ADR-4), so the change
 * becomes a node linked to its task without anybody maintaining a second
 * record of it. `Reviewed-By` is for people.
 */
export function mergeMessage(request: MergeDecisionRequest, branch: string): string {
  const review = request.review;
  const lines = [`Merge ${branch}`, ''];
  if (review !== undefined) {
    lines.push(review.summary, '');
    lines.push(`Reviewed-By: ${review.reviewerRole} (${review.reviewTaskId})`);
  }
  lines.push(`Closes-Task: ${request.taskId}`);
  return lines.join('\n');
}

/**
 * Merge a reviewed, green change into the trunk.
 *
 * Refuses without merging if {@link decideMerge} says no, and refuses if the
 * trunk is not where it expects — a merge run from the wrong branch or over a
 * dirty tree would produce a commit nobody asked for.
 */
export async function mergeChange(options: MergeChangeOptions): Promise<MergeResult> {
  const into = options.into ?? 'main';
  const emit = options.emit ?? ((): void => undefined);
  const decision = decideMerge(options.request);

  if (!decision.allowed) {
    return { merged: false, decision, reason: decision.reasons.join('; ') };
  }

  const head = await git(options.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head !== into) {
    throw new MergeError(
      `expected '${options.repo}' to be on '${into}', found '${head}'`,
    );
  }
  if ((await git(options.repo, ['status', '--porcelain'])) !== '') {
    throw new MergeError(`refusing to merge into a dirty '${into}'`);
  }

  const tip = await git(options.repo, ['rev-parse', options.branch]);
  const message = mergeMessage(options.request, options.branch);

  // A remote configured by this name is what makes the merge below something
  // more than a local rehearsal (T4.2.12, see `MergeChangeOptions.remote`).
  // Its absence is not an error — a project with nothing to push to keeps
  // exactly today's local-only behaviour — but its presence is not optional:
  // recorded in the effect's own params so `gitMergeContract.check` below
  // knows, on resume, whether "landed" has to mean "reachable from the
  // remote" or merely "reachable from the local trunk".
  const remoteName = options.remote ?? 'origin';
  const remote = await remoteExists(options.repo, remoteName) ? remoteName : '';

  const perform = async (): Promise<string> => {
    try {
      await git(options.repo, [
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        message,
        options.branch,
      ]);
    } catch (cause) {
      // Leave the trunk as it was. A half-merged working tree is worse than a
      // refused merge, and the conflict is a task for an agent, not a state
      // for the kernel to sit in.
      await git(options.repo, ['merge', '--abort']).catch(() => '');
      throw new MergeError(
        `merging ${options.branch} into ${into} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    const commit = await git(options.repo, ['rev-parse', 'HEAD']);

    if (remote !== '') {
      try {
        await git(options.repo, ['push', remote, into]);
      } catch (cause) {
        // The merge landed locally — it is not aborted, unlike a conflict
        // above, because there is nothing to undo and undoing a real merge
        // to paper over a network failure would lose it a second way. But it
        // has not landed anywhere else yet, which is exactly the state this
        // task exists to stop `ChangeMerged` from claiming otherwise. A retry
        // of this same effect re-merges nothing (the branch is already
        // merged) and simply pushes again, which is the "merge redone rather
        // than lost" this task asks for.
        throw new MergeError(
          `merged ${options.branch} into ${into} locally as ${commit}, but pushing ` +
            `${remote} failed, so no clone can resolve it yet: ` +
            (cause instanceof Error ? cause.message : String(cause)),
          { cause },
        );
      }
    }

    return commit;
  };

  const effect = {
    runId: options.runId,
    taskId: options.request.taskId,
    contract: GIT_MERGE_CONTRACT,
    operation: GIT_MERGE_OPERATION,
    params: { repo: options.repo, branch: options.branch, into, tip, remote },
  };

  let commit: string;
  try {
    commit =
      options.journal === undefined
        ? await perform()
        : await options.journal.perform(effect, perform);
  } catch (cause) {
    return {
      merged: false,
      decision,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }

  await emit({
    runId: options.runId,
    type: 'ChangeMerged',
    payload: {
      taskId: options.request.taskId,
      branch: options.branch,
      into,
      commit,
      reviewTaskId: options.request.review?.reviewTaskId ?? '',
    },
  });

  return { merged: true, decision, commit };
}

export const GIT_MERGE_CONTRACT = 'git.merge';
export const GIT_MERGE_OPERATION = 'mergeBranch';

/**
 * Resume can ask git whether the merge landed, which makes this the safest
 * kind of effect there is (DESIGN §6): the repository itself is the record.
 *
 * When the intent named a remote (T4.2.12), "landed" has to mean reachable
 * from *that* remote's `into`, not merely from the local one — a merge whose
 * local `git merge` succeeded and whose `git push` did not is exactly the
 * half-finished state this task exists to stop `ChangeMerged` from claiming
 * as done. Answering `true` from the local repository alone here would tell
 * resume the effect already landed, and it would never be retried — the
 * commit would then be permanently local, the very defect this fixes. So a
 * remote that cannot be reached, or that does not yet have the commit,
 * answers `false`: not "landed", which sends the effect back through
 * `perform` for a retried push rather than a redone merge (the local merge
 * is a no-op the second time; only the push has anything left to do) — a
 * merge redone rather than a merge lost (CONV-4).
 */
export const gitMergeContract: EffectContract = {
  contract: GIT_MERGE_CONTRACT,
  operation: GIT_MERGE_OPERATION,
  semantics: 'checkable',
  check: async (intent: EffectIntent): Promise<boolean> => {
    const repo = intent.params.repo;
    const into = intent.params.into;
    const tip = intent.params.tip;
    const remote = intent.params.remote;
    if (
      typeof repo !== 'string' ||
      typeof into !== 'string' ||
      typeof tip !== 'string' ||
      (remote !== undefined && typeof remote !== 'string')
    ) {
      return false;
    }
    try {
      await git(repo, ['merge-base', '--is-ancestor', tip, into]);
    } catch {
      // Not an ancestor of the local trunk, or the ref is gone. Either way
      // the merge itself did not land, which is the only answer this may
      // return with confidence.
      return false;
    }
    if (remote === undefined || remote === '') {
      // No remote was in play for this merge (T4.2.12) — landing locally is
      // the whole of what "landed" means for it, same as before this task.
      return true;
    }
    try {
      await git(repo, ['fetch', remote, into]);
      await git(repo, ['merge-base', '--is-ancestor', tip, 'FETCH_HEAD']);
      return true;
    } catch {
      // The local trunk has it; the remote does not (yet), or is
      // unreachable to ask. Fail closed: say it did not land rather than
      // guess, since guessing "yes" here is exactly how a commit stays
      // unresolvable from every clone but this one.
      return false;
    }
  },
};
