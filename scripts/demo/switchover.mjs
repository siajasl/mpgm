/**
 * T3.1.8 verification — mpgm dispatches and merges its first self-task.
 *
 * Offline and part of `npm run check`. The live milestone verification runs
 * the same function against real sessions and real CI; what is established
 * here is the wiring, which is the part that can be wrong in a way no model
 * call would reveal.
 *
 * Everything except the sessions and CI is real: the plan artifact, the plan
 * ingestion, the role freeze, the worktree manager, the repair loop, the merge
 * gate and git itself.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore,
  assertRolesFrozen,
  DEFAULT_EGRESS_POLICY,
  EventLog,
  fold,
  implementTask,
  ingestPlan,
  kernelRegistry,
  loadKnowledgeBase,
  loadRoleFreeze,
  MEMORY,
  mergeVerdict,
  projectArtifactSchemas,
  projectOutputSchemas,
  readyTasks,
  RoleRegistry,
  ScriptedProvider,
  scriptedSuccess,
  SessionRunner,
  WorktreeManager,
} from '../../dist/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];
const temporary = [];

function check(label, condition, detail = '') {
  process.stdout.write(
    `  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) {
    failures.push(label);
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

process.stdout.write('\n1. The role freeze holds (PLAN section 1)\n');

const freeze = loadRoleFreeze(join(projectRoot, 'roles', 'freeze.json'));
let drift;
try {
  drift = assertRolesFrozen(freeze, join(projectRoot, 'roles'));
  check(
    'every role matches its frozen digest, or carries an exemption',
    true,
    `${String(Object.keys(freeze.digests).length)} roles`,
  );
} catch (error) {
  check(
    'every role matches its frozen digest, or carries an exemption',
    false,
    String(error),
  );
}
check(
  'the freeze covers the roles the implement loop needs',
  freeze.digests.implementer !== undefined &&
    freeze.digests['code-reviewer'] !== undefined,
);
if (drift !== undefined) {
  for (const entry of drift) {
    process.stdout.write(`  note  ${entry.detail} (exempt: ${String(entry.exempt)})\n`);
  }
}

process.stdout.write('\n2. mpgm reads its own plan and picks a task\n');

const store = new ArtifactStore({
  root: projectRoot,
  schemas: projectArtifactSchemas(),
});
const plan = store.read('artifacts/plan/plan.md').data;
const graph = ingestPlan(plan);
const ready = readyTasks(graph, new Set());
const task = ready[0];

check(
  'the plan artifact ingests as a task graph',
  graph.tasks.length > 0,
  `${String(graph.tasks.length)} tasks across ${String(graph.milestones.length)} milestones`,
);
check(
  'at least one task is ready to dispatch',
  task !== undefined,
  task === undefined ? '' : `${task.id} — ${task.title}`,
);

if (task === undefined) {
  process.stdout.write('\nT3.1.8 verification FAILED\n\n');
  process.exit(1);
}

process.stdout.write('\n3. The task runs in its own worktree, is reviewed, and merges\n');

// A repository standing in for the project. The worktree manager, the merge
// and the trailers are the real ones; only the sessions and CI are scripted.
const repo = mkdtempSync(join(tmpdir(), 'mpgm-switchover-'));
temporary.push(repo);
git(repo, ['init', '--initial-branch=main', '--quiet']);
git(repo, ['config', 'user.email', 'switchover@example.com']);
git(repo, ['config', 'user.name', 'mpgm switchover']);
writeFileSync(join(repo, 'README.md'), '# subject project\n');
git(repo, ['add', '--all']);
git(repo, ['commit', '--quiet', '-m', 'initial']);

const worktrees = new WorktreeManager({ repo });
const acquired = await worktrees.acquire(task.id);

/** The implementing agent commits, so the ref it reports is a real one. */
function commitWork(fileName, body) {
  writeFileSync(join(acquired.path, fileName), body);
  git(acquired.path, ['add', '--all']);
  git(acquired.path, ['commit', '--quiet', '-m', `work for ${task.id}`]);
  return git(acquired.path, ['rev-parse', 'HEAD']);
}

const firstRef = commitWork('first.txt', 'a change that does not build\n');

// CI: red for the first commit, green for whatever comes after. That exercises
// the repair loop rather than asserting it exists.
const GREEN = ['build', 'lint', 'typecheck', 'test', 'scan'].map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  url: '',
}));
const RED = GREEN.map((run) =>
  run.name === 'test' ? { ...run, conclusion: 'failure' } : run,
);

let secondRef;
let thirdRef;
const checked = [];
const checks = (ref) => {
  checked.push(ref);
  return Promise.resolve(mergeVerdict({ ref, runs: ref === firstRef ? RED : GREEN }));
};

// Every branch the loop asks about, and how many times it asked. A repository
// whose CI runs on pull requests reports nothing at all for a bare pushed
// branch, so opening the PR is what makes the checks the loop waits for exist.
const pullRequests = [];
const openPullRequest = ({ branch, into, task: planTask }) => {
  const existing = pullRequests.find((entry) => entry.branch === branch);
  if (existing !== undefined) {
    return Promise.resolve(existing.number);
  }
  const opened = { branch, into, task: planTask.id, number: 100 + pullRequests.length };
  pullRequests.push(opened);
  return Promise.resolve(opened.number);
};

const provider = new ScriptedProvider([
  // The first attempt.
  scriptedSuccess({
    ref: firstRef,
    summary: 'first attempt at the task',
    files: ['first.txt'],
    tests: [],
    complete: true,
    remaining: '',
    deviations: [],
  }),
  // The repair, after CI came back red.
  scriptedSuccess({
    get ref() {
      secondRef ??= commitWork('second.txt', 'the fix\n');
      return secondRef;
    },
    summary: 'fixed the failing test',
    files: ['first.txt', 'second.txt'],
    tests: ['second.test.ts'],
    complete: true,
    remaining: '',
    deviations: [
      { convention: 'CONV-1', why: 'two commits, because the first was repaired' },
    ],
  }),
  // The first review: a convention the change broke and never declared. The
  // merge gate refuses on that whatever the verdict says (IMP-4).
  scriptedSuccess({
    get ref() {
      return secondRef;
    },
    verdict: 'request-changes',
    summary: 'the new test passes against the unmodified code',
    findings: [
      {
        file: 'second.test.ts',
        line: 4,
        concern: 'the assertion holds whether or not the fix is present',
        remedy: 'assert on the behaviour the fix introduces',
        severity: 'blocker',
      },
    ],
    deviations: [
      { convention: 'CONV-1', where: 'two commits on the branch' },
      { convention: 'CONV-6', where: 'second.test.ts cannot fail' },
    ],
  }),
  // The rework, after the findings went back to the author.
  scriptedSuccess({
    get ref() {
      thirdRef ??= commitWork('third.txt', 'a test that can fail\n');
      return thirdRef;
    },
    summary: 'made the new test able to fail',
    files: ['first.txt', 'second.txt', 'third.txt'],
    tests: ['second.test.ts'],
    complete: true,
    remaining: '',
    deviations: [
      { convention: 'CONV-1', why: 'three commits, because the first was repaired' },
    ],
  }),
  // The second review, of the reworked change.
  scriptedSuccess({
    get ref() {
      return thirdRef;
    },
    verdict: 'approve',
    summary: 'the test now fails against the unmodified code',
    findings: [],
    deviations: [{ convention: 'CONV-1', where: 'three commits on the branch' }],
  }),
]);

const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
log.append({
  runId: 'switchover',
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'macg' },
});

const result = await implementTask({
  runId: 'switchover',
  task,
  repo,
  worktrees,
  sessions: new SessionRunner({
    log,
    provider,
    schemas: projectOutputSchemas(),
  }),
  roles: RoleRegistry.fromDirectory(join(projectRoot, 'roles')),
  log,
  kb: loadKnowledgeBase(join(projectRoot, 'kb')),
  policy: DEFAULT_EGRESS_POLICY,
  checks,
  openPullRequest,
});

check(
  'the task merged',
  result.status === 'merged',
  result.reason ?? String(result.commit),
);
check(
  'CI was red once and repaired within budget',
  (result.rounds?.[0]?.repair.attempts.length ?? 0) === 1 &&
    result.rounds?.[0]?.repair.status === 'green',
  `${String(result.rounds?.[0]?.repair.attempts.length ?? 0)} repair attempt(s) in round 1`,
);
check(
  'a refused review went back to its author, and the change merged on the second',
  result.rounds?.length === 2 &&
    result.rounds[0]?.review.approved === false &&
    result.rounds[1]?.review.approved === true,
  `${String(result.rounds?.length ?? 0)} review round(s)`,
);
check(
  'the rework was reviewed again, by a task of its own',
  result.rounds?.[0]?.review.reviewTaskId !== result.rounds?.[1]?.review.reviewTaskId,
  `${String(result.rounds?.[0]?.review.reviewTaskId)} then ${String(result.rounds?.[1]?.review.reviewTaskId)}`,
);
check(
  'and the reworked commit cleared CI in its own right',
  checked.includes(result.ref) && result.ref === result.rounds?.[1]?.repair.ref,
  `merged ${String(result.ref).slice(0, 12)}`,
);
check(
  'the review was by a role other than the author',
  result.review?.reviewerRole === 'code-reviewer',
  result.review?.summary ?? '',
);
check(
  'a pull request was opened for the task, targeting the trunk',
  pullRequests.length === 1 &&
    pullRequests[0]?.branch === `mpgm/${task.id}` &&
    pullRequests[0]?.into === 'main',
  pullRequests.length === 0
    ? 'none was opened'
    : `#${String(pullRequests[0]?.number)} ${String(pullRequests[0]?.branch)} -> ${String(pullRequests[0]?.into)}`,
);
check(
  'and only one, though the repair pushed the branch a second time',
  result.pullRequest === pullRequests[0]?.number,
  `result reports #${String(result.pullRequest)}`,
);

process.stdout.write('\n4. The trunk and the log say what happened\n');

const subject = git(repo, ['log', '-1', '--pretty=%s']);
const body = git(repo, ['log', '-1', '--pretty=%b']);
check('the trunk carries a merge commit', subject.startsWith('Merge mpgm/'), subject);
check(
  'trailered with the task, so the trace index picks it up (ADR-4)',
  body.includes(`Closes-Task: ${task.id}`),
);
check('and with who reviewed it', body.includes('Reviewed-By: code-reviewer'), '');
check(
  'the branch was cleaned up now that it is merged',
  git(repo, ['branch', '--list', acquired.branch]) === '',
);

const state = fold(log.read()).runs.switchover;
const merged = state?.tasks[task.id]?.merged;
check(
  'the log records the merge and what authorised it',
  merged?.into === 'main',
  merged?.commit ?? '',
);
check(
  'and records the review, with the deviation both sides declared',
  state?.tasks[task.id]?.review?.approved === true &&
    (state?.tasks[task.id]?.review?.undeclaredDeviations.length ?? 1) === 0,
);
check(
  'the reviewing session is a task of its own in the log',
  state?.tasks[`${task.id}-review`]?.role === 'code-reviewer',
);

log.close();
for (const directory of temporary) {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT3.1.8 verification passed\n\n'
    : `\nT3.1.8 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
