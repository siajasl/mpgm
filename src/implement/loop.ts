import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { renderConflict } from './conflict.js';
import {
  changeReviewed,
  decideMerge,
  mergeChange,
  type MergeDecision,
  type MergeDecisionRequest,
  type MergeResult,
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

/**
 * How much of one conflicted file's content is inlined into a
 * conflict-resolution prompt before it is named as conflicted-but-not-shown
 * instead (T4.3.9). `git diff --diff-filter=U` reports a conflicted
 * `package-lock.json` the same as any other conflicted file, and inlining a
 * megabyte of it would spend the role's token budget on content no
 * resolution needs, turning a cheap refusal into an expensive failed
 * session.
 */
const CONFLICT_FILE_CHAR_LIMIT = 20_000;

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
 * What the implementer role spent on this task's *last round* — every
 * `SessionUsage` for the task since the last `ChangeReviewed` that closed a
 * round, or since the beginning of the task if none has closed yet — read
 * off the event log rather than off a table of prices the kernel does not
 * have (`estimateEscalatedCostUsd`, `agent/models.ts`).
 *
 * A round, not a dispatch. The two are not the same thing: `track('repair',
 * ...)` (`repairUntilGreen`'s callback, above) dispatches a CI-repair session
 * under this same `taskId`, writing its own `TaskDispatched`, and a round
 * that went red on CI and was repaired is still one round — the repair is
 * the round finishing, not a new one starting. An earlier revision of this
 * function reset its accumulator on every `TaskDispatched` for the task,
 * which measured the last *dispatch* rather than the last *round*: a $3.00
 * rework round followed by a $0.05 repair reported an estimate of $0.40,
 * the guard below passed, and the escalated round dispatched on the full
 * allowance — the exact outcome this function exists to keep the guard
 * from missing. `ChangeReviewed` is what the loop appends once per round,
 * after CI is green and the reviewer has seen the result (`track('review',
 * ...)`, above), so it is the boundary a repair dispatch never crosses and
 * a fresh round always does.
 *
 * Every session this loop dispatches for the task carries `taskId: task.id`
 * except a review, which runs under `${task.id}-review[-n]` (see `track`
 * above) — so filtering on `task.id` alone already excludes the reviewer's
 * own spend, and `ChangeReviewed` itself is recorded under `task.id`
 * (`changeReviewed`, `implement/merge.ts`), not under the review's own id,
 * so the same filter finds the round boundary too.
 *
 * The preceding round rather than an average over every round the task has
 * run, because `ESCALATION_COST_MULTIPLIER` is a ratio between two adjacent
 * rounds — T4.3.2's Opus round at $8.0142675 over the Sonnet round right
 * before it at $1.0557692 — and a ratio measured against one round means
 * nothing multiplied by another quantity. The two differ by a lot rather
 * than a little: for T4.3.2 the preceding round gives an estimate of $8.45
 * and the lifetime average $26.80, and across this repo's own log
 * (`.mpgm/state.db`, 38 tasks with more than one implementer dispatch) the
 * average is above the $1 at which 8x crosses the $8 allowance on 30 of
 * them against 13 for the last round. An earlier revision of this function
 * computed the average while its documentation described the preceding
 * round; the firing rate that followed is the difference between guarding
 * the escalated round and retiring it.
 *
 * Retries inside a dispatch count toward it too: `SessionRunner.runTask`
 * writes one `TaskDispatched` and one `SessionUsage` per validation
 * attempt, and those attempts share one ledger, so what "the round cost"
 * means at the cap is the sum over every attempt of every dispatch the
 * round made.
 */
function implementerPrecedingRoundCostUsd(
  events: readonly StoredEvent[],
  runId: string,
  taskId: string,
): number {
  let costUsd = 0;
  let dispatched = false;
  // Starts open: the task's first dispatch begins its first round rather
  // than continuing one that was never seen.
  let roundOpen = true;
  for (const event of events) {
    if (event.runId !== runId) {
      continue;
    }
    if (
      event.type === 'TaskDispatched' &&
      (event.payload as { taskId: string }).taskId === taskId
    ) {
      dispatched = true;
      // Reset only when this dispatch opens a fresh round — the one right
      // after the last round's `ChangeReviewed` closed it. A dispatch that
      // lands while the round is still open (a repair, mid-round) adds to
      // what that round has already spent instead of starting a new count.
      if (roundOpen) {
        costUsd = 0;
        roundOpen = false;
      }
    } else if (
      event.type === 'ChangeReviewed' &&
      (event.payload as { taskId: string }).taskId === taskId
    ) {
      roundOpen = true;
    } else if (
      dispatched &&
      event.type === 'SessionUsage' &&
      (event.payload as { taskId: string }).taskId === taskId
    ) {
      costUsd += (event.payload as { costUsd: number }).costUsd;
    }
  }
  // 0 when nothing has been dispatched for this task in this run, which is
  // unreachable once a rework round is in play: the implementing session
  // that opens every task always dispatches and is always recorded first.
  // Answering 0 rather than throwing keeps this a measurement rather than an
  // assertion — a caller finding no evidence estimates nothing, rather than
  // refusing a round it cannot say anything about.
  return costUsd;
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

  // Shared by both places a conflict between this task's branch and `into`
  // can turn up: here, before the first session ever runs, and again right
  // before the trunk-side merge at the end of this function, where a filing
  // that landed on `into` during this task's own 20-40 minute life can make
  // `mergeChange`'s own merge conflict the same way (`merge.ts`, T4.3.9).
  // Both sites hand the conflict to the same role that authored the change,
  // with the common ancestor visible, and ask it to reconcile the two sides
  // honestly rather than have an operator do it by hand (T4.3.2, T4.3.9,
  // `conflict.ts`) — the dispatch both `worktree.ts` and `merge.ts` have long
  // claimed happens.
  //
  // `resolveTaskId` is suffixed by the caller so the two sites do not share
  // one id: `${task.id}-catchup` here, `${task.id}-catchup-2` at the
  // trunk-side site, numbered the way a rework round's `-review-${n}` already
  // is — each a session-only id `overhead.ts` and `supersede` already know
  // how to treat as not itself a plan task.
  const catchUpAndResolve = async (
    resolveSuffix: string,
  ): Promise<
    | { readonly status: 'clean' }
    | { readonly status: 'refused'; readonly detail: string }
    | { readonly status: 'blocked'; readonly reason: string }
  > => {
    // `leaveConflicted` so that a conflict is handed to `track('resolve-
    // conflict', ...)` below with its markers still in place, rather than
    // aborted before anything could see them (T4.3.9, `conflict.ts`).
    const caughtUp = await options.worktrees.catchUp(task.id, into, {
      leaveConflicted: true,
    });
    if (caughtUp.status === 'refused') {
      return { status: 'refused', detail: caughtUp.detail };
    }
    if (caughtUp.status !== 'conflicted') {
      return { status: 'clean' };
    }

    const blocked = async (
      reason: string,
    ): Promise<{ status: 'blocked'; reason: string }> => {
      // Left as the resolver left it unless a merge is genuinely still open
      // — a resolver that finished the merge but was refused for some other
      // reason (an unparseable result, say) has nothing here to undo, and
      // aborting it would throw its commit away for no reason connected to
      // the merge itself.
      if (await options.worktrees.mergeInProgress(task.id)) {
        await options.worktrees.abortMerge(task.id);
      }
      return { status: 'blocked', reason };
    };

    const conflictSummary =
      `'${worktree.branch}' is behind '${into}' and merging it conflicts in ` +
      `${caughtUp.files.join(', ')}.`;

    // Checked here, not left to `track`'s own guard, because that guard
    // returns a `blocked`-shaped outcome without dispatching anything and
    // this branch's messages below say "an agent was asked" — true only if
    // one actually was. An operator who paused or killed the run between
    // `catchUp` leaving the conflict in place and here gets told that,
    // rather than a resolver's own reason for one it was never given.
    const conflictControl = runControl(fold(options.log.read()), runId);
    if (conflictControl !== 'running') {
      return blocked(
        `${conflictSummary} The run was ${conflictControl} by an operator ` +
          `before an agent could be dispatched to resolve it.`,
      );
    }

    // Every conflicted file's content goes in the prompt, but bounded: an
    // unbounded inline (a conflicted `package-lock.json`, say — `git
    // diff --diff-filter=U` reports one exactly like any other file) would
    // spend the role's token budget on content no resolution needs, turning
    // a cheap refusal into an expensive failed session.
    const fileContents = new Map<string, string>();
    for (const file of caughtUp.files) {
      const content = await readFile(join(worktree.path, file), 'utf8').catch(
        () => '(could not be read — a binary file, most likely)',
      );
      fileContents.set(
        file,
        content.length > CONFLICT_FILE_CHAR_LIMIT
          ? `(${String(content.length)} characters, over the ${String(
              CONFLICT_FILE_CHAR_LIMIT,
            )}-character limit shown here — conflicted but not shown; use ` +
              `your own tools to read '${file}' if you need it)`
          : content,
      );
    }
    const resolveTaskId = `${task.id}-${resolveSuffix}`;
    const resolution = await track('resolve-conflict', 1, {
      taskId: resolveTaskId,
      role: implementerRole,
      prompt: renderConflict({
        taskId: task.id,
        branch: worktree.branch,
        into,
        files: fileContents,
      }),
      policyRoot: worktree.path,
    });

    if (resolution.status !== 'completed') {
      return blocked(
        `${conflictSummary} An agent was asked to resolve it and did not ` +
          `finish: ${resolution.reason}`,
      );
    }
    const resolved = changeSchema.safeParse(resolution.output);
    if (!resolved.success) {
      return blocked(
        `${conflictSummary} The agent asked to resolve it did not report a ` +
          `usable result: ${resolved.error.message}`,
      );
    }
    if (!resolved.data.complete) {
      return blocked(
        `${conflictSummary} It could not be honestly resolved: ` +
          `${resolved.data.remaining} Resolving it is a change somebody has ` +
          `to make; until it is made, a pull request for this branch cannot ` +
          `report checks at all.`,
      );
    }
    if (await options.worktrees.mergeInProgress(task.id)) {
      return blocked(
        `${conflictSummary} The resolving agent reported success but left ` +
          `the merge unfinished — 'MERGE_HEAD' is still set, so nothing here ` +
          `treats it as resolved.`,
      );
    }
    // `MERGE_HEAD` being clear is not proof the merge landed: `git merge
    // --abort` clears it exactly as `git commit` does, so a resolver that
    // walked away from the conflict looks the same as one that committed
    // the resolution to the check above alone. Rerun the same count
    // `catchUp` computed before attempting the merge — zero means the
    // branch now actually contains `into`, whatever `MERGE_HEAD` said
    // (T4.3.9, `WorktreeManager.behind`'s own doc).
    const stillBehind = await options.worktrees.behind(task.id, into);
    if (stillBehind === undefined || stillBehind > 0) {
      return blocked(
        `${conflictSummary} The resolving agent reported success and no ` +
          `merge is left in progress, but '${worktree.branch}' still does ` +
          `not carry '${into}'` +
          (stillBehind === undefined
            ? ''
            : ` (${String(stillBehind)} commit(s) still missing)`) +
          ` — a merge that was aborted rather than finished looks the same ` +
          `as one that committed, to 'MERGE_HEAD' alone. Resolving it is a ` +
          `change somebody has to make; until it is made, a pull request ` +
          `for this branch cannot report checks at all.`,
      );
    }
    return { status: 'clean' };
  };

  // Read here, immediately before `catchUpAndResolve` below — the first
  // thing this loop does *to* the repository rather than merely off it (a
  // real merge of the trunk into the task's branch). `track`'s own read
  // guards every session dispatch, but nothing stood between acquiring the
  // checkout above and this merge: a kill or pause already on record before
  // this task's very first session still let it happen, unlike every other
  // action a stopped run refuses to take (review, T4.2.4). `stop` already
  // handles "no session dispatched yet" correctly — it only appends
  // `TaskBlocked` once this task has a `TaskDispatched` for the fold to
  // attach it to — so it is safe to call here too, before any session has
  // run.
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
  const caughtUp = await catchUpAndResolve('catchup');
  if (caughtUp.status === 'refused') {
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
      reason: `could not bring '${worktree.branch}' up to '${into}': ${caughtUp.detail}`,
    };
  }
  if (caughtUp.status === 'blocked') {
    // Not `stop`, for the same reason as the `refused` branch above: any
    // session dispatched from `catchUpAndResolve` runs under a session-only
    // id, not `task.id` itself, so the fold still has no `TaskDispatched` for
    // `task.id` for `TaskBlocked` to be about.
    return {
      status: 'blocked',
      taskId: task.id,
      branch: worktree.branch,
      worktree: worktree.path,
      reason: caughtUp.reason,
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
      // Two different facts leave through here, and until T4.3.10 they left
      // saying the same thing. A reviewer that asked for changes refused the
      // change. A reviewer that approved it and named a convention the
      // author had not declared did not: T4.3.3 ended on "the review still
      // refuses the change after 4 attempt(s)" with both of the
      // `ChangeReviewed` events it ended on carrying `approved: true` —
      // eight sessions and $16.84 closing on a sentence no reviewer said.
      //
      // This sentence is what the CLI prints, what `TaskBlocked` stores and
      // what the dashboard shows, and it is read first by an operator
      // deciding what to do next. A change held for want of a signature and
      // a change the gate turned down want different next moves, the same
      // distinction T4.2.15 drew for an operator override (HIL-5).
      //
      // It still blocks, and that is a choice rather than an oversight.
      // Merging with the deviation recorded against the change is the
      // silent introduction IMP-4 refuses — nothing downstream reads that
      // record as a flag, so recording it would be the flag going
      // unraised. "Go to the operator" is what blocking already is here: a
      // blocked task is the thing an operator looks at, and `redirect` is
      // the verb that answers it. What was wrong was never the outcome, it
      // was the account of it.
      //
      // The merge-gate refusal rate is deliberately untouched.
      // `computeGateRates` counts an approving review carrying an
      // undeclared deviation as a refusal because the loop dispatches a
      // fresh session on it, which is a decision T4.2.2a made with its
      // reason stated; `BudgetExceeded` adds no count of its own there, so
      // nothing below changes a figure.
      return stop(
        wantsDeclaration
          ? `the review approved this change and it is held for want of a ` +
              `declaration: it reports the change departing from ` +
              `${undeclared.join('; ')}, which the author's result does not ` +
              `declare, and the one declaration round this task is granted was ` +
              `already spent. No reviewer refused it. Declaring means the ` +
              `\`deviations\` field of the result; an operator who judges the ` +
              `departure acceptable can say so with \`mpgm redirect\` and re-run.`
          : `the review still refuses the change after ${String(attempts)} attempt(s): ` +
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
    //
    // Never a declaration round, whatever the arithmetic says. A declaration
    // round granted at the cap sets `attempts += 1` above, which makes
    // `round === attempts - 1` true of the very round it just bought — so
    // without this clause the one round whose work is known to be trivial
    // (an approved change, one convention id and a sentence into the
    // author's `deviations`) is the round that escalates, and then the guard
    // below can refuse to fund it and end the task. That is the opposite of
    // what both tasks wanted: T4.2.4 added this round because $29.52 of
    // review had already been spent on a change nobody disputed, and
    // T4.2.13 escalated the last *rework* round because rework is where a
    // weaker model runs out of ideas. Asking for a signature is not rework,
    // so it runs on the tier the role is funded for and never reaches the
    // guard.
    const isFinalRework = !declarationRound && round === attempts - 1;
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
    // this task's own log (`implementerPrecedingRoundCostUsd`,
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
    //
    // How often this refuses, measured rather than guessed, because "refused
    // rarely" and "refused almost always" are different designs and only one
    // of them leaves T4.2.13 delivering anything. Against this repo's own log
    // (`.mpgm/state.db`): 22 rounds have been dispatched one tier up, 21 of
    // them with a preceding round to measure, and 11 of those 21 had a
    // preceding round above the $1 at which 8x crosses the implementer's $8 —
    // so this guard would have refused about half of them. Two of the 22
    // actually reached the cap. The multiplier is the worst ratio the log has
    // seen (7.6x, T4.3.2) rounded up, not the median (~1.2x), so a refusal
    // says "this round could breach", not "this round will": the trade is a
    // rework round the task might have got for a round that cannot end with
    // finished work stranded outside the branch. That trade is the one the
    // task asked for — funded or refused, never started and killed part-way —
    // and it is reversible in the direction an operator controls, by raising
    // the allowance in `roles/implementer.md` with the freeze updated in the
    // same commit. If the eval harness (T5.2.1a) later fits a real
    // distribution to escalated rounds, this is the number to revisit, and
    // the figures above are what it should be revisited against.
    if (isFinalRework && reworkModel !== implementerRole.model) {
      const precedingRoundCostUsd = implementerPrecedingRoundCostUsd(
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
        // Everything needed to act on this without reading this file
        // (CONV-3): which round of which task stopped, what it was going to
        // be dispatched on, where the estimate came from and what it was
        // compared against, and the one edit that changes the answer.
        return stop(
          `${task.id}: the final rework round (round ${String(round)} of ` +
            `${String(attempts)}) would escalate from ${implementerRole.model} to ` +
            `${reworkModel}, estimated at $${estimatedCostUsd.toFixed(4)} — ` +
            `${String(ESCALATION_COST_MULTIPLIER)}x the ` +
            `$${precedingRoundCostUsd.toFixed(4)} this task's preceding round cost on ` +
            `${implementerRole.model}, the largest ratio between adjacent rounds this ` +
            `project has recorded (T4.3.2) — against the ${implementerRole.name} role's ` +
            `$${implementerRole.budgets.costUsd.toFixed(2)} allowance, which is sized for ` +
            `${implementerRole.model} and does not move when the model does. The round is ` +
            `refused before dispatch rather than started and truncated at the cap, which ` +
            `is how T4.3.2 lost two finished commits. To fund it, raise ` +
            `budgets.costUsd in roles/${implementerRole.name}.md above ` +
            `$${estimatedCostUsd.toFixed(2)} and update roles/freeze.json in the same ` +
            `commit with who approved it and why; to re-run the round on ` +
            `${implementerRole.model} instead, resume the task, which starts from the ` +
            `worktree as it stands`,
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
      // Compared against `tip` — read from git above, at the top of this
      // round — rather than `repair.ref`. `repair.ref` traces back to the
      // implementing session's own `change.data.ref`/`fixed.data.ref`, which
      // is never run through `reconcileRef` (only the reviewer's ref is, a
      // few hundred lines below, for the same reason: "a seven-character ref
      // matches nothing"). An implementer that reported an abbreviated SHA
      // for the very commit git is already on would make this comparison
      // true with zero new commits, manufacturing stranded work that was
      // never written.
      const strandedTip = await options.worktrees.head(task.id);
      const strandedNewWork = strandedTip !== undefined && strandedTip !== tip;
      const strandedControl = runControl(fold(options.log.read()), runId);
      // Whether the push actually ran, not merely whether it was attempted:
      // `options.publish` is optional (a project whose CI runs locally has
      // nothing to publish), and `strandedControl` can have moved off
      // 'running' while the killed session was in flight — the same race the
      // three earlier publish guards in this function exist for. Either one
      // means the commit below stayed in the worktree, and the message has
      // to say that rather than claim a push that did not happen.
      const strandedPushed =
        strandedNewWork && strandedControl === 'running' && options.publish !== undefined;
      if (strandedPushed) {
        await options.publish(worktree.branch, strandedTip);
      }
      // Named precisely enough to go and look at what the killed session
      // left, from the message alone (CONV-3): the commit, the branch it is
      // on or the path it is only on, and which of the two reasons a push
      // did not happen — a paused run and an unconfigured publish need
      // different things done about them.
      return stop(
        `${task.id}: the rework session blocked: ${reworked.reason}` +
          (strandedNewWork
            ? strandedPushed
              ? ` — it had already committed up to ${strandedTip}, pushed to ` +
                `${worktree.branch} for review rather than left only in the worktree at ` +
                worktree.path
              : ` — it had already committed up to ${strandedTip} on ${worktree.branch}, ` +
                `left in the worktree at ${worktree.path} rather than pushed, because ` +
                (strandedControl !== 'running'
                  ? `the run was ${strandedControl} before it could be published; resume ` +
                    'the run, or push that branch by hand, or the work is visible only ' +
                    'there'
                  : 'no publish was configured for this run; push that branch by hand, ' +
                    'or the work is visible only there')
            : ''),
        {
          ref: strandedTip ?? tip,
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

  const attemptMerge = (): Promise<MergeResult> =>
    mergeChange({
      runId,
      repo: options.repo,
      branch: worktree.branch,
      into,
      request,
      emit: (event) => {
        options.log.append(event);
      },
    });

  let merged = await attemptMerge();

  if (!merged.merged && merged.conflict !== undefined) {
    // `mergeChange` already fetched and fast-forwarded the local `into`
    // before finding this, so the branch's own worktree can see exactly the
    // trunk state that just failed to merge — a filing landed on `into`
    // after this branch was last caught up and reviewed, reproducing
    // `catchUp`'s own conflict at the far end of the loop instead of the
    // near one (T4.3.9, `merge.ts`, `conflict.ts`).
    const conflictedFiles = merged.conflict.files;
    const resolved = await catchUpAndResolve('catchup-2');
    if (resolved.status === 'refused') {
      return stop(
        `'${worktree.branch}' passed review, but merging it into '${into}' now ` +
          `conflicts in ${conflictedFiles.join(', ')}, and it could not be brought ` +
          `up to '${into}' to retry: ${resolved.detail}`,
        { ref: repair.ref, review, repair },
      );
    }
    if (resolved.status === 'blocked') {
      return stop(resolved.reason, { ref: repair.ref, review, repair });
    }
    // Resolved and confirmed to actually carry `into` now (`catchUpAndResolve`'s
    // own `stillBehind` check) — retried once, not looped: a second conflict
    // here would mean that check was wrong, not that trying a third time
    // would fare any better.
    merged = await attemptMerge();
    if (!merged.merged && merged.conflict !== undefined) {
      return stop(
        `'${worktree.branch}' still conflicts merging into '${into}' in ` +
          `${merged.conflict.files.join(', ')} even after being brought up to date ` +
          `and reconciled — the reconciliation did not resolve what the retry needed.`,
        { ref: repair.ref, review, repair },
      );
    }
  }

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
