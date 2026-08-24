/**
 * T1.3.6 verification — every CLI verb, end to end.
 *
 * Runs against a scripted provider in a throwaway project, so it exercises the
 * real argument parsing and the real command implementations without making
 * model calls. The live path is the M1.3 demo.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EventLog,
  fingerprint,
  kernelRegistry,
  listGateTags,
  openDatabase,
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
  allResolved: true,
};

const priorArt = {
  summary: 'Two comparable school library systems, both intranet-hosted.',
  systems: [
    {
      name: 'Koha',
      whatItDoes: 'Open-source integrated library system with circulation.',
      relevance: 'Covers loans and returns, and self-hosts on one machine.',
      source: {
        title: 'Koha documentation',
        url: 'https://koha-community.org/documentation/',
        kind: 'primary',
      },
    },
  ],
  gaps: ['Nothing found on paper-ledger migration for schools specifically.'],
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
  // A git repo of its own, so `approve --tag` is actually exercised. Without
  // one the tagging branch is skipped silently, which is how the M1.3 demo
  // shipped with the --tag flag never reaching the command.
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm e2e'], { cwd: workspace });
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '--quiet', '-m', 'sample project'], { cwd: workspace });

  const lines = [];
  const context = {
    root: workspace,
    provider: scriptedProvider([
      // chat: one question, then conclusions. Turns are wrapped under `turn`
      // because a tool input schema must be an object at its top level.
      scriptedSuccess({
        turn: { kind: 'question', question: 'Who uses it?', rationale: 'Stakeholders.' },
      }),
      scriptedSuccess({ turn: { kind: 'conclusions', conclusions } }),
      // run definition: survey-prior-art, draft-brief, then challenge-brief
      scriptedSuccess(priorArt),
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
    'the assertion criterion reads the reviewer attestation, not "it ran"',
    ran.output.includes('challenge-brief.allResolved = true'),
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

  // reject — refusing a gate leaves it shut
  const rejected = await call([
    'approve',
    'definition-gate',
    '--run',
    'r1',
    '--by',
    'macg',
    '--reject',
    '--reason',
    'success metrics are unmeasurable',
  ]);
  check(
    'reject records the decision',
    rejected.output.includes('rejected by macg'),
    rejected.output,
  );
  const afterReject = await call(['status', '--run', 'r1']);
  check(
    'a rejected gate is not approved',
    afterReject.output.includes('gate definition-gate rejected'),
    afterReject.output,
  );

  // A decision naming something that does not exist must be refused before it
  // is appended: the log is append-only, so an unfoldable event is permanent.
  const bogusRun = await call([
    'approve',
    'definition-gate',
    '--run',
    'nope',
    '--by',
    'macg',
  ]);
  check(
    'a decision on an unknown run is refused',
    !bogusRun.result.ok && bogusRun.output.includes('no such run'),
    bogusRun.output,
  );
  const bogusGate = await call([
    'approve',
    'no-such-gate',
    '--run',
    'r1',
    '--by',
    'macg',
  ]);
  check(
    'a decision on an unknown gate is refused, and lists the real ones',
    !bogusGate.result.ok && bogusGate.output.includes('Presented gates: definition-gate'),
    bogusGate.output,
  );

  // approve — the decision is recorded
  const approved = await call([
    'approve',
    'definition-gate',
    '--run',
    'r1',
    '--by',
    'macg',
    '--tag',
  ]);
  check(
    'approve records the decision',
    approved.output.includes('approved by macg'),
    approved.output,
  );
  check(
    'approve --tag writes the derived git tag',
    listGateTags(workspace).length > 0,
    listGateTags(workspace).join(', ') || 'no tags written',
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

  // An approved phase refuses to re-run, so the approval and the artifacts it
  // froze survive a second `mpgm run`.
  const rerun = await call(['run', 'definition', '--run', 'r1']);
  check(
    'an approved phase refuses to re-run without a reopen',
    !rerun.result.ok && rerun.output.includes('already approved'),
    rerun.output,
  );
  const stillApproved = await call(['status', '--run', 'r1']);
  check(
    'the approval survives the attempt',
    stillApproved.output.includes('gate definition-gate approved by macg'),
    stillApproved.output,
  );

  // reopen — ORC-6. A dry run first: reopening costs a phase of work, and an
  // append-only log is not where to discover that.
  const planned = await call([
    'reopen',
    'definition',
    '--run',
    'r1',
    '--reason',
    'the operator revised a goal',
    '--dry-run',
  ]);
  check(
    'reopen --dry-run shows the cascade without recording it',
    planned.result.ok && planned.output.includes('Would reopen'),
    planned.output,
  );
  const notYet = await call(['status', '--run', 'r1']);
  check(
    'the dry run changed nothing',
    notYet.output.includes('gate definition-gate approved by macg'),
    notYet.output,
  );

  const reopened = await call([
    'reopen',
    'definition',
    '--run',
    'r1',
    '--reason',
    'the operator revised a goal',
  ]);
  check(
    'reopen invalidates the phase gate',
    reopened.result.ok && reopened.output.includes('definition-gate'),
    reopened.output,
  );
  const afterReopen = await call(['status', '--run', 'r1']);
  check(
    'the approval is withdrawn, and says so',
    afterReopen.output.includes('definition-gate invalidated'),
    afterReopen.output,
  );

  const refused = await call([
    'reopen',
    'scope',
    '--run',
    'r1',
    '--reason',
    'no such gate here',
  ]);
  check(
    'reopening a phase this run never gated is refused',
    !refused.result.ok && refused.output.includes('no gate for phase'),
    refused.output,
  );

  // trace — the derived graph (ADR-4), and coverage (TST-2)
  const traced = await call(['trace', 'definition-brief@1']);
  check(
    'trace reports the graph around an artifact',
    traced.result.ok && traced.output.includes('declared in'),
    traced.output,
  );

  const coverage = await call(['trace', '--coverage']);
  check(
    'trace --coverage reports requirement coverage',
    coverage.result.ok && coverage.output.includes('Requirement coverage'),
    coverage.output.split('\n')[0] ?? '',
  );

  const dangling = await call(['trace', '--dangling']);
  check(
    'trace --dangling finds nothing to complain about here',
    dangling.result.ok && dangling.output.includes('No citation resolves to nothing'),
    dangling.output,
  );

  const unknownId = await call(['trace', 'NOPE-1']);
  check(
    'trace refuses an id the graph has never seen',
    !unknownId.result.ok && unknownId.output.includes('Nothing in the trace graph'),
    unknownId.output,
  );

  // confirm — SAF-4. A destructive call may only be confirmed once it has
  // actually been simulated: the operator approves what the dry run *did*, and
  // an unknown fingerprint means there was nothing to look at.
  const releaseCall = { environment: 'staging', version: '1.0.0' };
  const print = fingerprint('mcp__deploy__release', releaseCall, 'dryRun');

  const premature = await call(['confirm', print, '--run', 'r1', '--by', 'macg']);
  check(
    'confirming a call nothing simulated is refused',
    !premature.result.ok && premature.output.includes('must be dry-run'),
    premature.output,
  );

  // Record the dry run the way the guard would have, then confirm it.
  {
    const db = openDatabase(join(workspace, '.mpgm', 'state.db'));
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    log.append({
      runId: 'r1',
      type: 'DryRunRecorded',
      payload: {
        taskId: 'draft-brief',
        tool: 'mcp__deploy__release',
        fingerprint: print,
        summary: 'would replace 1 service',
      },
    });
    db.close();
  }

  const confirmed = await call([
    'confirm',
    print,
    '--run',
    'r1',
    '--by',
    'macg',
    '--reason',
    'the simulated effect is the intended one',
  ]);
  check(
    'a simulated call can be confirmed, and says by whom',
    confirmed.result.ok && confirmed.output.includes('confirmed by macg'),
    confirmed.output,
  );

  // implement — the self-hosting entry point (T3.1.8). The sample project has
  // no gated Plan artifact, so the verb refuses rather than dispatching an
  // agent against a task it invented. Getting this wrong would be worse than
  // failing: a run that starts on a plan nobody approved.
  const noPlan = await call([
    'implement',
    'T9.9.9',
    '--repo',
    'example/sample',
    '--run',
    'r1',
  ]);
  check(
    'implement refuses without a gated Plan artifact',
    !noPlan.result.ok && noPlan.output.includes('could not read the gated Plan'),
    noPlan.output.split('\n')[0] ?? '',
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

  // A phase whose required input is absent must refuse to run. Running anyway
  // is how the M1.3 demo produced a confident artifact about material nobody
  // supplied.
  rmSync(join(workspace, 'artifacts', 'definition', 'elicitation.v1.md'), {
    force: true,
  });
  const starved = await call(['run', 'definition', '--run', 'r2']);
  check(
    'a missing required input blocks the phase',
    !starved.result.ok && starved.output.includes('required input'),
    starved.output,
  );
  check(
    'the elicitation artifact was genuinely removed',
    !existsSync(join(workspace, 'artifacts', 'definition', 'elicitation.v1.md')),
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
