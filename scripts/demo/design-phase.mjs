/**
 * T2.1.3a/b verification — the Design phase on a sample project.
 *
 *   seeded requirement set → three proposers argue three stances in parallel →
 *   a comparer puts them side by side → a three-judge panel votes and the
 *   *kernel* counts → an architect turns the winner into the design of record
 *   with ADRs → four critics attack it, one DSG-3 lens each, and a curator
 *   records what implementers will need in the knowledge base → gate packet
 *
 * Makes real model calls (fourteen sessions). Not part of `npm run check` or
 * CI: CI has no credentials, and a verification that silently skipped itself
 * would be worse than none. Run with `npm run demo:design`.
 *
 * The requirement set is seeded so this spends on the Design phase alone, and
 * so its requirement ids are known here — which lets the demo check something
 * the schema cannot: that the design traces to requirements that actually
 * exist, rather than to plausible-looking ids (DSG-4).
 *
 * **The planted flaw.** LOAN-6 below asks for the member view to be reachable
 * without signing in. It is a plausible-sounding convenience requirement and a
 * real security hole: any faithful design carries it, because the architect's
 * job is to implement the requirement set rather than to second-guess Scope.
 * The security lens is expected to find it; the other three are not. Planting
 * it upstream rather than editing a generated design is the only way to plant
 * a flaw in output that does not exist until the phase runs.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { SCOPE } from './sample-project.mjs';

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

/**
 * Read an artifact the phase was meant to produce, or report that it is not
 * there.
 *
 * A blocked task leaves its artifact unwritten. Letting the read throw turns
 * one failed task into a stack trace that hides every check after it —
 * including the ones that would have said how much of the phase did work,
 * which is the whole of what a failed run has left to tell.
 */
function readArtifact(store, path, label) {
  try {
    return store.read(path).data;
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error));
    return {};
  }
}

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
  const candidateSet = readArtifact(
    store,
    'artifacts/design/candidates.md',
    'the candidate set was written',
  );
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
  let kbWrites = [];
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
    kbWrites = log.read({ type: 'KnowledgeBaseUpdated' });
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
  const design = readArtifact(
    store,
    'artifacts/design/design.md',
    'the design of record was written',
  );
  process.stdout.write(
    `  chosen: ${design.chosen ?? '(nothing — no design was written)'}\n`,
  );
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
      (design.adrs ?? []).every((adr) => adr.alternatives.length > 0),
    `${String((design.adrs ?? []).length)} ADR(s)`,
  );

  // The schema requires every element to trace *somewhere*; only the demo
  // knows which requirement ids actually exist, so only the demo can catch a
  // trace to a plausible-looking id that was never in the Scope artifact.
  const traced = [
    ...(design.components ?? []),
    ...(design.interfaces ?? []),
    ...(design.technologies ?? []),
    ...(design.crossCutting ?? []),
    ...(design.adrs ?? []),
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
      (design.crossCutting ?? []).some((entry) => entry.concern === needed),
    ),
    (design.crossCutting ?? []).map((entry) => entry.concern).join(', '),
  );

  process.stdout.write('\n5. Adversarial review (DSG-3)\n');
  const findings = readArtifact(
    store,
    'artifacts/design/findings.md',
    'the review findings were written',
  );
  for (const finding of findings.findings ?? []) {
    process.stdout.write(`  [${finding.status}] ${finding.about}: ${finding.issue}\n`);
  }

  check(
    'four critics reviewed it, one lens each, plus a collector',
    [
      'review-design-lens-1',
      'review-design-lens-2',
      'review-design-lens-3',
      'review-design-lens-4',
      'review-design-collect',
    ].every((id) => dispatched.includes(id)),
    dispatched.filter((id) => id.startsWith('review-design')).join(', '),
  );
  check(
    'the review found something',
    (findings.findings ?? []).length > 0,
    'finding nothing is a possible result, but on a first design it is the rarest one',
  );

  const reviewText = JSON.stringify(findings).toLowerCase();
  check(
    'the planted security flaw was found (DSG-3)',
    /loan-6|unauthenticat|anonymous|no login|without (signing|logging|a login|authentication)/.test(
      reviewText,
    ),
    'the review must name the unauthenticated member view, however it classifies it',
  );

  const openFindings = (findings.findings ?? []).filter(
    (finding) => finding.status === 'open',
  );
  check(
    'the attestation matches the findings it is attesting to',
    findings.allResolved === (openFindings.length === 0),
    `allResolved=${String(findings.allResolved)} with ${String(openFindings.length)} open`,
  );

  process.stdout.write('\n6. Knowledge base (CTX-4)\n');
  const kbFiles = existsSync(join(workspace, 'kb'))
    ? readdirSync(join(workspace, 'kb'), { recursive: true }).filter((entry) =>
        String(entry).endsWith('.md'),
      )
    : [];
  process.stdout.write(`  ${kbFiles.map(String).join(', ') || '(nothing)'}\n`);

  check(
    'the curator task ran',
    dispatched.includes('record-conventions'),
    'CTX-4: the knowledge base has to stay current as decisions land',
  );
  check(
    'every knowledge-base write is attributable (CTX-4)',
    kbWrites.every((event) => event.payload.taskId === 'record-conventions'),
    kbWrites.map((event) => `${event.payload.path}: ${event.payload.title}`).join('; ') ||
      'the curator returned no updates, which is a legitimate answer',
  );

  process.stdout.write('\n7. Status\n');
  await call(['status', '--run', 'r1']);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT2.1.3a/b verification passed\n\n'
    : `\nT2.1.3a/b verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
