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
const checks = (ref) =>
  Promise.resolve(mergeVerdict({ ref, runs: ref === firstRef ? RED : GREEN }));

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
  // The review.
  scriptedSuccess({
    get ref() {
      return secondRef;
    },
    verdict: 'approve',
    summary: 'reads correctly and the new test can fail',
    findings: [],
    deviations: [{ convention: 'CONV-1', where: 'two commits on the branch' }],
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
});

check(
  'the task merged',
  result.status === 'merged',
  result.reason ?? String(result.commit),
);
check(
  'CI was red once and repaired within budget',
  (result.repair?.attempts.length ?? 0) === 1 && result.repair?.status === 'green',
  `${String(result.repair?.attempts.length ?? 0)} repair attempt(s)`,
);
check(
  'the review was by a role other than the author',
  result.review?.reviewerRole === 'code-reviewer',
  result.review?.summary ?? '',
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
