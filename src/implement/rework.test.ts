import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 30_000);

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
  }, 30_000);
});
