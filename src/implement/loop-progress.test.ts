import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { SessionRunner } from '../agent/runner.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import { implementTask } from './loop.js';
import type { SessionProgress } from './progress.js';
import { WorktreeManager } from './worktree.js';
import { mergeVerdict, type CheckRun } from './checks.js';

/**
 * T4.2.3: a long-running verb reports each session as it starts and
 * finishes, on the terminal that started it, before the run ends (OBS-3,
 * NFR-2).
 *
 * `implementTask` is where every session `mpgm implement` dispatches is
 * actually run, so this is where the gap the operator hit lived: a task runs
 * 20-40 minutes and nothing printed between dispatch and the final line.
 * These tests exercise `onProgress` directly, which is what a unit test of
 * `progress.ts` alone cannot see — whether the loop calls it at all, in what
 * order, and before the run has finished rather than only once it has.
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
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-progress-'));
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

function baseOptions(repo: string, provider: ScriptedProvider, log: EventLog) {
  return {
    runId: 'r',
    task: {
      id: 'T1',
      title: 'A task whose sessions are reported as they run',
      completionCriteria: ['It is done.'],
      tracesTo: ['OBS-3'],
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

describe('progress reported as sessions start and finish (OBS-3, NFR-2)', () => {
  it('reports the implement and review sessions of a change that merges first time', async () => {
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

    const seen: SessionProgress[] = [];
    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        onProgress: (event) => {
          seen.push(event);
        },
      });

      expect(result.status).toBe('merged');

      // Reported in order, and each finish paired with the start before it —
      // an operator reading the terminal top to bottom sees a session begin
      // and then sees it end, never the other way round.
      expect(seen.map((event) => `${event.phase}:${event.kind}`)).toStrictEqual([
        'start:implement',
        'finish:implement',
        'start:review',
        'finish:review',
      ]);

      const [implementStart, implementFinish, reviewStart, reviewFinish] = seen;
      expect(implementStart).toMatchObject({
        taskId: 'T1',
        role: 'implementer',
        round: 1,
      });
      expect(implementFinish).toMatchObject({ outcome: 'completed' });
      expect(reviewStart).toMatchObject({
        taskId: 'T1-review',
        role: 'code-reviewer',
        round: 1,
      });
      expect(reviewFinish).toMatchObject({ outcome: 'completed' });
    } finally {
      log.close();
    }
  });

  it('reports the finish of a session before the loop moves on to the next one', async () => {
    // The criterion this task exists for: reported *as it happens*, not only
    // recoverable from the final result. Asserted by having the reporter
    // itself observe the loop is not yet done — a spy that only recorded
    // events could not tell a progress report delivered mid-run from one
    // batched at the end.
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

    let sawImplementFinishBeforeReturn = false;
    let running = true;
    try {
      const promise = implementTask({
        ...baseOptions(repo, provider, log),
        onProgress: (event) => {
          if (event.phase === 'finish' && event.kind === 'implement') {
            sawImplementFinishBeforeReturn = running;
          }
        },
      });
      const result = await promise;
      running = false;

      expect(result.status).toBe('merged');
      expect(sawImplementFinishBeforeReturn).toBe(true);
    } finally {
      log.close();
    }
  });

  it('reports repair and rework rounds by the kind the loop dispatched, not just by role', async () => {
    // `repair` and `rework` both dispatch the implementer role — the kind is
    // what tells an operator which stage of the loop is running.
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
      scriptedSuccess(change),
      scriptedSuccess({
        ref: head,
        verdict: 'request-changes',
        summary: 'not yet',
        findings: [
          {
            file: 'README.md',
            concern: 'no',
            remedy: 'yes',
            severity: 'blocker' as const,
          },
        ],
        deviations: [],
      }),
      scriptedSuccess(change),
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

    const seen: SessionProgress[] = [];
    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        maxReviewAttempts: 2,
        onProgress: (event) => {
          seen.push(event);
        },
      });

      expect(result.status).toBe('merged');
      expect(
        seen.map((event) => `${event.phase}:${event.kind}:${String(event.round)}`),
      ).toStrictEqual([
        'start:implement:1',
        'finish:implement:1',
        'start:review:1',
        'finish:review:1',
        'start:rework:1',
        'finish:rework:1',
        'start:review:2',
        'finish:review:2',
      ]);
    } finally {
      log.close();
    }
  });
});
