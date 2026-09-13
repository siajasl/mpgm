import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
} from '../agent/session.js';
import { SessionRunner } from '../agent/runner.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import { fold } from '../state/reduce.js';
import { implementTask } from './loop.js';
import { WorktreeManager } from './worktree.js';
import { mergeVerdict, type CheckRun } from './checks.js';

/**
 * T4.2.4: an operator's pause, kill or redirect reaches a running task.
 *
 * `mpgm pause|resume|kill|redirect` already recorded `OperatorIntervened`
 * (T1.3.6), but the implement loop read none of the three — a redirection's
 * note went into the log and nowhere else, and pausing or killing a run left
 * `mpgm implement` dispatching sessions exactly as if nothing had happened.
 * These tests exercise `implementTask` itself, the same way
 * `loop-progress.test.ts` does, because that is the only place the gap could
 * be seen: a unit test of the CLI verb alone proves the event is recorded,
 * which is precisely what shipped inert (PLAN T1.3.6, T4.2.4).
 */

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

const tempDirs: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-control-'));
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

function baseOptions(repo: string, provider: AgentSessionProvider, log: EventLog) {
  return {
    runId: 'r',
    task: {
      id: 'T1',
      title: 'A task an operator may pause, kill or redirect',
      completionCriteria: ['It is done.'],
      tracesTo: ['HIL-3'],
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

/**
 * Replays scripted results like {@link ScriptedProvider}, but appends an
 * `OperatorIntervened` to `log` the instant one particular call *returns* —
 * simulating an operator's kill landing while that session was in flight, in
 * the window between it finishing and whatever the loop does next. Used to
 * reach the one gap `track`'s own check cannot: the interval after the final
 * review has returned and before `mergeChange` runs, where nothing else in
 * `implementTask` reads `runControl` again (T4.2.4).
 */
class KillAsCallReturns implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];
  #results: SessionResult[];
  #calls = 0;

  constructor(
    private readonly log: EventLog,
    private readonly killAfterCall: number,
    results: readonly SessionResult[],
  ) {
    this.#results = [...results];
  }

  run(request: SessionRequest): Promise<SessionResult> {
    this.#calls += 1;
    this.requests.push(request);
    const next = this.#results.shift();
    if (next === undefined) {
      throw new Error('KillAsCallReturns ran out of scripted results');
    }
    if (this.#calls === this.killAfterCall) {
      this.log.append({
        runId: 'r',
        type: 'OperatorIntervened',
        payload: { action: 'kill', detail: '' },
      });
    }
    return Promise.resolve(next);
  }
}

function openLog(): EventLog {
  const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
  log.append({
    runId: 'r',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });
  return log;
}

describe("an operator's control reaches a running task (HIL-3, HIL-5, T4.2.4)", () => {
  it('kill recorded before the task starts stops it before any session runs', async () => {
    const repo = newRepo();
    const provider = new ScriptedProvider([]);
    const log = openLog();
    log.append({
      runId: 'r',
      type: 'OperatorIntervened',
      payload: { action: 'kill', detail: '' },
    });

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('killed');
      // Not "ran and failed" — never dispatched at all, which is the
      // difference between a control that is read and one that is not.
      expect(provider.requests).toHaveLength(0);
      // The regression this task's first review found: a `TaskBlocked`
      // appended for a task that never got a `TaskDispatched` makes every
      // later fold of this run's log throw, which means `status`, `serve`,
      // `replay` and even a later `implement` on the same run all break from
      // here on. Folding the log is the only way to see that — the two
      // fields above passed against the broken code just as they do here.
      expect(() => fold(log.read())).not.toThrow();
    } finally {
      log.close();
    }
  });

  it('pause recorded before the task starts stops it the same way kill does', async () => {
    const repo = newRepo();
    const provider = new ScriptedProvider([]);
    const log = openLog();
    log.append({
      runId: 'r',
      type: 'OperatorIntervened',
      payload: { action: 'pause', detail: '' },
    });

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('paused');
      expect(provider.requests).toHaveLength(0);
      expect(() => fold(log.read())).not.toThrow();
    } finally {
      log.close();
    }
  });

  it('kill recorded mid-task stops the loop before its next session, not just its next task', async () => {
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
      // A review session scripted here would prove the kill was not read:
      // if the loop dispatched it, ScriptedProvider would consume it and
      // the task would go on to merge instead of stopping.
      scriptedSuccess({
        ref: head,
        verdict: 'approve',
        summary: 'good',
        findings: [],
        deviations: [],
      }),
    ]);

    const log = openLog();

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        // Simulates an operator killing the run while CI is being asked
        // about the implementing session's change — the loop's `checks`
        // callback is the first thing that runs after that session returns.
        checks: (ref) => {
          log.append({
            runId: 'r',
            type: 'OperatorIntervened',
            payload: { action: 'kill', detail: '' },
          });
          return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
        },
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('killed');
      // The implementing session ran; the review the kill should have
      // pre-empted did not.
      expect(provider.requests).toHaveLength(1);
    } finally {
      log.close();
    }
  });

  it('kill recorded while CI is red stops the repair loop instead of spending its budget', async () => {
    // `repairUntilGreen` only calls back into a session when CI is red, so
    // this is the path `track`'s own check cannot reach on its own: without
    // `repair.ts`'s `shouldContinue`, the loop would keep asking `checks`
    // with nothing changed until the repair budget looked exhausted, and
    // report a CI failure that was never the real cause (T4.2.4, CONV-3).
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
      // A repair session scripted here would prove the kill was not read in
      // time: if the loop dispatched it, ScriptedProvider would consume it.
      scriptedSuccess({
        ref: head,
        summary: 'fixed',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
    ]);

    const log = openLog();
    let checksCalled = 0;

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxRepairAttempts: 3,
        checks: (ref) => {
          checksCalled += 1;
          // The kill arrives once CI has already reported red, so the
          // budget check sees a real failure before it sees the stop.
          log.append({
            runId: 'r',
            type: 'OperatorIntervened',
            payload: { action: 'kill', detail: '' },
          });
          return Promise.resolve(mergeVerdict({ ref, runs: RED }));
        },
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('the run was killed by an operator');
      expect(result.reason).not.toContain('CI did not go green');
      expect(result.reason).not.toContain('exhausted');
      // Read once, to diagnose the failure — never asked again to check
      // whether an unfixed change turned green on its own.
      expect(checksCalled).toBe(1);
      // No repair session dispatched: the budget was never spent.
      expect(provider.requests).toHaveLength(1);
    } finally {
      log.close();
    }
  });

  it("a redirection naming this task is obeyed by the task's next session", async () => {
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

    const log = openLog();
    log.append({
      runId: 'r',
      type: 'OperatorIntervened',
      payload: { action: 'redirect', detail: 'focus on overdue fees', taskId: 'T1' },
    });

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('merged');
      expect(provider.requests[0]?.prompt).toContain('focus on overdue fees');
    } finally {
      log.close();
    }
  });

  it('a redirection naming a different task is not obeyed by this one', async () => {
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

    const log = openLog();
    log.append({
      runId: 'r',
      type: 'OperatorIntervened',
      payload: { action: 'redirect', detail: 'a note for someone else', taskId: 'T9' },
    });

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('merged');
      expect(provider.requests[0]?.prompt).not.toContain('a note for someone else');
    } finally {
      log.close();
    }
  });

  it('a redirection recorded while the task is in flight is obeyed by the review session that follows', async () => {
    // The review session for T1 dispatches under `T1-review`, not `T1` — the
    // regression this task's first review found: looking the note up under
    // the session's own id, rather than the plan task's, meant a redirect
    // landing after the implementing session and before the review reached
    // nothing at all, and the change merged as if the operator had said
    // nothing.
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

    const log = openLog();

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        // The window PLAN M4.2's verification names: a redirection issued
        // while a task is in flight, before its next (here, review) session
        // has been dispatched.
        checks: (ref) => {
          log.append({
            runId: 'r',
            type: 'OperatorIntervened',
            payload: {
              action: 'redirect',
              detail: 'reject anything that raises the late fee',
              taskId: 'T1',
            },
          });
          return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
        },
      });

      expect(result.status).toBe('merged');
      // Not the implementing session's prompt — that was already sent
      // before the redirect was recorded. The review's is.
      expect(provider.requests[1]?.prompt).toContain(
        'reject anything that raises the late fee',
      );
    } finally {
      log.close();
    }
  });

  it('a redirection reaches a blocked task when the operator requeues it by running implement again', async () => {
    // DESIGN §4.4 glosses `redirect <task>` as "revise a task's
    // instructions/context and requeue". This harness has no scheduler that
    // pulls a blocked plan task back into work on its own — `mpgm implement
    // <task>` is what does that, named, every time, whether the task has
    // been dispatched before or not — so "requeues it" is exercised here the
    // way an operator actually does it: run the task through the loop once
    // to blocked, redirect it, then call `implementTask` again for the same
    // task and run and show its very first session reads the note.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const log = openLog();

    const firstAttempt = new ScriptedProvider([
      scriptedSuccess({
        ref: head,
        summary: 'first attempt',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        ref: head,
        verdict: 'request-changes',
        summary: 'not yet',
        findings: [
          {
            file: 'README.md',
            concern: 'not good enough',
            remedy: 'fix it',
            severity: 'major',
          },
        ],
        deviations: [],
      }),
    ]);

    try {
      const blocked = await implementTask({
        ...baseOptions(repo, firstAttempt, log),
        // One attempt: the review's refusal exhausts the budget and blocks
        // the task without the run itself being paused or killed, which is
        // the ordinary way a plan task ends up needing a redirect.
        maxReviewAttempts: 1,
      });

      expect(blocked.status).toBe('blocked');

      log.append({
        runId: 'r',
        type: 'OperatorIntervened',
        payload: {
          action: 'redirect',
          detail: 'drop the fee waiver, keep the rest',
          taskId: 'T1',
        },
      });

      const secondAttempt = new ScriptedProvider([
        scriptedSuccess({
          ref: head,
          summary: 'second attempt',
          files: ['README.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
        scriptedSuccess({
          ref: head,
          verdict: 'approve',
          summary: 'good now',
          findings: [],
          deviations: [],
        }),
      ]);

      const requeued = await implementTask(baseOptions(repo, secondAttempt, log));

      expect(requeued.status).toBe('merged');
      expect(secondAttempt.requests[0]?.prompt).toContain(
        'drop the fee waiver, keep the rest',
      );
    } finally {
      log.close();
    }
  });

  it('kill recorded as the final review session returns stops the merge, not just the sessions before it', async () => {
    // The gap `track`'s dispatch guard cannot reach: once the review session
    // has returned an approval, nothing between `decideMerge` and
    // `mergeChange` reads `runControl` again. Without a check placed there
    // too, this kill — recorded the instant the review call returns, strictly
    // after `track` last looked — would never be seen, and the task would
    // merge to the trunk with the operator having already killed the run.
    const repo = newRepo();
    const trunkBefore = git(repo, ['rev-parse', 'main']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const log = openLog();
    const provider = new KillAsCallReturns(log, 2, [
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

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('the run was killed by an operator');
      // The irreversible act itself did not happen: the trunk is exactly
      // where it was before this task ever ran.
      expect(git(repo, ['rev-parse', 'main'])).toBe(trunkBefore);
    } finally {
      log.close();
    }
  });
});
