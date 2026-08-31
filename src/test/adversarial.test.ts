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
  AdversarialResultMismatchError,
  AdversarialRunError,
  adversarialSuiteSchema,
  adversarialVerdict,
  nodeTestExecutor,
  parseTapResults,
  renderSuite,
  runAdversarialSuite,
  type AdversarialExecution,
  type AdversarialSuite,
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

  it('refuses a subject outside the project under test', () => {
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

  it('takes the last result for a case that was reported twice', () => {
    const parsed = suite();
    const executions = [
      ...parsed.cases.map((entry) => execution({ id: entry.id, passed: false })),
      ...parsed.cases.map((entry) => execution({ id: entry.id, passed: true })),
    ];

    expect(adversarialVerdict(parsed, executions).clean).toBe(true);
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
