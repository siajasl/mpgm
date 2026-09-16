import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { kernelRegistry } from '../event/catalog.js';
import type { EventInput } from '../event/envelope.js';
import { EventLog } from '../event/store.js';
import { MEMORY } from '../database.js';
import { fold } from '../state/reduce.js';
import { codeReviewSchema } from '../schemas.js';
import { mergeVerdict, type CheckRun } from './checks.js';
import {
  changeReviewed,
  decideMerge,
  gitMergeContract,
  mergeChange,
  mergeMessage,
  verifyOperatorMerge,
  type MergeDecisionRequest,
  type ReviewRecord,
} from './merge.js';
import { WorktreeManager } from './worktree.js';

const tempDirs: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-merge-'));
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

const GREEN: CheckRun[] = (['build', 'lint', 'typecheck', 'test', 'scan'] as const).map(
  (name) => ({ name, status: 'completed', conclusion: 'success', url: '' }),
);

function approval(ref: string): ReviewRecord {
  return {
    reviewTaskId: 'T1-review',
    reviewerRole: 'code-reviewer',
    ref,
    approved: true,
    summary: 'reads correctly and the tests can fail',
  };
}

/**
 * `Partial` under `exactOptionalPropertyTypes` will not accept an explicit
 * `undefined`, and "no review was recorded" is exactly what several of these
 * tests need to say.
 */
type Overrides = {
  [K in keyof MergeDecisionRequest]?: MergeDecisionRequest[K] | undefined;
};

function request(overrides: Overrides = {}): MergeDecisionRequest {
  const ref = overrides.ref ?? 'abc123';
  const base = {
    taskId: overrides.taskId ?? 'T1',
    authorRole: overrides.authorRole ?? 'implementer',
    ref,
    verdict: overrides.verdict ?? mergeVerdict({ ref, runs: GREEN }),
  };
  const review = 'review' in overrides ? overrides.review : approval(ref);
  return review === undefined ? base : { ...base, review };
}

describe('decideMerge', () => {
  it('allows a green, independently approved change', () => {
    expect(decideMerge(request())).toEqual({ allowed: true, refusals: [], reasons: [] });
  });

  // T3.1.3 completion criterion: an authored change merges only after an
  // independent review event.
  it('refuses a change nobody reviewed', () => {
    const decision = decideMerge(request({ review: undefined }));

    expect(decision.allowed).toBe(false);
    expect(decision.refusals).toEqual(['no-review']);
  });

  it('refuses a review by the author’s own role', () => {
    const decision = decideMerge(
      request({ review: { ...approval('abc123'), reviewerRole: 'implementer' } }),
    );

    expect(decision.refusals).toEqual(['reviewer-not-independent']);
  });

  it('refuses when the reviewer asked for changes', () => {
    const decision = decideMerge(
      request({
        review: {
          ...approval('abc123'),
          approved: false,
          summary: 'the test cannot fail',
        },
      }),
    );

    expect(decision.refusals).toEqual(['changes-requested']);
    expect(decision.reasons[0]).toContain('the test cannot fail');
  });

  // The failure this is really about: a repair pushed after the review rides
  // into the trunk on an approval nobody gave it.
  it('refuses when the change moved on after the review', () => {
    const decision = decideMerge({
      ...request({ ref: 'def456' }),
      review: approval('abc123'),
    });

    expect(decision.refusals).toEqual(['review-is-stale']);
    expect(decision.reasons[0]).toContain('approved abc123');
  });

  it('refuses a verdict that is about a different commit', () => {
    const decision = decideMerge({
      ...request({ ref: 'def456' }),
      verdict: mergeVerdict({ ref: 'abc123', runs: GREEN }),
      review: approval('def456'),
    });

    expect(decision.refusals).toEqual(['checks-are-stale']);
  });

  // Models abbreviate. The loop now merges the commit git reports, in full,
  // while CI was asked about whatever ref the session wrote — so the gate has
  // to read those as the same commit or every abbreviated round is refused as
  // stale.
  it('reads an abbreviated ref and the commit it names as the same commit', () => {
    const head = 'ed8541d047f6c088dc6704bfc931bf71d17badea';
    const decision = decideMerge({
      ...request({ ref: head }),
      verdict: mergeVerdict({ ref: 'ed8541d', runs: GREEN }),
      review: approval('ED8541D047F6'),
    });

    expect(decision.allowed).toBe(true);
  });

  it('still refuses an abbreviation of some other commit', () => {
    const head = 'ed8541d047f6c088dc6704bfc931bf71d17badea';
    const decision = decideMerge({
      ...request({ ref: head }),
      review: approval('2c0d089'),
    });

    expect(decision.refusals).toEqual(['review-is-stale']);
  });

  it('refuses a prefix too short to name a commit', () => {
    // Six characters is a prefix of a great many commits, so a match there is
    // not evidence that the reviewer read this one.
    const head = 'ed8541d047f6c088dc6704bfc931bf71d17badea';
    const decision = decideMerge({
      ...request({ ref: head }),
      review: approval('ed8541'),
    });

    expect(decision.refusals).toEqual(['review-is-stale']);
  });

  it('refuses a red change', () => {
    const decision = decideMerge(
      request({ verdict: mergeVerdict({ ref: 'abc123', runs: GREEN.slice(0, 2) }) }),
    );

    expect(decision.refusals).toEqual(['checks-not-green']);
  });

  // T3.1.4 completion criterion: a planted deviation is flagged. The reviewer
  // found a convention broken; the change never declared it (IMP-4).
  it('refuses a change that broke a convention without declaring it', () => {
    const decision = decideMerge({
      ...request(),
      review: { ...approval('abc123'), deviations: ['CONV-1', 'CONV-6'] },
      declaredDeviations: ['CONV-1'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.refusals).toEqual(['undeclared-deviation']);
    expect(decision.reasons[0]).toContain('CONV-6');
    expect(decision.reasons[0]).not.toContain('CONV-1');
  });

  it('allows a deviation the change declared, since the reviewer judged it', () => {
    const decision = decideMerge({
      ...request(),
      review: { ...approval('abc123'), deviations: ['CONV-6'] },
      declaredDeviations: ['CONV-6'],
    });

    expect(decision.allowed).toBe(true);
  });

  it('does not hold a change to deviations it declared and nobody found', () => {
    const decision = decideMerge({
      ...request(),
      review: { ...approval('abc123'), deviations: [] },
      declaredDeviations: ['CONV-2'],
    });

    expect(decision.allowed).toBe(true);
  });

  it('reports every reason at once rather than one at a time', () => {
    const decision = decideMerge({
      taskId: 'T1',
      authorRole: 'implementer',
      ref: 'abc123',
      verdict: mergeVerdict({ ref: 'abc123', runs: [] }),
      review: {
        ...approval('older'),
        reviewerRole: 'implementer',
        approved: false,
        summary: 'no',
      },
    });

    expect(decision.refusals).toEqual([
      'checks-not-green',
      'reviewer-not-independent',
      'review-is-stale',
      'changes-requested',
    ]);
  });
});

describe('mergeChange', () => {
  async function repoWithBranch(): Promise<{
    repo: string;
    branch: string;
    ref: string;
  }> {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');
    writeFileSync(join(worktree.path, 'feature.ts'), 'export const feature = 1;\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'add the feature']);
    return {
      repo,
      branch: worktree.branch,
      ref: git(worktree.path, ['rev-parse', 'HEAD']),
    };
  }

  it('merges a reviewed change and records what authorised it', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const events: EventInput[] = [];

    const result = await mergeChange({
      runId: 'run-1',
      repo,
      branch,
      request: request({ ref }),
      emit: (event) => {
        events.push(event);
      },
    });

    expect(result.merged).toBe(true);
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe(`Merge ${branch}`);
    expect(git(repo, ['log', '-1', '--pretty=%b'])).toContain('Closes-Task: T1');
    expect(git(repo, ['log', '-1', '--pretty=%b'])).toContain(
      'Reviewed-By: code-reviewer (T1-review)',
    );
    // --no-ff: the merge is a distinct commit, so the trunk's history says a
    // review happened rather than absorbing the branch invisibly.
    expect(
      git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' '),
    ).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual(['ChangeMerged']);
  });

  it('does not touch the trunk when the change was not reviewed', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const before = git(repo, ['rev-parse', 'HEAD']);

    const result = await mergeChange({
      runId: 'run-1',
      repo,
      branch,
      request: request({ ref, review: undefined }),
    });

    expect(result.merged).toBe(false);
    expect(result.reason).toContain('no independent review');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('refuses to merge into a dirty trunk', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    writeFileSync(join(repo, 'stray.txt'), 'uncommitted\n');

    await expect(
      mergeChange({ runId: 'run-1', repo, branch, request: request({ ref }) }),
    ).rejects.toThrow(/dirty/);
  });

  it('leaves the trunk untouched when the merge conflicts', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    // The trunk grows a conflicting version of the same file.
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = 2;\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'a different feature']);
    const before = git(repo, ['rev-parse', 'HEAD']);

    const result = await mergeChange({
      runId: 'run-1',
      repo,
      branch,
      request: request({ ref }),
    });

    expect(result.merged).toBe(false);
    expect(result.reason).toContain('failed');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('folds into state that says which review authorised the merge', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    try {
      log.appendMany([
        { runId: 'run-1', type: 'RunStarted', payload: { project: 'p', operator: 'o' } },
        {
          runId: 'run-1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'run-1',
          type: 'ChangeReviewed',
          payload: {
            taskId: 'T1',
            reviewTaskId: 'T1-review',
            reviewerRole: 'code-reviewer',
            ref,
            approved: true,
            summary: 'fine',
            findings: 0,
          },
        },
      ]);

      await mergeChange({
        runId: 'run-1',
        repo,
        branch,
        request: request({ ref }),
        emit: (event) => {
          log.append(event);
        },
      });

      const task = fold(log.read()).runs['run-1']?.tasks.T1;
      expect(task?.review).toMatchObject({
        reviewerRole: 'code-reviewer',
        approved: true,
      });
      expect(task?.merged).toMatchObject({ into: 'main', reviewTaskId: 'T1-review' });
    } finally {
      log.close();
    }
  });

  it('can be asked afterwards whether the merge landed', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const intent = {
      intentId: 'i1',
      taskId: 'T1',
      contract: 'git.merge',
      operation: 'mergeBranch',
      params: { repo, branch, into: 'main', tip: ref },
    };

    expect(await gitMergeContract.check?.(intent)).toBe(false);
    await mergeChange({ runId: 'run-1', repo, branch, request: request({ ref }) });
    expect(await gitMergeContract.check?.(intent)).toBe(true);
  });

  function newBareRemote(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mpgm-remote-'));
    tempDirs.push(dir);
    git(dir, ['init', '--bare', '--initial-branch=main']);
    return dir;
  }

  /** A second clone of `remote`, used to advance it by a route the kernel's
   * own repo never sees locally — the shape of a pull request merged from
   * GitHub's UI. */
  function cloneOf(remote: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mpgm-clone-'));
    tempDirs.push(dir);
    execFileSync('git', ['clone', remote, dir], { encoding: 'utf8' });
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    return dir;
  }

  // T4.2.12: `mergeBranch` used to record `git rev-parse HEAD` against the
  // local trunk alone and stop there, so the sha `ChangeMerged` carried lived
  // only on the machine that made it. A test asserting merely that *some* sha
  // came back passes against exactly that defect (CONV-6) — the assertion has
  // to be that the sha is reachable from a remote's trunk, built fresh here
  // rather than assumed.
  it('pushes the merge to the trunk of a remote a clone can reach', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const remote = newBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', 'origin', 'main']);

    const result = await mergeChange({
      runId: 'run-1',
      repo,
      branch,
      request: request({ ref }),
    });

    expect(result.merged).toBe(true);
    const commit = result.commit;
    // Read directly off the bare remote, not off the local repo the kernel
    // ran in — the whole point is that a *different* clone can resolve it.
    expect(() =>
      execFileSync(
        'git',
        ['--git-dir', remote, 'merge-base', '--is-ancestor', String(commit), 'main'],
        { encoding: 'utf8' },
      ),
    ).not.toThrow();
  });

  it('leaves a merge unresolved from the remote, and reports it, when the push fails', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const remote = newBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', 'origin', 'main']);
    // Readable (so the pre-merge fetch this task adds still succeeds) but not
    // writable — the same shape as a network failure between the local merge
    // landing and the push it depends on, isolated from the fetch that now
    // runs before it.
    chmodSync(remote, 0o555);
    try {
      const result = await mergeChange({
        runId: 'run-1',
        repo,
        branch,
        request: request({ ref }),
      });

      expect(result.merged).toBe(false);
      expect(result.reason).toContain('pushing');
      expect(result.reason).toContain('no clone can resolve it');
      // The local merge is not undone: only the push failed, and there is
      // nothing to compensate by throwing the merge itself away.
      expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe(`Merge ${branch}`);
    } finally {
      // rmSync in afterEach needs to be able to delete this again.
      chmodSync(remote, 0o755);
    }
  });

  // T4.2.12 rework: a plain, unforced `git push` after the local `--no-ff`
  // merge is rejected non-fast-forward the moment `origin/main` has moved by
  // any other route while the kernel wasn't looking — most likely the "Merge
  // pull request #N" commit GitHub writes when a pull request is merged from
  // its UI. Reproduced here by advancing the remote from a second clone the
  // kernel's own repo never fetches from on its own. Left unfixed, the merge
  // commit made locally is stranded (created, unpushable) and every later
  // merge needs the same manual reset this task exists to end. The fix is to
  // catch the local trunk up *before* creating that commit, so the push that
  // follows lands as a fast-forward on the remote.
  it('catches a local trunk up to a remote that moved without it, before merging', async () => {
    const { repo, branch, ref } = await repoWithBranch();
    const remote = newBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', 'origin', 'main']);

    const external = cloneOf(remote);
    writeFileSync(join(external, 'external.txt'), 'landed via the GitHub UI\n');
    git(external, ['add', '--all']);
    git(external, ['commit', '-m', 'Merge pull request #99 from someone/elsewhere']);
    git(external, ['push', 'origin', 'main']);

    // The local repo has not fetched, so it does not yet know `origin/main`
    // moved — exactly the state the kernel is in when this happens for real.
    const result = await mergeChange({
      runId: 'run-1',
      repo,
      branch,
      request: request({ ref }),
    });

    expect(result.merged).toBe(true);
    // The local trunk was fast-forwarded onto the externally-advanced commit
    // before the task's own merge landed on top of it.
    expect(readFileSync(join(repo, 'external.txt'), 'utf8')).toContain(
      'landed via the GitHub UI',
    );
    const commit = result.commit;
    expect(() =>
      execFileSync(
        'git',
        ['--git-dir', remote, 'merge-base', '--is-ancestor', String(commit), 'main'],
        { encoding: 'utf8' },
      ),
    ).not.toThrow();
  });

  // T4.2.12: resume asks `gitMergeContract.check`, and a merge that comes to
  // depend on a push has to fail closed when the local merge landed but the
  // push did not — otherwise resume would call it "already-landed" and never
  // retry the push, leaving the commit permanently unresolvable from a clone.
  it('fails closed on resume between a local merge landing and its push', async () => {
    const { repo, branch } = await repoWithBranch();
    const remote = newBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', 'origin', 'main']);

    // Merge locally without going through `mergeChange`'s push, simulating a
    // crash between the two.
    git(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${branch}`, branch]);
    const tip = git(repo, ['rev-parse', 'HEAD']);

    const intent = {
      intentId: 'i1',
      taskId: 'T1',
      contract: 'git.merge',
      operation: 'mergeBranch',
      params: { repo, branch, into: 'main', tip, remote: 'origin' },
    };

    expect(await gitMergeContract.check?.(intent)).toBe(false);

    git(repo, ['push', 'origin', 'main']);

    expect(await gitMergeContract.check?.(intent)).toBe(true);
  });

  // T4.2.15: `verifyOperatorMerge` is what `mpgm record-merge` calls before
  // appending `ChangeMergedByOperator` — an operator's claim that a merge
  // landed is only ever recorded once this agrees, never on the operator's
  // word alone (CONV-4). Nested here (rather than its own top-level
  // `describe`) so it can reuse `repoWithBranch`/`newBareRemote` above.
  describe('verifyOperatorMerge', () => {
    /** The claim `mpgm record-merge` builds, with the task's own branch. */
    function claim(
      repo: string,
      claimedCommit: string,
      branch: string,
      overrides: Partial<Parameters<typeof verifyOperatorMerge>[0]> = {},
    ): Parameters<typeof verifyOperatorMerge>[0] {
      return { repo, claimedCommit, into: 'main', taskId: 'T1', branch, ...overrides };
    }

    it('verifies a commit the local trunk already carries, with no remote configured', async () => {
      const { repo, branch } = await repoWithBranch();
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${branch}`, branch]);
      const commit = git(repo, ['rev-parse', 'HEAD']);

      const result = await verifyOperatorMerge(claim(repo, commit, branch));

      expect(result).toMatchObject({ verified: true, commit });
      expect(result.detail).toContain('main');
    });

    it('refuses a commit that never reached the trunk', async () => {
      const { repo, ref, branch } = await repoWithBranch();

      // `ref` is the tip of the task's own branch — real, but never merged.
      const result = await verifyOperatorMerge(claim(repo, ref, branch));

      expect(result.verified).toBe(false);
      expect(result.detail).toContain('not reachable');
    });

    it('refuses a commit the repository does not have at all', async () => {
      const { repo, branch } = await repoWithBranch();

      const result = await verifyOperatorMerge(claim(repo, 'deadbeef1234', branch));

      expect(result.verified).toBe(false);
      expect(result.detail).toContain('not a commit');
      expect(result.commit).toBe('');
    });

    // T4.2.15 rework: an operator types `HEAD`, `main` or an abbreviation as
    // readily as a sha, and every one of those is a value that resolves
    // differently in another clone — or here tomorrow. Recording the string
    // as typed would put exactly the T4.2.12 defect back in the log through
    // the operator's keyboard, so what comes back to be recorded is the sha
    // git resolved, never the claim.
    it('resolves a symbolic ref to the full sha rather than handing the claim back', async () => {
      const { repo, branch } = await repoWithBranch();
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${branch}`, branch]);
      const commit = git(repo, ['rev-parse', 'HEAD']);

      for (const symbolic of ['HEAD', 'main', commit.slice(0, 8)]) {
        const result = await verifyOperatorMerge(claim(repo, symbolic, branch));

        expect(result.verified).toBe(true);
        expect(result.commit).toBe(commit);
        expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    // T4.2.15 rework: reachability from the trunk says *a* commit landed. It
    // says nothing about whose change is in it, so on its own it would verify
    // `record-merge T4.2.10 --commit <any commit on main>` — a record
    // indistinguishable in the log from a true one, which is the class of
    // claim this verb exists to keep out (CONV-4).
    it('refuses a trunk commit that has nothing to do with the task', async () => {
      const { repo, branch } = await repoWithBranch();
      // A commit on the trunk that is not the task's merge, and whose message
      // never names it: unrelated work landing first, as it does.
      writeFileSync(join(repo, 'unrelated.txt'), 'somebody else\n');
      git(repo, ['add', '--all']);
      git(repo, ['commit', '-m', 'unrelated work']);
      const unrelated = git(repo, ['rev-parse', 'HEAD']);

      const result = await verifyOperatorMerge(claim(repo, unrelated, branch));

      expect(result.verified).toBe(false);
      expect(result.detail).toContain('does not contain');
      expect(result.detail).toContain(branch);
    });

    // The branch deleted on merge is the normal state of a merged pull
    // request, so the tie cannot depend on it alone: the merge commit's own
    // message names the task (`Closes-Task` from `mergeMessage`, and equally
    // GitHub's `Merge pull request #134 from siajasl/mpgm/T4.2.9`).
    it('ties a merge to its task by the commit message when the branch is gone', async () => {
      const { repo, branch } = await repoWithBranch();
      git(repo, [
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        `Merge pull request #134 from siajasl/${branch}`,
        branch,
      ]);
      const commit = git(repo, ['rev-parse', 'HEAD']);
      git(repo, [
        'worktree',
        'remove',
        '--force',
        join(repo, '.mpgm', 'worktrees', 'T1'),
      ]);
      git(repo, ['branch', '-D', branch]);

      const result = await verifyOperatorMerge(claim(repo, commit, branch));

      expect(result).toMatchObject({ verified: true, commit });
      expect(result.detail).toContain('names T1');
    });

    // ...and when neither holds, it refuses rather than recording a merge
    // tied to the task by nothing but the operator's say-so.
    it('refuses when the branch is gone and nothing in the commit names the task', async () => {
      const { repo, branch } = await repoWithBranch();
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'Merge a branch', branch]);
      const commit = git(repo, ['rev-parse', 'HEAD']);
      git(repo, [
        'worktree',
        'remove',
        '--force',
        join(repo, '.mpgm', 'worktrees', 'T1'),
      ]);
      git(repo, ['branch', '-D', branch]);

      const result = await verifyOperatorMerge(claim(repo, commit, branch));

      expect(result.verified).toBe(false);
      expect(result.detail).toContain('nothing ties it to T1');
    });

    // A task id that is a prefix of another must not tie a merge to the
    // wrong task: `T4.2.1` reading itself into `T4.2.15` is a whole
    // milestone's worth of ids away from being hypothetical here.
    it('does not read a task id out of a longer one in the message', async () => {
      const { repo, branch } = await repoWithBranch();
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'Merge mpgm/T15', branch]);
      const commit = git(repo, ['rev-parse', 'HEAD']);
      git(repo, [
        'worktree',
        'remove',
        '--force',
        join(repo, '.mpgm', 'worktrees', 'T1'),
      ]);
      git(repo, ['branch', '-D', branch]);

      const result = await verifyOperatorMerge(claim(repo, commit, branch));

      expect(result.verified).toBe(false);
    });

    // The T4.2.12 shape, applied to an operator's claim rather than the
    // kernel's own: a commit only the local clone can resolve is exactly the
    // half-landed state this task exists to stop the log from recording as
    // done, so this fails closed on it rather than trusting the local
    // repository's word for what a fresh clone would see.
    it('fails closed when a remote is configured and does not yet have the commit', async () => {
      const { repo, branch } = await repoWithBranch();
      const remote = newBareRemote();
      git(repo, ['remote', 'add', 'origin', remote]);
      git(repo, ['push', 'origin', 'main']);
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${branch}`, branch]);
      const commit = git(repo, ['rev-parse', 'HEAD']);

      const beforePush = await verifyOperatorMerge(claim(repo, commit, branch));
      expect(beforePush.verified).toBe(false);
      expect(beforePush.detail).toContain('no clone but this one');

      git(repo, ['push', 'origin', 'main']);

      const afterPush = await verifyOperatorMerge(claim(repo, commit, branch));
      expect(afterPush.verified).toBe(true);
      expect(afterPush.detail).toContain('origin/main');
    });

    it('verifies against the local trunk alone when no remote by that name is configured', async () => {
      const { repo, branch } = await repoWithBranch();
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${branch}`, branch]);
      const commit = git(repo, ['rev-parse', 'HEAD']);

      const result = await verifyOperatorMerge(
        claim(repo, commit, branch, { remote: 'upstream' }),
      );

      expect(result.verified).toBe(true);
      expect(result.detail).toContain('local');
    });

    // The scenario this task exists for: a pull request merged on GitHub
    // (PRs 134, 135) whose merge commit the local clone has never fetched.
    // The local trunk does not carry the object at all — `cat-file -e`
    // against it alone would refuse a merge that demonstrably landed. This
    // fetches the remote before checking anything locally, so it verifies
    // rather than blaming a stale clone (CONV-3).
    it('verifies a commit merged on the remote before the local clone ever fetched it', async () => {
      const { repo, branch } = await repoWithBranch();
      const remote = newBareRemote();
      git(repo, ['remote', 'add', 'origin', remote]);
      git(repo, ['push', 'origin', 'main']);
      git(repo, ['push', 'origin', branch]);

      // The merge happens on a second clone — the shape of a pull request
      // merged from GitHub's UI — and is pushed to the remote. The kernel's
      // own repo never fetches on its own, so its local 'main' never learns
      // about this commit; it is not even an object the local repo has.
      const external = cloneOf(remote);
      git(external, [
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        `Merge ${branch}`,
        `origin/${branch}`,
      ]);
      const commit = git(external, ['rev-parse', 'HEAD']);
      git(external, ['push', 'origin', 'main']);

      expect(() =>
        execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
          cwd: repo,
          encoding: 'utf8',
        }),
      ).toThrow();

      const result = await verifyOperatorMerge(claim(repo, commit, branch));

      expect(result).toMatchObject({ verified: true, commit });
      expect(result.detail).toContain('origin/main');
    });
  });
});

describe('changeReviewed', () => {
  const findings = [
    {
      file: 'src/a.ts',
      line: 12,
      concern: 'drops the error',
      remedy: 'rethrow it',
      severity: 'blocker' as const,
    },
    {
      file: 'src/b.ts',
      concern: 'naming',
      remedy: 'rename it',
      severity: 'minor' as const,
    },
  ];

  it('records what the reviewer found and what nobody had declared', () => {
    const event = changeReviewed(
      'run-1',
      'T1',
      { ...approval('abc123'), deviations: ['CONV-1', 'CONV-6'] },
      findings,
      ['CONV-1'],
    );

    expect(event.payload).toMatchObject({
      deviations: ['CONV-1', 'CONV-6'],
      undeclaredDeviations: ['CONV-6'],
    });
  });

  // T4.2.14: a count alone cannot answer why a task was refused. Every field
  // a finding carries must survive into the event, not merely its length.
  it('carries every finding in full, not merely a count', () => {
    const event = changeReviewed('run-1', 'T1', approval('abc123'), findings);

    expect(event.payload).toMatchObject({
      findings: 2,
      findingDetails: findings,
    });
  });
});

describe('mergeMessage', () => {
  it('carries the trailer the trace index reads', () => {
    const message = mergeMessage(request(), 'mpgm/T1');

    expect(message.split('\n')[0]).toBe('Merge mpgm/T1');
    expect(message).toContain('Closes-Task: T1');
  });
});

describe('codeReviewSchema', () => {
  it('refuses an approval that also carries a blocker', () => {
    const review = codeReviewSchema.safeParse({
      ref: 'abc',
      verdict: 'approve',
      summary: 'looks fine',
      findings: [
        {
          file: 'src/a.ts',
          concern: 'drops the error',
          remedy: 'rethrow',
          severity: 'blocker',
        },
      ],
    });

    expect(review.success).toBe(false);
  });

  it('refuses a rejection with only nits', () => {
    const review = codeReviewSchema.safeParse({
      ref: 'abc',
      verdict: 'request-changes',
      summary: 'no',
      findings: [
        { file: 'src/a.ts', concern: 'naming', remedy: 'rename it', severity: 'minor' },
      ],
    });

    expect(review.success).toBe(false);
  });

  it('accepts an approval with reservations recorded as minor', () => {
    const review = codeReviewSchema.safeParse({
      ref: 'abc',
      verdict: 'approve',
      summary: 'good, with a note',
      findings: [
        { file: 'src/a.ts', concern: 'naming', remedy: 'rename it', severity: 'minor' },
      ],
    });

    expect(review.success).toBe(true);
  });
});
