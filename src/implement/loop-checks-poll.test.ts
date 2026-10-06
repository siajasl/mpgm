import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import type { AgentSessionProvider } from '../agent/session.js';
import { SessionRunner } from '../agent/runner.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import { implementTask } from './loop.js';
import { WorktreeManager } from './worktree.js';
import { ChecksPollError, mergeVerdict, type CheckRun } from './checks.js';

/**
 * T4.3.14: a transport failure while polling CI is retried with backoff
 * (pinned at the `awaitChecks` level in `repair.test.ts`) and, once that
 * retry is exhausted, refused by name rather than ending the run.
 *
 * `options.checks` here plays the part `cli/commands.ts`'s real `checks`
 * callback does in production: it wraps `awaitChecks` around a poll, and
 * `awaitChecks` only ever rejects once its own bounded retry has given up
 * (`ChecksPollError`). What this file pins is that such a rejection reaching
 * `implementTask` becomes a `blocked` result naming the branch and the
 * worktree — the T4.3.9 crash's shape (`GitHubChecksError` escaping through
 * `fetchCheckRuns`, `awaitChecks`, `repairUntilGreen` and `implementTask` to
 * `bin/mpgm.mjs`) — rather than a rejected promise reaching the CLI.
 */

const GREEN: CheckRun[] = [
  { name: 'build', status: 'completed', conclusion: 'success', url: '' },
  { name: 'lint', status: 'completed', conclusion: 'success', url: '' },
  { name: 'typecheck', status: 'completed', conclusion: 'success', url: '' },
  { name: 'test (node 24.x)', status: 'completed', conclusion: 'success', url: '' },
  { name: 'scan', status: 'completed', conclusion: 'success', url: '' },
];

const tempDirs: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-checks-poll-'));
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
      title: 'A task whose CI poll suffers a transient transport failure',
      completionCriteria: ['It is done.'],
      tracesTo: ['NFR-1'],
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

function openLog(): EventLog {
  const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
  log.append({
    runId: 'r',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });
  return log;
}

function implementerResult(ref: string) {
  return scriptedSuccess({
    ref,
    summary: 'done',
    files: ['README.md'],
    tests: [],
    complete: true,
    remaining: '',
    deviations: [],
  });
}

describe('a CI poll that exhausts its retries (T4.3.14, NFR-1, IMP-2)', () => {
  it('becomes a blocked result naming the branch and worktree, not a rejected promise', async () => {
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const provider = new ScriptedProvider([implementerResult(head)]);
    const log = openLog();

    const options = {
      ...baseOptions(repo, provider, log),
      // What `awaitChecks` throws once `cli/commands.ts`'s real `checks`
      // callback has already retried a transport failure with backoff and
      // given up. This is the shape `implementTask` must survive: the
      // promise `options.checks` returns rejects, rather than resolving
      // with a verdict of any kind.
      checks: () =>
        Promise.reject(
          new ChecksPollError(
            6,
            new Error(
              'gh api --paginate --slurp repos/o/r/commits/abc/check-runs failed: ' +
                'net/http: TLS handshake timeout',
            ),
          ),
        ),
    };

    try {
      // Fails against today: nothing between `options.checks` and
      // `implementTask`'s return catches this, so the rejection would
      // propagate out of `implementTask` itself instead of resolving to a
      // `blocked` result.
      const result = await implementTask(options);

      expect(result.status).toBe('blocked');
      expect(result.branch).toBe('mpgm/T1');
      expect(result.worktree.length).toBeGreaterThan(0);
      expect(result.reason).toContain('CI could not be reached');
      expect(result.reason).toContain('TLS handshake timeout');
      // The implementing session ran; nothing after it (review, merge) did.
      expect(provider.requests).toHaveLength(1);
    } finally {
      log.close();
    }
  });

  it('does not treat the retry bound as budget-exhaustion (T4.3.8 is a different guard)', async () => {
    // The escalation/repair-budget guard built for T4.3.2/T4.3.8 does not
    // cover this: a poll that never answers is not a round that ran and was
    // truncated, so the result must not read as `exhausted` repairs either.
    const repo = newRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const provider = new ScriptedProvider([implementerResult(head)]);
    const log = openLog();

    const options = {
      ...baseOptions(repo, provider, log),
      checks: () => Promise.reject(new ChecksPollError(6, new Error('ECONNRESET'))),
    };

    try {
      const result = await implementTask(options);

      expect(result.status).toBe('blocked');
      const budgetEvents = log.read().filter((event) => event.type === 'BudgetExceeded');
      expect(budgetEvents).toHaveLength(0);
    } finally {
      log.close();
    }
  });
});
