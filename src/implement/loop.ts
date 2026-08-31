import type { SessionRunner } from '../agent/runner.js';
import { assembleContext } from '../context/assembler.js';
import type { EgressPolicy } from '../context/egress.js';
import type { KbDocument } from '../context/knowledge-base.js';
import type { EventLog } from '../event/store.js';
import type { RoleRegistry } from '../role/loader.js';
import { changeSchema, codeReviewSchema } from '../schemas.js';
import type { MergeVerdict } from './checks.js';
import { undeclaredDeviations } from '../context/conventions.js';
import {
  changeReviewed,
  decideMerge,
  mergeChange,
  type MergeDecision,
  type MergeDecisionRequest,
  type ReviewRecord,
} from './merge.js';
import { repairUntilGreen, type RepairReport } from './repair.js';
import { DEFAULT_REVIEW_ATTEMPTS, isReworkable, renderReview } from './rework.js';
import type { WorktreeManager } from './worktree.js';

/**
 * The implement loop (IMP-1 to IMP-5, DESIGN section 4.7).
 *
 * One plan task, start to finish: an isolated worktree, an implementing
 * session, an independent review, CI, a bounded repair loop, and a merge the
 * kernel performs. Every piece already existed; this is the order they go in.
 *
 * It is deliberately a function rather than a phase playbook. A phase playbook
 * describes a fixed set of tasks producing named artifacts; the implement
 * phase is one of these per plan task, and the artifact it produces is a
 * commit. Forcing it into the playbook shape would mean parameterising ids and
 * paths that everything downstream currently relies on being literal.
 */

export interface ImplementTask {
  readonly id: string;
  readonly title: string;
  readonly completionCriteria: readonly string[];
  readonly tracesTo: readonly string[];
  readonly milestone: string;
}

export interface ImplementOptions {
  readonly runId: string;
  readonly task: ImplementTask;
  /** The main repository. The trunk, which no agent may write to. */
  readonly repo: string;
  readonly worktrees: WorktreeManager;
  readonly sessions: SessionRunner;
  readonly roles: RoleRegistry;
  readonly log: EventLog;
  readonly kb: readonly KbDocument[];
  readonly policy: EgressPolicy;
  /**
   * Make the branch visible to CI.
   *
   * The kernel pushes; agents cannot (the destructive guard refuses `git push`
   * outright). Injected rather than assumed, because a project whose CI runs
   * locally has nothing to publish, and one that pushes must do it with the
   * credential the broker holds rather than whatever the shell has.
   */
  readonly publish?: (branch: string, ref: string) => Promise<void>;
  /**
   * Open the task's pull request, or find the one already open for its branch.
   *
   * CI is usually configured for the trunk and for pull requests targeting it,
   * so a pushed branch nothing has opened a PR for is a branch no workflow
   * watches — and the loop then waits for checks that will never run. Opening
   * the PR is also what puts the task's journey on the board (PMG-2), which is
   * the visible half of what the Implement milestone asks for.
   *
   * Must be idempotent: a task re-run after an interruption has to find its
   * existing pull request rather than open a second one for the same branch.
   */
  readonly openPullRequest?: (request: PullRequestRequest) => Promise<number>;
  /** Settled merge verdict for a ref — see `awaitChecks`. */
  readonly checks: (ref: string) => Promise<MergeVerdict>;
  readonly logsFor?: (check: string, ref: string) => Promise<string>;
  readonly implementerRole?: string;
  readonly reviewerRole?: string;
  readonly maxRepairAttempts?: number;
  /**
   * How many times a refused review may go back to the author (IMP-3).
   *
   * Bounded for the same reason the repair budget is: an agent that cannot
   * satisfy a reviewer in two goes is a task for an operator, not a loop to
   * leave running. One attempt means the findings reach the author once,
   * which is the difference between a review and a report nobody reads.
   */
  readonly maxReviewAttempts?: number;
  readonly into?: string;
  /** Remove the worktree once the change has merged. Off while debugging. */
  readonly cleanUp?: boolean;
}

/**
 * One trip round the review loop: what CI said, and what the reviewer said.
 *
 * Kept per round because `repair` and `review` below are the round that
 * decided the outcome, and reading those alone would say a task merged with
 * CI green first time when an earlier round had been red and repaired.
 */
export interface ReviewRound {
  /** 1-based. */
  readonly round: number;
  readonly repair: RepairReport;
  readonly review: ReviewRecord;
}

export interface PullRequestRequest {
  readonly branch: string;
  readonly into: string;
  readonly task: ImplementTask;
}

export type ImplementStatus = 'merged' | 'blocked';

export interface ImplementResult {
  readonly status: ImplementStatus;
  readonly taskId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly ref?: string;
  readonly commit?: string;
  /** The review that decided the outcome — the last one taken. */
  readonly review?: ReviewRecord;
  /** The repair report of the round that decided the outcome. */
  readonly repair?: RepairReport;
  /** Every round, in order. One per review taken. */
  readonly rounds?: readonly ReviewRound[];
  /** The pull request the change was published on, when one was opened. */
  readonly pullRequest?: number;
  /** Why it stopped, when it did not merge. */
  readonly reason?: string;
}

function implementPrompt(task: ImplementTask, branch: string): string {
  return [
    `Implement ${task.id} — ${task.title}.`,
    '',
    'Done when:',
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    '',
    `This advances: ${task.tracesTo.join(', ')}.`,
    '',
    `You are in your own checkout on branch ${branch}. Commit your work there.`,
    'You cannot reach the trunk and you are not meant to: the kernel merges,',
    'after CI is green and another agent has reviewed what you wrote.',
    '',
    'Report the commit you ended at in `ref`, and set `complete` honestly — a',
    'partial change with an account of what remains is recoverable, and a',
    'confident claim of completion is not.',
  ].join('\n');
}

export function reviewPrompt(
  task: ImplementTask,
  ref: string,
  base: string,
  round = 1,
): string {
  const lines = [
    `Review the change for ${task.id} — ${task.title}.`,
    '',
    'It was asked to satisfy:',
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    '',
    `The change is commit ${ref}. See it with \`git diff ${base}...${ref}\` and`,
    `\`git log ${base}..${ref}\`.`,
  ];

  // Said only from the second round, because on the first there is one commit
  // and nothing to explain — and a note about rework rounds would invite a
  // reviewer to look for a shape that is not there.
  //
  // T3.2.6 is why this exists. Its third review approved the change and
  // refused it anyway, over a one-commit-per-change convention it saw broken
  // by the four commits the loop had itself made. That was the last attempt,
  // so the author was never even given the chance to declare a departure it
  // had not made. Phrased about commit structure rather than naming a
  // convention id: which id that is belongs to a project's knowledge base,
  // and the project being reviewed here may have no such convention at all.
  if (round > 1) {
    lines.push(
      '',
      'This branch carries one commit per review round: the change, and then one',
      "for each time it came back from review. That shape is the loop's doing",
      "rather than the author's, and the author cannot collapse it — rewriting a",
      'published commit discards the review already given to it.',
      '',
      'So do not report the number of commits as a departure this change made.',
      "What each commit *says* is still the author's: a rework commit whose",
      'message does not explain why it changed what it did is a finding like any',
      'other.',
    );
  }

  lines.push(
    '',
    `Set \`ref\` to ${ref}. Your approval is of that commit and travels no`,
    'further: if the change moves afterwards, the kernel refuses to merge on it.',
  );

  return lines.join('\n');
}

/**
 * Run one plan task end to end.
 *
 * Returns rather than throws for every outcome an operator can act on — a
 * review that asked for changes, a repair budget exhausted, a merge refused.
 * A task that cannot proceed is a task to look at, not an exception to catch.
 */
export async function implementTask(options: ImplementOptions): Promise<ImplementResult> {
  const { task, runId } = options;
  const implementerRole = options.roles.get(options.implementerRole ?? 'implementer');
  const reviewerRole = options.roles.get(options.reviewerRole ?? 'code-reviewer');
  const into = options.into ?? 'main';

  if (implementerRole.name === reviewerRole.name) {
    throw new Error(
      `the reviewer must not share the author's role (IMP-3); both are '${implementerRole.name}'`,
    );
  }

  const worktree = await options.worktrees.acquire(task.id);
  // Rounds are attached by the helper rather than by each caller: a task that
  // blocked in its second round should say so wherever it stopped, and
  // thirteen call sites each remembering to pass them is twelve chances not
  // to.
  const rounds: ReviewRound[] = [];
  const stop = (
    reason: string,
    extra: Partial<ImplementResult> = {},
  ): ImplementResult => ({
    status: 'blocked',
    taskId: task.id,
    branch: worktree.branch,
    worktree: worktree.path,
    reason,
    ...(rounds.length === 0 ? {} : { rounds: [...rounds] }),
    ...extra,
  });

  const context = assembleContext({
    task: {
      description: `${task.id} — ${task.title} (${task.milestone})`,
      prompt: implementPrompt(task, worktree.branch),
    },
    upstream: [],
    kb: options.kb,
    policy: options.policy,
  });

  const authored = await options.sessions.runTask({
    runId,
    taskId: task.id,
    role: implementerRole,
    prompt: context.prompt,
    policyRoot: worktree.path,
  });

  if (authored.status !== 'completed') {
    return stop(`the implementing session blocked: ${authored.reason}`);
  }

  const change = changeSchema.safeParse(authored.output);
  if (!change.success) {
    return stop(
      `the implementing session did not report a usable change: ${change.error.message}`,
    );
  }
  if (!change.data.complete) {
    // Not a failure, and not something to merge either. The task stops here
    // with what it learned, which is worth more than a change nobody claims.
    return stop(`the change is incomplete: ${change.data.remaining}`, {
      ref: change.data.ref,
    });
  }

  // What the *latest* session said about its change. A repair replaces the
  // change, so the deviations it declares are the ones the review is compared
  // against — reading them off the first attempt would refuse a merge for a
  // convention the author declared on the second try, which is exactly the
  // bug the switchover demo caught.
  let latest = change.data;

  await options.publish?.(worktree.branch, change.data.ref);

  // The pull request comes before the wait for checks, not after the merge: on
  // a repository whose CI runs on pull requests, it is the thing that causes
  // the checks to exist at all.
  let pullRequest: number | undefined;
  if (options.openPullRequest !== undefined) {
    try {
      pullRequest = await options.openPullRequest({
        branch: worktree.branch,
        into,
        task,
      });
    } catch (cause) {
      // Blocked rather than pressed on with. Continuing would wait out the
      // checks grace period and report "no checks" — true, but it would hide
      // the reason, which is right here.
      return stop(
        `could not open a pull request for ${worktree.branch}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
        { ref: change.data.ref },
      );
    }
  }

  const maxReviewAttempts = options.maxReviewAttempts ?? DEFAULT_REVIEW_ATTEMPTS;
  let review: ReviewRecord | undefined;
  let repair: RepairReport | undefined;
  let decision: MergeDecision | undefined;
  let request: MergeDecisionRequest | undefined;

  // One pass per review. CI runs inside it rather than outside, because rework
  // is a new commit and a new commit has to clear the checks again — a change
  // that fixed a finding and broke the build is not one to merge on the
  // strength of the review it just earned.
  for (let round = 1; round <= maxReviewAttempts; round += 1) {
    // CI before review, and repair before review: an agent asked to read a
    // change that does not build is spending an expensive session on something
    // the build already said (IMP-2).
    repair = await repairUntilGreen({
      runId,
      taskId: task.id,
      ref: latest.ref,
      model: implementerRole.model,
      ...(options.maxRepairAttempts === undefined
        ? {}
        : { maxAttempts: options.maxRepairAttempts }),
      checks: options.checks,
      ...(options.logsFor === undefined ? {} : { logsFor: options.logsFor }),
      emit: (event) => {
        options.log.append(event);
      },
      repair: async (request) => {
        const retry = await options.sessions.runTask({
          runId,
          taskId: task.id,
          role: implementerRole,
          prompt: `${context.prompt}\n\n## The checks failed\n\n${request.feedback}`,
          model: request.model,
          policyRoot: worktree.path,
        });
        const fixed =
          retry.status === 'completed' ? changeSchema.safeParse(retry.output) : undefined;
        if (fixed?.success === true) {
          latest = fixed.data;
          await options.publish?.(worktree.branch, fixed.data.ref);
        }
        // A repair session that produced nothing usable leaves the ref where it
        // was, so the next verdict is the same one and the budget still shrinks
        // — rather than the loop losing track of which commit it is judging.
        return { ref: fixed?.success === true ? fixed.data.ref : request.ref };
      },
    });

    if (repair.status !== 'green') {
      return stop(`CI did not go green: ${repair.reason}`, {
        ref: repair.ref,
        repair,
        ...(pullRequest === undefined ? {} : { pullRequest }),
      });
    }

    // Each round's review is its own task, so a rework's review does not
    // overwrite the record of the one that asked for it (OBS-1).
    const reviewTaskId =
      round === 1 ? `${task.id}-review` : `${task.id}-review-${String(round)}`;
    const reviewed = await options.sessions.runTask({
      runId,
      taskId: reviewTaskId,
      role: reviewerRole,
      prompt: reviewPrompt(task, repair.ref, into, round),
      policyRoot: worktree.path,
    });

    if (reviewed.status !== 'completed') {
      return stop(`the review session blocked: ${reviewed.reason}`, {
        ref: repair.ref,
        repair,
      });
    }

    const parsed = codeReviewSchema.safeParse(reviewed.output);
    if (!parsed.success) {
      return stop(`the review was not usable: ${parsed.error.message}`, {
        ref: repair.ref,
        repair,
      });
    }

    const declared = latest.deviations.map((entry) => entry.convention);
    review = {
      reviewTaskId,
      reviewerRole: reviewerRole.name,
      ref: parsed.data.ref,
      approved: parsed.data.verdict === 'approve',
      summary: parsed.data.summary,
      deviations: parsed.data.deviations.map((entry) => entry.convention),
    };
    options.log.append(
      changeReviewed(runId, task.id, review, parsed.data.findings.length, declared),
    );

    request = {
      taskId: task.id,
      authorRole: implementerRole.name,
      ref: repair.ref,
      verdict: repair.verdict,
      review,
      declaredDeviations: declared,
    };

    rounds.push({ round, repair, review });

    decision = decideMerge(request);
    if (decision.allowed) {
      break;
    }

    // A refusal the author cannot act on from its worktree — a stale verdict, a
    // reviewer that shares its role — is not rework. Sending it back would ask
    // an agent to fix something it cannot see.
    if (!isReworkable(decision)) {
      return stop(decision.reasons.join('; '), { ref: repair.ref, review, repair });
    }

    if (round === maxReviewAttempts) {
      options.log.append({
        runId,
        type: 'BudgetExceeded',
        payload: {
          taskId: task.id,
          kind: 'reviews',
          limit: maxReviewAttempts,
          observed: round,
        },
      });
      return stop(
        `the review still refuses the change after ${String(maxReviewAttempts)} attempt(s): ` +
          decision.reasons.join('; '),
        { ref: repair.ref, review, repair },
      );
    }

    // Back to the author, with what the reviewer found. Without this the review
    // is written, recorded and read by nobody, and the next attempt at the task
    // reproduces the defect because a fresh session knows nothing about it.
    const reworked = await options.sessions.runTask({
      runId,
      taskId: task.id,
      role: implementerRole,
      prompt: `${context.prompt}\n\n## The review asked for changes\n\n${renderReview({
        review: parsed.data,
        undeclared: undeclaredDeviations(review.deviations ?? [], declared),
        attempt: round,
        attemptsRemaining: maxReviewAttempts - round,
      })}`,
      policyRoot: worktree.path,
    });

    if (reworked.status !== 'completed') {
      return stop(`the rework session blocked: ${reworked.reason}`, {
        ref: repair.ref,
        review,
        repair,
      });
    }

    const revised = changeSchema.safeParse(reworked.output);
    if (!revised.success) {
      return stop(
        `the rework session did not report a usable change: ${revised.error.message}`,
        { ref: repair.ref, review, repair },
      );
    }

    latest = revised.data;
    await options.publish?.(worktree.branch, revised.data.ref);
  }

  if (repair === undefined || review === undefined || request === undefined) {
    // Unreachable: the loop runs at least once, and every path out of it
    // either sets these or returns. Stated rather than asserted with `!`.
    return stop('the review loop produced no decision');
  }

  const merged = await mergeChange({
    runId,
    repo: options.repo,
    branch: worktree.branch,
    into,
    request,
    emit: (event) => {
      options.log.append(event);
    },
  });

  if (!merged.merged) {
    return stop(merged.reason ?? 'the merge did not happen', {
      ref: repair.ref,
      review,
      repair,
    });
  }

  if (options.cleanUp ?? true) {
    // Only after a merge, and never forced: the branch is gone from the
    // worktree's point of view but the work is on the trunk, and anything
    // uncommitted left behind is worth an operator seeing rather than losing.
    await options.worktrees.release(task.id, { deleteBranch: 'if-merged' });
  }

  return {
    status: 'merged',
    taskId: task.id,
    branch: worktree.branch,
    worktree: worktree.path,
    ref: repair.ref,
    ...(merged.commit === undefined ? {} : { commit: merged.commit }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
    review,
    repair,
    rounds: [...rounds],
  };
}
