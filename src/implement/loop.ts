import type { SessionRunner, TaskOutcome } from '../agent/runner.js';
import {
  ESCALATION_COST_MULTIPLIER,
  escalateModel,
  estimateEscalatedCostUsd,
} from '../agent/models.js';
import { assembleContext } from '../context/assembler.js';
import type { EgressPolicy } from '../context/egress.js';
import type { KbDocument } from '../context/knowledge-base.js';
import type { StoredEvent } from '../event/envelope.js';
import type { EventLog } from '../event/store.js';
import type { RoleRegistry } from '../role/loader.js';
import { fold, redirectNoteFor, runControl } from '../state/reduce.js';
import { changeSchema, codeReviewSchema } from '../schemas.js';
import type { MergeVerdict } from './checks.js';
import { conventionIdOf, undeclaredDeviations } from '../context/conventions.js';
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
import { reconcileRef } from './commit-ref.js';
import { lastReviewOf, renderPriorReview } from './prior-review.js';
import { earnsDeclarationRound, renderDeclarationRound } from './late-deviation.js';
import type { ProgressReporter, SessionKind } from './progress.js';
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
  /**
   * Told each time a session starts and finishes (OBS-3, NFR-2).
   *
   * A task runs 20-40 minutes across an implementing session, a bounded
   * repair loop and a bounded review loop, and printed nothing at all between
   * dispatch and its final line — an operator watching the terminal could not
   * tell an implementing session from a review, a rework round from a stall,
   * or a run that never launched from one in progress. Optional because a
   * caller with nowhere to print — a test, `replay` — has nothing to lose by
   * leaving it unset.
   */
  readonly onProgress?: ProgressReporter;
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

/** What a checkout handed over from an earlier session already holds. */
export interface CarriedWork {
  /** Commits on the branch beyond the trunk. */
  readonly commits: number;
  /** Changes written but never committed. */
  readonly uncommitted: boolean;
}

export function implementPrompt(
  task: ImplementTask,
  branch: string,
  carried?: CarriedWork,
): string {
  const lines = [
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
  ];

  // A worktree outlives the session that was working in it, which is the whole
  // point (DESIGN §6) — and until now nothing told the session that replaced
  // it. T4.1.1 ran out of turns with every file written and staged and none of
  // them committed; a replacement given only "implement this" would have found
  // a tree full of changes it did not make, with no account of where they came
  // from, and been as likely to start again as to finish.
  //
  // Said only when there is something to say: a checkout acquired by a session
  // that died before writing anything holds nothing, and describing that would
  // send an agent looking for work that is not there.
  if (carried !== undefined && (carried.commits > 0 || carried.uncommitted)) {
    const held = [
      carried.commits > 0
        ? `${String(carried.commits)} commit(s) on the branch already`
        : undefined,
      carried.uncommitted ? 'changes written but not committed' : undefined,
    ].filter((entry) => entry !== undefined);

    lines.push(
      '',
      `This checkout is not empty. An earlier session on this task stopped`,
      `before it finished and left ${held.join(', and ')}.`,
      '',
      'Read what is there before you write anything. It may be finished, nearly',
      'finished, or wrong, and you cannot tell which without looking — but it is',
      'the work this task has already been paid for, and starting again spends',
      "that twice. Uncommitted changes are the previous session's: judge them,",
      'and commit them if they are right rather than discarding them because you',
      'did not write them.',
      '',
      'Committing is not agreeing. What you commit is reviewed by another agent',
      'and has to pass CI, so leaving something broken in place costs a round;',
      'fix what is wrong, finish what is unfinished, and commit the result.',
    );
  }

  lines.push(
    '',
    'Report the commit you ended at in `ref`, and set `complete` honestly — a',
    'partial change with an account of what remains is recoverable, and a',
    'confident claim of completion is not.',
    '',
    // T4.1.4a declared a deviation in its commit message — "Declaring CONV-5
    // as a deviation this rework does not attempt to close" — and the gate
    // refused the merge for an undeclared deviation, because the gate reads
    // the result and not the log. An approved change, one field short.
    'If you knowingly depart from one of the conventions above, declare it in',
    '`deviations` — one entry per convention, with its id in `convention` and',
    'your reason in `why`. That field is the declaration, and it is the only',
    'thing read: a departure explained in a commit message, a code comment or',
    'the summary is undeclared as far as the merge is concerned, and an',
    'undeclared deviation the reviewer finds refuses the merge however good the',
    'reason was (IMP-4).',
  );

  return lines.join('\n');
}

export function reviewPrompt(
  task: ImplementTask,
  ref: string,
  base: string,
  /**
   * True when the loop is responsible for the branch carrying more than one
   * commit — this round is a rework, or the checkout was picked up from an
   * earlier run that already had them.
   */
  loopAddedCommits = false,
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

  // Said only when the loop is the reason there is more than one commit.
  //
  // T3.2.6 is why this exists. Its third review approved the change and
  // refused it anyway, over a one-commit-per-change convention it saw broken
  // by the four commits the loop had itself made. That was the last attempt,
  // so the author was never even given the chance to declare a departure it
  // had not made.
  //
  // The condition is who made the commits, not which round this is. Saying it
  // on every round after the first missed a reused checkout, whose *first*
  // round already carries an earlier run's rework — which is exactly what
  // T3.2.6 hit on the re-run. Saying it unconditionally would be worse: an
  // author who split a fresh change into three commits made that choice
  // themselves, and excusing it would throw away a real finding.
  //
  // Phrased about commit structure rather than naming a convention id: which
  // id that is belongs to a project's knowledge base, and the project being
  // reviewed here may have no such convention at all.
  if (loopAddedCommits) {
    lines.push(
      '',
      'This branch carries one commit per review round: the change, and then one',
      'for each time it came back from review — including rounds from an earlier',
      'run of this task, if the checkout was picked up where it left off. That',
      "shape is the loop's doing rather than the author's, and the author cannot",
      'collapse it — rewriting a published commit discards the review already',
      'given to it.',
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
 * What the implementer role has actually spent on this task's rounds so
 * far, averaged per `TaskDispatched` — the weaker tier's own measured going
 * rate for this task, read off the event log rather than off a table of
 * prices the kernel does not have (`estimateEscalatedCostUsd`, `agent/
 * models.ts`).
 *
 * Every session this loop dispatches for the task carries `taskId: task.id`
 * except a review, which runs under `${task.id}-review[-n]` (see `track`
 * above) — so filtering on `task.id` alone already excludes the reviewer's
 * own spend, with no need to filter on role as well.
 *
 * Divided by dispatch count rather than summed: what the escalation guard
 * below needs is "what one more round like the ones already run would
 * cost", not "what the task has spent in total" — the two differ once a
 * round has needed more than one CI repair attempt.
 */
function implementerRoundCostSoFar(
  events: readonly StoredEvent[],
  runId: string,
  taskId: string,
): number {
  let costUsd = 0;
  let dispatches = 0;
  for (const event of events) {
    if (event.runId !== runId) {
      continue;
    }
    if (
      event.type === 'TaskDispatched' &&
      (event.payload as { taskId: string }).taskId === taskId
    ) {
      dispatches += 1;
    } else if (
      event.type === 'SessionUsage' &&
      (event.payload as { taskId: string }).taskId === taskId
    ) {
      costUsd += (event.payload as { costUsd: number }).costUsd;
    }
  }
  // Unreachable once a rework round is in play: the implementing session
  // that opens every task always dispatches and is always counted first, so
  // by the time any round can be "final" at least one dispatch is already on
  // record. Answering 0 rather than throwing keeps this a measurement
  // rather than an assertion — a caller finding no evidence estimates
  // nothing, rather than refusing a round it cannot say anything about.
  return dispatches === 0 ? 0 : costUsd / dispatches;
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

  // Every session the loop dispatches goes through here, so `onProgress` is
  // told about all four kinds from one place rather than from four call
  // sites that could drift apart (OBS-3, NFR-2). Wraps `sessions.runTask`
  // rather than replacing it: the caller still sees the same `TaskOutcome`.
  //
  // It is also where pause, kill and redirect actually reach a running task
  // (T4.2.4, HIL-3, HIL-5) — until now the loop read none of the three.
  // Checked fresh before every dispatch, not once at the start, the same
  // rule `runPhase`'s own `shouldDispatch` applies to a playbook's steps: an
  // operator who pauses or kills mid-task expects the session already
  // running to be the last one, and one who redirects expects the very next
  // session — whichever kind it is — to read the note.
  const track = async (
    kind: SessionKind,
    round: number,
    request: Omit<Parameters<typeof options.sessions.runTask>[0], 'runId'>,
  ): Promise<TaskOutcome> => {
    const state = fold(options.log.read());
    const control = runControl(state, runId);
    if (control !== 'running') {
      // Not dispatched at all: `onProgress` reports sessions that ran, and
      // this one never did. `stop()` at each call site turns this into a
      // `blocked` result, appending `TaskBlocked` only if some earlier
      // session for this task already has (see `stop`'s own comment) — the
      // same outcome shape as any other that is not `completed`.
      return {
        status: 'blocked',
        reason: `the run was ${control} by an operator`,
        attempts: 0,
        lastIssues: [],
      };
    }

    // Keyed on the owning plan task (`task.id`), not on `request.taskId`: a
    // review session is dispatched under `${task.id}-review` (and a rework
    // round under `-review-<n>`), so looking the note up under the session's
    // own id missed a redirect that landed while the task was already in
    // flight — the change would merge with the operator's note never having
    // been read by anything. `task.id` is what a redirect names (DESIGN
    // §4.4 `redirect <task>`), so it is what every dispatch under this task
    // reads the note back under, whichever kind of session it is.
    const note = redirectNoteFor(state, runId, task.id);
    const prompt =
      note === undefined
        ? request.prompt
        : `${request.prompt}\n\n## An operator redirected this task\n\n${note}`;

    options.onProgress?.({
      phase: 'start',
      taskId: request.taskId,
      kind,
      role: request.role.name,
      round,
    });
    const outcome = await options.sessions.runTask({ runId, ...request, prompt });
    options.onProgress?.({
      phase: 'finish',
      taskId: request.taskId,
      kind,
      role: request.role.name,
      round,
      outcome: outcome.status === 'completed' ? 'completed' : outcome.reason,
    });
    return outcome;
  };

  const worktree = await options.worktrees.acquire(task.id);
  // Asked before any session runs, so it is a fact about what the checkout was
  // handed over carrying rather than about anything this run did. A reused
  // worktree with commits on it was left mid-task by an earlier run, and those
  // commits are the loop's for the same reason this run's rework commits are.
  const inheritedCommits = worktree.reused
    ? ((await options.worktrees.commitsAhead(task.id, into)) ?? 0)
    : 0;
  // Read before the session starts, for the same reason: what the checkout was
  // handed over holding, not what this run went on to do to it.
  //
  // Not gated on `reused`, though only a reused checkout can hold anything. A
  // fresh one is created from the trunk and is clean, so it answers zero and
  // false and the prompt says nothing — which makes the flag a branch no test
  // could fail on. Deciding on what the checkout actually holds is also the
  // more robust of the two: if acquiring ever left something behind, the
  // session would be told rather than the flag saying it could not have.
  const carried: CarriedWork = {
    commits: inheritedCommits,
    uncommitted: await options.worktrees.isDirty(task.id),
  };
  // A reused checkout's `base` is its branch tip, so this is the commit the
  // last run left — and the only one a previous review can still be about.
  const priorReview = worktree.reused
    ? lastReviewOf(options.log.read(), task.id, worktree.base)
    : undefined;
  // Rounds are attached by the helper rather than by each caller: a task that
  // blocked in its second round should say so wherever it stopped, and
  // thirteen call sites each remembering to pass them is twelve chances not
  // to.
  const rounds: ReviewRound[] = [];
  const stop = (
    reason: string,
    extra: Partial<ImplementResult> = {},
  ): ImplementResult => {
    // Recorded here rather than at each `return stop(...)` for the same reason
    // the rounds are: there are thirteen of them, and thirteen call sites each
    // remembering to log is twelve chances not to. Without the event the fold
    // leaves the task saying `dispatched`, which is indistinguishable from one
    // still running (OBS-4).
    //
    // Appended only when a session for this task has actually been
    // dispatched. `track` returns a `blocked` outcome without dispatching at
    // all when the run is paused or killed before this task's first session
    // — which is the outcome that reaches `stop` when an operator pauses or
    // kills before `implementTask` gets this far. Appending `TaskBlocked` for
    // that task then would write an event the fold has never seen a
    // `TaskDispatched` for, and `requireTask` refuses exactly that — not just
    // for this event, but for every event any run ever folds afterwards,
    // because `Projector.project()` refolds the whole log (T4.2.4, CONV-5:
    // the obligation "no event about a task before its `TaskDispatched`" is
    // made impossible to violate here rather than merely checked for and
    // reported after the fact). The catch-up refusal above already avoids
    // this the same way, by returning bare rather than through `stop`.
    if (fold(options.log.read()).runs[runId]?.tasks[task.id] !== undefined) {
      options.log.append({
        runId,
        type: 'TaskBlocked',
        payload: { taskId: task.id, reason },
      });
    }
    return {
      status: 'blocked',
      taskId: task.id,
      branch: worktree.branch,
      worktree: worktree.path,
      reason,
      ...(rounds.length === 0 ? {} : { rounds: [...rounds] }),
      ...extra,
    };
  };

  // Read here, immediately before `catchUp` below — the first thing this
  // loop does *to* the repository rather than merely off it (a real merge of
  // the trunk into the task's branch). `track`'s own read guards every
  // session dispatch, but nothing stood between acquiring the checkout above
  // and this merge: a kill or pause already on record before this task's
  // very first session still let it happen, unlike every other action a
  // stopped run refuses to take (review, T4.2.4). `stop` already handles "no
  // session dispatched yet" correctly — it only appends `TaskBlocked` once
  // this task has a `TaskDispatched` for the fold to attach it to — so it is
  // safe to call here too, before any session has run.
  const controlBeforeCatchUp = runControl(fold(options.log.read()), runId);
  if (controlBeforeCatchUp !== 'running') {
    return stop(`the run was ${controlBeforeCatchUp} by an operator`);
  }

  // Only now, and deliberately after everything above has been read off the
  // checkout as it was handed over: a branch cut before its own dependencies
  // merged is a branch CI may never be asked about at all, because a provider
  // that builds a merge commit to test cannot build one for a pull request
  // that conflicts. `priorReview` is read first for the same reason in
  // reverse — a mechanical trunk merge moves the tip without answering
  // anything a reviewer said about the author's own work.
  const caughtUp = await options.worktrees.catchUp(task.id, into);
  if (caughtUp.status === 'conflicted' || caughtUp.status === 'refused') {
    // Not `stop`, which appends `TaskBlocked`: no session has been dispatched
    // yet, so the fold has no task for that event to be about and `requireTask`
    // refuses it — the same shape as the refusals in `cli/commands.ts` that
    // happen before a run begins. The reason reaches the operator through the
    // result, which is where a refusal to start belongs.
    return {
      status: 'blocked',
      taskId: task.id,
      branch: worktree.branch,
      worktree: worktree.path,
      reason:
        caughtUp.status === 'conflicted'
          ? `'${worktree.branch}' is behind '${into}' and merging it conflicts in ` +
            `${caughtUp.files.join(', ')}. Resolving it is a change somebody has ` +
            `to make; until it is made, a pull request for this branch cannot ` +
            `report checks at all.`
          : `could not bring '${worktree.branch}' up to '${into}': ${caughtUp.detail}`,
    };
  }

  // Timed and logged (T4.2.9, NFR-3), the same as `phase/runner.ts`'s own
  // call: this is the path every `mpgm implement` uses, and it runs before
  // `sessions.runTask` — outside the span `SessionUsage.durationMs` covers.
  const contextStartedAt = performance.now();
  const context = assembleContext({
    task: {
      description: `${task.id} — ${task.title} (${task.milestone})`,
      prompt:
        priorReview === undefined
          ? implementPrompt(task, worktree.branch, carried)
          : `${implementPrompt(task, worktree.branch, carried)}\n\n## What the last review found\n\n${renderPriorReview(priorReview)}`,
    },
    upstream: [],
    kb: options.kb,
    policy: options.policy,
  });
  options.log.append({
    runId,
    type: 'ContextAssembled',
    payload: {
      taskId: task.id,
      site: 'implement',
      durationMs: performance.now() - contextStartedAt,
    },
  });

  const authored = await track('implement', 1, {
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
  // change, so its account of what it did is the one that counts — reading the
  // summary or the ref off the first attempt would describe work that has since
  // been rewritten.
  //
  // Deviations are the exception, and `declaredDeviations` below is why.
  let latest = change.data;

  // Read again immediately before publishing this change or opening its pull
  // request — the first things the loop does outside the repository itself,
  // and a window `track`'s own guard cannot reach: the implementing session
  // just ran for minutes, and a kill or pause recorded while it was in flight
  // lands strictly after `track` last checked, before either of these runs.
  // In production `publish` is a real `git push` and `openPullRequest` a real
  // pull request (`cli/commands.ts`); without this a killed run still pushed
  // the branch and opened the PR, which is the same class of gap this task
  // already closed for `catchUp` and `mergeChange` — check before the first
  // thing the loop does to something outside the repository, not only before
  // its last (T4.2.4, HIL-3). `stop` here appends `TaskBlocked` correctly: a
  // session for this task has already been dispatched by the time this runs.
  const controlBeforePublish = runControl(fold(options.log.read()), runId);
  if (controlBeforePublish !== 'running') {
    return stop(`the run was ${controlBeforePublish} by an operator`, {
      ref: change.data.ref,
    });
  }

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
  // Deviations the author has already been sent back with, and whether the one
  // extra round a late declaration can buy has been spent. Both live outside
  // the loop because both are facts about the task, not about a round.
  // Keyed by convention id so that 'CONV-1' and 'CONV-1 (one logical change per
  // commit)' are one declaration rather than two.
  const declaredSoFar = new Map<string, string>();
  let extensionSpent = false;
  let attempts = maxReviewAttempts;

  for (let round = 1; round <= attempts; round += 1) {
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
      // `track` already refuses to dispatch a repair session once the run is
      // paused or killed, but `repairUntilGreen` keeps iterating without
      // dispatching one whenever a repair produces nothing usable — which is
      // exactly what an intervention causes here. Without this the loop would
      // spend the rest of the repair budget on that instead of reporting the
      // real cause (T4.2.4, HIL-3, CONV-3).
      shouldContinue: () => {
        const control = runControl(fold(options.log.read()), runId);
        return control === 'running'
          ? { ok: true }
          : { ok: false, reason: `the run was ${control} by an operator` };
      },
      repair: async (request) => {
        const retry = await track('repair', request.attempt, {
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
          // Read again immediately before publishing, for the same reason as
          // the guard around the first publish above: the repair session just
          // ran, and a kill or pause recorded while it was in flight lands
          // after `track` last checked. This does not itself need to stop the
          // loop — `shouldContinue` above and the next `track` call already
          // do that — it only keeps the push from happening on the way there
          // (T4.2.4, HIL-3).
          const controlBeforeRepairPublish = runControl(fold(options.log.read()), runId);
          if (controlBeforeRepairPublish === 'running') {
            await options.publish?.(worktree.branch, fixed.data.ref);
          }
        }
        // A repair session that produced nothing usable leaves the ref where it
        // was, so the next verdict is the same one and the budget still shrinks
        // — rather than the loop losing track of which commit it is judging.
        return { ref: fixed?.success === true ? fixed.data.ref : request.ref };
      },
    });

    if (repair.status !== 'green') {
      // 'stopped' is an operator's doing, not CI's (T4.2.4, CONV-3): saying
      // "CI did not go green" over a kill or a pause would send an operator
      // looking at a build that was never the cause.
      return stop(
        repair.status === 'stopped'
          ? repair.reason
          : `CI did not go green: ${repair.reason}`,
        {
          ref: repair.ref,
          repair,
          ...(pullRequest === undefined ? {} : { pullRequest }),
        },
      );
    }

    // What the checkout is on now that the round's commits have settled. Every
    // ref below is compared against this rather than against the one a session
    // reported, because a review is of a commit and git is the only thing here
    // that knows which commit that is (see `commit-ref.ts`).
    const tip = await options.worktrees.head(task.id);
    if (tip === undefined) {
      // Fail closed (CONV-4). Carrying on would leave the gate comparing one
      // model's account of the branch against another's, which is the state
      // this exists to end.
      return stop(
        `could not read the commit '${worktree.branch}' is on, so nothing can be checked against it`,
        {
          ref: repair.ref,
          repair,
          ...(pullRequest === undefined ? {} : { pullRequest }),
        },
      );
    }

    // Each round's review is its own task, so a rework's review does not
    // overwrite the record of the one that asked for it (OBS-1).
    const reviewTaskId =
      round === 1 ? `${task.id}-review` : `${task.id}-review-${String(round)}`;
    const reviewed = await track('review', round, {
      taskId: reviewTaskId,
      role: reviewerRole,
      prompt: reviewPrompt(task, tip, into, round > 1 || inheritedCommits > 0),
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

    // Every convention this task has declared a departure from, in any round,
    // not only the one that just ran.
    //
    // A rework session writes a fresh result, so a declaration it made last
    // round is gone unless it types it again — and T4.1.4b is what that costs.
    // Its author declared CONV-1 in round two, the undeclared list went empty,
    // and in round three it did not repeat itself: the reviewer approved the
    // change, reported CONV-1 and CONV-3, and the gate refused an approved
    // change for a declaration that had already been made and recorded.
    //
    // Requiring it to be retyped every round is a formality with no information
    // in it. A declaration is a decision on the record (IMP-4), so the record
    // is what the gate reads. Withdrawing one needs no verb: a declaration only
    // matters while the reviewer is still reporting that convention, and an
    // author that would rather fix the departure than stand behind it fixes it,
    // after which nothing reports it and nothing is carried.
    //
    // Within the run, deliberately. A declaration made in an abandoned earlier
    // run is about work this one may have rewritten, which is the same reason
    // `lastReviewOf` refuses to carry a review whose commit has moved.
    for (const entry of latest.deviations) {
      declaredSoFar.set(
        conventionIdOf(entry.convention) ?? entry.convention.trim(),
        entry.convention,
      );
    }
    const declared = [...declaredSoFar.values()];
    review = {
      reviewTaskId,
      reviewerRole: reviewerRole.name,
      // Recorded as the commit it names, not as the session wrote it. The log
      // is what a later run reads to carry these findings forward, and a
      // seven-character ref matches nothing there. A ref that names some other
      // commit is left as written, so the gate below still refuses it as stale.
      ref: reconcileRef(parsed.data.ref, tip),
      approved: parsed.data.verdict === 'approve',
      summary: parsed.data.summary,
      deviations: parsed.data.deviations.map((entry) => entry.convention),
    };
    options.log.append(
      changeReviewed(runId, task.id, review, parsed.data.findings, declared),
    );

    request = {
      taskId: task.id,
      authorRole: implementerRole.name,
      ref: tip,
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

    const undeclared = undeclaredDeviations(review.deviations ?? [], declared);

    // The reviewer approved and the only thing refusing the change is a
    // declaration, so ask for the declaration rather than for more work.
    //
    // Asked on every such review rather than once per task. The author writes
    // `deviations` before the review that reports one, so a deviation first
    // reported in round N cannot have been declared in round N — and that is
    // true of every N, not only of the first. T4.2.4 is what a once-per-task
    // bound costs: the grace went at round 1 for CONV-6, round 2 was a genuine
    // rework, and round 3 approved while reporting CONV-3 for the first time,
    // with no grace left to sign it. Twelve sessions and $29.52 refused over a
    // signature the author was never in a position to give.
    const wantsDeclaration = earnsDeclarationRound({
      decision,
      approved: review.approved,
    });
    // What bounds the loop is the budget, not the count of graces. Below the
    // cap a declaration round costs the round it replaces, which would
    // otherwise have been rework on a change the reviewer has passed — it
    // spends nothing that was not already going to be spent. At the cap there
    // is no round left to declare in, so one is added rather than taken, and
    // that addition is once per task: without it a reviewer reporting a fresh
    // deviation every round extends the budget forever, which is the
    // elasticity the grace is deliberately not.
    const declarationRound = wantsDeclaration && (round < attempts || !extensionSpent);
    if (declarationRound) {
      if (round === attempts) {
        extensionSpent = true;
        attempts += 1;
      }
    } else if (round === attempts) {
      options.log.append({
        runId,
        type: 'BudgetExceeded',
        payload: {
          taskId: task.id,
          kind: 'reviews',
          limit: attempts,
          observed: round,
        },
      });
      return stop(
        `the review still refuses the change after ${String(attempts)} attempt(s): ` +
          decision.reasons.join('; '),
        { ref: repair.ref, review, repair },
      );
    }

    // The last rework round runs one tier up, the same as the CI repair
    // loop's own last attempt and for the same reason (PLAN §3, T3.1.2b,
    // AGT-5): the model is a dispatch-time session parameter rather than a
    // role field, so trying a stronger one before the review budget runs out
    // costs nothing beyond the round that was going to be spent regardless —
    // true of the round count, which is T4.2.13's own claim, and never true
    // of the money: the same round on a stronger tier can cost roughly eight
    // times what its predecessor did, against an allowance that was sized
    // for the weaker one and does not move (T4.3.2, T4.3.8). Escalating
    // every round would spend the stronger model on rounds the weaker one
    // would have closed on its own; escalating none is what this task
    // found — every round pinned to the implementer role's frozen
    // `claude-sonnet-5` however many times it came back from review.
    //
    // "Last" is a round of the *budget*, not of the reviewer's patience: the
    // branch above already stops the task on a rejection at the cap with
    // nothing left to extend it (`BudgetExceeded`, `kind: 'reviews'`), and a
    // rework dispatched there would fix a change no further round would ever
    // review. So `track('rework', ...)` below is only ever reached with a
    // review round still to come, and the round dispatched here is the last
    // one whose fix that next round can still use — one short of `attempts`
    // as it stands now, after the extension above has already been applied
    // when this round earned one.
    //
    // Read off the implementer role rather than off the PLAN Model column:
    // `planTaskSchema` (`src/schemas.ts`) carries no model field, so the
    // gated Plan artifact never holds a per-task model for any dispatch to
    // read, and PLAN §3 hands routing on that column to T5.2.3. Making it
    // binding here, without changing the schema and revising §3 and T5.2.3's
    // scope in the same commit, would make the column binding by accident —
    // so the escalation stays role-relative, one tier above whatever this
    // role already runs on, whatever the column happens to say for this task.
    const isFinalRework = round === attempts - 1;
    const reworkModel = isFinalRework
      ? escalateModel(implementerRole.model)
      : implementerRole.model;

    // What actually guards the escalated round. An earlier revision of this
    // comment claimed `SessionRunner` already did: it does not, and T4.3.2 is
    // the measurement that shows it. `SessionRunner.runTask` (`agent/
    // runner.ts`) builds a fresh `BudgetLedger` from the implementer role's
    // own budget on *every* dispatch — "one ledger per task" there means one
    // per dispatch, since a review round is a fresh call sharing nothing with
    // the last one — and refuses to start only when `remainingCostUsd <= 0`,
    // which a brand-new ledger never is. So the escalated round always had
    // the whole allowance in front of it, and nothing ever asked whether that
    // allowance could fund the tier about to spend it: T4.3.2's Opus round
    // started on the implementer role's full $8, ran, and was truncated at
    // the cap after $8.0142675 — by which point it had already committed
    // twice and pushed neither.
    //
    // Guarded on an estimate of what the stronger tier needs, measured from
    // this task's own log (`implementerRoundCostSoFar`,
    // `estimateEscalatedCostUsd`) rather than invented, and refused outright
    // — not dispatched and left to be truncated — when the allowance the
    // estimate is checked against is the one already sized for the weaker
    // tier. The other two ways this could have gone are declined rather than
    // silently: raising the implementer role's `costUsd` to whatever this one
    // incident happened to cost would be sized for T4.3.2 and nothing else,
    // and a tier-relative allowance is a `roles/freeze.json` change that
    // needs an operator's name on it, not a decision this loop can make for
    // them. Refused is logged rather than dropped back a tier without saying
    // so — T4.2.13 already forbids that — so an operator who wants the
    // escalated tier funded can raise the allowance deliberately, the same
    // way every other role budget in `roles/freeze.json` was.
    if (isFinalRework && reworkModel !== implementerRole.model) {
      const precedingRoundCostUsd = implementerRoundCostSoFar(
        options.log.read(),
        runId,
        task.id,
      );
      const estimatedCostUsd = estimateEscalatedCostUsd(precedingRoundCostUsd);
      if (estimatedCostUsd > implementerRole.budgets.costUsd) {
        options.log.append({
          runId,
          type: 'BudgetExceeded',
          payload: {
            taskId: task.id,
            kind: 'escalation',
            limit: implementerRole.budgets.costUsd,
            observed: estimatedCostUsd,
          },
        });
        return stop(
          `the final rework round would escalate to ${reworkModel}, estimated at ` +
            `$${estimatedCostUsd.toFixed(4)} (${String(ESCALATION_COST_MULTIPLIER)}x this ` +
            `task's own $${precedingRoundCostUsd.toFixed(4)} per round on ` +
            `${implementerRole.model}) — more than the implementer role's ` +
            `$${implementerRole.budgets.costUsd.toFixed(2)} allowance can fund, so the round ` +
            `is refused before dispatch rather than started and truncated at the cap`,
          { ref: repair.ref, review, repair },
        );
      }
    }

    // Back to the author, with what the reviewer found. Without this the review
    // is written, recorded and read by nobody, and the next attempt at the task
    // reproduces the defect because a fresh session knows nothing about it.
    const reworked = await track('rework', round, {
      taskId: task.id,
      role: implementerRole,
      model: reworkModel,
      prompt: declarationRound
        ? `${context.prompt}\n\n## The reviewer approved. One thing is missing\n\n${renderDeclarationRound(undeclared)}`
        : `${context.prompt}\n\n## The review asked for changes\n\n${renderReview({
            review: parsed.data,
            undeclared,
            attempt: round,
            attemptsRemaining: attempts - round,
          })}`,
      policyRoot: worktree.path,
    });

    if (reworked.status !== 'completed') {
      // A kill lands after the session has already committed — T4.3.2's own
      // Opus round left two commits, 1,278 insertions over 16 files,
      // answering every blocking finding the second review had raised, when
      // the cap ended it before it pushed. The worktree outlives the session
      // that was working in it (DESIGN §6), so what it holds is read here
      // rather than reporting the block against `repair.ref` — the last
      // commit this loop itself published — which would leave finished work
      // visible only to whoever happens to look in the local worktree.
      //
      // Pushed rather than merely reported: publishing makes the branch
      // visible to CI and to a pull request the same way every other round's
      // commit is (`options.publish` above) — it is not a merge, and nothing
      // here approves what the killed session wrote. An operator or a later
      // run still has to look at it; what this closes is the gap where
      // nothing *could*, because only `git log` against a path nobody but
      // this worktree had would show it.
      const strandedTip = await options.worktrees.head(task.id);
      const strandedNewWork = strandedTip !== undefined && strandedTip !== repair.ref;
      const strandedControl = runControl(fold(options.log.read()), runId);
      if (strandedNewWork && strandedControl === 'running') {
        await options.publish?.(worktree.branch, strandedTip);
      }
      return stop(
        `the rework session blocked: ${reworked.reason}` +
          (strandedNewWork
            ? ` — it had already committed up to ${strandedTip}, pushed for review rather than left only in the worktree`
            : ''),
        {
          ref: strandedTip ?? repair.ref,
          review,
          repair,
        },
      );
    }

    const revised = changeSchema.safeParse(reworked.output);
    if (!revised.success) {
      return stop(
        `the rework session did not report a usable change: ${revised.error.message}`,
        { ref: repair.ref, review, repair },
      );
    }

    latest = revised.data;

    // Read again immediately before publishing the reworked change, for the
    // same reason as the guard around the first publish above: the rework
    // session just ran, and a kill or pause recorded while it was in flight
    // lands strictly after `track` last checked, before this push runs
    // (T4.2.4, HIL-3).
    const controlBeforeReworkPublish = runControl(fold(options.log.read()), runId);
    if (controlBeforeReworkPublish !== 'running') {
      return stop(`the run was ${controlBeforeReworkPublish} by an operator`, {
        ref: revised.data.ref,
        review,
        repair,
      });
    }

    await options.publish?.(worktree.branch, revised.data.ref);
  }

  if (repair === undefined || review === undefined || request === undefined) {
    // Unreachable: the loop runs at least once, and every path out of it
    // either sets these or returns. Stated rather than asserted with `!`.
    return stop('the review loop produced no decision');
  }

  // Read once more, immediately before the one dispatch-shaped call `track`
  // does not guard: merging is the loop's only irreversible act, and nothing
  // between the review returning (above) and here checks the run's control
  // again. Without this a kill or pause recorded while that review session
  // was in flight — after `track` last read it, before the change was
  // merged — reached everywhere else the loop stops but not this one
  // (T4.2.4, HIL-3): the task would merge to the trunk with the operator
  // having already told it not to.
  const controlBeforeMerge = runControl(fold(options.log.read()), runId);
  if (controlBeforeMerge !== 'running') {
    return stop(`the run was ${controlBeforeMerge} by an operator`, {
      ref: repair.ref,
      review,
      repair,
    });
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
