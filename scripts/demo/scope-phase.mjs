/**
 * T2.1.2 verification — the Scope phase on a sample project.
 *
 *   seeded Definition artifact → requirements-analyst derives the requirement
 *   set → three critics review it in parallel, one SCP-3 pathology each →
 *   collector merges → gate packet → operator approval → gated requirement set
 *
 * Makes real model calls. Not part of `npm run check` or CI: CI has no
 * credentials, and a verification that silently skipped itself would be worse
 * than none. Run with `npm run demo:scope`.
 *
 * The Definition is seeded rather than elicited, so this spends on the Scope
 * phase alone — and so the material can be *planted*. It contains a genuine
 * contradiction (an intranet-only system that also notifies members wherever
 * they are). Both halves are stated goals, so both are legitimately derivable
 * as requirements; catching that they cannot both hold is the conflict lens's
 * job, and is what M2.1's verification asks of this phase.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore,
  ClaudeAgentProvider,
  EventLog,
  kernelRegistry,
  openDatabase,
  Projector,
  SnapshotStore,
  projectArtifactSchemas,
  projectOutputSchemas,
  runCli,
} from '../../dist/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

function check(label, condition, detail = '') {
  process.stdout.write(
    `  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) {
    failures.push(label);
  }
}

/** The planted Definition. Two of its goals cannot both be met. */
const DEFINITION = {
  problem:
    'Librarians lose track of who has which book. Loans are written in a paper ' +
    'ledger, and the ledger is the only record.',
  goals: [
    'Record every loan and return so no loan record is ever lost.',
    'Let members see what they have out and when it is due.',
    'Run entirely on the school intranet, with no cloud services and no ' +
      'outbound network access of any kind.',
    'Notify members that a book is due wherever they happen to be, including ' +
      'on their phones away from school.',
  ],
  nonGoals: [
    'Replacing the library catalogue.',
    'Anything to do with purchasing or budgets.',
  ],
  stakeholders: [
    'Librarians, who record loans and chase overdue books.',
    'Members (pupils and staff), who borrow books.',
    'The school IT technician, who maintains the intranet server.',
  ],
  constraints: [
    'The intranet server is a single machine with no redundancy.',
    'The school has no budget for third-party services.',
    'Member records already exist in the school directory and must not be duplicated.',
  ],
  assumptions: [
    'Members can reach the intranet from school-owned devices on site.',
    'The school directory exposes a read-only interface.',
  ],
  successMetrics: [
    'No loan record is lost over a full term.',
    'Members stop emailing the librarian to ask what they have out.',
    'Overdue books are returned sooner than they are today.',
  ],
};

const workspace = mkdtempSync(join(tmpdir(), 'mpgm-t212-'));

try {
  for (const directory of ['roles', 'phases', 'kb']) {
    cpSync(join(projectRoot, directory), join(workspace, directory), { recursive: true });
  }
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm demo'], { cwd: workspace });
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');

  // Seed the Definition the Scope phase reads. Written through the store, so
  // it carries the same frontmatter and provenance a real phase would produce.
  new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() }).write({
    id: 'definition-brief',
    basePath: 'artifacts/definition/brief.md',
    schema: 'definition',
    data: DEFINITION,
    producedBy: {
      task: 'seeded',
      role: 'analyst',
      model: '(seeded)',
      runId: 'r1',
    },
  });

  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '--quiet', '-m', 'Sample project'], { cwd: workspace });

  const lines = [];
  const context = {
    root: workspace,
    provider: new ClaudeAgentProvider(),
    outputSchemas: projectOutputSchemas(),
    artifactSchemas: projectArtifactSchemas(),
    write: (line) => lines.push(line),
  };

  const call = async (argv, { echo = true } = {}) => {
    lines.length = 0;
    const result = await runCli(argv, context);
    const output = lines.join('\n');
    if (echo) {
      process.stdout.write(`${output}\n`);
    }
    return { result, output };
  };

  process.stdout.write('\n1. Scope phase\n');
  const ran = await call(['run', 'scope', '--run', 'r1']);
  check('the phase ran to its gate', ran.result.ok, ran.output);
  check('a gate packet was presented', ran.output.includes('Gate: scope-gate'));
  check('the gate was not auto-approved (HIL-1)', ran.output.includes('Approve with:'));

  const store = new ArtifactStore({
    root: workspace,
    schemas: projectArtifactSchemas(),
  });

  process.stdout.write('\n2. The requirement set (SCP-1, SCP-2)\n');
  const scope = store.read('artifacts/scope/requirements.md').data;
  const requirements = scope.requirements ?? [];
  process.stdout.write(
    `${requirements
      .map(
        (requirement) =>
          `  ${requirement.id} [${requirement.priority}] ${requirement.statement}`,
      )
      .join('\n')}\n`,
  );

  // Reaching this line at all means the artifact validated: the schema cannot
  // express a non-functional requirement without a quantified threshold, nor a
  // requirement without acceptance criteria, nor two requirements sharing an id.
  check(
    'a requirement set exists and validated against its schema',
    requirements.length > 0,
  );

  const nonFunctional = requirements.filter((entry) => entry.kind === 'non-functional');
  check(
    'non-functional requirements were derived and quantified (SCP-1)',
    nonFunctional.length > 0,
    nonFunctional
      .map(
        (entry) =>
          `${entry.id}: ${entry.threshold.metric} ${String(entry.threshold.value)}${entry.threshold.unit}`,
      )
      .join('; '),
  );
  check(
    'every requirement traces to the Definition (ART-2)',
    requirements.every((entry) => entry.tracesTo.length > 0),
  );
  check(
    'the set is prioritised rather than merely listed (SCP-2)',
    new Set(requirements.map((entry) => entry.priority)).size > 1,
    [...new Set(requirements.map((entry) => entry.priority))].join(', '),
  );
  check(
    'the scope boundary is explicit (SCP-2)',
    (scope.outOfScope ?? []).length > 0,
    (scope.outOfScope ?? []).map((entry) => entry.item).join('; '),
  );

  process.stdout.write('\n3. The SCP-3 review\n');
  const db = openDatabase(join(workspace, '.mpgm', 'state.db'));
  let dispatched = [];
  try {
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    const projector = new Projector({
      log,
      snapshots: SnapshotStore.attach(db),
      interval: 50,
    });
    dispatched = Object.keys(projector.project().runs.r1?.tasks ?? {});
  } finally {
    db.close();
  }

  check(
    'the fan-out dispatched one critic per SCP-3 lens, plus a collector',
    [
      'flag-issues-worker-1',
      'flag-issues-worker-2',
      'flag-issues-worker-3',
      'flag-issues-collect',
    ].every((id) => dispatched.includes(id)),
    dispatched.join(', '),
  );

  const findings = store.read('artifacts/scope/findings.md').data;
  process.stdout.write(
    `${(findings.findings ?? [])
      .map((entry) => `  [${entry.status}] ${entry.about}: ${entry.issue}`)
      .join('\n')}\n`,
  );

  const reviewText = JSON.stringify(findings).toLowerCase();
  const namesIsolation = /intranet|offline|no outbound|air.?gap|on.?site/.test(
    reviewText,
  );
  const namesNotification = /notif|push|sms|email|off.?site|away from school/.test(
    reviewText,
  );
  check(
    'the planted conflict was found (SCP-3)',
    (findings.findings ?? []).length > 0 && namesIsolation && namesNotification,
    'the review must name both halves of the contradiction, however it classifies it',
  );

  process.stdout.write('\n4. Gate and approval\n');
  const approved = await call([
    'approve',
    'scope-gate',
    '--run',
    'r1',
    '--by',
    'demo-operator',
    '--tag',
  ]);
  check(
    'the decision is recorded',
    approved.output.includes('approved by demo-operator'),
  );

  const second = await call(['run', 'scope', '--run', 'r1'], { echo: false });
  check(
    'the gated requirement set is frozen against re-derivation',
    !second.result.ok && second.output.includes('already approved'),
    second.output.split('\n')[0] ?? '',
  );

  process.stdout.write('\n5. Status\n');
  await call(['status', '--run', 'r1']);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT2.1.2 verification passed\n\n'
    : `\nT2.1.2 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
