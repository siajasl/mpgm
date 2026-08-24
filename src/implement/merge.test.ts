import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  decideMerge,
  gitMergeContract,
  mergeChange,
  mergeMessage,
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

  it('refuses a red change', () => {
    const decision = decideMerge(
      request({ verdict: mergeVerdict({ ref: 'abc123', runs: GREEN.slice(0, 2) }) }),
    );

    expect(decision.refusals).toEqual(['checks-not-green']);
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
