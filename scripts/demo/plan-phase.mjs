/**
 * T2.2.3 verification — the Plan phase on the sample project.
 *
 *   seeded requirement set + design → planner decomposes into plan phases,
 *   milestones and single-session tasks → three critics attack the
 *   decomposition, the risk ordering and the coverage → gate packet, with the
 *   kernel's own acyclicity and trace checks
 *
 * Makes real model calls (five sessions). Not part of `npm run check` or CI:
 * CI has no credentials, and a verification that silently skipped itself would
 * be worse than none. Run with `npm run demo:plan`.
 *
 * Both upstream artifacts are seeded, so this spends on the Plan phase alone —
 * and so the demo knows every requirement and design element id a plan may
 * legitimately cite. That is what lets it check the thing the schema cannot:
 * a task tracing to an id nobody declared (ART-2).
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
  TraceIndex,
  designElementIds,
  projectArtifactSchemas,
  projectOutputSchemas,
  runCli,
} from '../../dist/index.js';
import { DESIGN, SCOPE } from './sample-project.mjs';

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
 * Every id a plan may legitimately cite.
 *
 * Both upstream artifacts are seeded, so this is exact rather than a
 * heuristic. That matters because the kernel's own dangling check cannot be:
 * it filters citations to the ones that look like ids, which is what makes an
 * id worth having and what makes a citation of prose invisible to it.
 */
const declaredIds = new Set([
  ...SCOPE.requirements.map((entry) => entry.id),
  ...designElementIds(DESIGN),
]);

const workspace = mkdtempSync(join(tmpdir(), 'mpgm-t223-'));

try {
  for (const directory of ['roles', 'phases', 'kb']) {
    cpSync(join(projectRoot, directory), join(workspace, directory), { recursive: true });
  }
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm demo'], { cwd: workspace });
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');

  const seed = new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() });
  seed.write({
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
  seed.write({
    id: 'design',
    basePath: 'artifacts/design/design.md',
    schema: 'design',
    data: DESIGN,
    producedBy: {
      task: 'seeded',
      role: 'design-architect',
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

  process.stdout.write('\n1. Plan phase\n');
  const ran = await call(['run', 'plan', '--run', 'r1']);
  check('the phase ran to its gate', ran.result.ok, ran.output);
  check('a gate packet was presented', ran.output.includes('Gate: plan-gate'));
  check('the gate was not auto-approved (HIL-1)', ran.output.includes('Approve with:'));

  const store = new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() });

  process.stdout.write('\n2. The plan (PLN-1)\n');
  const plan = store.read('artifacts/plan/plan.md').data;
  const milestones = plan.phases.flatMap((phase) => phase.milestones);
  const tasks = milestones.flatMap((milestone) => milestone.tasks);

  for (const phase of plan.phases) {
    process.stdout.write(`  ${phase.id} ${phase.title}\n`);
    for (const milestone of phase.milestones) {
      process.stdout.write(
        `    ${milestone.id} ${milestone.title} (${String(milestone.tasks.length)} tasks)` +
          `${milestone.validatesRisk ? ` [${milestone.validatesRisk}]` : ''}\n`,
      );
    }
  }

  // Reaching this line means the artifact validated: the schema cannot express
  // a cyclic plan, a duplicate task id, a dependency on a task nobody
  // declared, or a task with no completion criteria.
  check(
    'a three-level plan exists and validated against its schema',
    plan.phases.length > 0 && milestones.length > 0 && tasks.length > 0,
    `${String(plan.phases.length)} phases, ${String(milestones.length)} milestones, ${String(tasks.length)} tasks`,
  );
  check(
    'every task declares how to tell it is finished (PLN-1)',
    tasks.every((task) => task.completionCriteria.length > 0),
  );
  check(
    'every milestone says what must demonstrably work (PLN-3)',
    milestones.every((milestone) => milestone.verification.trim() !== ''),
  );

  process.stdout.write('\n3. Risk ordering (PLN-2)\n');
  for (const risk of plan.risks) {
    process.stdout.write(
      `  ${risk.id}: ${risk.assumption} — settled by ${risk.validatedBy.join(', ')}\n`,
    );
  }

  const firstPhaseMilestones = new Set(
    (plan.phases[0]?.milestones ?? []).map((milestone) => milestone.id),
  );
  check(
    'the plan names its riskiest assumptions',
    plan.risks.length > 0,
    `${String(plan.risks.length)} risk(s)`,
  );
  check(
    'at least one risk is settled in the first plan phase (PLN-2)',
    plan.risks.some((risk) =>
      risk.validatedBy.some((id) => firstPhaseMilestones.has(id)),
    ),
    'front-loading is the requirement; a plan that settles everything last has ordered by comfort',
  );

  process.stdout.write('\n4. Traceability (ART-2)\n');
  const cited = [...new Set(tasks.flatMap((task) => task.tracesTo))];
  const invented = cited.filter((id) => !declaredIds.has(id));

  const tracedLine =
    ran.output.split('\n').find((line) => line.includes('plan-traced')) ?? '';
  check('the gate checked the citations itself', tracedLine !== '', tracedLine.trim());
  check(
    'the kernel found no dangling citation',
    tracedLine.trim().startsWith('met'),
    'the traces-resolve criterion is the T2.2.3 gate check, and it can genuinely fail',
  );
  // Checked independently of the kernel, and more strictly: every citation
  // must name something the seeded artifacts declare, id-shaped or not.
  check(
    'no task traces to anything nobody declared',
    invented.length === 0,
    invented.length === 0
      ? `${String(cited.length)} distinct citation(s), all declared`
      : `invented: ${invented.join(', ')}`,
  );

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

    const index = TraceIndex.attach(db);
    const planNode = `plan@${String(store.latestVersion('artifacts/plan/plan.md'))}`;
    check(
      'the trace index agrees with the gate',
      index.danglingFrom(planNode).length === 0,
      index
        .danglingFrom(planNode)
        .map((entry) => `${entry.src} -> ${entry.dst}`)
        .join(', '),
    );
    check(
      'the plan is reachable from a requirement it implements (ART-2)',
      index.downstreamOf('LOAN-1').includes(planNode),
      index.downstreamOf('LOAN-1').join(', '),
    );
  } finally {
    db.close();
  }

  process.stdout.write('\n5. The review\n');
  const findings = store.read('artifacts/plan/findings.md').data;
  for (const finding of findings.findings ?? []) {
    process.stdout.write(`  [${finding.status}] ${finding.about}: ${finding.issue}\n`);
  }
  check(
    'three critics reviewed the plan, one lens each, plus a collector',
    [
      'review-plan-lens-1',
      'review-plan-lens-2',
      'review-plan-lens-3',
      'review-plan-collect',
    ].every((id) => dispatched.includes(id)),
    dispatched.filter((id) => id.startsWith('review-plan')).join(', '),
  );
  const open = (findings.findings ?? []).filter((entry) => entry.status === 'open');
  check(
    'the attestation matches the findings it is attesting to',
    findings.allResolved === (open.length === 0),
    `allResolved=${String(findings.allResolved)} with ${String(open.length)} open`,
  );

  process.stdout.write('\n6. Status\n');
  await call(['status', '--run', 'r1']);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT2.2.3 verification passed\n\n'
    : `\nT2.2.3 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
