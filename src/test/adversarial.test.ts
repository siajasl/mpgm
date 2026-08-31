import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputSchemaRegistry } from '../agent/output-registry.js';
import { ScriptedProvider, scriptedSuccess } from '../agent/scripted-provider.js';
import { SessionRunner } from '../agent/runner.js';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { loadRoleFile } from '../role/loader.js';
import { projectOutputSchemas } from '../schemas.js';
import {
  AdversarialDuplicateResultError,
  AdversarialResultMismatchError,
  AdversarialRunError,
  adversarialSuiteSchema,
  adversarialVerdict,
  executionsFromRun,
  nodeTestExecutor,
  parseTapResults,
  renderSuite,
  runAdversarialSuite,
  testEnvironment,
  type AdversarialExecution,
  type AdversarialSuite,
  type TestRunOutcome,
} from './adversarial.js';

const projectRoot = join(import.meta.dirname, '..', '..');
const sampleProject = join(import.meta.dirname, '__fixtures__', 'sample-project');

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A copy of the sample project, so a run never writes into the fixture. */
function sampleCheckout(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mpgm-adversarial-'));
  temporary.push(directory);
  cpSync(sampleProject, directory, { recursive: true });
  return directory;
}

/**
 * What an `adversarial-tester` session returns for the sample project.
 *
 * Held here as data, exactly as it comes back from a session (the end-to-end
 * case below runs it through the role's own output schema to prove the shape
 * is the one the role promises). Three of these cases catch the planted
 * rounding defect in `split.mjs`; three pass against it, which is what makes
 * the failures evidence about the subject rather than about the suite.
 */
const generatedSuite: unknown = {
  subject: './split.mjs',
  summary:
    'Attacks splitEvenly: the domain it must refuse, the amounts that do not ' +
    'divide evenly, and the invariant that money is conserved.',
  cases: [
    {
      id: 'zero-ways-is-refused',
      kind: 'negative',
      about: 'splitting between nobody',
      defect: 'splitEvenly divides by zero instead of refusing an empty split',
      body: 'assert.throws(() => subject.splitEvenly(100, 0), RangeError);',
    },
    {
      id: 'negative-total-is-refused',
      kind: 'negative',
      about: 'splitting a negative amount',
      defect: 'splitEvenly accepts a debt as if it were an amount to distribute',
      body: 'assert.throws(() => subject.splitEvenly(-1, 2), RangeError);',
    },
    {
      id: 'indivisible-amount-keeps-every-cent',
      kind: 'boundary',
      about: 'ten cents between three, the first amount that does not divide evenly',
      defect: 'a cent is lost when the amount does not divide evenly',
      body: 'assert.deepEqual(subject.splitEvenly(10, 3), [4, 3, 3]);',
    },
    {
      id: 'one-cent-between-two',
      kind: 'boundary',
      about: 'the smallest amount that cannot be shared equally',
      defect: 'a cent is invented: two recipients are each given the only cent there was',
      body: 'assert.deepEqual(subject.splitEvenly(1, 2), [1, 0]);',
    },
    {
      id: 'shares-always-sum-to-the-total',
      kind: 'property',
      about: 'conservation of money across every amount and every number of ways',
      defect: 'splitting an amount creates or destroys money',
      body: [
        'for (let total = 0; total <= 60; total += 1) {',
        '  for (let ways = 1; ways <= 7; ways += 1) {',
        '    const shares = subject.splitEvenly(total, ways);',
        '    const sum = shares.reduce((running, share) => running + share, 0);',
        '    assert.equal(sum, total, `${total} split ${ways} ways summed to ${sum}`);',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      id: 'shares-differ-by-at-most-one-cent',
      kind: 'property',
      about: 'fairness: no recipient is given more than a cent more than another',
      defect: 'the split is not even — one recipient is favoured over another',
      body: [
        'for (let total = 0; total <= 60; total += 1) {',
        '  for (let ways = 1; ways <= 7; ways += 1) {',
        '    const shares = subject.splitEvenly(total, ways);',
        '    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);',
        '  }',
        '}',
      ].join('\n'),
    },
  ],
};

/** The cases that the planted defect in `split.mjs` should break. */
const expectedDefects = [
  'indivisible-amount-keeps-every-cent',
  'one-cent-between-two',
  'shares-always-sum-to-the-total',
];

function suite(): AdversarialSuite {
  return adversarialSuiteSchema.parse(generatedSuite);
}

function execution(
  overrides: Partial<AdversarialExecution> & { id: string },
): AdversarialExecution {
  return { passed: true, detail: '', ...overrides };
}

describe('the adversarial suite schema (TST-4)', () => {
  it('accepts a suite carrying all three kinds', () => {
    expect(suite().cases).toHaveLength(6);
  });

  it.each(['negative', 'boundary', 'property'])(
    'refuses a suite with no %s case',
    (kind) => {
      const parsed = suite();
      const thinned = {
        ...parsed,
        cases: parsed.cases.filter((entry) => entry.kind !== kind),
      };

      const result = adversarialSuiteSchema.safeParse(thinned);

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('every kind TST-4 names');
    },
  );

  it('refuses two cases sharing an id, since a failure could not be attributed', () => {
    const parsed = suite();
    const duplicated = {
      ...parsed,
      cases: [...parsed.cases, ...parsed.cases.slice(0, 1)],
    };

    expect(adversarialSuiteSchema.safeParse(duplicated).success).toBe(false);
  });

  it('refuses a subject the rendered file could not resolve or could not quote', () => {
    // A resolution and rendering constraint, not a confinement one: the
    // generated file is written into the project under test, so only a
    // relative specifier names the module the run was asked about, and only a
    // quote-free one can be dropped between quotes without the import
    // statement ending early. It stops none of these from being reached from
    // inside a case `body`, and the executor says so — see the trust
    // assumption on `nodeTestExecutor` and the test that pins it below.
    for (const subject of ['node:fs', '/etc/passwd', 'lodash', "./x.mjs'; import 'fs"]) {
      expect(adversarialSuiteSchema.safeParse({ ...suite(), subject }).success).toBe(
        false,
      );
    }
  });
});

describe('renderSuite', () => {
  it('names each test by its case id, so a result can be matched back to it', () => {
    const source = renderSuite(suite());

    for (const entry of suite().cases) {
      expect(source).toContain(`test('${entry.id}', async () => {`);
    }
    expect(source).toContain("import * as subject from './split.mjs';");
  });

  it('keeps a multi-line body on its own lines rather than flattening it', () => {
    const source = renderSuite(suite());

    expect(source).toContain('    const shares = subject.splitEvenly(total, ways);');
  });
});

describe('adversarialVerdict', () => {
  it('treats a case the runner never reported on as unreported, not as a pass', () => {
    const parsed = suite();
    const verdict = adversarialVerdict(
      parsed,
      parsed.cases.slice(1).map((entry) => execution({ id: entry.id })),
    );

    expect(verdict.notReported.map((row) => row.id)).toEqual(
      parsed.cases.slice(0, 1).map((entry) => entry.id),
    );
    expect(verdict.defects).toEqual([]);
    // Absence is not success: nothing failed, and the suite is still not clean.
    expect(verdict.clean).toBe(false);
  });

  it('reports a failing case as a defect, carrying what the tester said it means', () => {
    const parsed = suite();
    const verdict = adversarialVerdict(
      parsed,
      parsed.cases.map((entry) =>
        execution({
          id: entry.id,
          passed: entry.id !== 'one-cent-between-two',
          detail: entry.id === 'one-cent-between-two' ? 'AssertionError' : '',
        }),
      ),
    );

    expect(verdict.defects).toHaveLength(1);
    expect(verdict.defects[0]?.defect).toContain('a cent is invented');
    expect(verdict.clean).toBe(false);
  });

  it('refuses results for a case the suite never declared', () => {
    const parsed = suite();

    expect(() =>
      adversarialVerdict(parsed, [
        ...parsed.cases.map((entry) => execution({ id: entry.id })),
        execution({ id: 'left-over-from-another-run' }),
      ]),
    ).toThrow(AdversarialResultMismatchError);
  });

  it('refuses a case reported twice rather than taking the last result (CONV-4)', () => {
    // This used to be the fail-open: a rerun and a phantom row look
    // identical from here — both are a second execution under an id the
    // suite already declared — and folding either by last-wins can turn a
    // genuine failure into a silent pass. Nothing in this module produces a
    // real rerun inside one execution list, so there is no result this can
    // wrongly refuse; a caller that does mean to merge reruns does so before
    // calling this function, on purpose, rather than getting it for free.
    const parsed = suite();
    const executions = [
      ...parsed.cases.map((entry) => execution({ id: entry.id, passed: false })),
      ...parsed.cases.map((entry) => execution({ id: entry.id, passed: true })),
    ];

    expect(() => adversarialVerdict(parsed, executions)).toThrow(
      AdversarialDuplicateResultError,
    );
    expect(() => adversarialVerdict(parsed, executions)).toThrow(
      new RegExp(parsed.cases[0]?.id ?? ''),
    );
  });
});

describe('parseTapResults', () => {
  it('reads passes, failures and a failure’s diagnostics', () => {
    const results = parseTapResults(
      [
        'TAP version 13',
        '# Subtest: alpha',
        'ok 1 - alpha',
        '  ---',
        '  duration_ms: 0.4',
        '  ...',
        '# Subtest: beta',
        'not ok 2 - beta',
        '  ---',
        '  error: |-',
        '    Expected values to be strictly equal',
        '  ...',
        '1..2',
      ].join('\n'),
    );

    expect(results).toEqual([
      { id: 'alpha', passed: true, detail: '' },
      {
        id: 'beta',
        passed: false,
        detail: 'error: |-\nExpected values to be strictly equal',
      },
    ]);
  });

  it('reads cases reported as subtests of the file, not only top-level ones', () => {
    // Node nests differently depending on how it ran the file, and the suite
    // must be read either way — a parser that only took top-level results
    // would report a whole suite as unreported on a runtime that nested them.
    // The file's own row comes back here and is dropped by the executor,
    // which knows a case id can never be a module path.
    const results = parseTapResults(
      [
        'TAP version 13',
        '# Subtest: adversarial-1.test.mjs',
        '    # Subtest: alpha',
        '    ok 1 - alpha',
        '    # Subtest: beta',
        '    not ok 2 - beta',
        '      ---',
        '      error: nope',
        '      ...',
        '    1..2',
        'not ok 1 - adversarial-1.test.mjs',
        '  ---',
        '  failureType: subtestsFailed',
        '  ...',
        '1..1',
      ].join('\n'),
    );

    expect(results).toEqual([
      { id: 'alpha', passed: true, detail: '' },
      { id: 'beta', passed: false, detail: 'error: nope' },
      {
        id: 'adversarial-1.test.mjs',
        passed: false,
        detail: 'failureType: subtestsFailed',
      },
    ]);
  });

  it('reads the case id off a line padded, CRLF-terminated or carrying a directive', () => {
    // Everything after the id on a result line is the runner's, not the
    // suite's: a `# SKIP` directive, the padding Node aligns its columns with,
    // the `\r` a CRLF report leaves behind once the output is split on '\n'.
    // Any of them left inside the id makes the case unmatchable, and the
    // verdict then reports a case that ran as `not-reported` (CONV-4) while
    // refusing the run outright for a result it cannot attribute.
    const results = parseTapResults(
      ['ok 1 - alpha  ', 'ok 2 - beta\r', 'not ok 3 - gamma # SKIP no runtime'].join(
        '\n',
      ),
    );

    expect(results.map((result) => result.id)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('does not read a result line out of an open failure’s own diagnostics', () => {
    // Reproduces a real run: two declared cases, `b-case` and `a-case`,
    // where `b-case` fails for a genuine reason and `a-case` fails on an
    // assertion whose *message* happens to spell a TAP result line naming
    // `b-case` — `assert.equal(1, 2, "ok 9 - b-case")` prints exactly this,
    // and Node puts it verbatim inside `a-case`'s own `error: |-` block. That
    // is not contrived: it is what any assertion message containing the
    // words "ok" and a case id produces, and a suite the tester writes by
    // accident can easily do it. `b-case`'s real result comes first in the
    // stream, so a parser that reads a result line at any indentation reads
    // the phantom line inside `a-case`'s block as a second, later result for
    // `b-case` — this time passing — and `adversarialVerdict` folds by id,
    // so the phantom overwrites the real failure with a pass. There must be
    // exactly one row per case, and `b-case`'s must stay failed.
    const results = parseTapResults(
      [
        'TAP version 13',
        '# Subtest: b-case',
        'not ok 1 - b-case',
        '  ---',
        '  duration_ms: 0.1',
        '  error: |-',
        '    genuine failure',
        '  ...',
        '# Subtest: a-case',
        'not ok 2 - a-case',
        '  ---',
        '  duration_ms: 0.1',
        '  error: |-',
        '    ok 9 - b-case',
        '  ...',
        '1..2',
      ].join('\n'),
    );

    expect(results.map((result) => result.id)).toEqual(['b-case', 'a-case']);
    const bCase = results.find((result) => result.id === 'b-case');
    expect(bCase?.passed).toBe(false);
    expect(bCase?.detail).toContain('genuine failure');
    const aCase = results.find((result) => result.id === 'a-case');
    expect(aCase?.passed).toBe(false);
    // The phantom line is kept — it is genuinely part of what `a-case`
    // printed — but as inert text inside `a-case`'s own diagnostics, never
    // as a result of its own.
    expect(aCase?.detail).toContain('ok 9 - b-case');
  });
});

describe('the environment a generated suite is run with (SAF-2)', () => {
  it('keeps only what a node child needs, whatever else the kernel holds', () => {
    // An allowlist, so the failure mode is a suite that cannot read a variable
    // it wanted rather than a credential handed to model-authored code. The
    // classified ones are here to show that a denylist would have had to know
    // about them; `MPGM_ANYTHING` is the one it would not have known about.
    const scrubbed = testEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/kernel',
      GITHUB_TOKEN: 'ghp_not_a_real_token',
      AWS_SECRET_ACCESS_KEY: 'not-a-real-key',
      MPGM_ANYTHING: 'the variable nobody classified',
      NODE_OPTIONS: '--require ./anything.js',
      UNSET: undefined,
    });

    expect(scrubbed).toEqual({ PATH: '/usr/bin', HOME: '/home/kernel' });
  });

  it('matches names the way the platform that set them resolves them', () => {
    // Windows preserves the case it was given and resolves without it, so a
    // case-sensitive allowlist drops `Path` and leaves the child unable to
    // spawn anything — a scrub that breaks every run is a scrub somebody
    // turns off.
    const scrubbed = testEnvironment({
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      SomethingElse: 'dropped',
    });

    expect(scrubbed).toEqual({
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
    });
  });
});

describe('reading a finished run (CONV-4)', () => {
  const context = {
    source: '// the rendered suite',
    command: "'node --test adversarial-1.test.mjs' in '/project'",
    timeoutMs: 1_000,
  };
  const outcome = (overrides: Partial<TestRunOutcome>): TestRunOutcome => ({
    stdout: 'TAP version 13\nok 1 - a-case\n',
    stderr: '',
    code: 0,
    timedOut: false,
    ...overrides,
  });

  it('folds a finished run that reported a failure', () => {
    const executions = executionsFromRun(
      outcome({ stdout: 'TAP version 13\nok 1 - a-case\nnot ok 2 - b-case\n', code: 1 }),
      context,
    );

    expect(executions.map((execution) => execution.passed)).toEqual([true, false]);
  });

  it('refuses a killed run even when it printed results first', () => {
    // Two ways this bites. The cases the runner never reached would fold as
    // `not-reported`, which describes a suite the runner declined rather than
    // a case that hung; and the results it did print get trusted, so a body
    // that prints its own `ok` lines and then loops for ever would be
    // reporting on itself. A killed run is not a report.
    expect(() =>
      executionsFromRun(outcome({ code: null, timedOut: true }), context),
    ).toThrow(AdversarialRunError);
    expect(() =>
      executionsFromRun(outcome({ code: null, timedOut: true }), context),
    ).toThrow(/killed after 1000ms/);
  });

  it('refuses a run whose every case passed and whose process then failed', () => {
    // The runner exits non-zero when a case fails, so a non-zero exit next to
    // no failure is a disagreement: an unhandled rejection after the last
    // case, a crash on the way out, something the report does not describe. A
    // clean verdict is the one verdict that must not come out of it.
    expect(() => executionsFromRun(outcome({ code: 7 }), context)).toThrow(
      /disagrees with its own report/,
    );
  });

  it('reports the reason without the reader having to read this module', () => {
    // CONV-3: the runner's own output is where the cause is, and the rendered
    // file is gone by the time anybody reads the error.
    try {
      executionsFromRun(
        outcome({ stdout: '', stderr: 'SyntaxError: Unexpected token', code: 1 }),
        context,
      );
      expect.unreachable('a run with no results must not fold into a verdict');
    } catch (error) {
      expect(error).toBeInstanceOf(AdversarialRunError);
      expect((error as AdversarialRunError).message).toContain(
        'SyntaxError: Unexpected token',
      );
      expect((error as AdversarialRunError).message).toContain('reported no tests');
      expect((error as AdversarialRunError).source).toBe(context.source);
    }
  });
});

describe('the sample project (T3.2.2 completion criterion)', () => {
  it("passes the implementer's own tests despite the planted defect", () => {
    // The premise of TST-4. Every amount the author tested divides evenly, so
    // the rounding defect never shows: an adversarial pass is not redundant
    // with the tests that came with the code.
    const directory = sampleCheckout();

    const run = (): number => {
      try {
        execFileSync(process.execPath, ['--test', 'split.test.mjs'], {
          cwd: directory,
          encoding: 'utf8',
        });
        return 0;
      } catch {
        return 1;
      }
    };

    expect(run()).toBe(0);
  });

  it('catches the planted bug with the generated tests', async () => {
    const directory = sampleCheckout();

    const verdict = await runAdversarialSuite({
      suite: suite(),
      execute: nodeTestExecutor({ projectDir: directory }),
    });

    expect(verdict.defects.map((row) => row.id).sort()).toEqual([...expectedDefects]);
    expect(verdict.clean).toBe(false);
    // A defect report is only useful if it says what broke, so the runner's
    // own account of the failure travels with it.
    expect(verdict.defects[0]?.detail).not.toBe('');
    expect(verdict.notReported).toEqual([]);
    // Both classes that could see this defect saw it, and the negative cases
    // — which the subject does handle — did not fire.
    expect(new Set(verdict.defects.map((row) => row.kind))).toEqual(
      new Set(['boundary', 'property']),
    );
  }, 30_000);

  it('still catches the defect when another case’s message names the catching case', async () => {
    // The end-to-end version of the `parseTapResults` reproduction above, run
    // through Node's own test runner against the real planted defect rather
    // than a hand-written TAP string: a suite the tester could write by
    // accident must not lose a caught defect to it. `names-the-real-case`
    // fails with a message that spells a TAP result line for
    // `one-cent-invents-a-cent` — the case that genuinely catches the planted
    // rounding defect — and is declared after it, which is the order a
    // last-wins fold gets wrong.
    const directory = sampleCheckout();
    const named = adversarialSuiteSchema.parse({
      subject: './split.mjs',
      summary: 'One case names another in its own failure message.',
      cases: [
        {
          id: 'one-cent-invents-a-cent',
          kind: 'boundary',
          about: 'the smallest amount that cannot be shared equally',
          defect:
            'a cent is invented: two recipients are each given the only cent there was',
          body: 'assert.deepEqual(subject.splitEvenly(1, 2), [1, 0]);',
        },
        {
          id: 'names-the-real-case',
          kind: 'property',
          about: 'a message that happens to read as a TAP result line',
          defect: 'this case always fails; it exists to spell another case’s id',
          body: "assert.ok(false, 'ok 9 - one-cent-invents-a-cent');",
        },
        {
          id: 'zero-ways-is-refused',
          kind: 'negative',
          about: 'splitting between nobody',
          defect: 'splitEvenly divides by zero instead of refusing an empty split',
          body: 'assert.throws(() => subject.splitEvenly(100, 0), RangeError);',
        },
      ],
    });

    const verdict = await runAdversarialSuite({
      suite: named,
      execute: nodeTestExecutor({ projectDir: directory }),
    });

    const catcher = verdict.rows.find((row) => row.id === 'one-cent-invents-a-cent');
    // The planted defect must still read as caught — not silently overwritten
    // by the phantom row the other case's message produces.
    expect(catcher?.outcome).toBe('failed');
    expect(verdict.rows.find((row) => row.id === 'names-the-real-case')?.outcome).toBe(
      'failed',
    );
    expect(verdict.rows.find((row) => row.id === 'zero-ways-is-refused')?.outcome).toBe(
      'passed',
    );
  }, 30_000);

  it('passes the same generated tests once the defect is fixed', async () => {
    // The other half of CONV-6: a suite that fails whatever the subject does
    // has not caught anything. The cases are byte-identical to the run above;
    // only the module under test changed.
    const directory = sampleCheckout();
    writeFileSync(
      join(directory, 'split.mjs'),
      readFileSync(join(directory, 'split.fixed.mjs'), 'utf8'),
    );

    const verdict = await runAdversarialSuite({
      suite: suite(),
      execute: nodeTestExecutor({ projectDir: directory }),
    });

    expect(verdict.defects).toEqual([]);
    expect(verdict.clean).toBe(true);
  }, 30_000);

  it('leaves no generated file behind in the project it ran against', async () => {
    const directory = sampleCheckout();
    const before = execFileSync('ls', [directory], { encoding: 'utf8' });

    await runAdversarialSuite({
      suite: suite(),
      execute: nodeTestExecutor({ projectDir: directory }),
    });

    expect(execFileSync('ls', [directory], { encoding: 'utf8' })).toBe(before);
  }, 30_000);

  it('runs case bodies as trusted code, reaching whatever the kernel reaches', async () => {
    // Pins the trust assumption documented on `nodeTestExecutor` rather than
    // leaving it as prose that can quietly stop being true. There is no
    // control being evaded here: `body` is unconstrained JavaScript, this
    // executor writes it into the project and runs it with the harness's own
    // privileges, and the `subject` constraint in the schema bounds none of
    // that. The case below names `./split.mjs` as its subject and touches a
    // directory outside the project anyway. If a sandbox ever lands (ADR-6),
    // this test fails — and whoever lands it rewrites the docstring with it,
    // which is the point of asserting an assumption instead of asserting a
    // guarantee nobody has.
    const directory = sampleCheckout();
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'mpgm-adversarial-outside-'));
    temporary.push(outsideDirectory);
    const outside = join(outsideDirectory, 'reached.txt');

    const reaching = adversarialSuiteSchema.parse({
      subject: './split.mjs',
      summary: 'What a case body can reach, which is everything the kernel can.',
      cases: [
        {
          id: 'a-body-reaches-the-filesystem',
          kind: 'negative',
          about: 'a body importing a module its suite was never allowed to name',
          defect: 'the assumption changed: something now confines a case body',
          body: [
            "const fs = await import('node:fs');",
            `fs.writeFileSync(${JSON.stringify(outside)}, 'reached', 'utf8');`,
          ].join('\n'),
        },
        {
          id: 'the-subject-still-loads',
          kind: 'boundary',
          about: 'the declared subject is the module the file imported',
          defect: 'the rendered import did not resolve against the project',
          body: "assert.equal(typeof subject.splitEvenly, 'function');",
        },
        {
          id: 'the-run-reported-every-case',
          kind: 'property',
          about: 'a suite with a side effect is still reported on case by case',
          defect: 'a case ran and the verdict did not hear about it',
          body: 'assert.ok(true);',
        },
      ],
    });

    const verdict = await runAdversarialSuite({
      suite: reaching,
      execute: nodeTestExecutor({ projectDir: directory }),
    });

    expect(verdict.clean).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('reached');
  }, 30_000);

  it("does not hand a case body the kernel's credentials", async () => {
    // The other half of the trust assumption above, and the half that needs no
    // sandbox: a case body is model-authored code from a session that has just
    // read an arbitrary repository (SAF-3), and the secret broker's first
    // layer of control is that a credential is simply not in the environment
    // to be read (src/secret/broker.ts). A child that inherited `process.env`
    // would defeat that layer for every secret at once, on a path the broker
    // never sees — `process.env.GITHUB_TOKEN` in a body, out over a socket,
    // never touching log-write redaction. So the suite's process gets an
    // allowlist and nothing else.
    const directory = sampleCheckout();
    process.env.MPGM_FAKE_CREDENTIAL = 'not-a-real-credential-value';

    try {
      const scrubbed = adversarialSuiteSchema.parse({
        subject: './split.mjs',
        summary: 'What the kernel hands the process it runs a generated suite in.',
        cases: [
          {
            id: 'a-kernel-credential-is-not-in-scope',
            kind: 'negative',
            about: "reading a variable of the kernel's from inside a case body",
            defect: "the suite's process inherited the kernel's credentials",
            body: 'assert.equal(process.env.MPGM_FAKE_CREDENTIAL, undefined);',
          },
          {
            id: 'nothing-outside-the-allowlist-survives',
            kind: 'boundary',
            about: 'a variable nobody classified, which is the usual kind',
            defect: 'the scrub is a denylist, so an unclassified secret passes',
            body: [
              'const leaked = Object.keys(process.env).filter((name) =>',
              "  name.startsWith('MPGM_'),",
              ');',
              'assert.deepEqual(leaked, []);',
            ].join('\n'),
          },
          {
            id: 'the-child-can-still-find-its-way-around',
            kind: 'property',
            about: 'the allowlist keeps what a node child needs to run at all',
            defect: 'the scrub is so tight the suite cannot run',
            body: 'assert.ok(process.env.PATH !== undefined || process.env.Path !== undefined);',
          },
        ],
      });

      const verdict = await runAdversarialSuite({
        suite: scrubbed,
        execute: nodeTestExecutor({ projectDir: directory }),
      });

      expect(verdict.defects).toEqual([]);
      expect(verdict.clean).toBe(true);
    } finally {
      delete process.env.MPGM_FAKE_CREDENTIAL;
    }
  }, 30_000);

  it('runs with the environment it was given, and with nothing else', async () => {
    // A subject that reads configuration from the environment is served by
    // naming the variables, one at a time, rather than by turning inheritance
    // back on. What is passed is what the child gets.
    const directory = sampleCheckout();
    process.env.MPGM_FAKE_CREDENTIAL = 'not-a-real-credential-value';

    try {
      const configured = adversarialSuiteSchema.parse({
        subject: './split.mjs',
        summary: 'A suite whose project needs one variable of its own.',
        cases: [
          {
            id: 'the-declared-variable-arrives',
            kind: 'boundary',
            about: 'the one variable the caller chose to pass',
            defect: 'the executor ignored the environment it was handed',
            body: "assert.equal(process.env.MPGM_PROJECT_SETTING, 'configured');",
          },
          {
            id: 'the-undeclared-one-does-not',
            kind: 'negative',
            about: 'everything the caller did not choose to pass',
            defect: "the given environment was merged with the kernel's",
            body: 'assert.equal(process.env.MPGM_FAKE_CREDENTIAL, undefined);',
          },
          {
            id: 'the-subject-still-loads',
            kind: 'property',
            about: 'a scrubbed environment does not stop the module resolving',
            defect: 'the run cannot import what it was asked to attack',
            body: "assert.equal(typeof subject.splitEvenly, 'function');",
          },
        ],
      });

      const verdict = await runAdversarialSuite({
        suite: configured,
        execute: nodeTestExecutor({
          projectDir: directory,
          env: { ...testEnvironment(), MPGM_PROJECT_SETTING: 'configured' },
        }),
      });

      expect(verdict.defects).toEqual([]);
      expect(verdict.clean).toBe(true);
    } finally {
      delete process.env.MPGM_FAKE_CREDENTIAL;
    }
  }, 30_000);

  it('reports why a run produced no results rather than calling it unreported', async () => {
    // A suite that will not parse: node reports the file as failed and no case
    // at all. The file's row is dropped — it is not a case — which leaves
    // nothing, and nothing is an error carrying the runner's output rather
    // than six silently unreported cases.
    const directory = sampleCheckout();
    const broken = adversarialSuiteSchema.parse({
      ...(generatedSuite as Record<string, unknown>),
      cases: suite().cases.map((entry) => ({
        ...entry,
        body: 'this is not javascript(',
      })),
    });

    await expect(
      runAdversarialSuite({
        suite: broken,
        execute: nodeTestExecutor({ projectDir: directory }),
      }),
    ).rejects.toThrow(AdversarialRunError);
  }, 30_000);

  it('kills a case body that loops for ever, rather than hanging on it', async () => {
    // The wall-clock bound is the only defence this module has against what
    // it documents a case body can do: `await new Promise(() => {})` never
    // resolves, and nothing about a generated body stops the tester writing
    // exactly that. This is provoked for real — a live process, spawned,
    // timed out and killed — not asserted against a hand-built
    // `TestRunOutcome`, because a hand-built one cannot say whether the timer
    // and the `SIGKILL` actually fire; removing them would leave a suite like
    // this one hanging the kernel for ever and this test is what would go
    // red first.
    const directory = sampleCheckout();
    const hanging = adversarialSuiteSchema.parse({
      subject: './split.mjs',
      summary: 'One case never returns.',
      cases: [
        {
          id: 'a-case-that-never-returns',
          kind: 'negative',
          about: 'a body that awaits a promise nothing ever settles',
          defect: 'the wall-clock bound stopped enforcing itself',
          body: 'await new Promise(() => {});',
        },
        {
          id: 'the-subject-still-loads',
          kind: 'boundary',
          about: 'the declared subject is the module the file imported',
          defect: 'the rendered import did not resolve against the project',
          body: "assert.equal(typeof subject.splitEvenly, 'function');",
        },
        {
          id: 'the-suite-still-needs-every-kind',
          kind: 'property',
          about: 'a third, ordinary case, present only so the suite validates',
          defect: 'not a real defect — the schema requires all three kinds',
          body: 'assert.ok(true);',
        },
      ],
    });

    await expect(
      runAdversarialSuite({
        suite: hanging,
        execute: nodeTestExecutor({ projectDir: directory, timeoutMs: 1_500 }),
      }),
    ).rejects.toThrow(/killed after 1500ms/);
  }, 15_000);
});

describe('the adversarial-tester role', () => {
  it('returns a suite the kernel accepts, through the schema its role names', async () => {
    // The path a real run takes: role file → session → the output schema the
    // role's `output.schema` names → a suite the runner can render.
    const role = loadRoleFile(join(projectRoot, 'roles', 'adversarial-tester.md'));
    const schemas = projectOutputSchemas();
    expect(schemas.has(role.output.schema)).toBe(true);
    // The SDK needs an object at the top level; failing here beats failing
    // after a session has been dispatched.
    expect(schemas.jsonSchema(role.output.schema).type).toBe('object');

    const db = openDatabase(MEMORY);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.append({
        runId: 'run-1',
        type: 'RunStarted',
        payload: { project: 'sample', operator: 'op' },
      });
      const runner = new SessionRunner({
        log,
        provider: new ScriptedProvider([scriptedSuccess(generatedSuite)]),
        schemas: new OutputSchemaRegistry({
          [role.output.schema]: schemas.get(role.output.schema),
        }),
      });

      const outcome = await runner.runTask({
        runId: 'run-1',
        taskId: 'T-attack',
        role,
        prompt: 'Attack ./split.mjs.',
      });

      expect(outcome.status).toBe('completed');
      const returned = adversarialSuiteSchema.parse(
        outcome.status === 'completed' ? outcome.output : undefined,
      );
      expect(returned.cases.map((entry) => entry.id)).toContain(
        'shares-always-sum-to-the-total',
      );
    } finally {
      db.close();
    }
  });

  it('cannot write files: its output is the suite, and the kernel runs it', () => {
    const role = loadRoleFile(join(projectRoot, 'roles', 'adversarial-tester.md'));

    expect(role.paths.write).toEqual([]);
    expect(role.tools.allow).not.toContain('Bash');
    expect(role.tools.allow).not.toContain('Write');
  });
});
