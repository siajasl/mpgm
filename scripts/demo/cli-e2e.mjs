/**
 * T1.3.6 verification — every CLI verb, end to end.
 *
 * Runs against a scripted provider in a throwaway project, so it exercises the
 * real argument parsing and the real command implementations without making
 * model calls. The live path is the M1.3 demo.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  projectArtifactSchemas,
  projectOutputSchemas,
  runCli,
  ScriptedIo,
  scriptedSuccess,
  VERBS,
} from '../../dist/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const failures = [];
const exercised = new Set();

function check(label, condition, detail = '') {
  process.stdout.write(
    `  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) {
    failures.push(label);
  }
}

const conclusions = {
  problem: 'Library loans are tracked on paper and get lost.',
  goals: ['Digitise loan records', 'Show members their own loans'],
  nonGoals: ['Replace the catalogue system'],
  stakeholders: ['Librarians', 'Members'],
  constraints: ['Must run on the existing intranet'],
  assumptions: ['Member records already exist'],
  successMetrics: ['No lost loan records over a full term'],
};

const findings = {
  findings: [
    {
      about: 'successMetrics',
      issue: 'A "full term" is not defined anywhere in the brief.',
      resolution: 'Operator confirmed a term is 12 teaching weeks.',
      status: 'resolved',
    },
  ],
  summary: 'One ambiguity found and resolved; the brief otherwise holds up.',
};

/** Scripted sessions, in the order the phase and chat will consume them. */
function scriptedProvider(results) {
  const queue = [...results];
  return {
    run() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('scripted provider exhausted');
      }
      return Promise.resolve(next);
    },
  };
}

const workspace = mkdtempSync(join(tmpdir(), 'mpgm-cli-e2e-'));

try {
  // A throwaway project carrying the real roles, phases and knowledge base.
  for (const directory of ['roles', 'phases', 'kb']) {
    cpSync(join(projectRoot, directory), join(workspace, directory), { recursive: true });
  }

  const lines = [];
  const context = {
    root: workspace,
    provider: scriptedProvider([
      // chat: one question, then conclusions
      scriptedSuccess({
        kind: 'question',
        question: 'Who uses it?',
        rationale: 'Stakeholders.',
      }),
      scriptedSuccess({ kind: 'conclusions', conclusions }),
      // run definition: draft-brief, then challenge-brief
      scriptedSuccess(conclusions),
      scriptedSuccess(findings),
    ]),
    io: new ScriptedIo(['Librarians and members.']),
    outputSchemas: projectOutputSchemas(),
    artifactSchemas: projectArtifactSchemas(),
    write: (line) => lines.push(line),
  };

  const call = async (argv) => {
    lines.length = 0;
    exercised.add(argv[0]);
    const result = await runCli(argv, context);
    return { result, output: lines.join('\n') };
  };

  process.stdout.write('\nCLI verbs\n');

  // chat — elicitation produces an artifact
  const chat = await call([
    'chat',
    'definition',
    '--run',
    'r1',
    '--brief',
    'A library tool.',
  ]);
  check('chat produces an elicitation artifact', chat.result.ok, chat.output);
  check('chat asked the operator', context.io.asked.length === 1);

  // status — before the phase runs
  const early = await call(['status', '--run', 'r1']);
  check(
    'status reports the run',
    early.output.includes('run r1 [running]'),
    early.output,
  );

  // pause / resume — dispatch is refused while paused
  await call(['pause', '--run', 'r1']);
  const paused = await call(['run', 'definition', '--run', 'r1']);
  check(
    'pause stops dispatch',
    !paused.result.ok && paused.output.includes('paused'),
    paused.output,
  );

  const resumed = await call(['resume', '--run', 'r1']);
  check(
    'resume restores dispatch',
    resumed.output.includes('now running'),
    resumed.output,
  );

  // redirect — recorded as an intervention
  const redirected = await call([
    'redirect',
    '--run',
    'r1',
    '--note',
    'focus on overdue fees',
  ]);
  check('redirect is recorded', redirected.result.ok, redirected.output);

  // run — executes the phase and presents the gate
  const ran = await call(['run', 'definition', '--run', 'r1']);
  check(
    'run presents the gate',
    ran.result.ok && ran.output.includes('Gate: definition-gate'),
    ran.output,
  );
  check(
    'the packet carries options, trade-offs and a recommendation',
    ran.output.includes('Options') &&
      ran.output.includes('Trade-offs') &&
      ran.output.includes('Recommendation:'),
  );
  check(
    'the gate is not auto-approved',
    ran.output.includes('Approve with: mpgm approve'),
  );

  // approve — the decision is recorded
  const approved = await call([
    'approve',
    'definition-gate',
    '--run',
    'r1',
    '--by',
    'macg',
  ]);
  check(
    'approve records the decision',
    approved.output.includes('approved by macg'),
    approved.output,
  );

  const after = await call(['status', '--run', 'r1']);
  check(
    'status shows the approved gate',
    after.output.includes('gate definition-gate approved by macg'),
    after.output,
  );
  check(
    'status shows completed tasks',
    after.output.includes('draft-brief completed'),
    after.output,
  );

  // kill — terminal, and resume does not undo it
  await call(['kill', '--run', 'r1']);
  const afterKill = await call(['resume', '--run', 'r1']);
  check('kill is terminal', afterKill.output.includes('now killed'), afterKill.output);

  // replay — reproduces the run from the log alone
  const replayed = await call(['replay', '--run', 'r1']);
  check('replay reproduces the run', replayed.result.ok, replayed.output);
  check(
    'replay reports the whole event sequence',
    replayed.output.includes('RunStarted') &&
      replayed.output.includes('GateApproved') &&
      replayed.output.includes('reproduces the run exactly'),
  );

  // usage and error paths
  const unknown = await call(['nonsense']);
  check(
    'an unknown verb is refused with usage',
    !unknown.result.ok && unknown.output.includes('mpgm run <phase>'),
  );

  process.stdout.write('\nCoverage\n');
  const missing = VERBS.filter((verb) => !exercised.has(verb));
  check(
    'every verb was exercised',
    missing.length === 0,
    missing.length === 0
      ? `${String(VERBS.length)} verbs`
      : `missing: ${missing.join(', ')}`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nCLI end-to-end passed\n\n'
    : `\nCLI end-to-end FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
