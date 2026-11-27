import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import type { AgentSessionProvider, SessionResult } from '../agent/session.js';
import { SessionRunner } from '../agent/runner.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import { implementTask } from './loop.js';
import { WorktreeManager } from './worktree.js';
import { ChecksPollError, mergeVerdict, type CheckRun } from './checks.js';

/**
 * T4.3.26: the loop asked CI about whatever `ref` the implementing session
 * reported, as written — so T4.3.22's implementing session reporting it as
 * `5925262 (branch mpgm/T4.3.22) -- "Let a task retry the merge alone once
 * its last allowed round cleared review"` reached GitHub's check-runs API as
 * that whole string, which answered "No commit found for SHA" (HTTP 422) and
 * was read as CI being unreachable — six retries and a refusal naming the
 * wrong cause, sending the operator to look at CI when CI was never asked.
 *
 * The first two tests drive `implementTask` with an implementing session
 * whose reported `ref` the loop must not simply trust: one with surrounding
 * prose, and one that is a well-formed sha naming a real commit the branch is
 * not on. Each must fail against the unmodified loop — the first by reaching
 * `options.checks` with the prose intact, the second by merging content
 * nobody asked CI about.
 *
 * The last two are the same question asked of the *second* poll of a round,
 * where the ref is a repair attempt's rather than the implementing session's:
 * once CI is asked again after every repair, a round has more than one author
 * of refs, and a guard that assumes the implementing session is the only one
 * misnames the cause and strands the repair budget (review finding).
 */

const GREEN: CheckRun[] = [
  { name: 'build', status: 'completed', conclusion: 'success', url: '' },
  { name: 'lint', status: 'completed', conclusion: 'success', url: '' },
  { name: 'typecheck', status: 'completed', conclusion: 'success', url: '' },
  { name: 'test (node 24.x)', status: 'completed', conclusion: 'success', url: '' },
  { name: 'scan', status: 'completed', conclusion: 'success', url: '' },
];

const RED: CheckRun[] = [
  { name: 'build', status: 'completed', conclusion: 'failure', url: '' },
  { name: 'lint', status: 'completed', conclusion: 'success', url: '' },
  { name: 'typecheck', status: 'completed', conclusion: 'success', url: '' },
  { name: 'test (node 24.x)', status: 'completed', conclusion: 'success', url: '' },
  { name: 'scan', status: 'completed', conclusion: 'success', url: '' },
];

const tempDirs: string[] = [];

/**
 * A provider that runs a side effect before answering.
 *
 * `ScriptedProvider` cannot touch the worktree, and the case the post-repair
 * poll turns on is a session that *committed* and then produced unusable
 * output — so the tip moves while no claim about it exists. That needs the
 * commit to happen at the moment the session runs, between one `checks` call
 * and the next.
 */
class EffectfulProvider implements AgentSessionProvider {
  readonly #steps: { readonly effect?: () => void; readonly result: SessionResult }[];

  constructor(
    steps: readonly { readonly effect?: () => void; readonly result: SessionResult }[],
  ) {
    this.#steps = [...steps];
  }

  run(): Promise<SessionResult> {
    const next = this.#steps.shift();
    if (next === undefined) {
      throw new Error('EffectfulProvider ran out of steps');
    }
    next.effect?.();
    return Promise.resolve(next.result);
  }
}

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
      // Scripted so that a version of `changeSchema` with the regex removed
      // does not crash this test on an exhausted `ScriptedProvider` once the
      // prose ref stops being refused at the session boundary — a review
      // round is the very next thing the loop would dispatch, and without a
      // scripted answer for it the test fails on "ran out of scripted
      // results" rather than on the assertions below, which is not a failure
      // this test was designed to report (review finding).
      scriptedSuccess({
        ref: proseRef,
        verdict: 'approve',
        summary: 'looked fine',
        findings: [],
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
      // Not merely "not the wrong cause" — the right one, named well enough
      // to fix without reading this file (CONV-3). `SessionRunner` already
      // has this detail in `lastIssues`; the refusal must actually carry it
      // rather than only the attempt count.
      expect(result.reason ?? '').toContain(
        'ref: must be a commit object name (7-40 hex characters), not prose about one',
      );
      // The two direct regression guards for the misdiagnosis this task is
      // named after — a positive assertion on the schema message does not by
      // itself exclude a reason that *also* blames CI (review finding).
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
        // Scripted so that a loop with `checksAgainstWorktreeTip` removed
        // does not crash this test on an exhausted `ScriptedProvider` once
        // the wrong-sha ref stops being refused — a review round is the very
        // next thing the loop would dispatch, and without a scripted answer
        // for it the test fails on "ran out of scripted results" rather than
        // on the assertions below, which is not a failure this test was
        // designed to report (review finding).
        scriptedSuccess({
          ref: otherCommit,
          verdict: 'approve',
          summary: 'looked fine',
          findings: [],
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
        // This is not a build failure and CI was never asked about it — the
        // refusal must not read as CI being unreachable (review finding).
        expect(result.reason ?? '').not.toContain('CI could not be reached');
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

  it(
    'asks CI about the worktree tip after a repair session commits and then ' +
      'produces no usable output, spending the budget rather than aborting ' +
      '— and publishes that tip before polling it',
    async () => {
      // The second `checks` call, where the ref is not a session's claim at
      // all but whatever the loop carried forward after a repair produced
      // nothing usable. Carrying the *previous* ref there names an ancestor
      // of the branch once the repair has committed, which the tip guard
      // refuses — aborting the task on the implementing session's own
      // correct commit and abandoning the repair budget the loop documents
      // as still shrinking (review finding, T4.3.26).
      //
      // This path never called `options.publish` before T4.3.26's rework —
      // only the usable-output arm did — so the tip it carried forward could
      // be a commit the real CI provider had never seen, which answers a
      // check-runs lookup 422, which `awaitChecks` retries and reports as CI
      // being unreachable: the exact misdiagnosis this task exists to
      // remove, reopened through the one path that skipped the push (review
      // finding). `checks` below rejects any ref `publish` has not already
      // recorded, the same way the real provider would answer for a sha it
      // has never seen, so polling an unpushed commit fails this test
      // instead of passing it quietly.
      const repo = newRepo();
      const worktrees = new WorktreeManager({ repo });
      const implemented = git(repo, ['rev-parse', 'HEAD']);
      let repairCommit = '';

      const provider = new EffectfulProvider([
        {
          result: scriptedSuccess({
            ref: implemented,
            summary: 'done',
            files: ['README.md'],
            tests: [],
            complete: true,
            remaining: '',
            deviations: [],
          }),
        },
        {
          // The repair session commits — then fails validation, which since
          // this task is exactly what reporting a ref as prose does.
          effect: () => {
            const path = worktrees.pathFor('T1');
            writeFileSync(join(path, 'fix.txt'), 'an attempted fix\n');
            git(path, ['add', '--all']);
            git(path, ['commit', '-m', 'an attempted fix']);
            repairCommit = git(path, ['rev-parse', 'HEAD']);
          },
          result: scriptedSuccess({
            ref: 'the commit I just made -- "an attempted fix"',
            summary: 'tried',
            files: ['fix.txt'],
            tests: [],
            complete: true,
            remaining: '',
            deviations: [],
          }),
        },
      ]);
      const log = openLog();
      const asked: string[] = [];
      const published: { branch: string; ref: string }[] = [];
      const pushedRefs = new Set<string>();

      try {
        const result = await implementTask({
          ...baseOptions(repo, provider, log, { maxValidationAttempts: 1 }),
          worktrees,
          maxRepairAttempts: 1,
          publish: (branch: string, ref: string) => {
            published.push({ branch, ref });
            pushedRefs.add(ref);
            return Promise.resolve();
          },
          checks: (ref: string) => {
            asked.push(ref);
            if (!pushedRefs.has(ref)) {
              // What the real provider wrapper (`awaitChecks` over
              // `fetchCheckRuns`) does once GitHub has answered "No commit
              // found for SHA" enough times in a row to give up — the shape
              // this test's own `checks` arrives in once an unpushed ref
              // reaches production's provider.
              throw new ChecksPollError(6, new Error(`No commit found for SHA: ${ref}`));
            }
            return Promise.resolve(mergeVerdict({ ref, runs: RED }));
          },
        });

        // Two polls: the implementing commit, then the commit the repair
        // session actually left behind — read from git, since no usable
        // output claimed it. Neither poll reached `checks` for an unpushed
        // ref, because `published` already recorded it by the time the poll
        // ran.
        expect(asked).toEqual([implemented, repairCommit]);
        expect(published.map((p) => p.ref)).toContain(repairCommit);
        // The budget was spent on a verdict, not abandoned by a refusal
        // naming the wrong session, and not misread as CI being unreachable.
        expect(result.status).toBe('blocked');
        expect(result.reason ?? '').toContain('retry budget of 1 attempts exhausted');
        expect(result.reason ?? '').not.toContain('refusing to ask CI about');
        expect(result.reason ?? '').not.toContain('CI could not be reached');
      } finally {
        log.close();
      }
    },
  );

  it('names the repair session, not the implementing one, when a repair reports a ref the branch is not on', async () => {
    const repo = newRepo();
    const worktrees = new WorktreeManager({ repo });
    const implemented = git(repo, ['rev-parse', 'HEAD']);
    // Well-formed, resolvable, and simply not on the task's branch.
    git(repo, ['checkout', '-b', 'unrelated']);
    writeFileSync(join(repo, 'elsewhere.txt'), 'not on the task branch\n');
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-m', 'a commit on an unrelated branch']);
    const otherCommit = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);

    const provider = new ScriptedProvider([
      scriptedSuccess({
        ref: implemented,
        summary: 'done',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
      scriptedSuccess({
        ref: otherCommit,
        summary: 'tried',
        files: ['README.md'],
        tests: [],
        complete: true,
        remaining: '',
        deviations: [],
      }),
    ]);
    const log = openLog();
    const asked: string[] = [];

    try {
      const result = await implementTask({
        ...baseOptions(repo, provider, log),
        worktrees,
        maxRepairAttempts: 1,
        checks: (ref: string) => {
          asked.push(ref);
          return Promise.resolve(mergeVerdict({ ref, runs: RED }));
        },
      });

      expect(result.status).toBe('blocked');
      // CI was asked only about the implementing commit; the repair's claim
      // never reached it.
      expect(asked).toEqual([implemented]);
      // Whose claim it was. A refusal that says "the implementing session"
      // here sends an operator to a commit the branch really is on, which is
      // a wrong diagnosis in an error that stops work (CONV-3).
      expect(result.reason ?? '').toContain("repair attempt 1's output");
      expect(result.reason ?? '').not.toContain('implementing session');
      expect(result.reason ?? '').toContain(otherCommit);
      expect(result.reason ?? '').toContain(implemented);
    } finally {
      log.close();
    }
  });

  it(
    'names the rework session, not the implementing one, when round 2 ' +
      "reports a ref the branch is not on — round 1's commit really is on it",
    async () => {
      // `polled` used to be set only at declaration and inside the repair
      // callback, never per round, so the first poll of round 2+ was given
      // the rework session's ref (`ref: latest.ref`) while the refusal still
      // blamed "the implementing session's output" — a commit the branch
      // really is on (review finding, T4.3.26).
      const repo = newRepo();
      const worktrees = new WorktreeManager({ repo });
      const implemented = git(repo, ['rev-parse', 'HEAD']);
      // Well-formed, resolvable, and simply not on the task's branch — the
      // rework session's claim, not the implementing session's.
      git(repo, ['checkout', '-b', 'unrelated']);
      writeFileSync(join(repo, 'elsewhere.txt'), 'not on the task branch\n');
      git(repo, ['add', '--all']);
      git(repo, ['commit', '-m', 'a commit on an unrelated branch']);
      const otherCommit = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['checkout', 'main']);

      const provider = new ScriptedProvider([
        // Round 1's implementing session: the real head, which CI passes.
        scriptedSuccess({
          ref: implemented,
          summary: 'done',
          files: ['README.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
        // Round 1's review asks for changes.
        scriptedSuccess({
          ref: implemented,
          verdict: 'request-changes',
          summary: 'not yet',
          findings: [
            {
              file: 'README.md',
              concern: 'no',
              remedy: 'yes',
              severity: 'major' as const,
            },
          ],
          deviations: [],
        }),
        // Round 1's rework reports a commit the branch is not on — it never
        // actually committed it to the worktree, so git's tip stays at
        // `implemented`.
        scriptedSuccess({
          ref: otherCommit,
          summary: 'tried',
          files: ['README.md'],
          tests: [],
          complete: true,
          remaining: '',
          deviations: [],
        }),
      ]);
      const log = openLog();
      const asked: string[] = [];

      try {
        const result = await implementTask({
          ...baseOptions(repo, provider, log),
          worktrees,
          checks: (ref: string) => {
            asked.push(ref);
            return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
          },
        });

        expect(result.status).toBe('blocked');
        // Round 2's poll never reached CI: the ref could not be placed.
        expect(asked).toEqual([implemented]);
        // Whose claim it was. A refusal that says "the implementing session"
        // sends an operator to round 1's commit, which the branch really is
        // on — the wrong diagnosis in an error that stops work (CONV-3).
        expect(result.reason ?? '').toContain("round 1's rework output");
        expect(result.reason ?? '').not.toContain('the implementing session');
        expect(result.reason ?? '').toContain(otherCommit);
        expect(result.reason ?? '').toContain(implemented);
      } finally {
        log.close();
      }
    },
  );

  it(
    'says the commit could not be read, rather than naming a tip it never ' +
      'had, when the worktree is gone before CI can be asked',
    async () => {
      // The other half of `UnplacedRefError` (`commit-ref.ts`): every test
      // above exercises the mismatch arm, where `worktrees.head` reads a
      // real tip that simply disagrees with the reported ref. This is the
      // `tip === undefined` arm — the worktree vanishing between the
      // implementing session returning and `checksAgainstWorktreeTip`
      // reading it, the same aftermath a hard kill leaves (DESIGN §6) —
      // which had no test and no case that could reach it.
      const repo = newRepo();
      const worktrees = new WorktreeManager({ repo });
      const implemented = git(repo, ['rev-parse', 'HEAD']);

      const provider = new EffectfulProvider([
        {
          effect: () => {
            rmSync(worktrees.pathFor('T1'), { recursive: true, force: true });
          },
          result: scriptedSuccess({
            ref: implemented,
            summary: 'done',
            files: ['README.md'],
            tests: [],
            complete: true,
            remaining: '',
            deviations: [],
          }),
        },
      ]);
      const log = openLog();
      let checksCalls = 0;

      try {
        const result = await implementTask({
          ...baseOptions(repo, provider, log),
          worktrees,
          checks: (ref: string) => {
            checksCalls += 1;
            return Promise.resolve(mergeVerdict({ ref, runs: GREEN }));
          },
        });

        expect(result.status).toBe('blocked');
        // CI is never asked about a tip that could not be read — asking
        // would be a guess, and this is not a build failure to retry.
        expect(checksCalls).toBe(0);
        expect(result.reason ?? '').toContain(
          "could not read the commit 'mpgm/T1' is on, so nothing can be " +
            'checked against it',
        );
        expect(result.reason ?? '').not.toContain('CI could not be reached');
      } finally {
        log.close();
      }
    },
  );
});
