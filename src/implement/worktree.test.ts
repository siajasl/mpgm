import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorktreeError,
  WorktreeManager,
  branchNameFor,
  taskIdFromBranch,
} from './worktree.js';

const tempDirs: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-worktree-'));
  tempDirs.push(dir);
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# sample\n');
  git(dir, ['add', '--all']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('branch naming', () => {
  it('round-trips a task id', () => {
    expect(branchNameFor('T3.1.1')).toBe('mpgm/T3.1.1');
    expect(taskIdFromBranch('mpgm/T3.1.1')).toBe('T3.1.1');
    expect(taskIdFromBranch('refs/heads/mpgm/draft-brief')).toBe('draft-brief');
  });

  it('does not claim branches belonging to someone else', () => {
    expect(taskIdFromBranch('main')).toBeUndefined();
    expect(taskIdFromBranch('feature/mpgm/x')).toBeUndefined();
  });

  it('refuses task ids that are not usable as a ref', () => {
    expect(() => branchNameFor('has space')).toThrow(WorktreeError);
    expect(() => branchNameFor('a..b')).toThrow(WorktreeError);
    expect(() => branchNameFor('x.lock')).toThrow(WorktreeError);
    expect(() => branchNameFor('')).toThrow(WorktreeError);
  });
});

describe('WorktreeManager', () => {
  it('gives each task its own checkout on its own branch', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });

    const one = await manager.acquire('T3.1.1');
    const two = await manager.acquire('T3.1.2');

    expect(one.path).not.toBe(two.path);
    expect(one.branch).toBe('mpgm/T3.1.1');
    expect(two.branch).toBe('mpgm/T3.1.2');
    expect(git(one.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mpgm/T3.1.1');
    expect(git(two.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mpgm/T3.1.2');
  });

  // IMP-1: the completion criterion for T3.1.1. Eight tasks commit at once to
  // one repository; nothing may land on the trunk and nothing may see another
  // task's work.
  it('lets parallel tasks commit without touching the trunk or each other', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const before = git(repo, ['rev-parse', 'HEAD']);
    const taskIds = Array.from({ length: 8 }, (_, index) => `T3.1.${String(index)}`);

    const worktrees = await Promise.all(
      taskIds.map(async (taskId) => {
        const worktree = await manager.acquire(taskId);
        writeFileSync(join(worktree.path, `${taskId}.txt`), `work by ${taskId}\n`);
        git(worktree.path, ['add', '--all']);
        git(worktree.path, ['commit', '-m', `work by ${taskId}`]);
        return worktree;
      }),
    );

    expect(new Set(worktrees.map((worktree) => worktree.path)).size).toBe(taskIds.length);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(repo, ['status', '--porcelain'])).toBe('');

    for (const worktree of worktrees) {
      const files = git(worktree.path, ['ls-files']).split('\n');
      expect(files).toContain(`${worktree.taskId}.txt`);
      for (const other of taskIds) {
        if (other !== worktree.taskId) {
          expect(files).not.toContain(`${other}.txt`);
        }
      }
    }
  });

  it('counts what a branch carries beyond the trunk', async () => {
    // Read at acquire time to tell a checkout picked up mid-task from a fresh
    // one, which is what decides whether a review is told the extra commits
    // are the loop's rather than the author's.
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('counted');

    expect(await manager.commitsAhead('counted', 'main')).toBe(0);

    for (const index of [1, 2, 3]) {
      writeFileSync(join(worktree.path, `${String(index)}.txt`), 'work\n');
      git(worktree.path, ['add', '--all']);
      git(worktree.path, ['commit', '-m', `commit ${String(index)}`]);
      expect(await manager.commitsAhead('counted', 'main')).toBe(index);
    }
  });

  it('cannot count a branch that is not checked out, and says so', async () => {
    // Undefined rather than zero: "there is no such worktree" is not "it has
    // no commits", and a caller that treated them alike would claim the loop
    // made commits it knows nothing about.
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    await manager.acquire('present');

    expect(await manager.commitsAhead('absent', 'main')).toBeUndefined();
    expect(await manager.commitsAhead('present', 'no-such-ref')).toBeUndefined();
  });

  it('hands back the existing checkout when a task is re-acquired', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });

    const first = await manager.acquire('resume-me');
    // Partial work from a session that died mid-task (DESIGN §6).
    writeFileSync(join(first.path, 'partial.txt'), 'half done\n');

    const second = await manager.acquire('resume-me');

    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'partial.txt'))).toBe(true);
    expect(await manager.list()).toHaveLength(1);
  });

  it('reports uncommitted work and refuses to discard it', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('messy');
    writeFileSync(join(worktree.path, 'unsaved.txt'), 'not committed\n');

    expect(await manager.isDirty('messy')).toBe(true);

    const refused = await manager.release('messy');
    expect(refused.removed).toBe(false);
    expect(refused.reason).toContain('uncommitted');
    expect(existsSync(worktree.path)).toBe(true);

    const forced = await manager.release('messy', { force: true });
    expect(forced.removed).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('keeps the branch by default and deletes it only when merged', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('unmerged');
    writeFileSync(join(worktree.path, 'change.txt'), 'a change\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'a change']);

    const kept = await manager.release('unmerged');
    expect(kept.removed).toBe(true);
    expect(kept.branchDeleted).toBe(false);
    expect(git(repo, ['branch', '--list', 'mpgm/unmerged'])).not.toBe('');

    // The commit is not on main, so git's own check must refuse the delete.
    const again = await manager.acquire('unmerged');
    expect(again.reused).toBe(false);
    const survived = await manager.release('unmerged', { deleteBranch: 'if-merged' });
    expect(survived.branchDeleted).toBe(false);
    expect(git(repo, ['branch', '--list', 'mpgm/unmerged'])).not.toBe('');

    git(repo, ['merge', '--no-ff', '-m', 'merge', 'mpgm/unmerged']);
    const third = await manager.acquire('unmerged');
    expect(third.reused).toBe(false);
    const deleted = await manager.release('unmerged', { deleteBranch: 'if-merged' });
    expect(deleted.branchDeleted).toBe(true);
    expect(git(repo, ['branch', '--list', 'mpgm/unmerged'])).toBe('');
  });

  it('hides its workspace without editing anything the project tracks', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    await manager.acquire('hidden');

    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['ls-files'])).toBe('README.md');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('lists only the checkouts it owns', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    await manager.acquire('mine');
    const foreign = join(repo, '.mpgm', 'foreign');
    git(repo, ['worktree', 'add', '-b', 'someone-elses', foreign]);

    expect(await manager.list()).toEqual([
      { taskId: 'mine', branch: 'mpgm/mine', path: manager.pathFor('mine') },
    ]);
  });

  it('recreates a checkout whose directory vanished under it', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const first = await manager.acquire('vanishing');
    rmSync(first.path, { recursive: true, force: true });

    const second = await manager.acquire('vanishing');

    expect(second.reused).toBe(false);
    expect(existsSync(join(second.path, 'README.md'))).toBe(true);
  });

  it('removes orphaned directories that would block the next acquire', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('orphan');
    // Registration removed, directory left behind — what a hard kill leaves.
    git(repo, ['worktree', 'remove', '--force', worktree.path]);
    writeFileSync(join(repo, '.mpgm', 'worktrees', 'orphan.txt'), 'debris\n');

    expect(await manager.prune()).toEqual([join(manager.root, 'orphan.txt')]);
  });

  it('refuses a branch that differs from an existing one only by case', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    await manager.acquire('Task-A');

    await expect(manager.acquire('task-a')).rejects.toThrow(/differ only by case/);
  });
});
