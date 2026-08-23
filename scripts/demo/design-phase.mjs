/**
 * T2.1.3a verification — the Design phase on a sample project.
 *
 *   seeded requirement set → three proposers argue three stances in parallel →
 *   a comparer puts them side by side → a three-judge panel votes and the
 *   *kernel* counts → an architect turns the winner into the design of record
 *   with ADRs → gate packet
 *
 * Makes real model calls (eight sessions). Not part of `npm run check` or CI:
 * CI has no credentials, and a verification that silently skipped itself would
 * be worse than none. Run with `npm run demo:design`.
 *
 * The requirement set is seeded so this spends on the Design phase alone, and
 * so its requirement ids are known here — which lets the demo check something
 * the schema cannot: that the design traces to requirements that actually
 * exist, rather than to plausible-looking ids (DSG-4).
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

const SCOPE = {
  summary:
    'Requirements for a school library loan tracker, derived from the gated ' +
    'Definition. The intranet-only constraint was resolved in favour of the ' +
    'constraint: notifications are in-app rather than off-site.',
  requirements: [
    {
      kind: 'functional',
      id: 'LOAN-1',
      statement: 'A librarian records a loan of a book to a member.',
      rationale: 'The Definition goal "record every loan and return".',
      priority: 'must',
      acceptanceCriteria: [
        'Recording a loan makes it visible to the member immediately.',
        'A loan cannot be recorded against an unknown member.',
      ],
      tracesTo: ['goal: record every loan and return'],
    },
    {
      kind: 'functional',
      id: 'LOAN-2',
      statement: 'A librarian records the return of a loaned book.',
      rationale: 'The same Definition goal; a loan with no return is half a record.',
      priority: 'must',
      acceptanceCriteria: ['A returned book stops appearing on the member view.'],
      tracesTo: ['goal: record every loan and return'],
    },
    {
      kind: 'functional',
      id: 'LOAN-3',
      statement: 'A member sees what they currently have out and when it is due.',
      rationale: 'The Definition goal "let members see what they have out".',
      priority: 'must',
      acceptanceCriteria: ['The member view lists every open loan with its due date.'],
      tracesTo: ['goal: let members see what they have out'],
    },
    {
      kind: 'functional',
      id: 'LOAN-4',
      statement: 'A member is notified in the application when a loan is due.',
      rationale:
        'The notification goal, narrowed to what the intranet-only constraint ' +
        'permits: off-site delivery would require outbound network access.',
      priority: 'should',
      acceptanceCriteria: ['An overdue loan is flagged on the member view.'],
      tracesTo: ['goal: notify members a book is due', 'constraint: intranet only'],
    },
    {
      kind: 'functional',
      id: 'LOAN-5',
      statement: 'Member identity comes from the school directory, not a local copy.',
      rationale: 'The Definition constraint against duplicating member records.',
      priority: 'must',
      acceptanceCriteria: ['No member record is created by this system.'],
      tracesTo: ['constraint: member records already exist'],
    },
    {
      kind: 'non-functional',
      id: 'NFR-1',
      statement: 'No loan record is lost, including across an unclean shutdown.',
      rationale: 'The Definition success metric "no loan record lost over a term".',
      priority: 'must',
      acceptanceCriteria: ['A recorded loan survives a power failure mid-write.'],
      tracesTo: ['success metric: no loan record lost'],
      threshold: {
        metric: 'loan records lost per term',
        value: 0,
        unit: 'records',
        measuredBy: 'kill -9 during a write, then compare against the audit log',
      },
    },
    {
      kind: 'non-functional',
      id: 'NFR-2',
      statement: 'Recording a loan is fast enough not to slow the issue desk.',
      rationale: 'Librarians record loans with a queue in front of them.',
      priority: 'should',
      acceptanceCriteria: ['p95 stays within the threshold at the desk load below.'],
      tracesTo: ['stakeholder: librarians'],
      threshold: {
        metric: 'p95 loan-recording latency',
        value: 500,
        unit: 'ms',
        measuredBy: '20 loans/minute sustained for 10 minutes on the intranet server',
      },
    },
    {
      kind: 'non-functional',
      id: 'NFR-3',
      statement: 'The system runs on the existing single intranet machine.',
      rationale: 'The Definition constraint: one machine, no budget, no cloud.',
      priority: 'must',
      acceptanceCriteria: [
        'It runs within the stated footprint with no external service.',
      ],
      tracesTo: ['constraint: single machine, no cloud'],
      threshold: {
        metric: 'resident memory under normal load',
        value: 512,
        unit: 'MB',
        measuredBy: 'peak RSS during the NFR-2 load test',
      },
    },
  ],
  outOfScope: [
    { item: 'Replacing the library catalogue.', why: 'A stated non-goal.' },
    { item: 'Purchasing and budgets.', why: 'A stated non-goal.' },
    {
      item: 'Off-site notification by email or SMS.',
      why: 'Requires outbound network access, which the intranet-only constraint forbids.',
    },
  ],
};

const requirementIds = new Set(SCOPE.requirements.map((entry) => entry.id));
const workspace = mkdtempSync(join(tmpdir(), 'mpgm-t213a-'));

try {
  for (const directory of ['roles', 'phases', 'kb']) {
    cpSync(join(projectRoot, directory), join(workspace, directory), { recursive: true });
  }
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm demo'], { cwd: workspace });
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');

  new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() }).write({
    id: 'requirement-set',
    basePath: 'artifacts/scope/requirements.md',
    schema: 'scope',
    data: SCOPE,
    producedBy: {
      task: 'seeded',
      role: 'requirements-analyst',
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

  process.stdout.write('\n1. Design phase\n');
  const ran = await call(['run', 'design', '--run', 'r1']);
  check('the phase ran to its gate', ran.result.ok, ran.output);
  check('a gate packet was presented', ran.output.includes('Gate: design-gate'));
  check('the gate was not auto-approved (HIL-1)', ran.output.includes('Approve with:'));

  const store = new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() });

  process.stdout.write('\n2. Candidates (DSG-1)\n');
  const candidateSet = store.read('artifacts/design/candidates.md').data;
  const candidates = candidateSet.candidates ?? [];
  for (const candidate of candidates) {
    process.stdout.write(`  [${candidate.stance}] ${candidate.name}\n`);
    process.stdout.write(`      ${candidate.summary}\n`);
  }

  check(
    'at least two candidates were generated (DSG-1)',
    candidates.length >= 2,
    `${String(candidates.length)} candidates`,
  );
  check(
    'they are genuinely different, not one idea described three times',
    new Set(candidates.map((entry) => entry.stance)).size === candidates.length,
  );
  check(
    'every candidate states what it costs, not only what it buys',
    candidates.every((entry) => entry.tradeOffs.length > 0),
  );

  process.stdout.write('\n3. The panel (ORC-4)\n');
  const db = openDatabase(join(workspace, '.mpgm', 'state.db'));
  let dispatched = [];
  let tallies = [];
  let votes = {};
  try {
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    const projector = new Projector({
      log,
      snapshots: SnapshotStore.attach(db),
      interval: 50,
    });
    const state = projector.project().runs.r1;
    dispatched = Object.keys(state?.tasks ?? {});
    votes = state?.votes ?? {};
    tallies = log.read({ type: 'VoteTallied' });
  } finally {
    db.close();
  }

  check(
    'three judges voted independently',
    [
      'select-candidate-judge-1',
      'select-candidate-judge-2',
      'select-candidate-judge-3',
    ].every((id) => dispatched.includes(id)),
    dispatched.join(', '),
  );
  check(
    'the tally cost no model call',
    !dispatched.includes('select-candidate-tally'),
    'a tally is arithmetic; a dispatched task would mean an agent counted the votes',
  );
  check(
    'the count is in the log, so the decision replays (ORC-3)',
    tallies.length === 1 && tallies[0].payload.rule === 'plurality',
    tallies[0] ? tallies[0].payload.summary : '(no VoteTallied event)',
  );

  const tally = votes['select-candidate-tally'];
  process.stdout.write(`  ${tally ? tally.summary : '(no tally in folded state)'}\n`);
  check(
    'the panel reached a decision rather than tying',
    tally?.carried === true,
    'a tie here is a real outcome, and would mean the candidates need work',
  );

  process.stdout.write('\n4. The design of record (DSG-1, DSG-2, DSG-4)\n');
  const design = store.read('artifacts/design/design.md').data;
  process.stdout.write(`  chosen: ${design.chosen}\n`);
  for (const adr of design.adrs ?? []) {
    process.stdout.write(`  ${adr.id}: ${adr.title}\n`);
  }

  // Recomputed from the logged ballots rather than parsed out of the tally's
  // prose: this is the same arithmetic the kernel did, done independently.
  const counts = {};
  for (const ballot of tallies[0]?.payload.ballots ?? []) {
    if (typeof ballot.value === 'string') {
      counts[ballot.value] = (counts[ballot.value] ?? 0) + 1;
    }
  }
  const best = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((option) => counts[option] === best);
  const winner = best > 0 && leaders.length === 1 ? leaders[0] : null;

  check(
    'the design implements the candidate the panel chose',
    winner !== null && design.chosen === winner,
    winner === null
      ? 'the panel did not produce a single winner, so there was nothing to implement'
      : `design says ${design.chosen}; the ballots say ${winner}`,
  );
  check(
    'ADRs were produced with the alternatives that lost',
    (design.adrs ?? []).length > 0 &&
      design.adrs.every((adr) => adr.alternatives.length > 0),
    `${String((design.adrs ?? []).length)} ADR(s)`,
  );

  // The schema requires every element to trace *somewhere*; only the demo
  // knows which requirement ids actually exist, so only the demo can catch a
  // trace to a plausible-looking id that was never in the Scope artifact.
  const traced = [
    ...design.components,
    ...design.interfaces,
    ...design.technologies,
    ...design.crossCutting,
    ...design.adrs,
  ].flatMap((element) => element.tracesTo);
  const invented = [...new Set(traced.filter((id) => !requirementIds.has(id)))];

  check(
    'every design element traces to a requirement that exists (DSG-4)',
    invented.length === 0,
    invented.length === 0
      ? `${String(traced.length)} traces`
      : `invented: ${invented.join(', ')}`,
  );
  check(
    'the design addresses every cross-cutting concern DSG-2 names',
    ['authn', 'authz', 'observability', 'failure-modes'].every((needed) =>
      design.crossCutting.some((entry) => entry.concern === needed),
    ),
    design.crossCutting.map((entry) => entry.concern).join(', '),
  );

  process.stdout.write('\n5. Status\n');
  await call(['status', '--run', 'r1']);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT2.1.3a verification passed\n\n'
    : `\nT2.1.3a verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
