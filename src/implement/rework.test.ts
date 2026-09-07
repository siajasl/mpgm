import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import { fold } from '../state/reduce.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { SessionRunner } from '../agent/runner.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import { implementTask } from './loop.js';
import { WorktreeManager } from './worktree.js';
import { decideMerge, type MergeDecisionRequest } from './merge.js';
import { mergeVerdict, type CheckRun } from './checks.js';
import {
  DEFAULT_REVIEW_ATTEMPTS,
  isReworkable,
  renderReview,
  type Review,
} from './rework.js';

const GREEN: CheckRun[] = [
  { name: 'build', status: 'completed', conclusion: 'success', url: '' },
  { name: 'lint', status: 'completed', conclusion: 'success', url: '' },
  { name: 'typecheck', status: 'completed', conclusion: 'success', url: '' },
  { name: 'test (node 24.x)', status: 'completed', conclusion: 'success', url: '' },
  { name: 'scan', status: 'completed', conclusion: 'success', url: '' },
];

function request(overrides: Partial<MergeDecisionRequest> = {}): MergeDecisionRequest {
  return {
    taskId: 'T1',
    authorRole: 'implementer',
    ref: 'abc',
    verdict: mergeVerdict({ ref: 'abc', runs: GREEN }),
    review: {
      reviewTaskId: 'T1-review',
      reviewerRole: 'code-reviewer',
      ref: 'abc',
      approved: true,
      summary: 'fine',
      deviations: [],
    },
    declaredDeviations: [],
    ...overrides,
  };
}

const review: Review = {
  ref: 'abc',
  verdict: 'request-changes',
  summary: 'the new test passes against the unmodified code',
  findings: [
    {
      file: 'src/test/nfr.test.ts',
      line: 238,
      concern: 'asserts only generic registry behaviour',
      remedy: 'assert on something this change introduced',
      severity: 'blocker',
    },
    {
      file: 'src/test/nfr.ts',
      concern: 'first-match lookup is order-dependent',
      remedy: 'key the lookup by requirement id',
      severity: 'minor',
    },
  ],
  deviations: [{ convention: 'CONV-6', where: 'nfr.test.ts:238' }],
};

describe('which refusals are the author’s to fix', () => {
  it('sends back a review that asked for changes', () => {
    const decision = decideMerge(
      request({
        review: {
          reviewTaskId: 'T1-review',
          reviewerRole: 'code-reviewer',
          ref: 'abc',
          approved: false,
          summary: 'no',
          deviations: [],
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(isReworkable(decision)).toBe(true);
  });

  it('sends back a deviation the change never declared', () => {
    // The T3.2.1 review: approved, and still refused, because a deviation is
    // a decision somebody signs (IMP-4).
    const decision = decideMerge(
      request({
        review: {
          reviewTaskId: 'T1-review',
          reviewerRole: 'code-reviewer',
          ref: 'abc',
          approved: true,
          summary: 'approved but CONV-6 is broken',
          deviations: ['CONV-6'],
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(isReworkable(decision)).toBe(true);
  });

  it('does not send back what the author cannot see from its worktree', () => {
    // A reviewer sharing the author's role is a dispatch mistake, and a stale
    // verdict means the change moved. Neither is a finding to act on, and
    // spending an attempt on one asks an agent to fix something invisible.
    const notIndependent = decideMerge(request({ authorRole: 'code-reviewer' }));
    expect(notIndependent.allowed).toBe(false);
    expect(isReworkable(notIndependent)).toBe(false);

    const stale = decideMerge(request({ ref: 'def' }));
    expect(stale.allowed).toBe(false);
    expect(isReworkable(stale)).toBe(false);
  });

  it('is never rework when the merge was allowed', () => {
    const allowed = decideMerge(request());
    expect(allowed.allowed).toBe(true);
    expect(isReworkable(allowed)).toBe(false);
  });
});

describe('what the author is shown', () => {
  const rendered = renderReview({
    review,
    undeclared: ['CONV-6'],
    attempt: 1,
    attemptsRemaining: 1,
  });

  it('carries the findings, with the remedy and where to apply it', () => {
    expect(rendered).toContain('src/test/nfr.test.ts:238');
    expect(rendered).toContain('asserts only generic registry behaviour');
    expect(rendered).toContain('Remedy: assert on something this change introduced');
  });

  it('leads with what blocks, not with what was merely noticed', () => {
    // A minor finding beside a blocker buries it. The minor one is in the
    // review the operator can read; what goes to the author is the blocker.
    expect(rendered).not.toContain('first-match lookup is order-dependent');
  });

  it('shows minor findings when there is nothing more serious', () => {
    const minorOnly = renderReview({
      review: { ...review, findings: [review.findings[1] as never] },
      undeclared: [],
      attempt: 1,
      attemptsRemaining: 1,
    });

    expect(minorOnly).toContain('first-match lookup is order-dependent');
  });

  it('names the undeclared conventions and says declaring is not the way out', () => {
    expect(rendered).toContain('CONV-6');
    // Declaring is legitimate (IMP-4) and cheap, and would always unblock the
    // gate — so the author is told the re-review is coming.
    expect(rendered).toMatch(/reviewed again/);
    expect(rendered).toMatch(/not told what you declared/);
  });

  it('says a declaration is a field, because that is how one was lost', () => {
    // T4.1.4a wrote "Declaring CONV-5 as a deviation this rework does not
    // attempt to close" in its commit message. The gate reads the result, not
    // the log, so the deviation was undeclared and refused an approved change
    // at attempt three of three.
    expect(rendered).toMatch(/`deviations` field of the result you return/);
    expect(rendered).toContain('`convention`');
    expect(rendered).toContain('`why`');
    expect(rendered).toMatch(/commit message/);
  });

  it('says why the branch has extra commits, so an attempt is not spent on it', () => {
    // The loop adds a commit per round, so it creates the departure from a
    // one-commit-per-change convention that the next review reports. Round 2
    // of the first real self-hosted task lost part of its attempt to exactly
    // that.
    expect(rendered).toMatch(/add a commit to a branch that already carries/);
    expect(rendered).toMatch(/declare it with that as\n?\s*the reason/);
  });

  it('names no convention the caller did not give it', () => {
    // `rework.ts` is harness code and conventions live in a project's
    // knowledge base, so hardcoding an id here would be wrong for every other
    // project — whose CONV-1 is something else entirely. Asserted as "every
    // id in the output was passed in" rather than "CONV-1 is absent", which
    // this fixture would satisfy however the text were written.
    const mentioned = new Set(rendered.match(/\bCONV-[0-9]+\b/g) ?? []);

    expect(mentioned.size).toBeGreaterThan(0);
    expect([...mentioned]).toStrictEqual(['CONV-6']);
  });

  it('refuses history rewriting, which would discard the review', () => {
    // A squashed or amended commit is a different commit, and `decideMerge`
    // refuses a review whose ref no longer matches — so tidying the branch
    // would silently throw away the approval it is working towards.
    expect(rendered).toMatch(/Do not rewrite history/);
    expect(rendered).toMatch(/refuses to merge on a review of a ref/);
  });

  it('says how many attempts are left, and refuses the easy way to pass', () => {
    expect(rendered).toContain('1 remain after it');
    expect(rendered).toMatch(/not delete, skip, weaken or exclude a test/);
  });
});

describe('a review that never approves (NFR-1)', () => {
  const tempDirs: string[] = [];

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
  }

  function newRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mpgm-rework-'));
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

  /**
   * Every session: the author says it is done, the reviewer refuses. What is
   * under test is that this terminates, blocks and leaves a record — a loop
   * that ran on would spend a budget nobody set.
   *
   * `maxReviewAttempts` omitted means the default applies, which is the only
   * way to tell that the default is still wired to anything.
   */
  async function refusedForever(maxReviewAttempts?: number) {
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const provider = new ScriptedProvider(
      Array.from({ length: 16 }, (_, index) =>
        scriptedSuccess(
          index % 2 === 0
            ? {
                ref: head,
                summary: 'done',
                files: ['README.md'],
                tests: [],
                complete: true,
                remaining: '',
                deviations: [],
              }
            : {
                ref: head,
                verdict: 'request-changes',
                summary: 'still not right',
                findings: [
                  {
                    file: 'README.md',
                    concern: 'no',
                    remedy: 'yes',
                    severity: 'blocker',
                  },
                ],
                deviations: [],
              },
        ),
      ),
    );

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    const result = await implementTask({
      runId: 'r',
      task: {
        id: 'T1',
        title: 'A task the reviewer will not accept',
        completionCriteria: ['It is done.'],
        tracesTo: ['IMP-3'],
        milestone: 'M1',
      },
      repo,
      worktrees: new WorktreeManager({ repo }),
      sessions: new SessionRunner({
        log,
        provider,
        schemas: projectOutputSchemas(),
        policyRoot: repo,
      }),
      roles: RoleRegistry.fromDirectory(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
      ),
      log,
      kb: [],
      policy: { maxClass: 'internal', unlabelled: 'internal' },
      checks: (ref) => Promise.resolve(mergeVerdict({ ref, runs: GREEN })),
      ...(maxReviewAttempts === undefined ? {} : { maxReviewAttempts }),
    });

    return { result, log, repo, head, git, provider };
  }

  it('blocks and escalates rather than merging or looping on', async () => {
    const { result, log, repo, head, git: run } = await refusedForever(2);
    try {
      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/still refuses the change after 2 attempt/);
      // Two reviews taken, not one and not forever.
      expect(result.rounds).toHaveLength(2);
      // Escalated rather than dropped: exhaustion is an event (NFR-1).
      const breach = log.read().find((event) => event.type === 'BudgetExceeded')
        ?.payload as { kind: string; limit: number };
      expect(breach.kind).toBe('reviews');
      expect(breach.limit).toBe(2);
      // The trunk is untouched: a change nobody approved does not land.
      expect(run(repo, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      log.close();
    }
  });

  /** An implementer that says it is done, and a reviewer that refuses. */
  function refusingProvider(ref: string): ScriptedProvider {
    return new ScriptedProvider([
      scriptedSuccess({
        ref,
        summary: 'done',
        files: ['earlier.txt'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        ref,
        verdict: 'request-changes',
        summary: 'no',
        findings: [
          { file: 'earlier.txt', concern: 'no', remedy: 'yes', severity: 'blocker' },
        ],
        deviations: [],
      }),
    ]);
  }

  /** Everything `implementTask` needs that these tests do not vary. */
  function baseOptions(repo: string, provider: ScriptedProvider, log: EventLog) {
    return {
      runId: 'r',
      task: {
        id: 'T1',
        title: 'A task picked up where it was left',
        completionCriteria: ['It is done.'],
        tracesTo: ['IMP-1'],
        milestone: 'M1',
      },
      repo,
      worktrees: new WorktreeManager({ repo }),
      sessions: new SessionRunner({
        log,
        provider,
        schemas: projectOutputSchemas(),
        policyRoot: repo,
      }),
      roles: RoleRegistry.fromDirectory(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
      ),
      log,
      kb: [],
      policy: { maxClass: 'internal' as const, unlabelled: 'internal' as const },
      checks: (ref: string) => Promise.resolve(mergeVerdict({ ref, runs: GREEN })),
    };
  }

  it('tells a resuming implementer what the checkout was handed over holding', async () => {
    // T4.1.1 ran out of turns with every file written and staged and none
    // committed. The prompt is built by the loop from what it reads off the
    // checkout, so a unit test of `implementPrompt` cannot tell whether the
    // loop looks at all — which is the way this silently stops working.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'committed.txt'), 'from an earlier round\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'work an earlier session committed']);
    // Written and staged, never committed — exactly how T4.1.1 stopped.
    writeFileSync(join(worktree.path, 'staged.txt'), 'never committed\n');
    git(worktree.path, ['add', '--all']);

    const provider = refusingProvider(git(worktree.path, ['rev-parse', 'HEAD']));
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
        maxReviewAttempts: 1,
      });

      const authoring = provider.requests.find((request) =>
        request.prompt.includes('Implement T1'),
      );
      expect(authoring?.prompt).toContain('This checkout is not empty');
      expect(authoring?.prompt).toContain('1 commit(s) on the branch already');
      expect(authoring?.prompt).toContain('changes written but not committed');
    } finally {
      log.close();
    }
  });

  it('says nothing about inherited work to a session given a fresh checkout', async () => {
    const repo = newRepo();
    const provider = refusingProvider(git(repo, ['rev-parse', 'HEAD']));
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 1,
      });

      const authoring = provider.requests.find((request) =>
        request.prompt.includes('Implement T1'),
      );
      expect(authoring?.prompt).not.toContain('This checkout is not empty');
    } finally {
      log.close();
    }
  });

  it('tells the first review of a reused checkout whose commits those are', async () => {
    // The gap the round-number version left. A checkout picked up from a run
    // that blocked already carries that run's rework, so its *first* review
    // sees several commits — and T3.2.6's re-run duly reported the departure
    // again, on the one round that was not being told anything.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'earlier.txt'), 'from a run that blocked\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'left behind by an earlier round']);
    const head = git(worktree.path, ['rev-parse', 'HEAD']);

    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: head,
        summary: 'done',
        files: ['earlier.txt'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        ref: head,
        verdict: 'request-changes',
        summary: 'no',
        findings: [
          { file: 'earlier.txt', concern: 'no', remedy: 'yes', severity: 'blocker' },
        ],
        deviations: [],
      }),
    ]);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      await implementTask({
        runId: 'r',
        task: {
          id: 'T1',
          title: 'A task picked up where it was left',
          completionCriteria: ['It is done.'],
          tracesTo: ['IMP-1'],
          milestone: 'M1',
        },
        repo,
        worktrees,
        sessions: new SessionRunner({
          log,
          provider,
          schemas: projectOutputSchemas(),
          policyRoot: repo,
        }),
        roles: RoleRegistry.fromDirectory(
          join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
        ),
        log,
        kb: [],
        policy: { maxClass: 'internal', unlabelled: 'internal' },
        checks: (ref) => Promise.resolve(mergeVerdict({ ref, runs: GREEN })),
        maxReviewAttempts: 1,
      });

      const reviews = provider.requests.filter((request) =>
        request.prompt.includes('Review the change for'),
      );
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.prompt).toContain('one commit per review round');
    } finally {
      log.close();
    }
  });

  it('does not blame the loop for a trunk the branch was simply taken past', async () => {
    // A fresh checkout is based on the repository's HEAD, which need not be
    // the branch the change merges into. Counting `main..HEAD` there returns
    // commits nobody in this loop made, so the count alone is not the signal —
    // whether the checkout was handed over from an earlier run is.
    const repo = newRepo();
    git(repo, ['checkout', '-q', '-b', 'ahead']);
    writeFileSync(join(repo, 'ahead.txt'), 'past main\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'a commit main does not have']);

    const provider = refusingProvider(git(repo, ['rev-parse', 'HEAD']));
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 1,
      });

      const reviews = provider.requests.filter((request) =>
        request.prompt.includes('Review the change for'),
      );
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.prompt).not.toContain('one commit per review round');
    } finally {
      log.close();
    }
  });

  it('claims nothing when it cannot tell what the checkout was carrying', async () => {
    // `commitsAhead` answers undefined when it cannot say — an unreadable
    // checkout, an unknown base. Undefined must not become "several": excusing
    // a commit structure on a guess is how a real finding gets waved through.
    const repo = newRepo();
    const worktrees = new (class extends WorktreeManager {
      override commitsAhead(): Promise<number | undefined> {
        return Promise.resolve(undefined);
      }
    })({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'earlier.txt'), 'from a run that blocked\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'left behind by an earlier round']);

    const provider = refusingProvider(git(worktree.path, ['rev-parse', 'HEAD']));
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
        maxReviewAttempts: 1,
      });

      const reviews = provider.requests.filter((request) =>
        request.prompt.includes('Review the change for'),
      );
      expect(reviews[0]?.prompt).not.toContain('one commit per review round');
    } finally {
      log.close();
    }
  });

  it('tells the second review that the extra commits are the loop’s', async () => {
    // The unit tests over `reviewPrompt` cannot see whether the loop passes it
    // the round, and without the round every review would be told it is the
    // first — which is how T3.2.6's third review came to refuse an approved
    // change over four commits the loop had made itself.
    const { log, provider } = await refusedForever(2);
    try {
      const reviews = provider.requests.filter((request) =>
        request.prompt.includes('Review the change for'),
      );
      expect(reviews).toHaveLength(2);
      expect(reviews[0]?.prompt).not.toContain('one commit per review round');
      expect(reviews[1]?.prompt).toContain('one commit per review round');
    } finally {
      log.close();
    }
  });

  it('grants one more round when a deviation arrives too late to declare', async () => {
    // T4.1.6: the reviewer approved, and the gate refused over a CONV-1 that
    // first appeared in round three of three, which the author had never been
    // shown and so could never have declared. A unit test of
    // `earnsAnotherRound` cannot see whether the loop acts on it.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    // Approve every round, and report the deviation only on the last one the
    // budget allows. Round 2 is the grace round; the author declares there.
    const approving = (deviations: { convention: string; where: string }[]) =>
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations,
      });
    const provider = new ScriptedProvider([
      scriptedSuccess(change),
      approving([{ convention: 'CONV-1', where: 'the branch' }]),
      // The grace round: the author declares it rather than changing anything.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-1', why: 'the loop made them' }],
      }),
      approving([{ convention: 'CONV-1', where: 'the branch' }]),
    ]);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 1,
      });

      // Without the grace it would block after one attempt; with it the
      // declaration lands and the change merges.
      expect(result.status).toBe('merged');
      expect(result.rounds).toHaveLength(2);

      const granted = provider.requests.find((request) =>
        request.prompt.includes('One round, to declare what you were never shown'),
      );
      expect(granted?.prompt).toContain('CONV-1');
      expect(granted?.prompt).toMatch(/never given the chance to declare it/);
    } finally {
      log.close();
    }
  });

  it('does not grant it twice, nor for a deviation already shown', async () => {
    // The grace is once, and only for what nobody said. A reviewer that keeps
    // reporting the same deviation the author keeps not declaring gets the
    // budget it was given.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const approving = scriptedSuccess({
      ref: head,
      verdict: 'approve',
      summary: 'good',
      findings: [],
      deviations: [{ convention: 'CONV-1', where: 'the branch' }],
    });
    const provider = new ScriptedProvider([
      scriptedSuccess(change),
      approving,
      scriptedSuccess(change), // the grace round, and the author declares nothing
      approving,
    ]);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 1,
      });

      expect(result.status).toBe('blocked');
      // Two rounds: the original and the one grace. Not three.
      expect(result.rounds).toHaveLength(2);
      expect(result.reason).toMatch(/after 2 attempt\(s\)/);
    } finally {
      log.close();
    }
  });

  it('grants the grace once, even when a second deviation is also new', async () => {
    // The guard that makes this bounded. Without it a reviewer reporting a
    // fresh deviation each round extends the budget forever — which is the
    // elasticity the grace is deliberately not.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const approving = (...conventions: string[]) =>
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: conventions.map((convention) => ({
          convention,
          where: 'the branch',
        })),
      });
    const provider = new ScriptedProvider([
      scriptedSuccess(change),
      approving('CONV-1'),
      // Grace round: declares CONV-1.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-1', why: 'the loop made them' }],
      }),
      // CONV-6 is new and never shown — a second grace, if nothing stopped it.
      approving('CONV-1', 'CONV-6'),
      // Only a loop that granted twice reaches these.
      scriptedSuccess({
        ...change,
        deviations: [
          { convention: 'CONV-1', why: 'the loop made them' },
          { convention: 'CONV-6', why: 'and this too' },
        ],
      }),
      approving('CONV-1', 'CONV-6'),
    ]);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 1,
      });

      expect(result.status).toBe('blocked');
      expect(result.rounds).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it('carries the last run’s review into the session that resumes it', async () => {
    // T4.1.6's second run re-found a gap its first run's final review had
    // already named. The findings are in the log; nothing read them. A unit
    // test of `lastReviewOf` cannot see whether the loop looks.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'left.txt'), 'from the run before\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'what the last run committed']);
    const tip = git(worktree.path, ['rev-parse', 'HEAD']);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });
    log.append({
      runId: 'r',
      type: 'TaskDispatched',
      payload: { taskId: 'T1', role: 'implementer', model: 'claude-sonnet-5' },
    });
    // The previous run's final review, about the commit the branch is still on.
    log.append({
      runId: 'r',
      type: 'ChangeReviewed',
      payload: {
        taskId: 'T1',
        reviewTaskId: 'T1-review-3',
        reviewerRole: 'code-reviewer',
        ref: tip,
        approved: false,
        summary: 'the env constraint is missing at the input boundary',
        findings: 1,
        deviations: ['CONV-5'],
        declaredDeviations: [],
        undeclaredDeviations: ['CONV-5'],
      },
    });

    const provider = refusingProvider(tip);
    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
        maxReviewAttempts: 1,
      });

      const authoring = provider.requests.find((request) =>
        request.prompt.includes('Implement T1'),
      );
      expect(authoring?.prompt).toContain('What the last review found');
      expect(authoring?.prompt).toContain(
        'the env constraint is missing at the input boundary',
      );
      expect(authoring?.prompt).toContain('CONV-5');
    } finally {
      log.close();
    }
  });

  it('carries nothing when the branch has moved past the review', async () => {
    // The guard. A review of an older commit has been partly answered by
    // whatever landed since, and there is no way to tell which parts.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'left.txt'), 'from the run before\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'what the last run committed']);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });
    log.append({
      runId: 'r',
      type: 'TaskDispatched',
      payload: { taskId: 'T1', role: 'implementer', model: 'claude-sonnet-5' },
    });
    log.append({
      runId: 'r',
      type: 'ChangeReviewed',
      payload: {
        taskId: 'T1',
        reviewTaskId: 'T1-review',
        reviewerRole: 'code-reviewer',
        ref: 'a-commit-that-is-no-longer-the-tip',
        approved: false,
        summary: 'this was about an older commit',
        findings: 1,
        deviations: [],
        declaredDeviations: [],
        undeclaredDeviations: [],
      },
    });

    const provider = refusingProvider(git(worktree.path, ['rev-parse', 'HEAD']));
    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
        maxReviewAttempts: 1,
      });

      const authoring = provider.requests.find((request) =>
        request.prompt.includes('Implement T1'),
      );
      expect(authoring?.prompt).not.toContain('What the last review found');
      expect(authoring?.prompt).not.toContain('this was about an older commit');
    } finally {
      log.close();
    }
  });

  it('carries nothing into a fresh checkout, even if a review names its base', async () => {
    // Re-dispatching a task that already merged gives it a fresh worktree off
    // the trunk — whose tip is the very commit that task's last review was
    // about. Deciding on the review's ref alone would hand a new run the
    // review of work that is already on main.
    const repo = newRepo();
    const trunk = git(repo, ['rev-parse', 'HEAD']);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });
    log.append({
      runId: 'r',
      type: 'TaskDispatched',
      payload: { taskId: 'T1', role: 'implementer', model: 'claude-sonnet-5' },
    });
    log.append({
      runId: 'r',
      type: 'ChangeReviewed',
      payload: {
        taskId: 'T1',
        reviewTaskId: 'T1-review',
        reviewerRole: 'code-reviewer',
        ref: trunk,
        approved: true,
        summary: 'this review is of work that has since merged',
        findings: 0,
        deviations: [],
        declaredDeviations: [],
        undeclaredDeviations: [],
      },
    });

    const provider = refusingProvider(trunk);
    try {
      await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 1,
      });

      const authoring = provider.requests.find((request) =>
        request.prompt.includes('Implement T1'),
      );
      expect(authoring?.prompt).not.toContain('What the last review found');
      expect(authoring?.prompt).not.toContain('has since merged');
    } finally {
      log.close();
    }
  });

  it('records the block in the log, whatever gave up', async () => {
    // Two different paths, because the block used to be recorded only where a
    // budget ran out. Every other way the loop gives up left the fold saying
    // `dispatched`, which reads as a task still running rather than one that
    // failed — and a success rate cannot be computed from that (OBS-4).
    const exhausted = await refusedForever(1);
    try {
      const blocked = exhausted.log
        .read()
        .filter((event) => event.type === 'TaskBlocked')
        .map((event) => event.payload as { taskId: string; reason: string });
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.taskId).toBe('T1');
      expect(blocked[0]?.reason).toMatch(/still refuses the change/);
    } finally {
      exhausted.log.close();
    }

    // Nothing about a budget here: the reviewer returns something the schema
    // will not take, so the loop gives up on the first round.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: head,
        summary: 'done',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      // Repeated, because a session that returns something the schema will not
      // take is retried before the runner gives up (AGT-3).
      ...Array.from({ length: 8 }, () =>
        scriptedSuccess({ nonsense: 'not a review at all' }),
      ),
    ]);
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 3,
      });
      expect(result.status).toBe('blocked');

      const events = log.read();
      const blocked = events
        .filter((event) => event.type === 'TaskBlocked')
        .map((event) => event.payload as { reason: string });
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.reason).toMatch(/review/);
      // No budget was involved, so nothing may claim one was.
      expect(events.some((event) => event.type === 'BudgetExceeded')).toBe(false);
      expect(fold(events).runs.r?.tasks.T1?.status).toBe('blocked');
    } finally {
      log.close();
    }
  });

  it('takes DEFAULT_REVIEW_ATTEMPTS reviews when the caller names no bound', async () => {
    // Asserted against the constant rather than against a literal: what would
    // go wrong is the default being disconnected, not its value changing, and
    // a test that has to be edited whenever the number moves is a test that
    // stops being read.
    const { result, log } = await refusedForever();
    try {
      expect(result.rounds).toHaveLength(DEFAULT_REVIEW_ATTEMPTS);
      expect(result.reason).toContain(
        `after ${String(DEFAULT_REVIEW_ATTEMPTS)} attempt(s)`,
      );
    } finally {
      log.close();
    }
  });
  it('records the commit a reviewer named, not the abbreviation it wrote', async () => {
    // The log is what a later run reads to carry findings forward, and it held
    // whatever string the reviewer typed. T4.1.6's blocking review recorded
    // `ed8541d`; the run that resumed it asked about the same commit in full,
    // matched nothing, and told the author nothing. A unit test of
    // `reconcileRef` cannot see which ref the loop writes down.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: head,
        summary: 'done',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        // As a reviewer writes it, and as the gate used to refuse it.
        ref: head.slice(0, 7),
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [],
      }),
    ]);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('merged');

      const reviewed = log
        .read()
        .filter((event) => event.type === 'ChangeReviewed')
        .at(-1);
      expect((reviewed?.payload as { ref: string }).ref).toBe(head);
    } finally {
      log.close();
    }
  });

  it('stops rather than gate a review against a commit it cannot read', async () => {
    // Fail closed (CONV-4). Without the head there is nothing to compare a
    // review against but the reviewer's own account of what it read, which is
    // the state this ended.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const worktrees = new (class extends WorktreeManager {
      override head(): Promise<string | undefined> {
        return Promise.resolve(undefined);
      }
    })({ repo });
    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: head,
        summary: 'done',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [],
      }),
    ]);

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('could not read the commit');
    } finally {
      log.close();
    }
  });
  it('brings a resumed checkout up to the trunk before the session starts', async () => {
    // T4.1.4a was cut before T4.1.6 merged and nothing brought it forward, so
    // its rework edited a file the trunk had rewritten and the pull request
    // went conflicting — which is a pull request no workflow runs against.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(repo, 'from-the-trunk.txt'), 'landed after the cut\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'a merge this branch was cut before']);

    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: 'unused',
        summary: 'done',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        ref: 'unused',
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [],
      }),
    ]);
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      await implementTask({ ...baseOptions(repo, provider, log), worktrees });

      // Whatever the outcome of the run itself, the checkout the session was
      // handed holds what the trunk holds.
      expect(existsSync(join(worktree.path, 'from-the-trunk.txt'))).toBe(true);
    } finally {
      log.close();
    }
  });

  it('blocks rather than work in a checkout that cannot be brought up to the trunk', async () => {
    // The kernel does not resolve conflicts. Saying so here costs one message;
    // finding out from CI costs a session, a grace period waiting for checks
    // that cannot exist, and a refusal that blames CI configuration.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'contested.txt'), 'what the branch says\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'the branch edits it']);
    writeFileSync(join(repo, 'contested.txt'), 'what the trunk says\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'the trunk edits it too']);

    const provider = new ScriptedProvider([]);
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('contested.txt');
      expect(result.reason).toMatch(/behind 'main'/);
      // No session was spent finding this out.
      expect(provider.requests).toHaveLength(0);
      // And nothing was written about a task no session ever ran: a
      // `TaskBlocked` for a task the run never dispatched is an event the fold
      // refuses, which CI caught and these tests had not.
      expect(() => fold(log.read())).not.toThrow();
      expect(log.read().some((event) => event.type === 'TaskBlocked')).toBe(false);
    } finally {
      log.close();
    }
  });
});
