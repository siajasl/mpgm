/**
 * T4.3.5 verification — the Test phase, run.
 *
 * M3.2 delivered three legs (T3.2.1-4) and only ever exercised one of them: a
 * defect round trip through fix and re-test, satisfied by an in-process unit
 * test (`src/test/defect-filing.test.ts`). Requirement coverage (T3.2.1/T3.2.3)
 * and an adversarial suite actually catching something (T3.2.2) never ran as a
 * phase over a real subject — the milestone closed on its tasks, not on a run.
 * T4.3.2 then wired `nfr`/`suite` playbook steps to real executors and T4.3.4
 * wired defect filing into `runPhase`; this is the run that was still missing:
 *
 *   seeded Scope (a real quantified NFR set) → nfr-scoper restates it →
 *   the kernel measures each one against a project-declared command
 *   (TST-3) → adversarial-tester attacks a real, planted-buggy module with a
 *   real suite → the kernel runs it with `node --test` (TST-4) → every
 *   failing case and every below-threshold NFR becomes a filed Defect
 *   (TST-5) → the Test gate is presented, unmet → every adversarially found
 *   defect is routed, fixed for real, and re-tested against the same
 *   evidence that caught it, closing to `verified` → the gate is
 *   re-presented over every defect on disk and the decision is recorded in
 *   the log.
 *
 * Makes real model calls (two sessions: `scope-nfrs`, `attack-subject`). Not
 * part of `npm run check` or CI: CI has no credentials, and a verification
 * that silently skipped itself would be worse than none. Run with
 * `npm run demo:test-phase`.
 *
 * **The subject.** A fresh temporary directory this script builds, never the
 * mpgm working tree — printed below so it is never merely implicit. It holds
 * a copy of `phases/`, `roles/` and `kb/` (needed to run a playbook at all), a
 * seeded Scope artifact (the school library loan tracker already shared with
 * `demo:design`/`demo:plan`), a `test/nfr.yaml` measurement manifest this
 * script fully controls, and exactly one module with real logic:
 * `src/loan-limit.mjs`. `testProjectDir` is pointed at that same directory
 * because it has to be: `phases/test.yaml`'s own comment on `attack-subject`
 * says the suite's `subject` specifier only resolves when `testProjectDir` is
 * the project root the tester read from — `nodeTestExecutor`'s subject
 * restriction is documented as not a confinement boundary, so pointing it
 * anywhere else is a decision this script makes explicitly, not a default.
 *
 * **The planted defect.** `mayCheckOut(openLoans, maxLoans)` is meant to
 * refuse a checkout once a member already holds `maxLoans` open loans
 * (LOAN-1). It is planted with `openLoans <= maxLoans` — an off-by-one that
 * allows exactly one loan too many at the boundary. A boundary case is one of
 * the three classes TST-4 requires of every suite, and this is the boundary
 * of the one substantive function in the project, so a suite that tried to
 * break this module and wrote any boundary case at all finds it. If the
 * generated suite does not catch it, this script reports that failure and
 * exits non-zero rather than reporting a run that merely completed.
 *
 * **The below-threshold NFR.** `test/nfr.yaml` measures NFR-1 as 1 record
 * lost against a threshold of 0 — a real failing measurement, left unrouted
 * and unfixed on purpose. Its coverage row is what makes the report name an
 * *unverified* requirement rather than three verified ones; and its still-open
 * defect is what makes the final gate decision an honest rejection rather
 * than a pass this run manufactured.
 *
 * **The re-test.** TST-5's round trip needs the *same* case, re-run, to
 * decide whether a fix held (`retestDefect`, `src/test/defect.ts`). The case
 * id is the adversarial-tester's own choice of words, made fresh each session
 * — a second `mpgm run test` would regenerate the suite from scratch and, in
 * all likelihood, name its cases differently, breaking the very id match the
 * round trip is keyed on. So the re-test here reuses the *exact* generated
 * suite this run's own `attack-subject` session returned — captured off the
 * `runPhase` result, the same object `run-suite`'s step handler would have
 * read — and re-executes it for real with `runAdversarialSuite`/
 * `nodeTestExecutor` against the fixed module, then closes the defect with
 * `verifyFixedDefect`. These are the exact functions `src/phase/runner.ts`
 * calls for a `suite` node; this script calls them directly instead of asking
 * for a second, non-deterministic session, and says so here rather than
 * leaving a reviewer to wonder why there is no second `mpgm run test`.
 *
 * **What the gate is shown.** Section 8 presents the gate over *every*
 * defect artifact on disk, enumerated from `artifacts/defect/` and parsed
 * with `defectSchema` — not over a list this script assembled from the two
 * defects it expects. `runPhase` hands the gate every defect it filed this
 * run, and `defectsFromAdversarialVerdict` files one per failing case, so a
 * suite that broke the planted module in three ways files three defects.
 * Presenting the gate over a chosen subset would make "only NFR-1 blocks"
 * true by filtering the evidence rather than by the state, and this script
 * would report a gate refusing on one defect while the run left several
 * open. So the round trip in sections 5-6 routes, fixes and re-tests *every*
 * adversarially found defect — they all indict the same planted off-by-one
 * and the same fix commit — and section 7 asserts the set still open is
 * exactly the one this run knowingly left open, naming each.
 *
 * **What this run cannot verify.** REQUIREMENTS' first Test-gate clause —
 * all Must-have requirements verified (TST-2) — is not met by this run and
 * cannot be by this playbook: `requirementCoverageReport` (`src/test/nfr.ts`)
 * needs a quarantine ledger and the whole Scope list that no `nfr` node
 * supplies, so `phases/test.yaml`'s gate description deliberately omits the
 * clause (DESIGN §9 decision 15). Section 2 reports that as a finding of the
 * run, naming the Must-have requirements no coverage row covers, rather than
 * letting three `nfr-coverage` rows stand in for requirement coverage.
 *
 * **What is asserted.** Everything below reads artifacts off disk
 * (`ArtifactStore`) and events off the log (`EventLog`) — never a session's
 * own transcript, since artifacts are the only interface between phases and
 * gate truth lives in the log (glossary, "Gate").
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore,
  CapabilityRegistry,
  ClaudeAgentProvider,
  DEFAULT_EGRESS_POLICY,
  EventLog,
  GateManager,
  PlaybookRegistry,
  Projector,
  RoleRegistry,
  SessionRunner,
  SnapshotStore,
  adversarialDefectId,
  commandNfrProvider,
  defectSchema,
  defectsFromAdversarialVerdict,
  defectsToVerifyFromAdversarialVerdict,
  fileAndWriteDefect,
  kernelRegistry,
  loadKnowledgeBase,
  nfrDefectId,
  nodeTestExecutor,
  openDatabase,
  projectArtifactSchemas,
  projectOutputSchemas,
  runAdversarialSuite,
  runCli,
  runPhase,
  testNfrContract,
  verifyFixedDefect,
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
 * there — an absent artifact throws (`ArtifactStore.read`), and letting that
 * throw turns one missing artifact into a stack trace that hides every check
 * after it, including the ones that would have said how much of the phase
 * did work.
 */
function readArtifact(store, path, label, fallback) {
  try {
    return store.read(path).data;
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

/** As {@link readArtifact}, but the whole artifact — what `GateEvidence` takes. */
function readArtifactRecord(store, path, label) {
  try {
    return store.read(path);
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Every defect on disk, latest version each, in id order.
 *
 * Enumerated rather than named: `runPhase` files one defect per failing
 * adversarial case and one per below-threshold NFR row, and how many of each
 * a live run produces is the run's finding, not this script's to assume. A
 * gate presented over a list assembled here would be a gate shown the
 * evidence that suits the narrative.
 *
 * Nothing here reports a check of its own. `ArtifactStore.list` already skips
 * a file it cannot read, and an id that does not round-trip through
 * `defectSchema` is skipped here too — both come out as a defect *missing*
 * from the returned set, which section 4's set-equality check against what
 * the verdict and the coverage rows imply is what fails on. A pair of
 * "readable"/"parses" checks here would pass by construction (`list` read
 * and migrated every artifact it returned an id for) and report coverage
 * that does not exist (CONV-6).
 */
function defectsOnDisk(store) {
  const ids = [
    ...new Set(store.list('artifacts/defect').map((e) => e.artifact.id)),
  ].sort();
  const found = [];
  for (const id of ids) {
    let parsed;
    try {
      parsed = defectSchema.safeParse(store.read(`artifacts/defect/${id}.md`).data);
    } catch {
      continue;
    }
    if (parsed.success) {
      found.push({ id, defect: parsed.data });
    }
  }
  return found;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const requirementIds = new Set(SCOPE.requirements.map((entry) => entry.id));

/** The buggy subject: allows one checkout too many at exactly the limit. */
const SUBJECT_BUGGY = `/**
 * LOAN-1: whether a librarian may record another loan for a member.
 *
 * A member may hold at most \`maxLoans\` open loans at once. Recording a loan
 * that would exceed that limit is refused here, not carried out silently as
 * one more entry in the ledger.
 *
 * @param {number} openLoans - the member's current count of open loans.
 * @param {number} maxLoans - the maximum open loans a member may hold at once.
 * @returns {boolean} true when another loan may be recorded.
 */
export function mayCheckOut(openLoans, maxLoans) {
  if (!Number.isInteger(openLoans) || openLoans < 0) {
    throw new TypeError('openLoans must be a non-negative integer');
  }
  if (!Number.isInteger(maxLoans) || maxLoans < 1) {
    throw new TypeError('maxLoans must be a positive integer');
  }
  return openLoans <= maxLoans;
}
`;

/** The fix: a member already at the limit is refused, not waved through. */
const SUBJECT_FIXED = SUBJECT_BUGGY.replace(
  'return openLoans <= maxLoans;',
  'return openLoans < maxLoans;',
);

const NFR_MANIFEST = `measurements:
  - requirement: NFR-1
    metric: loan records lost per term
    unit: records
    direction: at-most
    command: node
    args: ['-e', 'console.log(1)']
    evidence: 'demo fixture — stands in for a real kill -9 durability run'
  - requirement: NFR-2
    metric: p95 loan-recording latency
    unit: ms
    direction: at-most
    command: node
    args: ['-e', 'console.log(180)']
    evidence: 'demo fixture — stands in for a real desk-load test'
  - requirement: NFR-3
    metric: resident memory under normal load
    unit: MB
    direction: at-most
    command: node
    args: ['-e', 'console.log(300)']
    evidence: 'demo fixture — stands in for a real memory profile'
`;

const REQUIREMENTS_DOC = [
  '# Requirements',
  '',
  SCOPE.summary,
  '',
  ...SCOPE.requirements.map((r) => `- **${r.id}** (${r.priority}): ${r.statement}`),
  '',
].join('\n');

const workspace = mkdtempSync(join(tmpdir(), 'mpgm-t435-subject-'));
process.stdout.write(
  `Subject under test: ${workspace}\n` +
    `  (a fixture project this script builds — not the mpgm working tree)\n`,
);

try {
  for (const directory of ['roles', 'phases', 'kb']) {
    cpSync(join(projectRoot, directory), join(workspace, directory), { recursive: true });
  }
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'test'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'loan-limit.mjs'), SUBJECT_BUGGY);
  writeFileSync(join(workspace, 'test', 'nfr.yaml'), NFR_MANIFEST);
  writeFileSync(join(workspace, 'REQUIREMENTS.md'), REQUIREMENTS_DOC);
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');

  const store = new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() });
  store.write({
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

  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm demo'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '--quiet', '-m', 'Subject project (planted defect)'], {
    cwd: workspace,
  });
  const initialSha = git(workspace, ['rev-parse', 'HEAD']);

  const kb = (() => {
    try {
      return loadKnowledgeBase(join(workspace, 'kb'));
    } catch {
      return [];
    }
  })();

  process.stdout.write('\n1. The Test phase, run over the subject above\n');

  const dbPath = join(workspace, '.mpgm', 'state.db');
  const playbook = PlaybookRegistry.fromDirectory(join(workspace, 'phases')).get('test');
  let phaseResult;
  {
    const db = openDatabase(dbPath);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      const projector = new Projector({
        log,
        snapshots: SnapshotStore.attach(db),
        interval: 50,
      });
      log.append({
        runId: 'r1',
        type: 'RunStarted',
        payload: { project: workspace, operator: 'operator' },
      });

      const roles = RoleRegistry.fromDirectory(join(workspace, 'roles'));
      const capabilities = new CapabilityRegistry();
      capabilities.bind(testNfrContract, commandNfrProvider({ root: workspace }));

      phaseResult = await runPhase({
        runId: 'r1',
        playbook,
        roles,
        artifacts: store,
        capabilities,
        repo: 'demo/subject',
        ref: initialSha,
        testProjectDir: workspace,
        defectSeverity: 'high',
        sessions: new SessionRunner({
          log,
          provider: new ClaudeAgentProvider(),
          schemas: projectOutputSchemas(),
          policyRoot: workspace,
        }),
        gates: new GateManager({ log, projector }),
        log,
        projector,
        kb,
        policy: DEFAULT_EGRESS_POLICY,
      });
    } finally {
      db.close();
    }
  }

  check(
    'the phase ran to its gate',
    phaseResult.outcome.status === 'gate-presented',
    JSON.stringify(phaseResult.outcome),
  );
  if (phaseResult.outcome.status !== 'gate-presented') {
    process.stdout.write(
      `\nT4.3.5 verification FAILED: the Test phase did not reach its gate\n\n`,
    );
    rmSync(workspace, { recursive: true, force: true });
    process.exit(1);
  }
  check(
    'the gate was not auto-approved (HIL-1)',
    phaseResult.outcome.packet.autoApproved === false,
  );

  process.stdout.write(
    '\n2. Quantified-NFR coverage (TST-3) — the first leg that never ran\n',
  );
  const nfrCoverage = readArtifact(
    store,
    'artifacts/test/nfr-coverage.md',
    'the NFR coverage report was written',
    [],
  );
  const coverageRows = Array.isArray(nfrCoverage) ? nfrCoverage : [];
  for (const row of coverageRows) {
    process.stdout.write(
      `  ${row.verified ? 'verified  ' : 'unverified'}  ${row.id}` +
        `${row.problem ? ` (${row.problem})` : ''}\n`,
    );
  }
  check(
    'every quantified NFR Scope declares was measured',
    coverageRows.length === 3,
    coverageRows.map((row) => row.id).join(', '),
  );
  check(
    'NFR-2 and NFR-3 measured within threshold — verified',
    coverageRows
      .filter((row) => row.verified)
      .map((row) => row.id)
      .sort()
      .join(',') === 'NFR-2,NFR-3',
  );
  check(
    'NFR-1 measured below threshold — unverified: the coverage report names both, ' +
      'not a clean sweep',
    coverageRows.some(
      (row) =>
        row.id === 'NFR-1' && row.verified === false && row.problem === 'below-threshold',
    ),
  );
  check(
    'every coverage row names a requirement the gated Scope actually declares — a row ' +
      'for an id Scope never stated would be coverage of nothing',
    coverageRows.every((row) => requirementIds.has(row.id)),
    coverageRows
      .filter((row) => !requirementIds.has(row.id))
      .map((row) => row.id)
      .join(', '),
  );

  // Reported, not checked: this is a finding about what the phase can do at
  // all, and a check that "the gap is still there" would pass precisely while
  // the gap remains. It is printed so it appears in the run's own output,
  // which is the verification — the alternative is a gap visible only to
  // someone who reads `phases/test.yaml`.
  const measured = new Set(coverageRows.map((row) => row.id));
  const mustHaves = SCOPE.requirements.filter((entry) => entry.priority === 'must');
  const unmeasuredMustHaves = mustHaves.filter((entry) => !measured.has(entry.id));
  const unverifiedMustHaves = mustHaves.filter((entry) =>
    coverageRows.some((row) => row.id === entry.id && row.verified !== true),
  );
  process.stdout.write(
    `\n  FINDING (TST-2) — what this run does NOT verify, reported rather than\n` +
      `  worked around. REQUIREMENTS' first Test-gate clause is "all Must-have\n` +
      `  requirements verified". This playbook cannot report that figure at all:\n` +
      `  ${String(unmeasuredMustHaves.length)} of ${String(mustHaves.length)} Must-have ` +
      `requirements have no coverage row of any kind,\n` +
      `  because an \`nfr\` node measures the quantified subset and nothing else.\n`,
  );
  for (const entry of unmeasuredMustHaves) {
    process.stdout.write(`    no coverage row  ${entry.id}: ${entry.statement}\n`);
  }
  for (const entry of unverifiedMustHaves) {
    process.stdout.write(`    measured, UNVERIFIED  ${entry.id}: ${entry.statement}\n`);
  }
  process.stdout.write(
    `  The full report (\`requirementCoverageReport\`, src/test/nfr.ts) needs a\n` +
      `  quarantine ledger (TST-6) and the whole Scope list, neither of which\n` +
      `  \`PhaseRunOptions\` supplies — so \`phases/test.yaml\`'s gate description\n` +
      `  states in as many words that it omits the clause, and checks the narrower\n` +
      `  \`nfr-coverage\` rows instead (DESIGN §9 decision 15). The Test gate as\n` +
      `  REQUIREMENTS words it therefore cannot be met by this playbook today:\n` +
      `  this run verifies TST-3, TST-4 and TST-5, and leaves TST-2 open.\n`,
  );

  process.stdout.write(
    '\n3. Adversarial suite (TST-4) — the second leg that never ran\n',
  );
  const verdict = readArtifact(
    store,
    'artifacts/test/adversarial-verdict.md',
    'the adversarial verdict was written',
    { rows: [], defects: [], notReported: [], clean: true },
  );
  for (const row of verdict.rows ?? []) {
    process.stdout.write(`  [${row.outcome}] (${row.kind}) ${row.id}: ${row.about}\n`);
  }
  // The exact `AdversarialSuite` this run's own `attack-subject` session
  // returned — see this file's header doc for why the round trip in section 6
  // reuses it rather than asking a second session to regenerate one.
  const suite = phaseResult.outputs['attack-subject'];
  const suiteCases = Array.isArray(suite?.cases) ? suite.cases : [];
  // Stated, not checked: that the suite carries all three case classes TST-4
  // names is a refinement of `adversarialSuiteSchema` (CONV-5) — `runPhase`
  // parses the session's output against it before a case ever runs, so a
  // check here for three kinds could not fail and would report coverage that
  // does not exist (CONV-6).
  process.stdout.write(
    `  subject '${String(suite?.subject)}', ${String(suiteCases.length)} case(s), ` +
      `kinds ${[...new Set(suiteCases.map((entry) => entry.kind))].sort().join('/')} ` +
      `(all three TST-4 classes: unrepresentable otherwise, adversarialSuiteSchema)\n`,
  );
  check(
    'every case in the generated suite came back with a reported outcome — a case the ' +
      'runner never reported on is silence, and silence is not a pass',
    (verdict.rows ?? []).length === suiteCases.length &&
      (verdict.notReported ?? []).length === 0,
    `${String((verdict.rows ?? []).length)}/${String(suiteCases.length)} reported` +
      (verdict.notReported?.length
        ? `, not reported: ${verdict.notReported.map((row) => row.id).join(', ')}`
        : ''),
  );

  const defectRows = verdict.defects ?? [];
  const boundaryHit = defectRows.find((row) => row.kind === 'boundary');
  const textHit = defectRows.find((row) =>
    /check-?out|checkout|limit|boundary|off-by-one/i.test(
      `${row.about} ${row.defect} ${row.id}`,
    ),
  );
  const caughtRow = boundaryHit ?? textHit;
  check(
    'the planted off-by-one at the loan-checkout limit was caught (TST-4) — a demo ' +
      'reporting success on an empty suite would prove the phase ran, not that it works',
    caughtRow !== undefined,
    caughtRow ? `${caughtRow.id}: ${caughtRow.about}` : JSON.stringify(defectRows),
  );

  if (caughtRow === undefined) {
    process.stdout.write(
      `\nT4.3.5 verification FAILED: the adversarial suite did not catch the planted ` +
        `defect\n\n`,
    );
    rmSync(workspace, { recursive: true, force: true });
    process.exit(1);
  }

  const caseId = caughtRow.id;
  const adversarialId = adversarialDefectId(caseId);

  process.stdout.write(
    '\n4. What this run filed (TST-5) — every defect, read off disk\n',
  );
  const belowThreshold = coverageRows.filter((row) => row.problem === 'below-threshold');
  const expectedFiledIds = [
    ...defectRows.map((row) => adversarialDefectId(row.id)),
    ...belowThreshold.map((row) => nfrDefectId(row.id)),
  ].sort();
  const filedAfterRun = defectsOnDisk(store);
  for (const entry of filedAfterRun) {
    process.stdout.write(
      `  ${entry.defect.status.padEnd(11)} ${entry.defect.severity.padEnd(8)} ` +
        `${entry.id}: ${entry.defect.title}\n`,
    );
  }
  check(
    'the run filed exactly one defect per failing case and one per below-threshold NFR ' +
      'row — what the gate is shown below is this set, not a subset chosen here',
    filedAfterRun.map((entry) => entry.id).join(',') === expectedFiledIds.join(','),
    `on disk: ${filedAfterRun.map((entry) => entry.id).join(', ') || '(none)'} | ` +
      `expected: ${expectedFiledIds.join(', ') || '(none)'}`,
  );

  const filedDefect = readArtifact(
    store,
    `artifacts/defect/${adversarialId}.md`,
    'the adversarial defect was filed',
    undefined,
  );
  check(
    'filed open, tracing to a real requirement, with the suite case as its evidence (TST-5)',
    filedDefect !== undefined &&
      filedDefect.status === 'open' &&
      Array.isArray(filedDefect.tracesTo) &&
      filedDefect.tracesTo.length > 0 &&
      filedDefect.tracesTo.every((id) => requirementIds.has(id)) &&
      filedDefect.evidence?.kind === 'adversarial' &&
      filedDefect.evidence?.caseId === caseId,
    filedDefect ? `tracesTo: ${filedDefect.tracesTo?.join(', ')}` : '(not filed)',
  );

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

  process.stdout.write('\n5. Route to Implement, and a real fix (TST-5, ORC-1)\n');
  // Every adversarially found defect, not just the one that names the planted
  // bug most plainly: they were all filed against the same ten-line module
  // with one deliberate fault in it, and the single fix below is the answer to
  // each. Routing only one and letting the rest sit open would leave the gate
  // in section 8 blocking on defects this run never reported on.
  const adversarialIds = defectRows.map((row) => adversarialDefectId(row.id));
  for (const row of defectRows) {
    const id = adversarialDefectId(row.id);
    const routed = await call([
      'defect',
      'route',
      id,
      '--to',
      'implement',
      '--task',
      'T-demo-fix',
      '--by',
      'demo-operator',
      '--reason',
      `Adversarial case '${row.id}' broke mayCheckOut at the loan limit: ${row.defect}. ` +
        `A real bug in the implementation, not a design assumption.`,
    ]);
    check(`routed ${id} to Implement (ORC-1)`, routed.result.ok, routed.output);
  }

  writeFileSync(join(workspace, 'src', 'loan-limit.mjs'), SUBJECT_FIXED);
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync(
    'git',
    [
      'commit',
      '--quiet',
      '-m',
      'Fix: refuse a checkout exactly at the loan limit (LOAN-1)',
    ],
    { cwd: workspace },
  );
  const fixSha = git(workspace, ['rev-parse', 'HEAD']);

  for (const id of adversarialIds) {
    const fixed = await call([
      'defect',
      'fix',
      id,
      '--ref',
      fixSha,
      '--summary',
      'Changed `openLoans <= maxLoans` to `openLoans < maxLoans` in mayCheckOut, so a ' +
        'member already at the limit is refused.',
      '--by',
      'demo-operator',
    ]);
    check(
      `fix recorded for ${id} — fix-pending, awaiting re-test`,
      fixed.result.ok && fixed.result.detail === `${id} is fix-pending`,
      fixed.output,
    );
  }

  process.stdout.write(
    '\n6. Re-test: the same cases, re-run for real against the fix (TST-5)\n',
  );
  const retestVerdict = await runAdversarialSuite({
    suite,
    execute: nodeTestExecutor({ projectDir: workspace }),
  });
  const retestRow = retestVerdict.rows.find((row) => row.id === caseId);
  check(
    'the same case now passes against the fixed subject',
    retestRow?.outcome === 'passed',
    JSON.stringify(retestRow),
  );

  // Mirrors `runSuite` in `src/phase/runner.ts` exactly: file anything newly
  // failing (a regression the fix introduced — none expected here), then
  // close whatever passed and had a fix on record.
  const kernelProvenance = {
    task: 'run-suite',
    role: 'kernel',
    model: '(none)',
    runId: 'r1',
  };
  for (const entry of defectsFromAdversarialVerdict(retestVerdict, 'high')) {
    fileAndWriteDefect(store, entry.id, entry.file, kernelProvenance);
  }
  for (const entry of defectsToVerifyFromAdversarialVerdict(retestVerdict)) {
    verifyFixedDefect(store, entry.id, entry.detail, kernelProvenance);
  }
  const adversarialAfterRetest = adversarialIds.map((id) => ({
    id,
    status: readArtifact(
      store,
      `artifacts/defect/${id}.md`,
      `defect ${id} is still on disk after the re-test`,
      {},
    ).status,
  }));
  check(
    'every adversarially found defect closed to verified by the re-test — never by an ' +
      'operator asserting it, and never by leaving one out of the evidence',
    adversarialAfterRetest.every((entry) => entry.status === 'verified'),
    adversarialAfterRetest
      .map((entry) => `${entry.id}: ${String(entry.status)}`)
      .join(' | '),
  );

  process.stdout.write('\n7. What this run leaves open — reported, not worked around\n');
  const nfrOneId = nfrDefectId('NFR-1');
  // Read back off disk, every defect, after the round trip: the state the gate
  // below is shown is this, and the state this section reports is the same
  // list — there is no third list anywhere that names only what suits.
  const finalFiled = defectsOnDisk(store);
  for (const entry of finalFiled) {
    process.stdout.write(
      `  ${entry.defect.status.padEnd(11)} ${entry.defect.severity.padEnd(8)} ` +
        `${entry.id}: ${entry.defect.title}\n`,
    );
  }
  const stillOpen = finalFiled.filter((entry) => entry.defect.status !== 'verified');
  check(
    "the only defect this run leaves unverified is NFR-1's: every adversarially found " +
      'defect was routed, fixed and re-tested, and NFR-1 was deliberately left unrouted',
    stillOpen.length === 1 && stillOpen[0]?.id === nfrOneId,
    stillOpen.map((entry) => `${entry.id} (${entry.defect.status})`).join(', ') ||
      '(none open — the below-threshold NFR should have left one)',
  );
  check(
    "NFR-1's defect is open at a severity that blocks — a below-threshold NFR the gate " +
      'would wave through is a threshold that does not exist (CONV-4)',
    stillOpen.some(
      (entry) =>
        entry.id === nfrOneId &&
        entry.defect.status === 'open' &&
        (entry.defect.severity === 'high' || entry.defect.severity === 'critical'),
    ),
    finalFiled.find((entry) => entry.id === nfrOneId)?.defect.severity ?? '(not filed)',
  );

  process.stdout.write('\n8. The gate, re-presented over what this run actually found\n');
  // Evidence assembled from disk, both halves: every defect artifact
  // `defectsOnDisk` enumerated (not a hand-picked pair), and the two
  // artifacts re-read rather than the in-memory `phaseResult.produced` the
  // first presentation was given — a presence criterion fed the object it was
  // already fed could not fail and would report coverage that does not exist
  // (CONV-6). What is on disk now is what a later phase would read.
  const finalDefects = finalFiled.map((entry) => entry.defect);
  const finalArtifacts = {};
  for (const [id, path] of [
    ['nfr-coverage', 'artifacts/test/nfr-coverage.md'],
    ['adversarial-verdict', 'artifacts/test/adversarial-verdict.md'],
  ]) {
    const artifact = readArtifactRecord(
      store,
      path,
      `the ${id} artifact is readable from disk for the final gate evaluation`,
    );
    if (artifact !== undefined) {
      finalArtifacts[id] = artifact;
    }
  }
  let packet2;
  {
    const db = openDatabase(dbPath);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      const projector = new Projector({
        log,
        snapshots: SnapshotStore.attach(db),
        interval: 50,
      });
      const gates = new GateManager({ log, projector });
      packet2 = gates.present('r1', playbook, {
        artifacts: finalArtifacts,
        outputs: phaseResult.outputs,
        defects: finalDefects,
      });
    } finally {
      db.close();
    }
  }
  for (const criterion of packet2.criteria) {
    process.stdout.write(
      `  ${criterion.met ? 'met ' : 'UNMET'}  ${criterion.id}: ${criterion.detail}\n`,
    );
  }
  const noOpenDefects = packet2.criteria.find((entry) => entry.id === 'no-open-defects');
  check(
    'both artifacts are still readable from disk, at the versions the gate was shown — ' +
      'the round trip rewrote defects, not the phase output a later phase reads',
    packet2.criteria.find((entry) => entry.id === 'nfr-coverage-present')?.met === true &&
      packet2.criteria.find((entry) => entry.id === 'adversarial-verdict-present')
        ?.met === true,
  );
  // `no-open-defects`' `detail` lists blocking defects by `title`, never by
  // artifact id (`src/gate/manager.ts`), and opens with their count. So the
  // blocking set the gate reports can be compared, defect for defect, against
  // the set section 7 read off disk: the count must match, every still-open
  // defect's title must appear, and no verified defect's title may. That
  // fails if the round trip left an adversarial defect open (its title would
  // be in `detail` and the count would not match), and fails if NFR-1 dropped
  // out of the blocking set — which would mean this run quietly weakened the
  // gate rather than reporting what it found.
  const detail = noOpenDefects?.detail ?? '';
  const verifiedTitles = finalFiled
    .filter((entry) => entry.defect.status === 'verified')
    .map((entry) => entry.defect.title);
  check(
    'the gate blocks on exactly the defects this run left open, each named — the ' +
      'evidence is every defect on disk, so the set cannot be made to look better ' +
      'by choosing what to present',
    noOpenDefects !== undefined &&
      detail.startsWith(`${String(stillOpen.length)} open critical/high defect(s):`) &&
      stillOpen.every((entry) => detail.includes(entry.defect.title)) &&
      verifiedTitles.every((title) => !detail.includes(title)),
    detail === '' ? '(no-open-defects criterion not found)' : detail,
  );
  check(
    'the gate is honestly UNMET — NFR-1 is still below threshold and this run does not ' +
      'weaken the gate to hide it (REQUIREMENTS: no open critical/high defects)',
    packet2.allMet === false && noOpenDefects?.met === false,
  );

  process.stdout.write('\n9. The decision, recorded (HIL-1, HIL-5)\n');
  const decision = await call([
    'approve',
    'test-gate',
    '--run',
    'r1',
    '--by',
    'demo-operator',
    '--reject',
    '--reason',
    'NFR-1 remains below its Scope threshold and was left unrouted for this demo; every ' +
      'adversarially found defect was routed, fixed and re-tested. The Test gate ' +
      'correctly refuses rather than approving on a partial fix. Recorded alongside ' +
      "it: REQUIREMENTS' first Test-gate clause (all Must-have requirements verified, " +
      'TST-2) is not reported by this playbook at all — see the section 2 finding.',
  ]);
  check(
    'the refusal is a recorded operator decision, not a silently weakened gate',
    decision.result.ok,
  );

  process.stdout.write(
    '\n10. Gate truth, read from the log — never a transcript (glossary: Gate)\n',
  );
  {
    const db = openDatabase(dbPath);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      const presented = log
        .read({ type: 'GatePresented' })
        .filter((event) => event.payload.gateId === 'test-gate');
      const rejected = log
        .read({ type: 'GateRejected' })
        .filter((event) => event.payload.gateId === 'test-gate');
      check(
        'the gate was presented twice — once over the fresh defects, once over the ' +
          'round-tripped state',
        presented.length === 2,
        String(presented.length),
      );
      check(
        'the gate decision itself lives in the log (GateRejected), not in a packet a ' +
          'session printed',
        rejected.length === 1 && rejected[0].payload.by === 'demo-operator',
        JSON.stringify(rejected[0]?.payload),
      );
    } finally {
      db.close();
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.3.5 verification passed — with one finding standing (see section 2):\n' +
        "  M3.2's Test phase verifies TST-3, TST-4 and TST-5 over a real subject, and\n" +
        "  cannot report TST-2's requirement coverage at all. REQUIREMENTS' Test gate\n" +
        '  asks for all Must-have requirements verified; this playbook measures the\n' +
        '  quantified subset and says so (phases/test.yaml, DESIGN §9 decision 15).\n' +
        '  The gate was not weakened to close the milestone: the clause is open.\n\n'
    : `\nT4.3.5 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
