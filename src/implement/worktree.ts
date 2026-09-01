import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * Per-task git worktrees (ADR-5, IMP-1).
 *
 * Every implementation task gets its own checkout on its own branch, so that
 * tasks running concurrently never share an index or a working tree. The main
 * repository is only ever read: an agent cannot commit to the trunk because
 * the only writable checkout it is given is somewhere else, on a branch named
 * after its task.
 *
 * Nothing here decides *what* runs — this is the workspace, not the loop.
 */

const run = promisify(execFile);

export class WorktreeError extends Error {}

/**
 * Task ids that are safe to put in a branch name verbatim.
 *
 * Verbatim matters: the PM projector finds a task's issue from its PR's branch
 * (DESIGN §4.8), and a mapping that loses information one way is a mapping
 * that guesses on the way back. Anything outside this shape is refused rather
 * than mangled into something that happens to be a legal ref.
 */
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Absolute path with symlinks resolved, tolerating a path that is not there yet.
 *
 * `git worktree list` reports resolved paths, so a manager that reported
 * unresolved ones would hand back two different strings for one directory
 * depending on which method was asked — on macOS, where /tmp is a symlink,
 * every temporary repository hits this.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function assertUsableTaskId(taskId: string): void {
  if (!SAFE_TASK_ID.test(taskId) || taskId.includes('..') || taskId.endsWith('.lock')) {
    throw new WorktreeError(
      `task id '${taskId}' cannot be used as a branch name; expected letters, digits, '.', '-' or '_'`,
    );
  }
}

export const DEFAULT_BRANCH_PREFIX = 'mpgm';

export function branchNameFor(taskId: string, prefix = DEFAULT_BRANCH_PREFIX): string {
  assertUsableTaskId(taskId);
  return `${prefix}/${taskId}`;
}

/**
 * The task a branch belongs to, or undefined if it is not one of ours.
 *
 * The inverse of `branchNameFor`. `refs/heads/` is tolerated so that callers
 * can pass whatever git handed them.
 */
export function taskIdFromBranch(
  branch: string,
  prefix = DEFAULT_BRANCH_PREFIX,
): string | undefined {
  const name = branch.startsWith('refs/heads/')
    ? branch.slice('refs/heads/'.length)
    : branch;
  const head = `${prefix}/`;
  if (!name.startsWith(head)) {
    return undefined;
  }
  const taskId = name.slice(head.length);
  return taskId !== '' && SAFE_TASK_ID.test(taskId) ? taskId : undefined;
}

export interface Worktree {
  readonly taskId: string;
  readonly branch: string;
  /** Absolute path to the isolated checkout. */
  readonly path: string;
  /** The commit the branch started from. */
  readonly base: string;
  /**
   * True when the checkout was already there and has been handed back as-is.
   *
   * A session that dies mid-task leaves its work behind (DESIGN §6); the
   * replacement session is meant to continue in it, so re-acquiring is normal
   * rather than an error. Callers that care — a repair loop deciding whether
   * to re-read the diff — get told.
   */
  readonly reused: boolean;
}

/** One entry of `git worktree list`. */
interface Registration {
  readonly path: string;
  readonly branch: string | undefined;
  readonly prunable: boolean;
}

export interface WorktreeManagerOptions {
  /** The main repository. Never checked out into, never committed to. */
  readonly repo: string;
  /**
   * Where checkouts are created. Defaults to `<repo>/.mpgm/worktrees`, which
   * is gitignored — a worktree nested in a *tracked* directory would show up
   * as untracked files in the parent's status.
   */
  readonly root?: string;
  /** What new branches start from. Defaults to the repo's current HEAD. */
  readonly baseRef?: string;
  readonly branchPrefix?: string;
}

export interface ReleaseOptions {
  /**
   * Discard uncommitted changes. Off by default: an agent's unmerged work is
   * the expensive thing in this system, and deleting it because a task ended
   * untidily is not a cleanup.
   */
  readonly force?: boolean;
  /**
   * Also delete the branch. `'if-merged'` uses git's own safety check, so a
   * branch with unmerged commits survives. The branch normally outlives the
   * checkout — the PR is still open — so this defaults to keeping it.
   */
  readonly deleteBranch?: 'no' | 'if-merged' | 'force';
}

export interface ReleaseResult {
  readonly taskId: string;
  readonly removed: boolean;
  readonly branchDeleted: boolean;
  /** Why nothing was removed, when nothing was. */
  readonly reason?: string;
}

export class WorktreeManager {
  readonly #repo: string;
  readonly #root: string;
  readonly #baseRef: string;
  readonly #prefix: string;
  /**
   * Serializes writes to the shared repository.
   *
   * Concurrent `git worktree add` in one repository contend for the same
   * administrative files under `.git/worktrees`; the isolation this class
   * exists to provide covers the checkouts, not the bookkeeping that creates
   * them. Only creation and removal queue — work *inside* a worktree is where
   * the parallelism is, and that never comes through here.
   */
  #queue: Promise<unknown> = Promise.resolve();
  #ignored: Promise<void> | undefined;

  constructor(options: WorktreeManagerOptions) {
    this.#repo = realPath(options.repo);
    this.#root = realPath(options.root ?? join(this.#repo, '.mpgm', 'worktrees'));
    this.#baseRef = options.baseRef ?? 'HEAD';
    this.#prefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  }

  get repo(): string {
    return this.#repo;
  }

  get root(): string {
    return this.#root;
  }

  branchFor(taskId: string): string {
    return branchNameFor(taskId, this.#prefix);
  }

  pathFor(taskId: string): string {
    assertUsableTaskId(taskId);
    return join(this.#root, taskId);
  }

  async #git(args: readonly string[], cwd: string = this.#repo): Promise<string> {
    try {
      const { stdout } = await run('git', [...args], { cwd, encoding: 'utf8' });
      return stdout.trim();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new WorktreeError(`git ${args.join(' ')} failed: ${detail}`, { cause });
    }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #registrations(): Promise<Registration[]> {
    const output = await this.#git(['worktree', 'list', '--porcelain']);
    const entries: Registration[] = [];
    let path: string | undefined;
    let branch: string | undefined;
    let prunable = false;

    const flush = (): void => {
      if (path !== undefined) {
        entries.push({ path, branch, prunable });
      }
      path = undefined;
      branch = undefined;
      prunable = false;
    };

    for (const line of output.split('\n')) {
      if (line === '') {
        flush();
      } else if (line.startsWith('worktree ')) {
        flush();
        path = resolve(line.slice('worktree '.length));
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length);
      } else if (line.startsWith('prunable')) {
        prunable = true;
      }
    }
    flush();
    return entries;
  }

  /** Every checkout this manager owns, by task. */
  async list(): Promise<{ taskId: string; branch: string; path: string }[]> {
    const found: { taskId: string; branch: string; path: string }[] = [];
    for (const entry of await this.#registrations()) {
      const taskId =
        entry.branch === undefined
          ? undefined
          : taskIdFromBranch(entry.branch, this.#prefix);
      if (taskId !== undefined) {
        found.push({ taskId, branch: this.branchFor(taskId), path: entry.path });
      }
    }
    return found;
  }

  async find(taskId: string): Promise<{ branch: string; path: string } | undefined> {
    const branch = this.branchFor(taskId);
    for (const entry of await this.#registrations()) {
      if (entry.branch === `refs/heads/${branch}` && !entry.prunable) {
        return { branch, path: entry.path };
      }
    }
    return undefined;
  }

  /**
   * Get the task's checkout, creating it if it is not there.
   *
   * Safe to call concurrently for different tasks — that is the point — and
   * safe to call twice for the same task, which returns the existing checkout
   * rather than a second one.
   */
  acquire(taskId: string): Promise<Worktree> {
    assertUsableTaskId(taskId);
    return this.#serial(() => this.#acquire(taskId));
  }

  async #acquire(taskId: string): Promise<Worktree> {
    const branch = this.branchFor(taskId);
    const path = this.pathFor(taskId);

    await this.#refuseCaseCollision(branch);

    const registrations = await this.#registrations();
    const existing = registrations.find(
      (entry) => entry.branch === `refs/heads/${branch}`,
    );
    if (existing !== undefined && !existing.prunable && existsSync(existing.path)) {
      return {
        taskId,
        branch,
        path: existing.path,
        base: await this.#git(['rev-parse', 'HEAD'], existing.path),
        reused: true,
      };
    }
    if (existing !== undefined) {
      // Registered but gone from disk — the usual aftermath of a machine
      // being reset under a running task. Drop the registration so the
      // checkout can be recreated rather than reported as a conflict.
      await this.#git(['worktree', 'prune']);
    }

    await this.#ensureRootIgnored();
    await mkdir(this.#root, { recursive: true });
    if (existsSync(path)) {
      throw new WorktreeError(
        `'${path}' already exists but git does not know it as a worktree; remove it or pick another root`,
      );
    }

    const base = await this.#git(['rev-parse', this.#baseRef]);
    const branchExists =
      (await this.#git(['branch', '--list', branch, '--format=%(refname:short)'])) !== '';

    await this.#git(
      branchExists
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-b', branch, path, base],
    );

    return { taskId, branch, path, base, reused: false };
  }

  /**
   * Make sure the main repository ignores the directory holding the checkouts.
   *
   * The default root lives inside the repository, which is convenient — the
   * whole run stays under one directory — but a checkout the parent can see is
   * a checkout the parent will offer to commit, and `git add --all` in the
   * main repo would then swallow every worktree. Rather than require every
   * project to cooperate, the rule is written to `info/exclude`, which is
   * local to the clone and not a tracked file: mpgm hides its own workspace
   * without editing anything the project owns.
   */
  #ensureRootIgnored(): Promise<void> {
    this.#ignored ??= this.#writeExclude();
    return this.#ignored;
  }

  async #writeExclude(): Promise<void> {
    const inside = relative(this.#repo, this.#root);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      return;
    }
    const top = inside.split(sep)[0];
    if (top === undefined || top === '') {
      return;
    }
    const rule = `/${top}/`;
    try {
      await this.#git(['check-ignore', '--quiet', `${top}/`]);
      return;
    } catch {
      // Not ignored yet — fall through and add the rule.
    }
    // `--git-common-dir` is relative to the repository, not to the process.
    const gitDir = resolve(
      this.#repo,
      await this.#git(['rev-parse', '--git-common-dir']),
    );
    const excludes = join(gitDir, 'info', 'exclude');
    const current = await readFile(excludes, 'utf8').catch(() => '');
    if (current.split('\n').includes(rule)) {
      return;
    }
    await mkdir(join(excludes, '..'), { recursive: true });
    await appendFile(
      excludes,
      `${current.endsWith('\n') || current === '' ? '' : '\n'}# mpgm task worktrees (IMP-1)\n${rule}\n`,
    );
  }

  /**
   * Refuse a branch that differs from an existing one only by case.
   *
   * On a case-insensitive filesystem `mpgm/T1` and `mpgm/t1` are one ref, so
   * two tasks would silently share a checkout — the exact failure this class
   * is here to prevent, arriving as mysteriously interleaved commits rather
   * than as an error.
   */
  async #refuseCaseCollision(branch: string): Promise<void> {
    const listed = await this.#git([
      'branch',
      '--list',
      `${this.#prefix}/*`,
      '--format=%(refname:short)',
    ]);
    for (const other of listed.split('\n').filter((line) => line !== '')) {
      if (other !== branch && other.toLowerCase() === branch.toLowerCase()) {
        throw new WorktreeError(
          `branch '${branch}' collides with existing '${other}'; task ids must not differ only by case`,
        );
      }
    }
  }

  /** Uncommitted or untracked changes in the task's checkout. */
  async isDirty(taskId: string): Promise<boolean> {
    const found = await this.find(taskId);
    if (found === undefined) {
      return false;
    }
    return (await this.#git(['status', '--porcelain'], found.path)) !== '';
  }

  /**
   * How many commits a task's branch carries beyond `base`.
   *
   * Asked at acquire time, before any session runs, so that a reused checkout
   * can say whether it was picked up mid-task. A branch that already carries
   * commits was left there by an earlier run of this task, and those commits
   * are the loop's rather than anything the author about to work on it did.
   *
   * `undefined` when the question cannot be answered — an unknown base, or a
   * checkout that is not there. The callers treat that as "cannot tell" and
   * claim nothing, because the alternative is excusing a commit structure the
   * author may have chosen deliberately.
   */
  async commitsAhead(taskId: string, base: string): Promise<number | undefined> {
    const found = await this.find(taskId);
    if (found === undefined) {
      return undefined;
    }
    try {
      const count = await this.#git(['rev-list', '--count', `${base}..HEAD`], found.path);
      const parsed = Number(count);
      return Number.isInteger(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  release(taskId: string, options: ReleaseOptions = {}): Promise<ReleaseResult> {
    assertUsableTaskId(taskId);
    return this.#serial(() => this.#release(taskId, options));
  }

  async #release(taskId: string, options: ReleaseOptions): Promise<ReleaseResult> {
    const branch = this.branchFor(taskId);
    const found = await this.find(taskId);
    if (found === undefined) {
      return { taskId, removed: false, branchDeleted: false, reason: 'no such worktree' };
    }
    if (found.path === this.#repo) {
      throw new WorktreeError(
        `refusing to remove the main repository at '${this.#repo}'`,
      );
    }

    const force = options.force ?? false;
    if (!force && (await this.#git(['status', '--porcelain'], found.path)) !== '') {
      return {
        taskId,
        removed: false,
        branchDeleted: false,
        reason: 'worktree has uncommitted changes',
      };
    }

    await this.#git(['worktree', 'remove', ...(force ? ['--force'] : []), found.path]);

    const deleteBranch = options.deleteBranch ?? 'no';
    let branchDeleted = false;
    if (deleteBranch !== 'no') {
      try {
        await this.#git(['branch', deleteBranch === 'force' ? '-D' : '-d', branch]);
        branchDeleted = true;
      } catch (cause) {
        if (deleteBranch === 'force') {
          throw cause;
        }
        // `git branch -d` refusing an unmerged branch is the safety check
        // doing its job, not a failure of the release.
      }
    }

    return { taskId, removed: true, branchDeleted };
  }

  /**
   * Drop registrations whose directory is gone, and directories under the root
   * that git no longer knows about.
   *
   * Both halves are needed: `git worktree prune` forgets vanished checkouts
   * but leaves orphaned directories, and an orphaned directory is what makes
   * the next `acquire` for that task fail.
   */
  async prune(): Promise<string[]> {
    return this.#serial(async () => {
      await this.#git(['worktree', 'prune']);
      const known = new Set((await this.#registrations()).map((entry) => entry.path));
      const removed: string[] = [];
      let entries: string[];
      try {
        entries = await readdir(this.#root);
      } catch {
        return removed;
      }
      for (const entry of entries) {
        const path = join(this.#root, entry);
        const inside = relative(this.#root, path);
        if (inside.startsWith('..') || isAbsolute(inside) || known.has(path)) {
          continue;
        }
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      }
      return removed;
    });
  }
}
