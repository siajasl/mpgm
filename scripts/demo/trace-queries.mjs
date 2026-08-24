/**
 * T2.2.5 verification — the trace queries on the sample project.
 *
 * Offline and part of `npm run check`: the traceability graph is derived from
 * artifact frontmatter and commit trailers (ADR-4), so nothing here needs a
 * model. A query demo that could only be run with credentials would be a query
 * demo nobody ran.
 *
 * Builds the three-layer sample project — requirements, design, plan — commits
 * it with `Verifies:` trailers on some requirements and not others, and then
 * asks the questions ART-2 and TST-2 exist to answer.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  projectArtifactSchemas,
  projectOutputSchemas,
  runCli,
} from '../../dist/index.js';
import { DESIGN, PLAN, SCOPE } from './sample-project.mjs';

const failures = [];

function check(label, condition, detail = '') {
  process.stdout.write(
    `  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) {
    failures.push(label);
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'mpgm-t225-'));

try {
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm demo'], { cwd: workspace });
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');

  const store = new ArtifactStore({ root: workspace, schemas: projectArtifactSchemas() });
  const seeded = (task, role) => ({ task, role, model: '(seeded)', runId: 'r1' });

  store.write({
    id: 'requirement-set',
    basePath: 'artifacts/scope/requirements.md',
    schema: 'scope',
    data: SCOPE,
    producedBy: seeded('derive-requirements', 'requirements-analyst'),
  });
  store.write({
    id: 'design',
    basePath: 'artifacts/design/design.md',
    schema: 'design',
    data: DESIGN,
    producedBy: seeded('record-design', 'design-architect'),
  });
  store.write({
    id: 'plan',
    basePath: 'artifacts/plan/plan.md',
    schema: 'plan',
    data: PLAN,
    producedBy: seeded('decompose', 'planner'),
  });

  const commit = (message) => {
    execFileSync('git', ['add', '--all'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', message], {
      cwd: workspace,
    });
  };

  commit('Add the sample project artifacts');
  // Two requirements get a test; the rest deliberately do not, so the coverage
  // report has something to report rather than a wall of green.
  commit('Add the loan ledger\n\nImplements: LOAN-1\nVerifies: LOAN-1, NFR-1\n');
  commit('Add the return endpoint\n\nImplements: LOAN-2\nVerifies: LOAN-2\n');
  // Prose, not a trailer: this must not create a link.
  commit('Tidy the README\n\nMentions LOAN-3 in passing but declares nothing.\n');

  const lines = [];
  const context = {
    root: workspace,
    provider: {
      run: () => Promise.reject(new Error('the trace demo makes no model calls')),
    },
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

  process.stdout.write('\n1. One requirement, both directions (ART-2)\n');
  const loan1 = await call(['trace', 'LOAN-1']);
  check('the requirement is found', loan1.result.ok, loan1.output.split('\n')[0] ?? '');
  check(
    'it says which artifact declared it',
    loan1.output.includes('artifacts/scope/requirements.v1.md'),
  );
  check(
    'the design and the plan both show as tracing to it',
    loan1.output.includes('design@1') && loan1.output.includes('T1.1.1'),
  );
  check(
    'a change to it would reach the plan (ORC-6)',
    loan1.output.includes('plan@1'),
    (loan1.output.split('\n').at(-1) ?? '').trim(),
  );

  process.stdout.write('\n2. A decision, not a requirement\n');
  const adr = await call(['trace', 'ADR-3']);
  check(
    'an ADR is a first-class node, declared by the design',
    adr.result.ok && adr.output.includes('artifacts/design/design.v1.md'),
    adr.output.split('\n')[1] ?? '',
  );
  check('the plan task that implements it traces to it', adr.output.includes('T2.1.2'));

  process.stdout.write('\n3. Requirement coverage (TST-2)\n');
  const coverage = await call(['trace', '--coverage']);
  const summary = coverage.output.split('\n')[0] ?? '';
  check('a coverage report is produced', coverage.result.ok, summary);
  // Row ids only: ADRs and plan tasks legitimately appear in the "traced by"
  // column, and a naive substring check would pass by accident either way.
  const reported = [
    ...coverage.output.matchAll(/^ {2}(?:verified|UNVERIFIED)\s+(\S+)/gm),
  ].map((match) => match[1]);
  check(
    'only requirements are reported, not ADRs or plan tasks',
    reported.length > 0 &&
      reported.every((id) => SCOPE.requirements.some((entry) => entry.id === id)),
    reported.join(', '),
  );
  check(
    'requirements with a Verifies: trailer count as verified',
    /verified\s+LOAN-1/.test(coverage.output) && /verified\s+NFR-1/.test(coverage.output),
  );
  check('requirements without one do not', coverage.output.includes('UNVERIFIED LOAN-3'));
  check(
    'being designed for is not being verified',
    coverage.output.includes('but nothing verifies it'),
    'a design element citing a requirement is not evidence that anything checks it',
  );
  check(
    'prose in a commit body verifies nothing',
    !/verified\s+LOAN-3/.test(coverage.output),
  );
  check(
    'the summary counts what it listed',
    summary.includes(`/${String(SCOPE.requirements.length)} verified`),
    summary,
  );

  process.stdout.write('\n4. Citations that resolve to nothing\n');
  const clean = await call(['trace', '--dangling']);
  check(
    'the sample project has none',
    clean.result.ok && clean.output.includes('No citation resolves to nothing'),
    clean.output,
  );

  // A plan citing a requirement nobody declared is the failure ART-2 exists to
  // catch, so the demo creates one rather than asserting the happy path twice.
  const broken = structuredClone(PLAN);
  broken.phases[0].milestones[0].tasks[0].tracesTo = ['LOAN-1', 'NFR-9'];
  store.write({
    id: 'plan',
    basePath: 'artifacts/plan/plan.md',
    schema: 'plan',
    data: broken,
    producedBy: seeded('replan', 'planner'),
  });
  commit('Revise the plan against a requirement that does not exist');

  const dangling = await call(['trace', '--dangling']);
  check(
    'a citation of a requirement that does not exist is reported',
    !dangling.result.ok && dangling.output.includes('NFR-9'),
    dangling.output.split('\n').slice(0, 2).join(' '),
  );
  check(
    'and it names the task that made it, not just the artifact',
    dangling.output.includes('T1.1.1'),
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT2.2.5 verification passed\n\n'
    : `\nT2.2.5 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
