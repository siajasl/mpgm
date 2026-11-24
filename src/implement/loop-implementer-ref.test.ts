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
import { mergeVerdict, type CheckRun } from './checks.js';

/**
 * T4.3.26: the loop asked CI about whatever `ref` the implementing session
 * reported, as written — so T4.3.22's implementing session reporting it as
 * `5925262 (branch mpgm/T4.3.22) -- "Let a task retry the merge alone once
 * its last allowed round cleared review"` reached GitHub's check-runs API as
 * that whole string, which answered "No commit found for SHA" (HTTP 422) and
 * was read as CI being unreachable — six retries and a refusal naming the
 * wrong cause, sending the operator to look at CI when CI was never asked.
 *
 * Both tests here drive `implementTask` with an implementing session whose
 * reported `ref` the loop must not simply trust: one with surrounding prose,
 * and one that is a well-formed sha naming a real commit the branch is not
 * on. Each must fail against the unmodified loop — the first by reaching
 * `options.checks` with the prose intact, the second by merging content
 * nobody asked CI about.
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
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-implementer-ref-'));
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

function baseOptions(
  repo: string,
  provider: AgentSessionProvider,
  log: EventLog,
  overrides: { readonly maxValidationAttempts?: number } = {},
) {
  return {
    runId: 'r',
    task: {
      id: 'T1',
      title: 'A task whose implementing session reports an untrustworthy ref',
      completionCriteria: ['It is done.'],
      tracesTo: ['IMP-1', 'IMP-2'],
      milestone: 'M1',
    },
    repo,
    worktrees: new WorktreeManager({ repo }),
    sessions: new SessionRunner({
      log,
      provider,
      schemas: projectOutputSchemas(),
      policyRoot: repo,
      ...(overrides.maxValidationAttempts === undefined
        ? {}
        : { maxValidationAttempts: overrides.maxValidationAttempts }),
    }),
    roles: RoleRegistry.fromDirectory(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles'),
    ),
    log,
    kb: [],
    policy: { maxClass: 'internal' as const, unlabelled: 'internal' as const },
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

describe('a ref the implementing session reported, not read from the worktree (T4.3.26)', () => {
  it('does not reach the CI provider with a ref reported as prose, and does not blame CI for it', async () => {
    const repo = newRepo();
    // T4.3.22's actual implementing session, verbatim.
    const proseRef =
      '5925262 (branch mpgm/T4.3.22) -- "Let a task retry the merge alone once ' +
      'its last allowed round cleared review"';

    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: proseRef,
        summary: 'done',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
    ]);
    const log = openLog();
    let checksCalls = 0;

    try {
      // Fails against today: `changeSchema` accepts any non-empty string, so
      // this reaches `repairUntilGreen`'s `checks(ref)` as `proseRef`
      // exactly, and the real provider (`gh api .../commits/<ref>/check-runs`)
      // would answer "No commit found for SHA" — read here, and on the live
      // run this task was filed from, as CI being unreachable.
      const result = await implementTask({
        ...baseOptions(repo, provider, log, { maxValidationAttempts: 1 }),
        checks: (ref: string) => {
          checksCalls += 1;
          return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
        },
      });

      expect(result.status).toBe('blocked');
      // Never reached the provider with the unplaceable ref — the schema
      // refused it, which is the cheapest place to stop it (CONV-3): one
      // session, no `checks` call at all.
      expect(checksCalls).toBe(0);
      // The wrong cause this task exists to stop reporting: CI was never
      // asked, so the refusal must not say it could not be reached.
      expect(result.reason ?? '').not.toContain('CI could not be reached');
      expect(result.reason ?? '').not.toContain('No commit found');
    } finally {
      log.close();
    }
  });

  it(
    'blocks naming both refs, rather than merging, when the session reports a ' +
      'well-formed sha of a real commit the branch is not on',
    async () => {
      const repo = newRepo();
      // A real commit that exists in the repository but is not an ancestor of
      // the task's branch — well-formed, resolvable, and simply the wrong one.
      git(repo, ['checkout', '-b', 'unrelated']);
      writeFileSync(join(repo, 'elsewhere.txt'), 'not on the task branch\n');
      git(repo, ['add', '--all']);
      git(repo, ['commit', '-m', 'a commit on an unrelated branch']);
      const otherCommit = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['checkout', 'main']);

      const provider = new ScriptedProvider([
        scriptedSuccess({
          ref: otherCommit,
          summary: 'done',
          files: ['README.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
      ]);
      const log = openLog();
      let checksCalls = 0;

      try {
        // Fails against today: `namesCommit`/`reconcileRef` are never applied
        // to the implementer's own ref, so this would be asked of CI (and,
        // worse, merged) exactly as reported — content nobody asked CI about.
        const result = await implementTask({
          ...baseOptions(repo, provider, log),
          checks: (ref: string) => {
            checksCalls += 1;
            return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
          },
        });

        expect(result.status).toBe('blocked');
        // Not quietly substituted: CI is never asked about a ref that cannot
        // be placed on the branch.
        expect(checksCalls).toBe(0);
        expect(result.reason ?? '').toContain(otherCommit);
        // The real tip, named too — not just the claim that was wrong.
        const tip = git(repo, ['rev-parse', 'main']);
        expect(result.reason ?? '').toContain(tip);
      } finally {
        log.close();
      }
    },
  );

  it('still asks CI, and merges, when the session reports a bare full sha of its own commit', async () => {
    // The test this has always passed — pinned so a fix to the above cannot
    // start refusing the ordinary case instead.
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
    let checksCalls = 0;

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        checks: (ref: string) => {
          checksCalls += 1;
          return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
        },
      });

      expect(result.status).toBe('merged');
      expect(checksCalls).toBeGreaterThan(0);
    } finally {
      log.close();
    }
  });
});
