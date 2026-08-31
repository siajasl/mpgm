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
 * What that role returns is *data*, not code the kernel imports: a suite of
 * cases, each with an id, the class of attack it makes and a test body. The
 * kernel renders that suite into one `node:test` file (`renderSuite`), hands
 * it to an executor, and folds what comes back into a verdict keyed by case
 * id (`adversarialVerdict`). Two things follow from that split. A case that
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
 * without quoting. A suite that could name `node:fs`, an absolute path or an
 * installed package would be a suite that could reach outside the project it
 * was asked to test, and the cheapest place to refuse that is the schema —
 * the alternative is a check somewhere downstream that has to be remembered
 * (CONV-5).
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
 * Raised when a test run produced no case results at all (CONV-3, CONV-4).
 *
 * Returning an empty list would be read as "every case is `not-reported`",
 * which is true but useless: the interesting fact is *why* nothing ran — a
 * syntax error in a generated body, a subject that does not resolve, a
 * missing runtime. That reason is in the runner's own output and nowhere
 * else, so it travels with the error, along with the rendered source, since
 * the file it was written to is gone by the time anybody reads this.
 */
export class AdversarialRunError extends Error {
  readonly source: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(detail: string, source: string, exitCode: number | null, stderr: string) {
    super(
      `the generated adversarial suite produced no case results: ${detail}. ` +
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
  const line = /^(\s*)(not )?ok\s+\d+\s+-\s+(.*?)(?:\s+#.*)?$/;

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

  for (const raw of output.split('\n')) {
    const match = line.exec(raw);
    if (match !== null) {
      flush();
      pending = {
        id: match[3] ?? '',
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

export interface NodeTestExecutorOptions {
  /**
   * Directory the rendered suite is written into and run from. The suite's
   * `subject` resolves relative to it, so this is the project under test.
   */
  readonly projectDir: string;
  /** Wall-clock bound on the run. A generated case can loop for ever. */
  readonly timeoutMs?: number;
}

interface ProcessOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd });
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
 * An executor that runs the rendered suite with Node's own test runner.
 *
 * The file is written into the project under test — a generated suite imports
 * the subject by a relative specifier, so it has to sit where that specifier
 * resolves — under a name nothing else will collide with, and removed
 * afterwards whether the run passed, failed or threw. Left behind, it would
 * be picked up by the project's next test run as a test nobody wrote.
 */
export function nodeTestExecutor(options: NodeTestExecutorOptions): AdversarialExecutor {
  const timeoutMs = options.timeoutMs ?? 60_000;

  return async (source: string) => {
    const name = `adversarial-${randomUUID()}.test.mjs`;
    const path = join(options.projectDir, name);
    writeFileSync(path, source, 'utf8');

    try {
      const outcome = await runProcess(
        process.execPath,
        ['--test', '--test-reporter=tap', name],
        options.projectDir,
        timeoutMs,
      );
      const executions = parseTapResults(outcome.stdout).filter(
        (execution) => !isFileRow(execution.id),
      );
      if (executions.length === 0) {
        throw new AdversarialRunError(
          outcome.timedOut
            ? `the run was killed after ${String(timeoutMs)}ms`
            : `'${process.execPath} --test ${name}' in '${options.projectDir}' ` +
                `reported no tests`,
          source,
          outcome.code,
          outcome.stderr || outcome.stdout,
        );
      }
      return executions;
    } finally {
      rmSync(path, { force: true });
    }
  };
}
