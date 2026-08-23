/**
 * M1.3 verification — full Definition phase on a sample project.
 *
 *   elicitation chat → researcher surveys prior art → analyst drafts the
 *   Definition artifact → adversarial review → gate packet → operator
 *   approval → tagged artifact → replay
 *
 * Makes real model calls. Not part of `npm run check` or CI: CI has no
 * credentials, and a verification that silently skipped itself would be worse
 * than none. Run with `npm run demo:definition`.
 *
 * The operator's answers are scripted so the run is repeatable; the agents,
 * the gate evaluation and the artifacts are entirely real.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore,
  ClaudeAgentProvider,
  EventLog,
  gateOracleFromState,
  kernelRegistry,
  listGateTags,
  openDatabase,
  Projector,
  SnapshotStore,
  projectArtifactSchemas,
  projectOutputSchemas,
  runCli,
  ScriptedIo,
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

const ANSWERS = [
  'Librarians lose track of who has which book. Loans are written in a paper ledger.',
  'Librarians manage loans; members need to see what they have out and when it is due.',
  'It must run on the existing school intranet. No cloud services.',
  'Success means no loan records are lost over a full term, and members stop emailing to ask what they have out.',
  'Out of scope: replacing the catalogue, and anything to do with purchasing.',
  'Assume member records already exist in the school directory.',
];

const workspace = mkdtempSync(join(tmpdir(), 'mpgm-m13-'));

try {
  for (const directory of ['roles', 'phases', 'kb']) {
    cpSync(join(projectRoot, directory), join(workspace, directory), { recursive: true });
  }
  // A git repo of its own, so the gate tag lands here and not in mpgm.
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'mpgm demo'], { cwd: workspace });
  writeFileSync(join(workspace, '.gitignore'), '.mpgm/\n');
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '--quiet', '-m', 'Sample project'], { cwd: workspace });

  const lines = [];
  const io = new ScriptedIo(ANSWERS);
  const context = {
    root: workspace,
    provider: new ClaudeAgentProvider(),
    io,
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

  process.stdout.write('\n1. Elicitation dialogue\n\n');
  const chat = await call(
    [
      'chat',
      'definition',
      '--run',
      'r1',
      '--brief',
      'A tool for tracking school library loans.',
    ],
    { echo: false },
  );
  if (!chat.result.ok) {
    process.stdout.write(`${chat.output}\n`);
  }
  for (const asked of io.asked) {
    process.stdout.write(`  Q: ${asked.question}\n`);
  }
  check('elicitation produced an artifact', chat.result.ok, chat.output);

  process.stdout.write('\n2. Definition phase\n');
  const ran = await call(['run', 'definition', '--run', 'r1']);
  check('the phase ran to its gate', ran.result.ok, ran.output);
  check('a gate packet was presented', ran.output.includes('Gate: definition-gate'));
  check(
    'the packet is not a bare proceed (HIL-4)',
    ran.output.includes('Options') &&
      ran.output.includes('Trade-offs') &&
      ran.output.includes('Recommendation:'),
  );
  check('the gate was not auto-approved (HIL-1)', ran.output.includes('Approve with:'));

  process.stdout.write('\n3. Operator approval\n');
  const approved = await call([
    'approve',
    'definition-gate',
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
  check(
    'the artifact is tagged (ADR-3)',
    listGateTags(workspace).length > 0,
    listGateTags(workspace).join(', '),
  );

  process.stdout.write('\n4. Prior art (DEF-3)\n');
  const priorArtPath = join(workspace, 'artifacts', 'definition', 'prior-art.v1.md');
  const priorArt = readFileSync(priorArtPath, 'utf8');
  process.stdout.write(`${priorArt.split('\n').slice(0, 30).join('\n')}\n`);
  check(
    'the survey attributes its claims to sources (DEF-3)',
    priorArt.includes('https://') && priorArt.includes('kind:'),
  );
  check('the survey says what it could not find', priorArt.includes('gaps'));

  process.stdout.write('\n5. The artifact\n');
  const briefPath = join(workspace, 'artifacts', 'definition', 'brief.v1.md');
  const brief = readFileSync(briefPath, 'utf8');
  process.stdout.write(`${brief.split('\n').slice(0, 40).join('\n')}\n`);
  check(
    'the Definition artifact exists and is attributable (ART-1)',
    brief.includes('role: analyst'),
  );
  check(
    'it records every DEF-1 field',
    [
      'problem',
      'goals',
      'nonGoals',
      'stakeholders',
      'constraints',
      'assumptions',
      'successMetrics',
    ].every((field) => brief.includes(field)),
  );

  process.stdout.write('\n6. Immutability\n');

  // Re-running is refused before any task is dispatched, so this costs nothing.
  const second = await call(['run', 'definition', '--run', 'r1'], { echo: false });
  check(
    'an approved phase refuses to re-run without a reopen',
    !second.result.ok && second.output.includes('already approved'),
    second.output.split('\n')[0] ?? '',
  );

  // The freeze itself, rather than the fact that write() makes successors —
  // the previous version of this check passed for a reason unrelated to its
  // name, because write() always creates a successor whether gated or not.
  const db = openDatabase(join(workspace, '.mpgm', 'state.db'));
  try {
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    const projector = new Projector({
      log,
      snapshots: SnapshotStore.attach(db),
      interval: 50,
    });
    const store = new ArtifactStore({
      root: workspace,
      schemas: projectArtifactSchemas(),
      gates: gateOracleFromState(projector.project(), 'r1'),
    });
    const request = {
      id: 'definition-brief',
      basePath: 'artifacts/definition/brief.md',
      schema: 'definition',
      data: store.read('artifacts/definition/brief.md', 1).data,
      producedBy: {
        task: 'draft-brief',
        role: 'analyst',
        model: 'claude-sonnet-5',
        runId: 'r1',
      },
    };

    let refused = false;
    try {
      store.overwrite(request, 1);
    } catch {
      refused = true;
    }
    check('the approved version cannot be overwritten (ART-1)', refused);
    check('a successor version can still be created', store.write(request).version === 2);
  } finally {
    db.close();
  }

  process.stdout.write('\n7. Replay\n');
  const replayed = await call(['replay', '--run', 'r1']);
  check('replay reproduces the run from the log alone (ORC-3)', replayed.result.ok);

  process.stdout.write('\n8. Status\n');
  await call(['status', '--run', 'r1']);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nM1.3 verification passed\n\n'
    : `\nM1.3 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
