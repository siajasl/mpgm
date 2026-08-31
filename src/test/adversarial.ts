import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Adversarial test generation (TST-4, DESIGN §4.2, §4.7).
 *
 * TST-4 asks for tests *beyond the implementer's own*: an author writes the
 * cases that show the code doing what they meant it to do, and those are
 * exactly the cases the code was written against. The adversarial tester is a
 * separate role, reading the same subject with the opposite intent — the
 * argument nobody validated, the value at the edge of the range, the
 * invariant that holds on the three inputs the author happened to try.
 *
 * What that role returns is *data* on the way in — a suite of cases, each with
 * an id, the class of attack it makes and a test body, validated before
 * anything is done with it, which is why the role needs no shell and no
 * writable path (SAF-3, DESIGN §4.2). It does not stay data: the kernel
 * renders the suite into one `node:test` file (`renderSuite`), hands it to an
 * executor, and an executor runs it. Where that boundary is crossed, and on
 * what assumption, is written at {@link nodeTestExecutor}; the one thing this
 * module keeps out of a case body's reach is the kernel's environment, and
 * nothing else here confines one or should be read as doing so.
 * The verdict is then folded from what comes back, keyed by case id
 * (`adversarialVerdict`). Two things follow from that split. A case that
 * fails is attributable — it names the defect it found in the tester's own
 * words, which is what a defect artifact (T3.2.4) needs and what a raw
 * runner log does not have. And a case the runner never reported on is not
 * silently a pass: the kernel knows what it asked for, so absence is
 * `not-reported` and keeps the suite from reading as clean (CONV-4, the same
 * rule `ci.checks` applies to a required check nobody ran).
 */

/**
 * The classes of case TST-4 requires. Not a taxonomy for its own sake: each
 * one is a different way of being wrong, and a suite that skips one has left
 * that way of being wrong untested.
 */
export const adversarialCaseKinds = ['negative', 'boundary', 'property'] as const;

export type AdversarialCaseKind = (typeof adversarialCaseKinds)[number];

/**
 * Case ids are kebab-case, and that is load-bearing rather than cosmetic: the
 * id is written into the rendered file as a single-quoted test name and read
 * back out of the runner's report to match a result to the case that asked
 * for it. Constraining the character set means neither step has to escape
 * anything, so a case cannot be named in a way that breaks the file it is
 * rendered into (CONV-5).
 */
const caseId = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be lowercase kebab-case, e.g. 'ways-zero-is-refused'",
  );

/**
 * The module the suite attacks, as the rendered file will import it.
 *
 * Relative-only, and within the character set a specifier can be written in
 * without quoting. What that buys is a specifier the renderer can put between
 * single quotes and the runner can then resolve: the rendered file is written
 * into the project under test, so a relative specifier resolves against it,
 * where `node:fs`, an absolute path or an installed package resolves against
 * something the run was not asked about and reports on a module nobody chose.
 * The character set is the rendering half of the same point — a quote or a
 * newline in the string would close the import statement and continue in code,
 * and constraining the shape means the renderer never has to escape (CONV-5).
 *
 * It is **not** a confinement boundary and nothing may be built on it as one.
 * `body` is unconstrained JavaScript that {@link nodeTestExecutor} writes into
 * the project and executes, so a case reaches whatever the harness reaches —
 * the kernel's credentials excepted, which the executor withholds — whatever
 * `subject` names: `await import('node:fs')` inside a body gets everything a
 * subject of `node:fs` would have got, and this regex sees none of it. The
 * trust assumption that actually governs a run is stated at
 * {@link nodeTestExecutor}.
 */
const subjectSpecifier = z
  .string()
  .regex(
    /^\.{1,2}\/[A-Za-z0-9._\-/]+$/,
    "must be a relative specifier for a module inside the project under test, e.g. './split.mjs'",
  );

export const adversarialCaseSchema = z.object({
  id: caseId,
  kind: z.enum(adversarialCaseKinds),
  /** What the case attacks, in the tester's words. */
  about: z.string().min(1),
  /**
   * What it would mean if this case failed.
   *
   * Required, because a failing case is a defect report and a defect report
   * that says only "assertion failed" makes whoever reads it re-derive why
   * the case existed (CONV-3). It is also what a Defect artifact (T3.2.4)
   * files.
   */
  defect: z.string().min(1),
  /**
   * The test body: JavaScript, run with `subject` (the module under test),
   * `assert` (`node:assert/strict`) and `test`'s own context in scope.
   */
  body: z.string().min(1),
});

export type AdversarialCase = z.infer<typeof adversarialCaseSchema>;

/**
 * A generated suite (TST-4).
 *
 * The refinement is the point of the schema: a suite missing a whole class of
 * case cannot be represented, rather than being caught by a gate criterion
 * somebody has to write and keep (CONV-5). TST-4 names three classes, and an
 * adversarial tester that returns nine happy-path cases and calls it a suite
 * is the failure mode this exists to make impossible — it is also the one a
 * reviewer is least likely to notice, because the suite looks thorough.
 */
export const adversarialSuiteSchema = z
  .object({
    subject: subjectSpecifier,
    summary: z.string().min(1),
    cases: z.array(adversarialCaseSchema).min(adversarialCaseKinds.length),
  })
  .refine(
    (suite) => new Set(suite.cases.map((entry) => entry.id)).size === suite.cases.length,
    {
      error:
        'case ids must be unique — results come back keyed by id, and two cases ' +
        'sharing one means a failure cannot be attributed to either',
      path: ['cases'],
    },
  )
  .refine(
    (suite) =>
      adversarialCaseKinds.every((kind) =>
        suite.cases.some((entry) => entry.kind === kind),
      ),
    {
      error: `a suite must carry at least one case of every kind TST-4 names: ${adversarialCaseKinds.join(', ')}`,
      path: ['cases'],
    },
  );

export type AdversarialSuite = z.infer<typeof adversarialSuiteSchema>;

/** One line of provenance on a file nobody should edit by hand. */
const GENERATED_HEADER =
  '// Generated from an adversarial-tester session (TST-4). Edits are lost on the\n' +
  '// next render: the suite this came from is the artifact, not this file.';

function commentSafe(text: string): string {
  // Collapsed to one line: `about` is prose and may contain newlines, and a
  // newline inside a `//` comment turns the rest of the sentence into code.
  return text.replace(/\s+/g, ' ').trim();
}

function renderCase(testCase: AdversarialCase): string {
  const body = testCase.body
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `  ${line}`))
    .join('\n');

  return [
    `// ${testCase.kind}: ${commentSafe(testCase.about)}`,
    // Async whatever the body does: a case that awaits a rejected promise is
    // an ordinary negative case, and a renderer that only emits synchronous
    // tests would make it unwritable.
    `test('${testCase.id}', async () => {`,
    body,
    '});',
  ].join('\n');
}

/**
 * Render a suite into one `node:test` file.
 *
 * Every case becomes a test named by its id, which is how the verdict matches
 * a result back to the case that asked for it — one file rather than one per
 * case, because a suite is reported on as a whole and the runner's own
 * ordering is then the suite's.
 */
export function renderSuite(suite: AdversarialSuite): string {
  return [
    GENERATED_HEADER,
    `// Subject: ${suite.subject}`,
    `// ${commentSafe(suite.summary)}`,
    '',
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import * as subject from '${suite.subject}';`,
    '',
    suite.cases.map(renderCase).join('\n\n'),
    '',
  ].join('\n');
}

/** One case's result, as an executor read it out of the runner's report. */
export interface AdversarialExecution {
  readonly id: string;
  readonly passed: boolean;
  /** What the runner said — an assertion message, a stack. Empty is allowed. */
  readonly detail: string;
}

/**
 * Runs a rendered suite and reports per-case results.
 *
 * Injected rather than fixed, for the same reason `test.nfr` takes a `run`:
 * how a project executes tests is the project's business (EXT-1), and the
 * kernel's business is what the results mean.
 */
export type AdversarialExecutor = (
  source: string,
) => Promise<readonly AdversarialExecution[]>;

/**
 * `not-reported` is the fail-closed case: the suite declared the case, the
 * runner said nothing about it, and the kernel refuses to read silence as a
 * pass (CONV-4).
 */
export type AdversarialOutcome = 'passed' | 'failed' | 'not-reported';

export interface AdversarialCaseResult {
  readonly id: string;
  readonly kind: AdversarialCaseKind;
  readonly about: string;
  /** The tester's own account of what a failure means. */
  readonly defect: string;
  readonly outcome: AdversarialOutcome;
  readonly detail: string;
}

export interface AdversarialVerdict {
  readonly rows: readonly AdversarialCaseResult[];
  /**
   * Cases that failed. Each is a defect the suite caught in the subject —
   * this is what TST-4 exists to produce and what T3.2.4 files.
   */
  readonly defects: readonly AdversarialCaseResult[];
  /** Cases the runner never reported on. Not defects; not passes either. */
  readonly notReported: readonly AdversarialCaseResult[];
  /** True only when every declared case ran and passed. */
  readonly clean: boolean;
}

/**
 * Raised when an executor reports a case the suite never declared (CONV-4).
 *
 * The kernel knows exactly which cases it asked to be run, so a result under
 * an id it did not send is a disagreement about what was executed: a stale
 * file left in the working directory, a runner that picked up the project's
 * own tests as well, or results from another suite entirely. Every one of
 * those makes the verdict a statement about something other than this suite,
 * and dropping the extra row would hide the disagreement while keeping the
 * verdict — the same trade `NfrMismatchError` refuses.
 */
export class AdversarialResultMismatchError extends Error {
  readonly declared: readonly string[];
  readonly unexpected: readonly string[];

  constructor(declared: readonly string[], unexpected: readonly string[]) {
    super(
      `the test run reported ${String(unexpected.length)} case(s) this suite never ` +
        `declared: ${unexpected.join(', ')}. The suite declared: ` +
        `${declared.join(', ') || '(none)'}. Refusing the verdict rather than ` +
        `dropping the extra results, since they mean the run executed something ` +
        `other than this suite — a stale generated file in the working directory, ` +
        `or the project's own tests picked up alongside it (CONV-4)`,
    );
    this.name = 'AdversarialResultMismatchError';
    this.declared = declared;
    this.unexpected = unexpected;
  }
}

/**
 * Fold executions into a per-case verdict.
 *
 * Pure, so a verdict replays from the log without re-running a suite against
 * a subject that has since been fixed (as `nfrCoverage` is, and for the same
 * reason). Where an executor reports the same case twice — a rerun folded
 * into one report — the last result wins, since it is the one that ran last.
 */
export function adversarialVerdict(
  suite: AdversarialSuite,
  executions: readonly AdversarialExecution[],
): AdversarialVerdict {
  const declared = suite.cases.map((entry) => entry.id);
  const declaredIds = new Set(declared);
  const unexpected = [
    ...new Set(
      executions
        .filter((execution) => !declaredIds.has(execution.id))
        .map((execution) => execution.id),
    ),
  ];
  if (unexpected.length > 0) {
    throw new AdversarialResultMismatchError(declared, unexpected);
  }

  const byId = new Map(executions.map((execution) => [execution.id, execution]));

  const rows = suite.cases.map((entry): AdversarialCaseResult => {
    const execution = byId.get(entry.id);
    return {
      id: entry.id,
      kind: entry.kind,
      about: entry.about,
      defect: entry.defect,
      outcome:
        execution === undefined ? 'not-reported' : execution.passed ? 'passed' : 'failed',
      detail: execution?.detail ?? '',
    };
  });

  const defects = rows.filter((row) => row.outcome === 'failed');
  const notReported = rows.filter((row) => row.outcome === 'not-reported');

  return {
    rows,
    defects,
    notReported,
    clean: defects.length === 0 && notReported.length === 0,
  };
}

export interface RunAdversarialSuiteOptions {
  readonly suite: AdversarialSuite;
  readonly execute: AdversarialExecutor;
}

/**
 * The whole of the orchestration: render the suite, run it, read the verdict.
 */
export async function runAdversarialSuite(
  options: RunAdversarialSuiteOptions,
): Promise<AdversarialVerdict> {
  const executions = await options.execute(renderSuite(options.suite));
  return adversarialVerdict(options.suite, executions);
}

/**
 * Raised when a run produced nothing a verdict may be folded from (CONV-3,
 * CONV-4). See {@link executionsFromRun} for which runs those are.
 *
 * Folding such a run anyway would produce a verdict that is technically true
 * and useless: six cases `not-reported`, or a suite that reads as clean
 * because the runner was killed before it could say otherwise. The
 * interesting fact is *why* — a syntax error in a generated body, a subject
 * that does not resolve, a case that loops for ever, a missing runtime. That
 * reason is in the runner's own output and nowhere else, so it travels with
 * the error, along with the rendered source, since the file it was written to
 * is gone by the time anybody reads this.
 */
export class AdversarialRunError extends Error {
  readonly source: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(detail: string, source: string, exitCode: number | null, stderr: string) {
    super(
      `the generated adversarial suite produced no verdict: ${detail}. ` +
        `Exit code ${exitCode === null ? '(killed)' : String(exitCode)}. ` +
        `Runner output:\n${stderr.trim() || '(empty)'}\n` +
        `The rendered suite is on this error's \`source\` property.`,
    );
    this.name = 'AdversarialRunError';
    this.source = source;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * The name of a case, out of a TAP result line's description.
 *
 * A description may carry a directive — `# SKIP`, `# TODO`, and Node's own
 * `# type=testPointer` — which is a statement about the run and not part of
 * the name, so it is cut at the first `#` that follows whitespace. Scanned
 * rather than matched, because the regex that expresses this is ambiguous with
 * the description in front of it and backtracks quadratically on a long run of
 * spaces (CodeQL js/polynomial-redos); a single pass cannot.
 *
 * The remainder is right-trimmed: padding a runner added to align its columns
 * is no more part of the name than the directive is, and an id carrying it
 * matches no case the suite declared.
 */
function tapDescription(rest: string): string {
  for (let index = 1; index < rest.length; index += 1) {
    const previous = rest[index - 1];
    if (rest[index] === '#' && (previous === ' ' || previous === '\t')) {
      return rest.slice(0, index).trimEnd();
    }
  }
  return rest.trimEnd();
}

/**
 * Read per-case results out of TAP 13, as `node --test --test-reporter=tap`
 * emits it.
 *
 * Results are read at any indentation. Node's TAP nests differently depending
 * on how it decided to run the file — a test may be reported at the top level
 * or as a subtest of the file it came from — and a parser that only accepted
 * top-level results would read a whole suite as unreported on a runtime that
 * chose the other shape. Depth carries no meaning for a rendered suite in any
 * case: it is one flat test per case, so every result line is a case (or the
 * file's own summary row, which {@link nodeTestExecutor} drops).
 *
 * A failing result's indented YAML block follows it, and is kept verbatim
 * rather than parsed: the point is to hand a person the assertion they need,
 * not to model the runner's report format.
 */
export function parseTapResults(output: string): AdversarialExecution[] {
  const results: AdversarialExecution[] = [];
  // The description is read as `(\S.*)` and its trailing directive stripped by
  // {@link tapDescription}, rather than as a lazy `(.*?)` followed by an
  // optional `\s+#.*`: `.` matches a space, so the lazy group and the
  // whitespace in front of a directive overlap, and a result line carrying a
  // long run of spaces backtracks quadratically (CodeQL js/polynomial-redos).
  // A runner's output is exactly the kind of string nobody bounds.
  const resultLine = /^([ \t]*)(not )?ok[ \t]+\d+[ \t]+-[ \t]+(\S.*)?$/;

  let pending:
    { id: string; passed: boolean; indent: number; detail: string[] } | undefined;
  const flush = (): void => {
    if (pending !== undefined) {
      results.push({
        id: pending.id,
        passed: pending.passed,
        detail: pending.detail.join('\n'),
      });
      pending = undefined;
    }
  };

  for (const crlfLine of output.split('\n')) {
    // A CRLF report leaves a `\r` on the end of every line once the output is
    // split on '\n', and `.` does not match it: left on, it stops a result
    // line being recognised at all, so a whole suite reads as `not-reported`.
    const raw = crlfLine.endsWith('\r') ? crlfLine.slice(0, -1) : crlfLine;
    const match = resultLine.exec(raw);
    if (match !== null) {
      flush();
      pending = {
        id: tapDescription(match[3] ?? ''),
        passed: match[2] === undefined,
        indent: (match[1] ?? '').length,
        detail: [],
      };
      continue;
    }
    const indent = /^(\s*)\S/.exec(raw)?.[1]?.length;
    if (pending !== undefined && !pending.passed && indent !== undefined) {
      if (indent <= pending.indent) {
        flush();
        continue;
      }
      const trimmed = raw.trim();
      if (trimmed !== '---' && trimmed !== '...') {
        pending.detail.push(trimmed);
      }
    }
  }
  flush();

  return results;
}

/**
 * TAP rows that report on a *file* rather than on a case.
 *
 * Node reports the file it ran as a test of its own when it nests subtests,
 * and reports it as failed when anything inside it failed. That row is not a
 * case, and letting it through would make every run disagree with the suite
 * that produced it. It is recognised by its name being a module path, which a
 * case id can never be — ids are kebab-case, so no id contains a dot or a
 * slash. Anything else keeps its row, and is refused by the verdict
 * (CONV-4): dropping unrecognised results by shape would quietly discard the
 * disagreement the check exists to surface.
 */
function isFileRow(id: string): boolean {
  return /\.(?:mjs|cjs|js|ts)$/.test(id);
}

/**
 * Variables a generated suite's process keeps from the kernel's environment.
 *
 * An allowlist, not a denylist, because the question "does this variable hold
 * a credential?" has no reliable answer and a wrong answer here is a leak
 * (CONV-4): a variable nobody thought about is dropped rather than passed.
 * What is here is what a `node` child needs to start and to find a temporary
 * directory — on Windows, spawning fails outright without `SystemRoot` and
 * `ComSpec`.
 *
 * `NODE_OPTIONS` is conspicuously absent. It is the one variable whose value
 * is executed rather than read, and the process it would be executed in is
 * running model-authored code already.
 *
 * Names are matched case-insensitively: Windows preserves the case it was
 * given (`Path`, `SystemRoot`) but resolves without it, so a case-sensitive
 * list would drop `Path` and leave the child unable to spawn anything.
 */
export const testEnvironmentAllowlist: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  // Windows: without these a child process does not start at all.
  'SystemRoot',
  'SystemDrive',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'WINDIR',
];

/**
 * The environment a generated suite is run with, by default.
 *
 * The secret broker's first layer of control is that a credential is simply
 * *not there* to be read — every agent session is given
 * `SecretBroker.environment(process.env)` rather than the kernel's own
 * (src/secret/broker.ts, SAF-2, ADR-6). A case body is model-authored code
 * written by a session that has just read an arbitrary repository, which may
 * carry instructions of its own (SAF-3); handing that process the kernel's
 * environment would put `process.env.GITHUB_TOKEN` back within reach on a
 * path the broker never sees, and the value could leave over a socket without
 * ever passing log-write redaction. So this path scrubs too, and scrubs
 * harder than the broker does: the broker removes what it knows to be secret,
 * while a suite process is given only what it is known to need.
 *
 * This is the one part of the exposure at {@link nodeTestExecutor} that
 * needs no sandbox to close. The rest — the filesystem, the network — still
 * does.
 */
export function testEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const allowed = new Set(testEnvironmentAllowlist.map((name) => name.toLowerCase()));
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && allowed.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

export interface NodeTestExecutorOptions {
  /**
   * Directory the rendered suite is written into and run from. The suite's
   * `subject` resolves relative to it, so this is the project under test.
   */
  readonly projectDir: string;
  /** Wall-clock bound on the run. A generated case can loop for ever. */
  readonly timeoutMs?: number;
  /**
   * Environment for the suite's process. Defaults to {@link testEnvironment},
   * which keeps only what a `node` child needs — a project whose subject reads
   * configuration from the environment passes it here, one variable at a
   * time. Passing `process.env` restores inheritance, and gives a case body
   * every credential the kernel holds; nothing stops a caller doing that, and
   * nothing should read it as supported.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** What a finished suite process leaves behind for the verdict to be read from. */
export interface TestRunOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** Whether the kernel killed it for exceeding its wall-clock bound. */
  readonly timedOut: boolean;
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<TestRunOutcome> {
  return new Promise((resolve, reject) => {
    // `env` is passed explicitly rather than merged into `process.env`:
    // spawn's default is inheritance, so an omitted option is the leak.
    const child = spawn(command, [...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/**
 * The case results a finished run may be folded into a verdict from — or the
 * error saying why it may not (CONV-3, CONV-4).
 *
 * A run reports two things, and a verdict is only sound when they agree: the
 * TAP the runner printed, and how the process ended. Reading the first and
 * discarding the second is how a partial run reads as a whole one, so both
 * disagreements are refused rather than folded:
 *
 * - **The run was killed.** Whatever it managed to print, it did not finish,
 *   and the cases it never reached would fold as `not-reported` — true, but a
 *   description of a suite the runner declined to report rather than of a
 *   timeout. Worse, the results it did print are then trusted: a body that
 *   prints its own TAP and then hangs would be reporting on itself. A killed
 *   run is not a report.
 * - **Every reported case passed, and the process still failed.** The runner
 *   exits non-zero when a case fails, so that is expected next to a failure
 *   and a contradiction next to none: an unhandled rejection after the last
 *   case, a subject whose import crashed the process, a file row nobody
 *   parsed. Something happened that the report does not describe, and a clean
 *   verdict is the one verdict it must not produce.
 */
export function executionsFromRun(
  outcome: TestRunOutcome,
  context: { source: string; command: string; timeoutMs: number },
): AdversarialExecution[] {
  const executions = parseTapResults(outcome.stdout).filter(
    (execution) => !isFileRow(execution.id),
  );
  const fail = (detail: string): never => {
    throw new AdversarialRunError(
      detail,
      context.source,
      outcome.code,
      outcome.stderr || outcome.stdout,
    );
  };

  if (outcome.timedOut) {
    return fail(
      `${context.command} was killed after ${String(context.timeoutMs)}ms, ` +
        `having reported ${String(executions.length)} case result(s) — a case ` +
        `body can loop for ever, and a run that did not finish cannot say ` +
        `which case did`,
    );
  }
  if (executions.length === 0) {
    return fail(`${context.command} reported no tests`);
  }
  if (outcome.code !== 0 && executions.every((execution) => execution.passed)) {
    return fail(
      `${context.command} reported ${String(executions.length)} case(s), all ` +
        'passing, and then exited ' +
        (outcome.code === null ? 'on a signal' : `with code ${String(outcome.code)}`) +
        ' — the run disagrees with its own report, so it is not a clean suite',
    );
  }
  return executions;
}

/**
 * An executor that runs the rendered suite with Node's own test runner.
 *
 * The file is written into the project under test — a generated suite imports
 * the subject by a relative specifier, so it has to sit where that specifier
 * resolves — under a name nothing else will collide with, and removed
 * afterwards whether the run passed, failed or threw. Left behind, it would
 * be picked up by the project's next test run as a test nobody wrote.
 *
 * ## Trust assumption
 *
 * **Case bodies are executed as trusted code, with the privileges the kernel
 * has.** A suite is validated data until this function; here it becomes a file
 * in the project and a child process. Nothing constrains a body: it may
 * `await import('node:fs')`, read anything the harness can read, write outside
 * `projectDir`, or open a socket. In particular the schema's `subject`
 * constraint bounds none of that and is not intended to — a suite is only as
 * trustworthy as the session that generated it, and a tester that has read a
 * repository carrying planted instructions (SAF-3) is exactly the session that
 * assumption is uncomfortable about.
 *
 * That is an assumption and not a control, stated so that nobody builds on a
 * confinement this module does not provide (CONV-4 — a control that is trusted
 * and bypassed is worse than none). It holds only because generated suites are
 * run where the project's own tests already run, on code the harness would
 * have executed anyway. Confinement belongs to the OS layer (ADR-6:
 * sandboxed execution as defense in depth), and this path notably does not
 * pass through the `PreToolUse` policy hook that bounds an agent's own tool
 * calls — the agent never makes the call; the kernel does, on its behalf.
 * Until a sandbox exists, run generated suites where you would run untrusted
 * tests, which is to say not on anything you would mind losing.
 *
 * The assumption stops short of the kernel's *credentials*. The child is given
 * {@link testEnvironment} rather than `process.env`, because the broker's
 * first layer of control is that a secret is not there to be read, and a
 * sibling path that inherits the environment defeats that layer for every
 * secret at once (SAF-2). It is the one piece of confinement available here
 * without an OS to enforce it, so it is not left to one.
 */
export function nodeTestExecutor(options: NodeTestExecutorOptions): AdversarialExecutor {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const env = options.env ?? testEnvironment();

  return async (source: string) => {
    const name = `adversarial-${randomUUID()}.test.mjs`;
    const path = join(options.projectDir, name);
    writeFileSync(path, source, 'utf8');

    try {
      const outcome = await runProcess(
        process.execPath,
        ['--test', '--test-reporter=tap', name],
        options.projectDir,
        env,
        timeoutMs,
      );
      return executionsFromRun(outcome, {
        source,
        command: `'${process.execPath} --test ${name}' in '${options.projectDir}'`,
        timeoutMs,
      });
    } finally {
      rmSync(path, { force: true });
    }
  };
}
