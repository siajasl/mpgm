import type { BoundContract } from '../contract/capability.js';
import type { RunState } from '../state/kernel-state.js';
import { desiredProjection, type Plan } from './projection.js';
import {
  EMPTY_PROJECTION,
  reconcile,
  type ObservedProjection,
  type PmOperation,
} from './reconcile.js';

/**
 * The PM projector (PMG-1 to PMG-4, DESIGN section 4.8).
 *
 * Subscribes to nothing and remembers nothing. Every call recomputes what the
 * board should hold from the gated Plan and folded kernel state, reads what it
 * does hold, and applies the difference. Bootstrap is that call against an
 * empty board; reconcile is the same call again; currency (PMG-2) is that call
 * running when an event commits rather than on a timer.
 *
 * One function, three requirements. The alternative — a projector that tracks
 * what it believes it has already done — is a second source of truth about a
 * projection whose whole point is that it is derived (PMG-3).
 */

export interface PmProjectorOptions {
  readonly contract: BoundContract;
  /** `owner/repo`. */
  readonly repo: string;
  readonly boardTitle?: string;
}

export interface SyncReport {
  readonly operations: readonly PmOperation[];
  readonly applied: number;
  /** True when the board already matched — the normal steady state. */
  readonly converged: boolean;
}

export class PmProjector {
  readonly #contract: BoundContract;
  readonly #repo: string;
  readonly #boardTitle: string | undefined;

  constructor(options: PmProjectorOptions) {
    this.#contract = options.contract;
    this.#repo = options.repo;
    this.#boardTitle = options.boardTitle;
  }

  /** What the board should hold right now. */
  plan(plan: Plan, run?: RunState): PmOperation[] {
    return reconcile(this.#desired(plan, run), EMPTY_PROJECTION);
  }

  #desired(plan: Plan, run: RunState | undefined) {
    return desiredProjection(plan, {
      ...(this.#boardTitle === undefined ? {} : { boardTitle: this.#boardTitle }),
      ...(run === undefined ? {} : { run }),
    });
  }

  async observe(): Promise<ObservedProjection> {
    return this.#contract.invoke<ObservedProjection>('observe', { repo: this.#repo });
  }

  /**
   * Bring the board into line with the plan.
   *
   * Applies nothing when there is nothing to do, so a projector called on
   * every event is quiet between changes rather than writing the same board
   * over and over.
   */
  async sync(plan: Plan, run?: RunState): Promise<SyncReport> {
    const observed = await this.observe();
    const operations = reconcile(this.#desired(plan, run), observed);
    if (operations.length === 0) {
      return { operations, applied: 0, converged: true };
    }

    const result = await this.#contract.invoke<{ applied: number }>('apply', {
      repo: this.#repo,
      operations: operations as unknown as Record<string, unknown>[],
    });

    return { operations, applied: result.applied, converged: false };
  }

  /**
   * Record that a pull request belongs to a task.
   *
   * Separate from `sync` because the link is not derivable from the plan: the
   * branch name says which task a PR is for (worktree manager, IMP-1), and
   * nothing in the Plan artifact knows a PR exists.
   */
  async linkPullRequest(taskId: string, pullRequest: number): Promise<void> {
    const observed = await this.observe();
    const issue = observed.issues.find((entry) => entry.key === taskId);
    if (issue === undefined) {
      throw new Error(
        `no issue on the board for task '${taskId}'; run a sync before linking a pull request`,
      );
    }
    await this.#contract.invoke('apply', {
      repo: this.#repo,
      operations: [
        {
          kind: 'link-pull-request',
          key: taskId,
          number: issue.number,
          pullRequest,
        },
      ],
    });
  }
}
