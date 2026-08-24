import type { SessionRunner } from '../agent/runner.js';
import { assembleContext } from '../context/assembler.js';
import type { EgressPolicy } from '../context/egress.js';
import type { KbDocument } from '../context/knowledge-base.js';
import type { EventLog } from '../event/store.js';
import type { RoleRegistry } from '../role/loader.js';
import { changeSchema, codeReviewSchema } from '../schemas.js';
import type { MergeVerdict } from './checks.js';
import { changeReviewed, decideMerge, mergeChange, type ReviewRecord } from './merge.js';
import { repairUntilGreen, type RepairReport } from './repair.js';
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
  /** Settled merge verdict for a ref — see `awaitChecks`. */
  readonly checks: (ref: string) => Promise<MergeVerdict>;
  readonly logsFor?: (check: string, ref: string) => Promise<string>;
  readonly implementerRole?: string;
  readonly reviewerRole?: string;
  readonly maxRepairAttempts?: number;
  readonly into?: string;
  /** Remove the worktree once the change has merged. Off while debugging. */
  readonly cleanUp?: boolean;
}

export type ImplementStatus = 'merged' | 'blocked';

export interface ImplementResult {
  readonly status: ImplementStatus;
  readonly taskId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly review?: ReviewRecord;
  readonly repair?: RepairReport;
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

function reviewPrompt(task: ImplementTask, ref: string, base: string): string {
  return [
    `Review the change for ${task.id} — ${task.title}.`,
    '',
    'It was asked to satisfy:',
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    '',
    `The change is commit ${ref}. See it with \`git diff ${base}...${ref}\` and`,
    `\`git log ${base}..${ref}\`.`,
    '',
    `Set \`ref\` to ${ref}. Your approval is of that commit and travels no`,
    'further: if the change moves afterwards, the kernel refuses to merge on it.',
  ].join('\n');
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
  const stop = (
    reason: string,
    extra: Partial<ImplementResult> = {},
  ): ImplementResult => ({
    status: 'blocked',
    taskId: task.id,
    branch: worktree.branch,
    worktree: worktree.path,
    reason,
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

  // CI before review, and repair before review: an agent asked to read a
  // change that does not build is spending an expensive session on something
  // the build already said (IMP-2).
  const repair = await repairUntilGreen({
    runId,
    taskId: task.id,
    ref: change.data.ref,
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
    return stop(`CI did not go green: ${repair.reason}`, { ref: repair.ref, repair });
  }

  const reviewed = await options.sessions.runTask({
    runId,
    taskId: `${task.id}-review`,
    role: reviewerRole,
    prompt: reviewPrompt(task, repair.ref, into),
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

  const review: ReviewRecord = {
    reviewTaskId: `${task.id}-review`,
    reviewerRole: reviewerRole.name,
    ref: parsed.data.ref,
    approved: parsed.data.verdict === 'approve',
    summary: parsed.data.summary,
    deviations: parsed.data.deviations.map((entry) => entry.convention),
  };
  options.log.append(
    changeReviewed(
      runId,
      task.id,
      review,
      parsed.data.findings.length,
      latest.deviations.map((entry) => entry.convention),
    ),
  );

  const request = {
    taskId: task.id,
    authorRole: implementerRole.name,
    ref: repair.ref,
    verdict: repair.verdict,
    review,
    declaredDeviations: latest.deviations.map((entry) => entry.convention),
  };

  const decision = decideMerge(request);
  if (!decision.allowed) {
    return stop(decision.reasons.join('; '), { ref: repair.ref, review, repair });
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
    review,
    repair,
  };
}
