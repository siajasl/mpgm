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

/**
 * `mergeChange`'s trunk-side merge conflicted on real content, not merely
 * failed for some other reason. Thrown only inside `perform` (below), and
 * caught there before it ever leaves `mergeChange` — the same catch that
 * turns every other failure into `{ merged: false, reason }` reads this one
 * apart from those and copies its `files` onto `MergeResult.conflict`, so a
 * caller can tell "dispatch a resolver" apart from every other refusal
 * without this class or a thrown exception ever crossing the module
 * boundary (T4.3.9, `conflict.ts`).
 */
class MergeConflictError extends MergeError {
  constructor(
    message: string,
    readonly files: readonly string[],
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

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
   * request merge — but only because `mergeChange` also fetches the remote
   * trunk and fast-forwards the local one onto it before making the merge
   * commit (see the pre-merge step in `mergeChange` itself). A plain push
   * alone would not have ended that ritual: it would still be rejected
   * non-fast-forward the moment `origin/main` moved by some other route —
   * most likely the "Merge pull request #N" commit GitHub writes when a pull
   * request is merged from its UI, which is how this project's own trunk has
   * always advanced — leaving an unpushable merge commit behind and turning
   * the reset into a precondition for the next merge rather than removing it.
   */
  readonly remote?: string;
}

export interface MergeResult {
  readonly merged: boolean;
  readonly decision: MergeDecision;
  /** The merge commit, when one was made. */
  readonly commit?: string;
  readonly reason?: string;
  /**
   * Present exactly when `reason` is due to the trunk-side merge itself
   * conflicting on real content, rather than any other way this function can
   * fail (a dirty tree, a diverged local trunk, a failed push). A caller with
   * a session runner in hand — `implement/loop.ts` — reads this to tell
   * "dispatch a resolver" apart from every other refusal without parsing
   * `reason`, the same distinction `WorktreeManager.catchUp`'s `'conflicted'`
   * status draws for the branch-side merge (T4.3.9, `conflict.ts`).
   */
  readonly conflict?: { readonly files: readonly string[] };
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
 * dirty tree would produce a commit nobody asked for. Never throws for a
 * refusal of its own making: every one, including the wrong-branch and
 * dirty-tree checks right below and a real content conflict in the
 * trunk-side merge itself, comes back as `{ merged: false, reason }` rather
 * than an exception — a caller (`implement/loop.ts`, and the CLI beyond it,
 * which wraps no `catch` around either) can print "did not merge: `<reason>`"
 * for every one of them the same way, without a stack trace crashing the run
 * over a dirty tree the caller had no chance to prevent. When the reason is a
 * real content conflict, `MergeResult.conflict` also carries the files git
 * could not merge, so a caller with a session runner in hand can tell
 * "dispatch a resolver" apart from every other refusal (a dirty tree, a
 * diverged local trunk, a failed push) without parsing `reason`, and dispatch
 * one the way `catchUp`'s own conflict already does, rather than this
 * function trying to hold a resolver of its own (T4.3.9, `conflict.ts`).
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
    return {
      merged: false,
      decision,
      reason: `expected '${options.repo}' to be on '${into}', found '${head}'`,
    };
  }
  if ((await git(options.repo, ['status', '--porcelain'])) !== '') {
    return {
      merged: false,
      decision,
      reason: `refusing to merge into a dirty '${into}'`,
    };
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
  const remote = (await remoteExists(options.repo, remoteName)) ? remoteName : '';

  const perform = async (): Promise<string> => {
    if (remote !== '') {
      // Nothing here fetches or fast-forwards the local trunk on its own
      // (worktree.ts branches from whatever `into` already is), so once
      // `origin/into` has moved by any other route — most commonly the
      // "Merge pull request #N" commit GitHub writes when a pull request is
      // merged from its UI, which is how this repository's own trunk
      // advances — a plain `git push` below would be rejected non-fast-
      // forward. That would leave the local `--no-ff` merge made below
      // stranded: created, unpushable, and blocking every merge after it
      // until an operator resets `into` to the remote by hand — exactly the
      // ritual this task exists to end, turned into a precondition instead
      // of an afterthought. So catch up *before* making that commit: fetch
      // the remote trunk and fast-forward the local one onto it.
      try {
        await git(options.repo, ['fetch', remote, into]);
      } catch (cause) {
        throw new MergeError(
          `fetching '${remote}' to check '${into}' is caught up failed: ` +
            (cause instanceof Error ? cause.message : String(cause)),
          { cause },
        );
      }
      try {
        await git(options.repo, ['merge', '--ff-only', 'FETCH_HEAD']);
      } catch (cause) {
        // A real divergence, not merely a lag: local `into` carries commits
        // '${remote}/${into}' does not, so no fast-forward can reconcile
        // them without deciding which side wins — a decision this function
        // has no basis to make. Fail closed (CONV-4): refuse rather than
        // guess, and name the reset an operator would otherwise have
        // performed by hand after noticing the same divergence downstream.
        throw new MergeError(
          `local '${into}' has diverged from '${remote}/${into}' and cannot be ` +
            `fast-forwarded onto it; reset '${into}' to '${remote}/${into}' and retry: ` +
            (cause instanceof Error ? cause.message : String(cause)),
          { cause },
        );
      }
    }
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
      // refused merge either way, but *which* error this throws matters: a
      // real content conflict is a task for an agent, not a state for the
      // kernel to sit in, and `mergeChange`'s own caller — `implement/loop.ts`
      // — is the one that can dispatch that agent; this function has no
      // session runner to hand it to. `MergeConflictError` carries the
      // conflicted paths so the outer catch below can tell that case apart
      // from every other reason this merge could fail (a hook, a lock, a
      // corrupt object) and copy them onto `MergeResult.conflict`, without
      // this class itself ever crossing the module boundary (T4.3.9,
      // `conflict.ts`).
      const files = await git(options.repo, [
        'diff',
        '--name-only',
        '--diff-filter=U',
      ]).catch(() => '');
      await git(options.repo, ['merge', '--abort']).catch(() => '');
      const detail = `merging ${options.branch} into ${into} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (files !== '') {
        throw new MergeConflictError(detail, files.split('\n'), { cause });
      }
      throw new MergeError(detail, { cause });
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
      // `MergeConflictError` is thrown *inside* `perform` above and would
      // otherwise be indistinguishable here from a dirty tree, a diverged
      // local trunk or a failed push — every one of which also lands in this
      // same catch, all as a plain `Error`. Read off the conflicted files it
      // carries so a caller can dispatch a resolver rather than merely
      // refuse (T4.3.9, `conflict.ts`).
      ...(cause instanceof MergeConflictError
        ? { conflict: { files: cause.files } }
        : {}),
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

/** What {@link verifyOperatorMerge} found. */
export interface OperatorMergeVerification {
  readonly verified: boolean;
  /** Why, either way — what a refusal needs to be fixable without reading this module (CONV-3). */
  readonly detail: string;
  /**
   * The claimed commit resolved to a full 40-character sha, or `''` where it
   * resolved to nothing.
   *
   * This, never the operator's own string, is what may be recorded. An
   * operator types `HEAD`, `main`, `origin/main` or an abbreviation as
   * readily as a sha, and every one of those resolves differently in another
   * clone, or in this one tomorrow — which is precisely the T4.2.12 defect
   * (a value in an append-only log that nothing can resolve back to the
   * merge), reintroduced through the operator's keyboard rather than the
   * kernel's code.
   */
  readonly commit: string;
}

/**
 * An operator's claim that a merge landed, as {@link verifyOperatorMerge}
 * takes it.
 *
 * `taskId` and `branch` are not optional and not decoration: a verification
 * that cannot be asked without naming the task it is for is one that cannot
 * silently answer "some commit is on the trunk" when the question was "this
 * task's change is on the trunk" (CONV-5). Every trunk commit satisfies the
 * first; only the task's own merge satisfies the second.
 */
export interface OperatorMergeClaim {
  readonly repo: string;
  /** What the operator said the merge commit is — resolved before it is recorded, never recorded as typed. */
  readonly claimedCommit: string;
  /** The trunk it is claimed to have reached. */
  readonly into: string;
  /** The task whose merge this is claimed to be. */
  readonly taskId: string;
  /** The branch that task's change was written on. */
  readonly branch: string;
  /** Defaults to `origin`; used only when a remote by that name is configured. */
  readonly remote?: string;
}

/** Regex-safe form of a task id, so `T4.2.1` cannot match inside `T4.2.15`. */
function taskIdPattern(taskId: string): RegExp {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`);
}

/** The branch's tip, locally or on the remote, or `''` where nothing resolves it. */
async function branchTip(repo: string, branch: string, remote: string): Promise<string> {
  for (const ref of [
    `refs/heads/${branch}`,
    ...(remote === '' ? [] : [`refs/remotes/${remote}/${branch}`]),
  ]) {
    try {
      return await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
    } catch {
      // Not this ref; try the next.
    }
  }
  if (remote !== '') {
    try {
      await git(repo, ['fetch', remote, branch]);
      return await git(repo, ['rev-parse', 'FETCH_HEAD']);
    } catch {
      // The branch is gone from the remote too — the usual state after a
      // pull request is merged with "delete branch" on. Not an error here;
      // the caller falls back to the commit's own message.
    }
  }
  return '';
}

/** Whether `commit`'s own message names `taskId` — subject, body or trailer. */
async function messageNames(
  repo: string,
  commit: string,
  taskId: string,
): Promise<boolean> {
  try {
    const message = await git(repo, ['log', '-1', '--format=%B', commit]);
    return taskIdPattern(taskId).test(message);
  } catch {
    return false;
  }
}

/**
 * Whether `commit` is this task's merge and not merely *a* commit on the
 * trunk.
 *
 * Reachability from the trunk says a commit landed; it says nothing about
 * whose change landed in it, and `gitMergeContract.check` — the model this
 * follows — never had to ask, because it checks the branch tip it merged
 * itself. An operator's claim has no such provenance, so the tie is checked
 * two ways, either of which is evidence the repository itself holds:
 *
 * - the task's branch tip is an ancestor of the claimed commit, i.e. the
 *   commit really carries that branch; or
 * - the claimed commit's own message names the task — the `Closes-Task`
 *   trailer `mergeMessage` writes, and equally the `Merge pull request #N
 *   from siajasl/mpgm/T4.2.9` subject GitHub writes, which is the M4.2 case.
 *
 * The second exists because the first stops being available exactly when
 * this verb is most needed: a merged pull request usually has its branch
 * deleted, and a squashed one has a tip that is an ancestor of nothing. When
 * neither holds, this refuses rather than recording a merge tied to the task
 * by nothing but the operator's say-so (CONV-4) — an untied record is
 * indistinguishable in the log from a true one, which is the whole class of
 * claim this verb exists to keep out.
 */
async function tieToTask(
  repo: string,
  commit: string,
  claim: OperatorMergeClaim,
  remote: string,
): Promise<OperatorMergeVerification> {
  const { branch, taskId } = claim;
  const tip = await branchTip(repo, branch, remote);
  if (tip !== '' && (await isAncestor(repo, tip, commit))) {
    return {
      verified: true,
      detail: `and carries '${branch}' (${tip.slice(0, 12)}), ${taskId}'s own branch`,
      commit,
    };
  }
  if (await messageNames(repo, commit, taskId)) {
    return { verified: true, detail: `and its message names ${taskId}`, commit };
  }
  return {
    verified: false,
    detail:
      tip === ''
        ? `${commit} is on '${claim.into}', but nothing ties it to ${taskId}: ` +
          `'${branch}' resolves to no ref here${remote === '' ? '' : ` or on '${remote}'`} ` +
          `(deleted after the merge, most likely) and ${commit.slice(0, 12)}'s own ` +
          `message never names ${taskId}. Record the merge commit that names the ` +
          `task, or restore '${branch}' so its tip can be checked — a commit tied ` +
          `to this task by nothing but the claim is what this refuses to write`
        : `${commit} is on '${claim.into}', but does not contain '${branch}' ` +
          `(${tip.slice(0, 12)}), the branch ${taskId}'s change was written on, and ` +
          `its message never names ${taskId} — so it is a trunk commit, not this ` +
          `task's merge. Check the sha, or --branch if the change went in on ` +
          `another branch`,
    commit,
  };
}

/** Whether `ancestor` is reachable from `descendant`. */
async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks an operator's claim that `commit` reached `into`, the way
 * `gitMergeContract.check` already checks the kernel's own merges, applied
 * here to one nobody but git can attest to (T4.2.15).
 *
 * `mpgm record-merge` (`cli/commands.ts`'s `recordMerge`) calls this *before* appending
 * `ChangeMergedByOperator`, and refuses to record anything this returns
 * `verified: false` for (CONV-4): an operator asserting a merge that never
 * landed would otherwise put a commit in the log no clone can resolve — the
 * defect T4.2.12 closed for the kernel's own merges, reopened for an
 * operator's if nothing checks their word the same way.
 *
 * `remote` is used only when a remote by that name is actually configured on
 * `repo` — defaulting to `origin`, the same default `mergeChange` applies.
 * Where one *is* configured, it is fetched **before** anything is checked
 * locally, and the check is answered against `FETCH_HEAD`, not the local
 * trunk: the motivating case is a pull request merged on GitHub (T4.2.9,
 * T4.2.10 — PRs 134, 135) by an operator whose local clone has not pulled
 * since, and in that clone the merge commit is not an object the repository
 * has at all — checking the local trunk first would refuse the very merge
 * this task exists to record, and blame the sha for what is really a stale
 * clone (CONV-3). Only when no remote is configured does this fall back to
 * the local trunk alone, same as `gitMergeContract.check` does for a project
 * with nothing to push to.
 *
 * Two things beyond "the trunk can reach it" have to hold before this says
 * yes, because a record that satisfies only that one is not distinguishable
 * in the log from a true one:
 *
 * - the claimed commit resolves to a full sha, and that resolved sha — not
 *   the string the operator typed — is what {@link OperatorMergeVerification}
 *   hands back to be recorded; and
 * - the commit is tied to *this task* (see `tieToTask`), so that
 *   `record-merge T4.2.10 --commit <any commit on main>` is refused rather
 *   than written.
 */
export async function verifyOperatorMerge(
  claim: OperatorMergeClaim,
): Promise<OperatorMergeVerification> {
  const { repo, into } = claim;
  const remoteName = claim.remote ?? 'origin';
  const remote = (await remoteExists(repo, remoteName)) ? remoteName : '';

  // The trunk to answer against, pinned to a sha the moment it is fetched:
  // `tieToTask` may fetch the task's branch below, and that would move
  // `FETCH_HEAD` out from under a later reachability check.
  let trunk = into;
  let trunkName = `local '${into}'`;
  if (remote !== '') {
    try {
      await git(repo, ['fetch', remote, into]);
      trunk = await git(repo, ['rev-parse', 'FETCH_HEAD']);
      trunkName = `'${remote}/${into}'`;
    } catch (cause) {
      // Nothing here has been checked yet, so a refusal at this point is about
      // reaching the remote, not about the commit — say so, and name the next
      // step, rather than letting a network failure read as an unlanded merge
      // (CONV-3).
      return {
        verified: false,
        commit: '',
        detail:
          `fetching '${remote}' to check '${into}' failed (` +
          (cause instanceof Error ? cause.message : String(cause)) +
          `) — the local clone may simply be behind and unable to confirm the ` +
          `claimed merge until '${remote}' can be reached; retry once it can`,
      };
    }
  }

  let commit: string;
  try {
    commit = await git(repo, [
      'rev-parse',
      '--verify',
      `${claim.claimedCommit}^{commit}`,
    ]);
  } catch {
    return {
      verified: false,
      commit: '',
      detail:
        `'${claim.claimedCommit}' is not a commit '${repo}' has` +
        (remote === ''
          ? ''
          : `, even after fetching '${remote}/${into}' — check the sha, or that ` +
            `'${remote}' is where the merge actually landed`),
    };
  }

  if (await isAncestor(repo, commit, trunk)) {
    const tie = await tieToTask(repo, commit, claim, remote);
    return tie.verified
      ? { ...tie, detail: `reachable from ${trunkName} ${tie.detail}` }
      : tie;
  }

  if (remote === '') {
    return {
      verified: false,
      commit,
      detail:
        `'${commit}' is not reachable from local '${into}' in '${repo}' — ` +
        `the claimed merge did not land there`,
    };
  }

  // Fail closed, same as `gitMergeContract.check`: say it did not land
  // rather than guess, since guessing "yes" here is exactly how a commit
  // stays unresolvable from every clone but this one. The remote's trunk
  // was just fetched fresh above, so this is not a stale-clone question —
  // the claimed merge is not there.
  return {
    verified: false,
    commit,
    detail:
      `'${commit}' is not reachable from '${remote}/${into}' after ` +
      `fetching it — the claimed merge did not land there, and no clone but ` +
      `this one can resolve it yet`,
  };
}

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
