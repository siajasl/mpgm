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
      // Pins `catchUp`'s `-c merge.conflictStyle=diff3`: without it the
      // conflict markers carry only the two sides, not the common ancestor
      // between the `<<<<<<<` and `=======` markers, and this assertion
      // fails (CONV-6 — verified by removing that option and re-running,
      // which this test alone caught).
      expect(request.prompt).toContain('|||||||');
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
 * Walks away from the conflict with `git merge --abort` rather than
 * finishing it, and claims success anyway — the shape the reviewer of this
 * task's first attempt measured: `MERGE_HEAD` clears exactly the same way a
 * real `git commit` clears it, so a caller trusting that alone cannot tell
 * this from `ResolvesHeaderConflict` above.
 */
class AbortsAndClaimsSuccess implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];
  #calls = 0;

  constructor(private readonly worktreePath: string) {}

  run(request: SessionRequest): Promise<SessionResult> {
    this.requests.push(request);
    this.#calls += 1;

    if (this.#calls === 1) {
      git(this.worktreePath, ['merge', '--abort']);
      const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
      return Promise.resolve(
        scriptedSuccess({
          ref,
          summary: 'resolved it',
          files: ['PLAN.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
      );
    }

    // Reached only if the loop wrongly treats the abort above as a finished
    // resolution and carries on to an implementing or review session — the
    // shape this test's assertions refuse before any of this can run.
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
            summary: 'looked fine',
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

/**
 * Resolves a header conflict at the *trunk* side rather than the branch
 * side: the implementing session makes the branch's own genuine change, the
 * review session then simulates a filing landing on the trunk while review
 * was "in flight" (the window `merge.ts`'s own doc names, T4.3.9), and the
 * conflict-resolution session — dispatched under `${task.id}-catchup-2`,
 * not `-catchup` — reconciles it after review has already approved, the
 * same way `ResolvesHeaderConflict` reconciles one before review ever runs.
 */
class ResolvesTrunkSideConflict implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];
  #calls = 0;

  constructor(
    private readonly worktreePath: string,
    private readonly repo: string,
  ) {}

  run(request: SessionRequest): Promise<SessionResult> {
    this.requests.push(request);
    this.#calls += 1;

    if (this.#calls === 1) {
      // The implementing session: the branch's own genuine change.
      const path = join(this.worktreePath, 'PLAN.md');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '**Upstream:** DESIGN v0.35',
          '**Upstream:** DESIGN v0.36',
        ),
      );
      git(this.worktreePath, ['add', 'PLAN.md']);
      git(this.worktreePath, [
        'commit',
        '-m',
        "the branch's own rework bumps DESIGN to v0.36",
      ]);
      const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
      return Promise.resolve(
        scriptedSuccess({
          ref,
          summary: 'bumped DESIGN to v0.36',
          files: ['PLAN.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
      );
    }

    if (this.#calls === 2) {
      // The review session — while it runs, a filing lands directly on the
      // trunk. Two filings landed on `main` during T4.3.2's own life, so the
      // window is not narrow (`conflict.ts`).
      const trunkPlanPath = join(this.repo, 'PLAN.md');
      writeFileSync(
        trunkPlanPath,
        readFileSync(trunkPlanPath, 'utf8').replace(
          '**Status:** v0.21',
          '**Status:** v0.22',
        ),
      );
      git(this.repo, ['add', 'PLAN.md']);
      git(this.repo, ['commit', '-m', 'a filing bumps PLAN.md to v0.22']);

      const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
      return Promise.resolve(
        scriptedSuccess({
          ref,
          verdict: 'approve',
          summary: 'the DESIGN bump looks right',
          findings: [],
          deviations: [],
        }),
      );
    }

    // The trunk-side conflict-resolution session, dispatched under
    // `${task.id}-catchup-2` only after `mergeChange` itself conflicted.
    expect(request.prompt).toContain('merging it conflicts');
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
        summary: 'kept both edits at the trunk side, after review',
        files: ['PLAN.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
    );
  }
}

/**
 * The trunk-side counterpart of `RefusesCodeConflict`: the filing that lands
 * while review is in flight collides with the branch on actual code, not a
 * document header, and the resolver refuses honestly rather than guess.
 */
class RefusesTrunkSideCodeConflict implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];
  #calls = 0;

  constructor(
    private readonly worktreePath: string,
    private readonly repo: string,
  ) {}

  run(request: SessionRequest): Promise<SessionResult> {
    this.requests.push(request);
    this.#calls += 1;

    if (this.#calls === 1) {
      const path = join(this.worktreePath, 'code.js');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace("return 'hello';", "return 'hi';"),
      );
      git(this.worktreePath, ['add', 'code.js']);
      git(this.worktreePath, ['commit', '-m', "the branch's own change"]);
      const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
      return Promise.resolve(
        scriptedSuccess({
          ref,
          summary: "changed greet()'s return value",
          files: ['code.js'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
      );
    }

    if (this.#calls === 2) {
      const path = join(this.repo, 'code.js');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace("return 'hello';", "return 'hey';"),
      );
      git(this.repo, ['add', 'code.js']);
      git(this.repo, ['commit', '-m', 'a filing that also changes greet()']);

      const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
      return Promise.resolve(
        scriptedSuccess({
          ref,
          verdict: 'approve',
          summary: 'looks right',
          findings: [],
          deviations: [],
        }),
      );
    }

    const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
    return Promise.resolve(
      scriptedSuccess({
        ref,
        summary: 'left the conflict for a person to decide',
        files: [],
        tests: [],
        complete: false,
        remaining:
          "code.js: both sides changed greet()'s return value to something " +
          'different; there is no rule that says which one wins',
        deviations: [],
      }),
    );
  }
}

/**
 * Stages a conflict's resolution but never runs `git commit` — the most
 * likely real resolver mistake, and the one the reviewer of this task's
 * first attempt asked to be pinned: `MERGE_HEAD` stays set, and nothing here
 * treats a resolver's claimed success as one while a merge is still open.
 */
class StagesButDoesNotCommit implements AgentSessionProvider {
  readonly requests: SessionRequest[] = [];

  constructor(private readonly worktreePath: string) {}

  run(request: SessionRequest): Promise<SessionResult> {
    this.requests.push(request);
    writeFileSync(
      join(this.worktreePath, 'PLAN.md'),
      ['# PLAN', '', '**Status:** v0.22', '**Upstream:** DESIGN v0.36', ''].join('\n'),
    );
    git(this.worktreePath, ['add', 'PLAN.md']);
    // Deliberately no `git commit` — `MERGE_HEAD` is left set.
    const ref = git(this.worktreePath, ['rev-parse', 'HEAD']);
    return Promise.resolve(
      scriptedSuccess({
        ref,
        summary: 'resolved it',
        files: ['PLAN.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
    );
  }
}

/**
 * Simulates an operator pausing a run in the exact window `catchUpAndResolve`
 * (`implement/loop.ts`) cannot observe through `track`'s own guard: after
 * `catchUp` has found a conflict and left it in place, before any resolver
 * has been dispatched for it. Appends `OperatorIntervened` the instant the
 * real `catchUp` reports `'conflicted'`, rather than needing a session to
 * return first — nothing has been dispatched yet for this to hook on.
 */
class PausesOnceConflicted extends WorktreeManager {
  constructor(
    repo: string,
    private readonly log: EventLog,
  ) {
    super({ repo });
  }

  override async catchUp(
    taskId: string,
    into: string,
    options?: { readonly leaveConflicted?: boolean },
  ): ReturnType<WorktreeManager['catchUp']> {
    const result = await super.catchUp(taskId, into, options);
    if (result.status === 'conflicted') {
      this.log.append({
        runId: 'r',
        type: 'OperatorIntervened',
        payload: { action: 'pause', detail: '' },
      });
    }
    return result;
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

  // The reviewer of this task's first attempt: a scripted resolver that runs
  // `git merge --abort` and reports `complete: true` anyway made
  // `implementTask` accept the resolution, spend the implementing and review
  // sessions and the CI wait, and only then fail deep inside `mergeChange`
  // with a raw "Command failed: git merge --no-ff" — worse than the refusal
  // this task exists to replace, on exactly the failure mode (a resolver
  // that does not resolve) this check is here to catch. `MERGE_HEAD` clears
  // on `git merge --abort` exactly as it does on `git commit`
  // (`mergeInProgress`'s own doc), so this pins the check that looks past
  // it: the branch has to actually carry `into` afterwards, not merely have
  // no merge left open.
  it('refuses a resolver that reports success but aborted the merge instead of finishing it', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');
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

    const branchTipBefore = git(worktree.path, ['rev-parse', 'HEAD']);
    const provider = new AbortsAndClaimsSuccess(worktree.path);
    const log = openLog();

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      // Only the conflict-resolution session ran — never the implementing
      // session, the review, or CI. A resolver that walked away from the
      // conflict is caught before any of the wasted spend this task exists
      // to close, not after it.
      expect(provider.requests).toHaveLength(1);
      expect(result.reason).toContain('does not carry');
      expect(result.reason).toContain("'main'");

      // Left clean: the abort already ran inside the resolver, and nothing
      // here tries to finish or redo the merge.
      expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
      expect(mergeInProgress(worktree.path)).toBe(false);
      // The branch is exactly where it was before the resolver ran — no
      // silent partial merge, no lost commit.
      expect(git(worktree.path, ['rev-parse', 'HEAD'])).toBe(branchTipBefore);
    } finally {
      log.close();
    }

    // Nothing landed on the trunk: the trunk's own filing commit is still
    // its tip, and the branch's DESIGN bump never reached it.
    const trunkPlan = readFileSync(join(repo, 'PLAN.md'), 'utf8');
    expect(trunkPlan).toContain('**Status:** v0.22');
    expect(trunkPlan).not.toContain('**Upstream:** DESIGN v0.36');
  });

  // The review that found this task's second attempt incomplete: `merge.ts`'s
  // own conflict, hit at the very end of the loop after a filing lands on the
  // trunk while review is in flight, is the second site the task names and
  // was left throwing a raw `MergeError` out of `implementTask` uncaught.
  it('is dispatched to an agent when the trunk-side merge conflicts after review, and both edits survive', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');

    const provider = new ResolvesTrunkSideConflict(worktree.path, repo);
    const log = openLog();

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('merged');
      // implement, review, and the trunk-side resolver — never a second
      // implementing or review round.
      expect(provider.requests).toHaveLength(3);
      const dispatchedTaskIds = log
        .read()
        .filter((event) => event.type === 'TaskDispatched')
        .map((event) => (event.payload as { taskId: string }).taskId);
      expect(dispatchedTaskIds).toEqual(['T1', 'T1-review', 'T1-catchup-2']);

      const merged = readFileSync(join(repo, 'PLAN.md'), 'utf8');
      expect(merged).toContain('**Status:** v0.22');
      expect(merged).toContain('**Upstream:** DESIGN v0.36');
    } finally {
      log.close();
    }
  });

  // The review found the trunk-side retry landing the resolver's commit on
  // `checks-not-green`-equivalent verdicts a fresh `verdict.ref`/`request.ref`
  // agreement can no longer catch: with the request left stale, CI was never
  // asked about the reconciliation at all, only about the tip it replaced.
  // This pins that `options.checks` is asked again about the reconciled
  // commit specifically, and a red answer refuses the merge rather than
  // riding in on the review's now-stale green.
  it('refuses to merge a trunk-side reconciliation that CI does not clear, and leaves the trunk untouched', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');

    const provider = new ResolvesTrunkSideConflict(worktree.path, repo);
    const log = openLog();
    // Green for the first ask (the implementer's own commit, checked before
    // review), red for every ask after — which is exactly one more: the
    // reconciled commit the trunk-side resolver produces. Unmodified code
    // never asks `checks` a second time at all, so this call count is itself
    // part of what the test pins.
    let checksCalls = 0;
    const options = {
      ...baseOptions(repo, provider, log),
      checks: (ref: string) => {
        checksCalls += 1;
        return Promise.resolve(
          mergeVerdict({
            ref,
            runs:
              checksCalls === 1
                ? GREEN
                : [
                    {
                      name: 'build',
                      status: 'completed',
                      conclusion: 'failure',
                      url: '',
                    },
                    ...GREEN.slice(1),
                  ],
          }),
        );
      },
    };

    try {
      const result = await implementTask(options);

      expect(result.status).toBe('blocked');
      expect(result.reason ?? '').toContain('CI');
      expect(checksCalls).toBe(2);
    } finally {
      log.close();
    }

    // Nothing landed on the trunk: the reconciliation was never merged.
    const trunkPlan = readFileSync(join(repo, 'PLAN.md'), 'utf8');
    expect(trunkPlan).not.toContain('**Upstream:** DESIGN v0.36');
  });

  it('still refuses a trunk-side collision no rule can resolve, after review has already approved', async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');

    const provider = new RefusesTrunkSideCodeConflict(worktree.path, repo);
    const log = openLog();

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('code.js');
      expect(result.reason).toContain('conflict');
      expect(provider.requests).toHaveLength(3);

      // Left clean: nothing here tries to finish or redo the merge.
      expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
      expect(mergeInProgress(worktree.path)).toBe(false);
    } finally {
      log.close();
    }

    // Nothing landed on the trunk beyond the filing's own commit.
    expect(readFileSync(join(repo, 'code.js'), 'utf8')).toContain("return 'hey'");
  });

  // The reviewer of this task's second attempt: neither of these two
  // refusals had a test, and both are plausible in a real run — a resolver
  // that edits and stages the conflicted files but never commits is the most
  // likely mistake of all, and an operator can pause or kill a run in the
  // instant between `catchUp` leaving a conflict in place and a resolver
  // being dispatched for it.
  it("a resolver that stages but never commits leaves 'MERGE_HEAD' set, and is refused rather than trusted", async () => {
    const repo = newRepo();
    const manager = new WorktreeManager({ repo });
    const worktree = await manager.acquire('T1');
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

    const branchTipBefore = git(worktree.path, ['rev-parse', 'HEAD']);
    const provider = new StagesButDoesNotCommit(worktree.path);
    const log = openLog();

    try {
      const result = await implementTask(baseOptions(repo, provider, log));

      expect(result.status).toBe('blocked');
      expect(provider.requests).toHaveLength(1);
      expect(result.reason).toContain('MERGE_HEAD');
      expect(result.reason).toContain('still set');

      // The resolver's own `git add` is undone along with the abandoned
      // merge — left clean, not half-staged.
      expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
      expect(mergeInProgress(worktree.path)).toBe(false);
      expect(git(worktree.path, ['rev-parse', 'HEAD'])).toBe(branchTipBefore);
    } finally {
      log.close();
    }
  });

  it('refuses a conflict rather than dispatching one, once an operator pauses the run before an agent can be asked', async () => {
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

    // Never actually called: the pause is recorded before any resolver could
    // be dispatched, so this provider must not be reached.
    const provider = new RefusesCodeConflict(worktree.path);
    const log = openLog();

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees: new PausesOnceConflicted(repo, log),
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('conflicts');
      expect(result.reason).toContain('paused');
      expect(result.reason).toContain('before an agent could be dispatched');
      expect(provider.requests).toHaveLength(0);

      // Left clean: the conflict `catchUp` found was aborted, not handed to
      // anything, once the pause was seen.
      expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
      expect(mergeInProgress(worktree.path)).toBe(false);
    } finally {
      log.close();
    }
  });
});
