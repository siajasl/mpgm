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
import { escalateModel } from '../agent/models.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
} from '../agent/session.js';
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

const RED: CheckRun[] = GREEN.map((run) =>
  run.name === 'scan' ? { ...run, conclusion: 'failure' as const } : run,
);

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
  function baseOptions(repo: string, provider: AgentSessionProvider, log: EventLog) {
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
        request.prompt.includes('The reviewer approved. One thing is missing'),
      );
      expect(granted?.prompt).toContain('CONV-1');
      expect(granted?.prompt).toMatch(/reviewer approved this change/);
    } finally {
      log.close();
    }
  });

  it('tells the author a design document is not a declaration, and nor is a fix', () => {
    // Both are what T4.1.4b actually did: it argued CONV-4 in DESIGN section 9,
    // in contracts/env.provision.md and in the refusal text an operator reads,
    // and it fixed CONV-4 and CONV-5 rather than declaring them. The old text
    // enumerated commit messages, comments and `summary`, so neither case was
    // named as one that does not count.
    const rendered = renderReview({
      review: {
        ref: 'abc',
        verdict: 'request-changes' as const,
        summary: 'the gate leaves a state that recurs',
        findings: [],
        deviations: [{ convention: 'CONV-4', where: 'the gate' }],
      },

      undeclared: ['CONV-4'],
      attempt: 1,
      attemptsRemaining: 2,
    });
    expect(rendered).toMatch(/design document or a contract/);
    expect(rendered).toMatch(/Fixing a departure does not stop the reviewer/);
    expect(rendered).toMatch(/declare it as well/);
  });

  it('asks for the declaration at once, rather than reworking an approved change', async () => {
    // T4.1.4b, four runs of it. The first review approved and reported CONV-1;
    // the loop spent its other two rounds reworking a change the reviewer had
    // already passed, and that rework drew the later reports that refused it
    // for good. Five approving reviews across those runs, none merged, $57.20.
    // The declaration is the only thing the gate is waiting for, so ask for it
    // while there is still budget rather than at the cap.
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
      // The declaration round, at round two of three rather than at the cap.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-1', why: 'the loop made the commits' }],
      }),
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
        maxReviewAttempts: 3,
      });

      expect(result.status).toBe('merged');
      // Two rounds out of a budget of three: the loop stopped as soon as the
      // reviewer was satisfied instead of spending what it was allowed.
      expect(result.rounds).toHaveLength(2);
      // And it asked for a declaration, not for rework.
      const second = provider.requests.filter((request) =>
        request.prompt.includes('The reviewer approved. One thing is missing'),
      );
      expect(second).toHaveLength(1);
      expect(
        provider.requests.some((request) =>
          request.prompt.includes('The review asked for changes'),
        ),
      ).toBe(false);
    } finally {
      log.close();
    }
  });

  it('asks even for a deviation an earlier round already put to the author', async () => {
    // The condition this replaces refused the round for a deviation the author
    // had been shown, reading a re-report as silence. T4.1.4b's session did the
    // first thing the rework prompt asks and fixed the departure; the reviewer
    // approved and reported it anyway, because it reports what it finds and is
    // deliberately not told what was declared. A fix is indistinguishable from
    // silence from here, so the loop must not try to tell them apart.
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
    const reviewed = (verdict: 'approve' | 'request-changes') =>
      scriptedSuccess({
        ref: head,
        verdict,
        summary: 'the gate leaves a state that recurs',
        findings:
          verdict === 'approve'
            ? []
            : [
                {
                  file: 'src/policy/deploy-gate.ts',
                  concern: 'an empty state is one recurring identity',
                  remedy: 'bind the confirmation to something that cannot recur',
                  severity: 'major',
                },
              ],
        deviations: [{ convention: 'CONV-4', where: 'the empty-state identity' }],
      });
    const provider = new ScriptedProvider([
      scriptedSuccess(change),
      // Round one refuses and reports CONV-4, so the author is shown it.
      reviewed('request-changes'),
      // The author fixes rather than declares, exactly as the prompt asks first.
      scriptedSuccess(change),
      // Round two approves and reports CONV-4 all the same.
      reviewed('approve'),
      // The declaration round.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-4', why: 'no stateless identity exists' }],
      }),
      reviewed('approve'),
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

      expect(result.status).toBe('merged');
      const granted = provider.requests.find((request) =>
        request.prompt.includes('The reviewer approved. One thing is missing'),
      );
      expect(granted?.prompt).toContain('CONV-4');
      // And it tells the author the thing that wasted this round in T4.1.4b.
      expect(granted?.prompt).toMatch(/already fixed the departure/);
    } finally {
      log.close();
    }
  });

  it('does not grant it twice', async () => {
    // The extension is what is bounded, and one is the whole of it. A reviewer
    // that keeps reporting the same deviation the author keeps not declaring
    // gets the budget it was given plus that one round: a second extension
    // would be spent asking for a signature the author has already declined to
    // give, and would let the budget grow a round at a time forever.
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
      // Blocked for want of a declaration, and said so (T4.3.10). The
      // reviewer approved both rounds; reporting this as a refusal would be
      // putting a sentence in its mouth.
      expect(result.reason).toMatch(/held for want of a declaration/);
      expect(result.reason).not.toMatch(/still refuses the change/);
    } finally {
      log.close();
    }
  });

  it('grants the grace once, even when a second deviation is also new', async () => {
    // The guard that makes this bounded, at the cap where it costs a round
    // rather than replaces one. Without it a reviewer reporting a fresh
    // deviation each round extends the budget forever — which is the
    // elasticity the grace is deliberately not. Below the cap a fresh
    // deviation does earn another declaration round; that is the next test.
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

  it('grants it again when a later round approves and reports something new', async () => {
    // T4.2.4, twice. A grace spent early must not leave the last round unable
    // to sign for a deviation it is seeing for the first time: the author
    // writes `deviations` before the review that reports one, so a deviation
    // first reported in the final round is no more declarable there than one
    // first reported in the first. The real run spent its grace at round one
    // on CONV-6 and was refused at round three over a CONV-3 nobody had
    // mentioned yet — twelve sessions and $29.52 over a signature the author
    // was never in a position to give.
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
    const declaring = (...conventions: string[]) =>
      scriptedSuccess({
        ...change,
        deviations: conventions.map((convention) => ({
          convention,
          why: 'declared',
        })),
      });
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
      // Round 1 approves and reports CONV-6, which nothing declared. Below the
      // cap, so the declaration round costs the round it replaces.
      approving('CONV-6'),
      declaring('CONV-6'),
      // Round 2 is the cap, approves, and reports CONV-3 for the first time.
      // A once-per-task bound refuses here and the change never merges.
      approving('CONV-6', 'CONV-3'),
      declaring('CONV-6', 'CONV-3'),
      approving('CONV-6', 'CONV-3'),
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
        maxReviewAttempts: 2,
      });

      expect(result.status).toBe('merged');
      // Two rounds plus the one extension the cap buys.
      expect(result.rounds).toHaveLength(3);
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

  // T4.2.14: before this task, a blocked task's refusal existed only in the
  // rework prompt the implementing session happened to see — `ChangeReviewed`
  // carried a count, not the findings themselves, so nobody else could ever
  // read back why. This asserts the read-back, not merely that the count is
  // non-zero (CONV-6): every finding's file, severity and remedy must survive
  // replay untouched.
  it("lets a blocked task's refusal be read back from the log alone (T4.2.14)", async () => {
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const findings = [
      {
        file: 'src/a.ts',
        line: 12,
        concern: 'off-by-one in the boundary check',
        remedy: 'use <= rather than <',
        severity: 'blocker' as const,
      },
      {
        file: 'src/b.ts',
        concern: 'the new test cannot fail against the old code',
        remedy: 'assert on the behaviour the change introduces',
        severity: 'major' as const,
      },
      {
        file: 'src/c.ts',
        concern: 'naming is inconsistent with the rest of the module',
        remedy: 'rename to match the module it lives in',
        severity: 'minor' as const,
      },
    ];
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
        verdict: 'request-changes',
        summary: 'Two smaller inaccuracies and one assertion gap follow',
        findings,
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
        maxReviewAttempts: 1,
      });
      expect(result.status).toBe('blocked');

      // From here on, only the log is read — not `result`, not `provider`,
      // nothing the session returned directly. That is the property under
      // test: a transcript is not an interface (ORC-3), so this has to be
      // reconstructable without one.
      const reviewed = log
        .read()
        .filter((event) => event.type === 'ChangeReviewed')
        .map(
          (event) =>
            event.payload as {
              findings: number;
              findingDetails: readonly {
                file: string;
                line?: number;
                concern: string;
                remedy: string;
                severity: string;
              }[];
            },
        );

      expect(reviewed).toHaveLength(1);
      expect(reviewed[0]?.findings).toBe(3);
      expect(reviewed[0]?.findingDetails.map((f) => f.severity)).toStrictEqual([
        'blocker',
        'major',
        'minor',
      ]);
      expect(reviewed[0]?.findingDetails.map((f) => f.remedy)).toStrictEqual([
        'use <= rather than <',
        'assert on the behaviour the change introduces',
        'rename to match the module it lives in',
      ]);
      expect(reviewed[0]?.findingDetails).toStrictEqual(findings);
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

  it('escalates the last rework round one tier, and no earlier one (T4.2.13, AGT-5)', async () => {
    // The T4.2.9 case this is measured against: three rework rounds, checks
    // green every round, three rejections, blocked on `BudgetExceeded`
    // (kind: 'reviews') — and, before this task, no tier ever moved. Read off
    // the fixture role rather than hardcoded, so this fails instead of
    // passing vacuously if the role's own model ever changes.
    const implementerModel = RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ).get('implementer').model;
    const escalated = escalateModel(implementerModel);
    // If the fixture role already sat at the top tier, every assertion below
    // would pass whether or not escalation actually ran.
    expect(escalated).not.toBe(implementerModel);

    const { result, log } = await refusedForever();
    try {
      expect(result.rounds).toHaveLength(DEFAULT_REVIEW_ATTEMPTS);

      // Every `TaskDispatched` under the implementer role for this task: the
      // first implementing session, then one rework per round the review
      // budget still had a further round to spend the fix on. The final
      // round's own rejection is what exhausts the budget (`BudgetExceeded`
      // above), and nothing is dispatched to rework a change no further
      // review would ever read — so this is asserted in the log, per
      // T4.2.13, rather than on a return value nothing here exposes.
      const dispatched = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string; role: string }).taskId === 'T1' &&
            (event.payload as { taskId: string; role: string }).role === 'implementer',
        )
        .map((event) => (event.payload as { model: string }).model);

      expect(dispatched).toHaveLength(DEFAULT_REVIEW_ATTEMPTS);
      // Every round but the last runs on the role's own model — escalating
      // every round would spend the stronger one on rounds the weaker model
      // would have closed by itself.
      expect(dispatched.slice(0, -1)).toStrictEqual(
        dispatched.slice(0, -1).map(() => implementerModel),
      );
      // The last rework round — and it alone — runs one tier up.
      expect(dispatched.at(-1)).toBe(escalated);
    } finally {
      log.close();
    }
  });

  it('never escalates a task the reviewer approves on round one', async () => {
    // The other half of T4.2.13's test: unconditional escalation would pass
    // the first assertion above just as well (CONV-6). A task approved on its
    // first review dispatches no rework at all, so its one implementing
    // session is the only `TaskDispatched` the implementer role gets, and it
    // has to be the role's own model.
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
      const result = await implementTask(baseOptions(repo, provider, log));
      expect(result.status).toBe('merged');
      expect(result.rounds).toHaveLength(1);

      const implementerModel = RoleRegistry.fromDirectory(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
      ).get('implementer').model;
      const dispatched = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string; role: string }).taskId === 'T1' &&
            (event.payload as { taskId: string; role: string }).role === 'implementer',
        )
        .map((event) => (event.payload as { model: string }).model);

      expect(dispatched).toStrictEqual([implementerModel]);
    } finally {
      log.close();
    }
  });

  it('refuses the escalated round before it starts when the allowance cannot fund it (T4.3.2, T4.3.8)', async () => {
    // T4.2.13 reasoned escalation costs nothing beyond the round that was
    // going to be spent regardless — true of the round count, and false of
    // the money: T4.3.2's Opus round cost $8.0142675 against an implementer
    // budget of $8 that had not moved, roughly eight times the $1.06 Sonnet
    // round right before it. This drives a task to that same shape — a
    // final rework round about to escalate on an allowance sized for the
    // weaker tier — and checks the round never starts at all, rather than
    // starting and being truncated at the cap.
    const implementerRole = RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ).get('implementer');
    const escalated = escalateModel(implementerRole.model);
    // If the fixture role already sat at the top tier there would be nothing
    // to escalate to, and every assertion below would pass whether or not
    // the guard does anything.
    expect(escalated).not.toBe(implementerRole.model);

    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    // $2 for the one round this task has actually run, times the measured
    // eight-fold multiplier, estimates $16 for the escalated round — more
    // than the implementer role's own $8 allowance (`roles/implementer.md`)
    // can fund.
    const provider = new ScriptedProvider([
      scriptedSuccess(
        {
          ref: head,
          summary: 'done',
          files: ['README.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        },
        { usage: { inputTokens: 1000, outputTokens: 500, costUsd: 2 } },
      ),
      scriptedSuccess({
        ref: head,
        verdict: 'request-changes',
        summary: 'no',
        findings: [
          { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' },
        ],
        deviations: [],
      }),
      // Nothing scripted for a third session: if the guard fails to refuse
      // and the loop dispatches the escalated round anyway, `ScriptedProvider`
      // throws rather than this test passing on a round it never checked.
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
        maxReviewAttempts: 2,
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain(escalated);
      expect(result.reason).toMatch(/refused before dispatch/);

      // Refused before it started: exactly the two sessions scripted ran —
      // the implementing session and the one review — and no third was
      // ever asked for.
      expect(provider.requests).toHaveLength(2);
      const implementerDispatches = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string; role: string }).taskId === 'T1' &&
            (event.payload as { taskId: string; role: string }).role === 'implementer',
        );
      expect(implementerDispatches).toHaveLength(1);

      // A refusal is a decision on the record (T4.2.13 already forbids
      // silently dropping back a tier), and `kind: 'escalation'` — not
      // `kind: 'cost'` — is what tells this apart, by the log alone, from a
      // round that was dispatched and then truncated mid-session (the next
      // test).
      const decision = log.read().find((event) => event.type === 'BudgetExceeded')
        ?.payload as {
        kind: string;
        limit: number;
        observed: number;
      };
      expect(decision.kind).toBe('escalation');
      expect(decision.limit).toBe(implementerRole.budgets.costUsd);
      expect(decision.observed).toBeCloseTo(16, 5);

      // Nothing to strand: the round never ran, so the branch sits exactly
      // where the last real session left it.
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      log.close();
    }
  });

  it('estimates from the round before the escalation, not from every round averaged (T4.3.8)', async () => {
    // The multiplier is a ratio between two adjacent rounds — T4.3.2's Opus
    // round over the Sonnet round right before it — so the quantity it
    // multiplies has to be one round. Averaging the task's whole spend
    // instead compounds conservatism nobody measured: here the opening
    // implementation cost $6 and the rework round after it $0.30, so the
    // average says $25.20 and refuses, and the preceding round says $2.40
    // and funds a round that comfortably fits. Measured against this repo's
    // own log the difference is 30 tasks of 38 above the line against 13 —
    // the difference between guarding the escalated round and retiring it.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const implementerRole = RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ).get('implementer');
    const escalated = escalateModel(implementerRole.model);
    expect(escalated).not.toBe(implementerRole.model);

    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const reject = scriptedSuccess({
      ref: head,
      verdict: 'request-changes',
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' },
      ],
      deviations: [],
    });
    const provider = new ScriptedProvider([
      // The expensive opening round, which an average would carry into every
      // estimate the task ever makes.
      scriptedSuccess(change, {
        usage: { inputTokens: 3000, outputTokens: 1500, costUsd: 6 },
      }),
      reject,
      // The cheap round immediately before the escalation: what the
      // multiplier was actually measured against.
      scriptedSuccess(change, {
        usage: { inputTokens: 300, outputTokens: 150, costUsd: 0.3 },
      }),
      reject,
      // The escalated round, which this estimate has to let run.
      scriptedSuccess(change, {
        usage: { inputTokens: 400, outputTokens: 200, costUsd: 0.5 },
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
        maxReviewAttempts: 3,
      });

      expect(result.status).toBe('merged');

      // The escalated round ran, on the stronger tier, rather than being
      // refused on an estimate built from a round two rounds back.
      const models = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string }).taskId === 'T1',
        )
        .map((event) => (event.payload as { model: string }).model);
      expect(models).toEqual([implementerRole.model, implementerRole.model, escalated]);
      expect(
        log
          .read()
          .filter((event) => event.type === 'BudgetExceeded')
          .map((event) => (event.payload as { kind: string }).kind),
      ).toEqual([]);
    } finally {
      log.close();
    }
  });

  it('measures the whole round a CI repair finished, not the repair dispatch alone (T4.3.8)', async () => {
    // `implementerPrecedingRoundCostUsd` used to reset its accumulator on
    // every `TaskDispatched` for the task, and `repairUntilGreen`'s own
    // repair session dispatches under that same task id (`track('repair',
    // ...)`, `loop.ts`) — so a round that went red on CI and was repaired
    // cheaply reported the repair's spend alone as "the preceding round".
    // Here the round itself cost $3 and the repair that finished it $0.05:
    // the repair-alone estimate is $0.40 (well under the implementer's $8,
    // so the guard would let the escalated round through), and the
    // round's real cost of $3.05 estimates $24.40 (comfortably over it, so
    // the guard has to refuse). Only the second is right.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const implementerRole = RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ).get('implementer');
    const escalated = escalateModel(implementerRole.model);
    expect(escalated).not.toBe(implementerRole.model);

    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const reject = scriptedSuccess({
      ref: head,
      verdict: 'request-changes',
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' },
      ],
      deviations: [],
    });

    const provider = new ScriptedProvider([
      // The round itself: an expensive implementing session...
      scriptedSuccess(change, {
        usage: { inputTokens: 3000, outputTokens: 1500, costUsd: 3 },
      }),
      // ...that goes red on CI and is repaired cheaply — the round
      // finishing, not a new one starting.
      scriptedSuccess(change, {
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 },
      }),
      // The review that sends the now-green round back, at the cap — the
      // guard runs before the next (escalated) round would dispatch.
      reject,
    ]);

    let checksCalls = 0;
    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 2,
        checks: (ref) => {
          checksCalls += 1;
          return Promise.resolve(
            mergeVerdict({ ref, runs: checksCalls === 1 ? RED : GREEN }),
          );
        },
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('refused before dispatch');
      expect(result.reason).toContain(escalated);
      // The round's real cost — implementing session plus repair — not the
      // repair's alone.
      expect(result.reason).toContain('$3.0500');

      const budgetEvents = log
        .read()
        .filter((event) => event.type === 'BudgetExceeded')
        .map((event) => (event.payload as { kind: string }).kind);
      expect(budgetEvents).toContain('escalation');
    } finally {
      log.close();
    }
  });

  it('neither escalates nor refuses the declaration round the cap buys (T4.2.4, T4.3.8)', async () => {
    // The declaration round is granted by adding one to `attempts`, which
    // makes `round === attempts - 1` true of the round it just bought — so
    // an escalation keyed on that arithmetic escalates the one round whose
    // work is known to be trivial, and a funding guard behind it can then
    // refuse a change the reviewer has already approved, for want of a
    // sentence naming a convention. T4.2.4 bought that round with $29.52 of
    // review; this drives a task to it with a preceding round expensive
    // enough ($2, so 8x is $16 against the implementer's $8) that the guard
    // would certainly fire if it applied.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const implementerRole = RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ).get('implementer');
    expect(escalateModel(implementerRole.model)).not.toBe(implementerRole.model);

    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const approvingWithCONV6 = () =>
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [{ convention: 'CONV-6', where: 'the branch' }],
      });
    const provider = new ScriptedProvider([
      scriptedSuccess(change, {
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 2 },
      }),
      // At the cap: approved, and reporting a convention nothing declared.
      // This is what buys the extra round.
      approvingWithCONV6(),
      // The declaration round itself: the sentence, and nothing else.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-6', why: 'declared' }],
      }),
      approvingWithCONV6(),
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

      // The change merges: the declaration round happened and was not
      // refused for want of budget.
      expect(result.status).toBe('merged');
      expect(
        log
          .read()
          .filter((event) => event.type === 'BudgetExceeded')
          .map((event) => (event.payload as { kind: string }).kind),
      ).toEqual([]);

      // And it ran on the tier the role is funded for. Escalating it would
      // spend the stronger model on a change nobody disputes, and is what
      // put it in front of the guard in the first place.
      const models = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string }).taskId === 'T1',
        )
        .map((event) => (event.payload as { model: string }).model);
      expect(models).toEqual([implementerRole.model, implementerRole.model]);
    } finally {
      log.close();
    }
  });

  it('does not escalate a declaration round earned below the cap, even though its round number coincides with the final one (T4.2.13, T4.3.8)', async () => {
    // A second, unrelated way for `round === attempts - 1` to be true of a
    // declaration round: not because the cap bought it an extra round (the
    // test above), but because it happened to land, on its own arithmetic,
    // at the round right before the cap — `maxReviewAttempts: 3`, granted at
    // round 2, with `attempts` never incremented. T4.2.13 escalated on that
    // arithmetic alone, so a declaration round in this position escalated
    // before this task and the guard below could then refuse to fund a
    // change the reviewer had already approved, over a signature. The
    // round that precedes it is made expensive enough ($2, so 8x is $16
    // against the implementer's $8) that an escalation attempt here would
    // certainly be refused — so this either merges clean or blocks on
    // `BudgetExceeded{kind: 'escalation'}`, and only the first is right.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const implementerRole = RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ).get('implementer');
    expect(escalateModel(implementerRole.model)).not.toBe(implementerRole.model);

    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const reject = {
      ref: head,
      verdict: 'request-changes' as const,
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' as const },
      ],
      deviations: [],
    };
    const approvingWithCONV6 = () =>
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [{ convention: 'CONV-6', where: 'the branch' }],
      });
    const provider = new ScriptedProvider([
      // Round 1: a genuine rejection, not a declaration round.
      scriptedSuccess(change),
      scriptedSuccess(reject),
      // Round 1's fix — the round the guard would measure against, priced
      // high enough that an escalation attempt on the next round would be
      // refused.
      scriptedSuccess(change, {
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 2 },
      }),
      // Round 2: approved, but reporting a convention nothing declared —
      // granted below the cap (round 2 of 3), so no extension is spent.
      approvingWithCONV6(),
      // The declaration round itself: the sentence, and nothing else.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-6', why: 'declared' }],
      }),
      approvingWithCONV6(),
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

      expect(result.status).toBe('merged');
      expect(
        log
          .read()
          .filter((event) => event.type === 'BudgetExceeded')
          .map((event) => (event.payload as { kind: string }).kind),
      ).toEqual([]);

      const models = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string; role: string }).taskId === 'T1' &&
            (event.payload as { taskId: string; role: string }).role === 'implementer',
        )
        .map((event) => (event.payload as { model: string }).model);
      // Three implementer dispatches — the opening session, round 1's fix,
      // and the declaration round — none escalated.
      expect(models).toEqual([
        implementerRole.model,
        implementerRole.model,
        implementerRole.model,
      ]);
    } finally {
      log.close();
    }
  });

  it('pushes what a killed rework session already committed, rather than stranding it in the worktree (T4.3.2, T4.3.8)', async () => {
    // The other half: an allowance the guard above judges sufficient still
    // dispatches the escalated round, and a round that is dispatched can
    // still be killed mid-session — T4.3.2's Opus round had already
    // committed twice, 1,278 insertions over 16 files, answering every
    // blocking finding, when the cost cap ended it before it pushed. This
    // checks the loop does not report that block against the last ref it
    // published itself while the finished work sits unreachable in the
    // local worktree.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const head = git(repo, ['rev-parse', 'HEAD']);

    // $0.50 for the round already run, times eight, estimates $4 for the
    // escalated round — comfortably inside the implementer role's $8
    // allowance, so the guard above lets this one dispatch.
    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const reject = {
      ref: head,
      verdict: 'request-changes' as const,
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' as const },
      ],
      deviations: [],
    };
    // The escalated round's own session: committed real work, then hit its
    // cost cap before reporting anything the schema could parse — the same
    // shape `SessionRunner` reports for a live session terminated by the
    // SDK's own `maxBudgetUsd` (`agent/runner.ts`).
    const killedAtCap: SessionResult = {
      termination: 'budget_exceeded',
      structuredOutput: undefined,
      usage: { inputTokens: 4000, outputTokens: 2000, costUsd: 8.0142675 },
      turns: 40,
      denials: [],
      errorMessage: 'session exceeded its cost budget',
      durationMs: 120000,
      apiDurationMs: 95000,
    };

    let stranded: string | undefined;
    const requests: SessionRequest[] = [];
    let calls = 0;
    const provider: AgentSessionProvider = {
      run(request: SessionRequest): Promise<SessionResult> {
        requests.push(request);
        const index = calls;
        calls += 1;
        if (index === 0) {
          return Promise.resolve(
            scriptedSuccess(change, {
              usage: { inputTokens: 500, outputTokens: 250, costUsd: 0.5 },
            }),
          );
        }
        if (index === 1) {
          return Promise.resolve(scriptedSuccess(reject));
        }
        if (index === 2) {
          // What the killed session actually did to the checkout, before it
          // ran out of budget: real commits the loop never asked for and
          // never saw in any structured output.
          writeFileSync(join(worktrees.pathFor('T1'), 'escalated.txt'), 'fixed\n');
          git(worktrees.pathFor('T1'), ['add', '--all']);
          git(worktrees.pathFor('T1'), ['commit', '-m', 'answers the review']);
          git(worktrees.pathFor('T1'), [
            'commit',
            '--allow-empty',
            '-m',
            'a second commit',
          ]);
          stranded = git(worktrees.pathFor('T1'), ['rev-parse', 'HEAD']);
          return Promise.resolve(killedAtCap);
        }
        throw new Error('ran out of scripted results');
      },
    };

    const published: { branch: string; ref: string }[] = [];
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
        maxReviewAttempts: 2,
        publish: (branch, ref) => {
          published.push({ branch, ref });
          return Promise.resolve();
        },
      });

      expect(stranded).toBeDefined();
      expect(stranded).not.toBe(head);

      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/session terminated: budget_exceeded/);
      // Distinguished from the guard's own refusal (previous test) by
      // saying what actually happened: this round ran and was truncated,
      // rather than being refused before it was dispatched.
      expect(result.reason).not.toMatch(/refused before dispatch/);
      // Says where the work went, by commit and by branch, so an operator
      // can go and look at it without reading the loop (CONV-3).
      expect(result.reason).toContain(
        `already committed up to ${String(stranded)}, pushed to ${worktrees.branchFor('T1')} for review`,
      );
      expect(result.reason).toContain(worktrees.pathFor('T1'));
      expect(result.ref).toBe(stranded);

      // Pushed rather than left for only the local worktree to show: the
      // branch this loop reports as blocked is the same one that carries
      // the commits, because `publish` was called with the stranded tip.
      expect(published.some((entry) => entry.ref === stranded)).toBe(true);
      expect(published.some((entry) => entry.branch === worktrees.branchFor('T1'))).toBe(
        true,
      );

      // This is the "killed part-way" shape, not the "refused before
      // dispatch" one: the escalated round *did* get a `TaskDispatched`,
      // and the budget event it wrote is `kind: 'cost'` — `SessionRunner`'s
      // own accounting of a session that ran and hit the cap — not
      // `kind: 'escalation'`, which the guard above never had reason to
      // write here.
      const implementerDispatches = log
        .read()
        .filter(
          (event) =>
            event.type === 'TaskDispatched' &&
            (event.payload as { taskId: string; role: string }).taskId === 'T1' &&
            (event.payload as { taskId: string; role: string }).role === 'implementer',
        );
      expect(implementerDispatches).toHaveLength(2);
      const budgetEvents = log
        .read()
        .filter((event) => event.type === 'BudgetExceeded')
        .map((event) => (event.payload as { kind: string }).kind);
      expect(budgetEvents).toContain('cost');
      expect(budgetEvents).not.toContain('escalation');
    } finally {
      log.close();
    }
  });

  it('names a pause as why stranded work was not pushed, rather than claiming no publish was configured (T4.3.8)', async () => {
    // The third way the block message can end, and the one still untested:
    // `publish` *is* configured for this run — unlike the test below — but
    // an operator's pause landed on the killed session while it was still
    // in flight, after `track` last checked and before the loop could push
    // what it committed. That race needs its own words: a paused run is
    // resumed, an unconfigured publish is pushed by hand, and telling an
    // operator the wrong one sends them to fix something that was never
    // broken.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
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
    const reject = {
      ref: head,
      verdict: 'request-changes' as const,
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' as const },
      ],
      deviations: [],
    };
    const killedAtCap: SessionResult = {
      termination: 'budget_exceeded',
      structuredOutput: undefined,
      usage: { inputTokens: 4000, outputTokens: 2000, costUsd: 1 },
      turns: 40,
      denials: [],
      errorMessage: 'session exceeded its cost budget',
      durationMs: 120000,
      apiDurationMs: 95000,
    };

    let stranded: string | undefined;
    let calls = 0;
    const provider: AgentSessionProvider = {
      run(): Promise<SessionResult> {
        const index = calls;
        calls += 1;
        if (index === 0) {
          return Promise.resolve(
            scriptedSuccess(change, {
              usage: { inputTokens: 500, outputTokens: 250, costUsd: 0.5 },
            }),
          );
        }
        if (index === 1) {
          return Promise.resolve(scriptedSuccess(reject));
        }
        if (index === 2) {
          // Real work, committed before the session was killed — same as
          // the first test above.
          writeFileSync(join(worktrees.pathFor('T1'), 'paused.txt'), 'in flight\n');
          git(worktrees.pathFor('T1'), ['add', '--all']);
          git(worktrees.pathFor('T1'), [
            'commit',
            '-m',
            'work in flight when the pause landed',
          ]);
          stranded = git(worktrees.pathFor('T1'), ['rev-parse', 'HEAD']);
          // The pause lands while this session is still running — after
          // `track`'s own pre-dispatch check last read the run's control,
          // before its result comes back to the loop.
          log.append({
            runId: 'r',
            type: 'OperatorIntervened',
            payload: { action: 'pause', detail: '' },
          });
          return Promise.resolve(killedAtCap);
        }
        throw new Error('ran out of scripted results');
      },
    };

    const published: { branch: string; ref: string }[] = [];
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
        maxReviewAttempts: 2,
        publish: (branch, ref) => {
          published.push({ branch, ref });
          return Promise.resolve();
        },
      });

      expect(stranded).toBeDefined();
      expect(stranded).not.toBe(head);

      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/session terminated: budget_exceeded/);
      expect(result.reason).toContain(
        `already committed up to ${String(stranded)} on ${worktrees.branchFor('T1')}`,
      );
      expect(result.reason).toContain(
        `left in the worktree at ${worktrees.pathFor('T1')}`,
      );
      // Named as a pause — publish was configured for this run, so telling
      // the operator none was would be wrong.
      expect(result.reason).toContain('the run was paused before it could be published');
      expect(result.reason).toContain('resume the run, or push that branch by hand');
      expect(result.reason).not.toMatch(/no publish was configured/);
      expect(result.ref).toBe(stranded);

      // Not pushed: the pause landed before the loop's own publish call for
      // this round could run.
      expect(published.some((entry) => entry.ref === stranded)).toBe(false);
    } finally {
      log.close();
    }
  });

  it('reports stranded work as left in the worktree rather than pushed, when nothing publishes it (T4.3.8)', async () => {
    // The other race the block message has to get right: the killed session
    // above still committed real work, but this run has no `publish` at all
    // (a project whose CI runs locally has nothing to publish — the same
    // reason `publish` is optional in the first place) or was killed/paused
    // itself before the push could run. Either way the commit sits in the
    // worktree, unpushed, and the message the operator reads has to say that
    // rather than claim a push that never happened — the exact failure this
    // half of the task exists to end.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
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
    const reject = {
      ref: head,
      verdict: 'request-changes' as const,
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' as const },
      ],
      deviations: [],
    };
    const killedAtCap: SessionResult = {
      termination: 'budget_exceeded',
      structuredOutput: undefined,
      usage: { inputTokens: 4000, outputTokens: 2000, costUsd: 8.0142675 },
      turns: 40,
      denials: [],
      errorMessage: 'session exceeded its cost budget',
      durationMs: 120000,
      apiDurationMs: 95000,
    };

    let stranded: string | undefined;
    let calls = 0;
    const provider: AgentSessionProvider = {
      run(): Promise<SessionResult> {
        const index = calls;
        calls += 1;
        if (index === 0) {
          return Promise.resolve(
            scriptedSuccess(change, {
              usage: { inputTokens: 500, outputTokens: 250, costUsd: 0.5 },
            }),
          );
        }
        if (index === 1) {
          return Promise.resolve(scriptedSuccess(reject));
        }
        if (index === 2) {
          writeFileSync(join(worktrees.pathFor('T1'), 'escalated.txt'), 'fixed\n');
          git(worktrees.pathFor('T1'), ['add', '--all']);
          git(worktrees.pathFor('T1'), ['commit', '-m', 'answers the review']);
          stranded = git(worktrees.pathFor('T1'), ['rev-parse', 'HEAD']);
          return Promise.resolve(killedAtCap);
        }
        throw new Error('ran out of scripted results');
      },
    };

    const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
    log.append({
      runId: 'r',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });

    try {
      // No `publish` override: `baseOptions` carries none, so
      // `options.publish` is `undefined` for this run, the same as a project
      // whose CI runs locally.
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
        maxReviewAttempts: 2,
      });

      expect(stranded).toBeDefined();
      expect(stranded).not.toBe(head);

      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/session terminated: budget_exceeded/);
      // The work is real and the message says so, but it does not claim a
      // push nothing here performed.
      expect(result.reason).toContain(`already committed up to ${String(stranded)}`);
      // Never claims the push this run never made. The literal adjacency
      // "pushed for review" matches neither this message nor the pushed
      // one above — it is the actual substring the code emits, `pushed to
      // <branch> for review`, that the two have to differ on.
      expect(result.reason).not.toContain(
        `pushed to ${worktrees.branchFor('T1')} for review`,
      );
      // Names where the operator can still find it, and why it is not on
      // the branch, rather than leaving the gap silent.
      expect(result.reason).toContain(
        `left in the worktree at ${worktrees.pathFor('T1')}`,
      );
      expect(result.reason).toMatch(/no publish was configured for this run/);
      expect(result.ref).toBe(stranded);
    } finally {
      log.close();
    }
  });

  it('does not report a killed session as having committed, when the mismatch is only an abbreviated ref (T4.3.8)', async () => {
    // `repair.ref` traces back to the implementing session's own reported
    // ref, which is never run through `reconcileRef` the way a reviewer's is
    // — "a seven-character ref matches nothing" is why that reconciliation
    // exists at all. An implementer that reports an abbreviated SHA for the
    // very commit git is already on must not make a rework session that
    // commits nothing look like it stranded work: the comparison has to be
    // against git's own read of the branch tip, not against what a session
    // typed.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const head = git(repo, ['rev-parse', 'HEAD']);

    const change = {
      // Abbreviated, as a session can and does write one — matching `head`
      // exactly, so there is nothing here for a rework round to add to.
      ref: head.slice(0, 7),
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [],
    };
    const reject = {
      ref: head,
      verdict: 'request-changes' as const,
      summary: 'no',
      findings: [
        { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' as const },
      ],
      deviations: [],
    };
    // Killed, and this time genuinely nothing new: the worktree is left
    // exactly where the first round's commit left it.
    const killedNoCommits: SessionResult = {
      termination: 'budget_exceeded',
      structuredOutput: undefined,
      usage: { inputTokens: 4000, outputTokens: 2000, costUsd: 8.0142675 },
      turns: 40,
      denials: [],
      errorMessage: 'session exceeded its cost budget',
      durationMs: 120000,
      apiDurationMs: 95000,
    };

    let calls = 0;
    const provider: AgentSessionProvider = {
      run(): Promise<SessionResult> {
        const index = calls;
        calls += 1;
        if (index === 0) {
          return Promise.resolve(
            scriptedSuccess(change, {
              usage: { inputTokens: 500, outputTokens: 250, costUsd: 0.5 },
            }),
          );
        }
        if (index === 1) {
          return Promise.resolve(scriptedSuccess(reject));
        }
        if (index === 2) {
          return Promise.resolve(killedNoCommits);
        }
        throw new Error('ran out of scripted results');
      },
    };

    const published: { branch: string; ref: string }[] = [];
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
        maxReviewAttempts: 2,
        publish: (branch, ref) => {
          published.push({ branch, ref });
          return Promise.resolve();
        },
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/session terminated: budget_exceeded/);
      // No stranded-work clause at all: the killed round added nothing, so
      // there is nothing to say it committed or pushed.
      expect(result.reason).not.toMatch(/already committed up to/);
      expect(result.reason).not.toContain(
        `pushed to ${worktrees.branchFor('T1')} for review`,
      );
      expect(result.reason).not.toMatch(/left in the worktree/);
      expect(result.ref).toBe(head);

      // The only push in this run is the very first one, at the top of the
      // loop, of the abbreviated ref the implementer itself reported — not a
      // second one manufactured by comparing the killed round's tip against
      // that abbreviation.
      expect(published).toHaveLength(1);
      expect(published[0]?.ref).toBe(change.ref);
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

  it('blocks rather than guess when the agent it dispatches cannot honestly resolve a conflict (T4.3.9)', async () => {
    // The kernel does not resolve conflicts itself — it dispatches an agent
    // to (T4.3.9, `conflict.ts`) — but a real collision (both sides change
    // one line to different values) has no rule that picks a winner, and an
    // agent that reports so honestly still leaves the task blocked rather
    // than merging a guess.
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const worktree = await worktrees.acquire('T1');
    writeFileSync(join(worktree.path, 'contested.txt'), 'what the branch says\n');
    git(worktree.path, ['add', '--all']);
    git(worktree.path, ['commit', '-m', 'the branch edits it']);
    const branchTip = git(worktree.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'contested.txt'), 'what the trunk says\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'the trunk edits it too']);

    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: branchTip,
        summary: 'left the conflict for a person to decide',
        files: [],
        tests: [],
        complete: false,
        remaining: 'contested.txt: both sides changed it to something different',
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
      expect(result.reason).toContain('contested.txt');
      expect(result.reason).toMatch(/behind 'main'/);
      // One session was spent — the resolution attempt itself — but no
      // implementing or review session followed it, since there was nothing
      // to hand either of them.
      expect(provider.requests).toHaveLength(1);
      // The conflict was left alone once the resolution was refused: no
      // merge in progress, nothing staged.
      expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
      // And nothing was written about the owning task, which no session ever
      // dispatched under its own id: a `TaskBlocked` for a task the run
      // never dispatched is an event the fold refuses, which CI caught and
      // these tests had not.
      expect(() => fold(log.read())).not.toThrow();
      expect(log.read().some((event) => event.type === 'TaskBlocked')).toBe(false);
    } finally {
      log.close();
    }
  });
  it('keeps a declaration made in an earlier round, so it need not be retyped', async () => {
    // T4.1.4b: the author declared CONV-1 in round two and the undeclared list
    // went empty; in round three it did not repeat itself, and the gate refused
    // an approved change for a declaration already made and already recorded.
    // A rework session writes a fresh result, so anything it declared before is
    // gone unless it types it again — which is a formality with no information
    // in it.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [] as { convention: string; why: string }[],
    };
    const reports = (verdict: 'approve' | 'request-changes') =>
      scriptedSuccess({
        ref: head,
        verdict,
        summary: verdict === 'approve' ? 'good' : 'not yet',
        findings:
          verdict === 'approve'
            ? []
            : [
                {
                  file: 'README.md',
                  concern: 'no',
                  remedy: 'yes',
                  severity: 'blocker' as const,
                },
              ],
        deviations: [{ convention: 'CONV-1', where: 'the branch' }],
      });

    const provider = new ScriptedProvider([
      // Round one declares it.
      scriptedSuccess({
        ...change,
        deviations: [{ convention: 'CONV-1', why: 'the loop made the commits' }],
      }),
      reports('request-changes'),
      // Round two answers the findings and says nothing about the deviation.
      scriptedSuccess(change),
      reports('approve'),
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
        maxReviewAttempts: 2,
      });

      expect(result.status).toBe('merged');
      // And the log says the declaration was in force for the round that
      // merged, not only for the round that made it.
      const reviewed = log
        .read()
        .filter((event) => event.type === 'ChangeReviewed')
        .at(-1);
      expect(
        (reviewed?.payload as { declaredDeviations: string[] }).declaredDeviations,
      ).toStrictEqual(['CONV-1']);
    } finally {
      log.close();
    }
  });

  it('carries a declaration by its convention, however either round worded it', async () => {
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const change = {
      ref: head,
      summary: 'done',
      files: ['README.md'],
      tests: [],
      complete: true,
      remaining: '',
      deviations: [] as { convention: string; why: string }[],
    };
    const provider = new ScriptedProvider([
      scriptedSuccess({
        ...change,
        deviations: [
          {
            convention: 'CONV-1 (one logical change per commit)',
            why: 'the loop made the commits',
          },
        ],
      }),
      scriptedSuccess({
        ref: head,
        verdict: 'request-changes',
        summary: 'not yet',
        findings: [
          { file: 'README.md', concern: 'no', remedy: 'yes', severity: 'blocker' },
        ],
        deviations: [{ convention: 'CONV-1', where: 'the branch' }],
      }),
      scriptedSuccess(change),
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [
          { convention: 'CONV-1 — one logical change per commit', where: 'x' },
        ],
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
        maxReviewAttempts: 2,
      });

      expect(result.status).toBe('merged');
    } finally {
      log.close();
    }
  });

  /**
   * What the log says about a change nobody refused (T4.3.10).
   *
   * T4.3.3 ended on `TaskBlocked` reading "the review still refuses the change
   * after 4 attempt(s): the change departs from CONV-5", while both of the
   * `ChangeReviewed` events it ended on carried `approved: true`. Eight
   * sessions and $16.84 closed on a sentence no reviewer had said.
   *
   * The bound is not in question and is not reopened here: the grace is once
   * per task, for the reason `loop.ts` already gives. What was wrong is that
   * the out-of-declaration-rounds exit and the genuine-refusal exit left
   * through the same sentence — and that sentence is what the CLI prints, what
   * `TaskBlocked` stores and what an operator reads first.
   *
   * Asserted off the log rather than off the returned result, because the log
   * is what the dashboard and `mpgm status` read back: a result that said the
   * right thing while the log said the old one would be the same defect
   * wearing a better coat.
   */
  describe('a change two reviews approved is not recorded as refused (T4.3.10)', () => {
    it('says it is held for a declaration, and names no refusal', async () => {
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
      const approvingWith = (convention: string) =>
        scriptedSuccess({
          ref: head,
          verdict: 'approve',
          summary: 'good',
          findings: [],
          deviations: [{ convention, where: 'the branch' }],
        });

      // T4.3.3's shape exactly: approve naming one convention, spend the
      // grace declaring it, approve again naming a different one.
      const provider = new ScriptedProvider([
        scriptedSuccess(change),
        approvingWith('CONV-1'),
        scriptedSuccess({
          ...change,
          deviations: [{ convention: 'CONV-1', why: 'stated' }],
        }),
        approvingWith('CONV-5'),
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

        const events = log.read();
        const reviews = events.filter((event) => event.type === 'ChangeReviewed');
        // The premise: nobody refused this change.
        expect(reviews).toHaveLength(2);
        for (const review of reviews) {
          expect((review.payload as { approved: boolean }).approved).toBe(true);
        }

        const blocked = events.filter((event) => event.type === 'TaskBlocked');
        expect(blocked).toHaveLength(1);
        const reason = (blocked[0]?.payload as { reason: string }).reason;
        expect(reason).not.toMatch(/refuses the change/);
        expect(reason).toMatch(/held for want of a declaration/);
        // Names the departure it is waiting on, and what answers it.
        expect(reason).toContain('CONV-5');
        expect(reason).toMatch(/mpgm redirect/);
      } finally {
        log.close();
      }
    });

    it('still says a refusal is a refusal when the reviewer asked for changes', async () => {
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
      const refusing = scriptedSuccess({
        ref: head,
        verdict: 'request-changes',
        summary: 'not yet',
        findings: [
          {
            file: 'README.md',
            line: 1,
            concern: 'the ledger is wrong',
            remedy: 'correct it',
            severity: 'blocker' as const,
          },
        ],
        deviations: [],
      });
      const provider = new ScriptedProvider([
        scriptedSuccess(change),
        refusing,
        scriptedSuccess(change),
        refusing,
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
        // The other half of the split, and deliberately a test that passes
        // against the old code as well: its job is to show the refusal path
        // was not disturbed while the approval path was corrected. The test
        // that carries the change is the one above.
        expect(result.reason).toMatch(/still refuses the change/);
        expect(result.reason).not.toMatch(/held for want of a declaration/);
      } finally {
        log.close();
      }
    });
  });
});
