/**
 * T2.2.7 verification — mpgm's own plan, loaded and scheduled (R6).
 *
 * Offline and part of `npm run check`. R6 asks whether the gated Plan artifact
 * is ingestible as mpgm's own executable task graph; the answer is a property
 * of the artifact and the scheduler, and needs no model to establish.
 *
 * Nothing is dispatched. The scheduler used here is the real one, driven by a
 * runner that records an id and returns — a bespoke simulation would prove the
 * plan schedulable under a scheduler nobody runs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore,
  dryRunPlan,
  ingestPlan,
  planSchema,
  projectArtifactSchemas,
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

process.stdout.write('\n1. The Plan artifact loads\n');

const store = new ArtifactStore({ root: projectRoot, schemas: projectArtifactSchemas() });
let artifact;
try {
  artifact = store.read('artifacts/plan/plan.md');
} catch (error) {
  check('the artifact reads and validates', false, String(error));
  process.stdout.write('\nT2.2.7 verification FAILED\n\n');
  process.exit(1);
}

// Reading it at all means it validated: the schema rejects a cyclic plan,
// duplicate ids, a dependency on a task nobody declared, a task without
// completion criteria, and a risk validated by a milestone that does not exist.
check(
  'the artifact reads and validates against the plan schema',
  planSchema.safeParse(artifact.data).success,
  `${artifact.path.split('/').slice(-3).join('/')} v${String(artifact.version)}`,
);

const plan = artifact.data;
const tasks = plan.phases.flatMap((phase) =>
  phase.milestones.flatMap((milestone) => milestone.tasks),
);

check(
  'it covers the remaining phases and nothing already done',
  plan.phases.map((phase) => phase.id).join(',') === 'P3,P4,P5',
  plan.phases.map((phase) => phase.id).join(', '),
);

process.stdout.write('\n2. It agrees with PLAN.md\n');

// The only drift a machine can catch. The wording is on whoever edits them.
const planDoc = readFileSync(join(projectRoot, 'PLAN.md'), 'utf8');
const documented = new Set(
  [...planDoc.matchAll(/\bT([345])\.[0-9]+\.[0-9]+[a-z]?\b/g)].map((match) => match[0]),
);
const ingested = new Set(tasks.map((task) => task.id));

const missing = [...documented].filter((id) => !ingested.has(id)).sort();
const extra = [...ingested].filter((id) => !documented.has(id)).sort();

check(
  'every P3-P5 task in PLAN.md is in the artifact',
  missing.length === 0,
  missing.length === 0
    ? `${String(documented.size)} task ids`
    : `missing: ${missing.join(', ')}`,
);
check(
  'and the artifact invents none',
  extra.length === 0,
  extra.length === 0 ? '' : `not in PLAN.md: ${extra.join(', ')}`,
);

process.stdout.write('\n3. It ingests as a task graph (PLN-1)\n');

const graph = ingestPlan(plan);
check(
  'every task became a schedulable step',
  graph.tasks.length === tasks.length,
  `${String(graph.tasks.length)} tasks across ${String(graph.milestones.length)} milestones`,
);

const switchover = graph.tasks.find((task) => task.id === 'T3.1.8');
check(
  'declared dependencies are carried through',
  switchover !== undefined && switchover.declaredDependsOn.includes('T3.1.7'),
  switchover ? switchover.declaredDependsOn.join(', ') : '(T3.1.8 missing)',
);

const firstOfSecondMilestone = graph.tasks.find((task) => task.milestone === 'M3.2');
check(
  'milestone order is added, and kept apart from what the plan declared',
  firstOfSecondMilestone !== undefined &&
    firstOfSecondMilestone.declaredDependsOn.length === 0 &&
    firstOfSecondMilestone.orderedAfter.includes('T3.1.8'),
  'milestones are gated, so the next one waits for this one (PLAN section 4)',
);

process.stdout.write('\n4. It schedules — without dispatching anything\n');

const report = await dryRunPlan(graph, 4);

check('nothing was dispatched', report.dispatched === 0);
check(
  'every task was scheduled',
  report.order.length === graph.tasks.length,
  `${String(report.order.length)} of ${String(graph.tasks.length)}`,
);

const position = new Map(report.order.map((id, index) => [id, index]));
const violations = graph.tasks.flatMap((task) =>
  task.dependsOn
    .filter(
      (dependency) => (position.get(dependency) ?? -1) > (position.get(task.id) ?? -1),
    )
    .map((dependency) => `${task.id} ran before ${dependency}`),
);
check(
  'no task was scheduled before something it depends on',
  violations.length === 0,
  violations.join('; '),
);

const phaseOf = new Map(graph.tasks.map((task) => [task.id, task.phase]));
const phaseOrder = ['P3', 'P4', 'P5'];
const outOfPhase = report.order.filter((id, index) => {
  if (index === 0) {
    return false;
  }
  const previous = report.order[index - 1];
  return (
    phaseOrder.indexOf(phaseOf.get(id) ?? '') <
    phaseOrder.indexOf(phaseOf.get(previous) ?? '')
  );
});
check(
  'plan phases stay in order (PLAN section 4)',
  outOfPhase.length === 0,
  outOfPhase.join(', '),
);

process.stdout.write('\n5. What would run in parallel\n');
report.waves.forEach((wave, index) => {
  process.stdout.write(`  wave ${String(index + 1)}: ${wave.join(', ')}\n`);
});

check(
  'the graph is genuinely parallel, not a chain with extra steps',
  report.waves.some((wave) => wave.length > 1),
  `widest wave: ${String(Math.max(...report.waves.map((wave) => wave.length)))} tasks`,
);
check(
  'and it is not one flat wave either',
  report.waves.length > 1,
  `${String(report.waves.length)} waves`,
);

process.stdout.write(
  failures.length === 0
    ? '\nT2.2.7 verification passed\n\n'
    : `\nT2.2.7 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
