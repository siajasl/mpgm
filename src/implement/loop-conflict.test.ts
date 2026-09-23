import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { scriptedSuccess } from '../agent/scripted-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import { implementTask } from './loop.js';
import { WorktreeManager } from './worktree.js';
import { mergeVerdict, type CheckRun } from './checks.js';

/**
 * T4.3.9: a merge conflict is dispatched to an agent that can resolve it, or
 * refused with the reason it cannot be — not left for an operator to resolve
 * by hand the way T4.3.2's run was.
 *
 * `worktree.ts`'s `catchUp` and `merge.ts`'s `mergeChange` both said, in
 * their own comments, that a conflict "is a task for an agent, not a state
 * for the kernel to sit in", but nothing dispatched one. These tests exercise
 * `implementTask` itself — the only place the gap could be seen, the same
 * reasoning `loop-control.test.ts` and `loop-progress.test.ts` give for doing
 * the same — because a unit test of `catchUp` alone proves conflicts are
 * detected, which was never the missing half.
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

/** A repo whose PLAN.md carries the same two-line header CLAUDE.md requires. */
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-conflict-'));
  tempDirs.push(dir);
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# sample\n');
  writeFileSync(
    join(dir, 'PLAN.md'),
    ['# PLAN', '', '**Status:** v0.21', '**Upstream:** DESIGN v0.35', ''].join('\n'),
  );
  writeFileSync(
    join(dir, 'code.js'),
    ['function greet() {', "  return 'hello';", '}', ''].join('\n'),
  );
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
      title: 'A task whose branch conflicts with the trunk',
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

function openLog(): EventLog {
  const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
  log.append({
    runId: 'r',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });
  return log;
}

/**
 * Diverges `repo` (on `main`) and the `T1` worktree so that catching the
 * branch up to the trunk conflicts in `file`: the branch replaces `from`
 * with `branchTo`, and `main` replaces the same ancestor text with
 * `trunkTo` — each edit made independently of the other, the way two
 * unrelated tasks' changes are.
 */
function conflictOn(
  repo: string,
  worktreePath: string,
  file: string,
  from: string,
  branchTo: string,
  trunkTo: string,
): void {
  const path = join(worktreePath, file);
  const original = readFileSync(path, 'utf8');
  expect(original).toContain(from);
  writeFileSync(path, original.replace(from, branchTo));
  git(worktreePath, ['add', file]);
  git(worktreePath, ['commit', '-m', `the branch changes ${file}`]);

  const trunkPath = join(repo, file);
  const trunkOriginal = readFileSync(trunkPath, 'utf8');
  writeFileSync(trunkPath, trunkOriginal.replace(from, trunkTo));
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', `the trunk changes ${file}`]);
}

/**
 * Resolves the specific PLAN.md header collision honestly — keeping both the
 * trunk's and the branch's edits, the way a real agent asked to (T4.3.9,
 * `conflict.ts`) would. Any other session this provider is asked to run
 * (`implement`, `review`) reports the checkout as already done, since
 * nothing else in these tests needs a further change.
 */
class ResolvesHeaderConflict implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];
  #calls = 0;

  constructor(private readonly worktreePath: string) {}

  run(request: SessionRequest): Promise<SessionResult> {
    this.requests.push(request);
    this.#calls += 1;

    if (this.#calls === 1) {
      expect(request.prompt).toContain('merging it conflicts');
      expect(request.prompt).toContain('DESIGN v0.35');
      writeFileSync(
        join(this.worktreePath, 'PLAN.md'),
        ['# PLAN', '', '**Status:** v0.22', '**Upstream:** DESIGN v0.36', ''].join('\n'),
      );
      git(this.worktreePath, ['add', 'PLAN.md']);
      git(this.worktreePath, ['commit', '--no-edit']);
      const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
      return Promise.resolve(
        scriptedSuccess({
          ref,
          summary: 'kept both the Status and Upstream bumps',
          files: ['PLAN.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
      );
    }

    const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
    return Promise.resolve(
      this.#calls === 2
        ? scriptedSuccess({
            ref,
            summary: 'nothing further to do',
            files: [],
            tests: [],
            complete: true,
            remaining: '',
            deviations: [],
          })
        : scriptedSuccess({
            ref,
            verdict: 'approve',
            summary: 'the merge kept both edits',
            findings: [],
            deviations: [],
          }),
    );
  }
}

/**
 * Refuses honestly, exactly as a real agent is instructed to (`conflict.ts`)
 * when the two sides changed the same thing to different values — a
 * collision no rule in this project can resolve, so it is reported rather
 * than guessed at.
 */
class RefusesCodeConflict implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];

  constructor(private readonly worktreePath: string) {}

  run(request: SessionRequest): Promise<SessionResult> {
    this.requests.push(request);
    const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
    return Promise.resolve(
      scriptedSuccess({
        ref,
        summary: 'left the conflict for a person to decide',
        files: [],
        tests: [],
        complete: false,
        remaining:
          "code.js: both sides changed greet()'s return value to something different; " +
          'there is no rule that says which one wins',
        deviations: [],
      }),
    );
  }
}

/** Whether `worktreePath` is mid-merge — `MERGE_HEAD` set. */
function mergeInProgress(worktreePath: string): boolean {
  try {
    git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

describe('a conflict between a task branch and the trunk (T4.3.9, IMP-1, IMP-4, OBS-1)', () => {
  it('is dispatched to an agent, and both edits survive a header collision', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');
    // The shape T4.3.2 actually hit: the branch and the trunk each change a
    // *different* line of the same document's header — both wanted, neither
    // superseding the other — which git still reports as one conflict
    // because the changed lines sit next to each other.
    const planPath = join(worktree.path, 'PLAN.md');
    writeFileSync(
      planPath,
      readFileSync(planPath, 'utf8').replace(
        '**Upstream:** DESIGN v0.35',
        '**Upstream:** DESIGN v0.36',
      ),
    );
    git(worktree.path, ['add', 'PLAN.md']);
    git(worktree.path, ['commit', '-m', "the branch's own rework bumps DESIGN to v0.36"]);

    const trunkPlanPath = join(repo, 'PLAN.md');
    writeFileSync(
      trunkPlanPath,
      readFileSync(trunkPlanPath, 'utf8').replace(
        '**Status:** v0.21',
        '**Status:** v0.22',
      ),
    );
    git(repo, ['add', 'PLAN.md']);
    git(repo, ['commit', '-m', 'a filing bumps PLAN.md to v0.22']);

    const provider = new ResolvesHeaderConflict(worktree.path);
    const log = openLog();

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('merged');
      expect(provider.requests).toHaveLength(3);

      // The trunk now carries both edits — the whole point: a conflict
      // resolved by keeping both sides is not the same as one resolved by
      // preferring either (IMP-4).
      const merged = readFileSync(join(repo, 'PLAN.md'), 'utf8');
      expect(merged).toContain('**Status:** v0.22');
      expect(merged).toContain('**Upstream:** DESIGN v0.36');
    } finally {
      log.close();
    }
  });

  it('still refuses a collision no rule can resolve — two sides changing one line', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');
    conflictOn(
      repo,
      worktree.path,
      'code.js',
      "  return 'hello';",
      "  return 'hi';",
      "  return 'hey';",
    );

    const provider = new RefusesCodeConflict(worktree.path);
    const log = openLog();

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('code.js');
      expect(result.reason).toContain('conflict');
      // Only the conflict-resolution session ran — the loop never reached the
      // implementing session, because there was nothing to hand it.
      expect(provider.requests).toHaveLength(1);

      // Left clean, the same promise `catchUp` already kept for a conflict
      // nobody attempts to resolve: no merge in progress, nothing staged.
      expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
      expect(mergeInProgress(worktree.path)).toBe(false);
    } finally {
      log.close();
    }

    // Nothing landed on the trunk.
    expect(readFileSync(join(repo, 'code.js'), 'utf8')).toContain("return 'hey'");
  });
});
