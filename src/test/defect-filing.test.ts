import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../artifact/store.js';
import { projectArtifactSchemas } from '../schemas.js';
import type { AdversarialCaseResult, AdversarialVerdict } from './adversarial.js';
import {
  blocksGate,
  defectSchema,
  fileDefect,
  recordFix,
  retestDefect,
  routeDefect,
} from './defect.js';
import {
  adversarialDefectId,
  adversarialDefectOptions,
  DefectIdError,
  defectsFromAdversarialVerdict,
  defectsFromNfrCoverage,
  defectsToVerifyFromAdversarialVerdict,
  defectsToVerifyFromNfrCoverage,
  fileAndWriteDefect,
  verifyFixedDefect,
  nfrDefectId,
  nfrDefectOptions,
} from './defect-filing.js';
import type { NfrCoverageRow } from './nfr.js';

/**
 * `fileDefect`'s two producers, completed (T4.3.4): a failing adversarial
 * case and a below-threshold NFR row become a filed `Defect`, with
 * `severity`/`title` supplied rather than assumed and an evidence `detail`
 * that is never empty — the CONV-6 point of every test below is that each
 * one can fail against the naive version that just passes a producer's own
 * (possibly empty) `detail`/`evidence` straight through, which
 * `defectEvidenceSchema` would refuse.
 */

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store(): ArtifactStore {
  const root = mkdtempSync(join(tmpdir(), 'mpgm-defect-filing-'));
  temporary.push(root);
  return new ArtifactStore({ root, schemas: projectArtifactSchemas() });
}

function failedCase(
  overrides: Partial<AdversarialCaseResult> = {},
): AdversarialCaseResult {
  return {
    id: 'zero-ways-is-refused',
    kind: 'negative',
    about: 'splitting between nobody',
    defect: 'splitEvenly divides by zero instead of refusing an empty split',
    outcome: 'failed',
    detail: '',
    tracesTo: ['LOAN-3'],
    ...overrides,
  };
}

function belowThresholdRow(overrides: Partial<NfrCoverageRow> = {}): NfrCoverageRow {
  return {
    id: 'PERF-2',
    verified: false,
    problem: 'below-threshold',
    measured: 900,
    evidence: '',
    verifiedBy: [],
    ...overrides,
  };
}

describe('adversarialDefectOptions (T4.3.4)', () => {
  it('supplies a non-empty detail from the case’s own defect account when the runner gave none', () => {
    const options = adversarialDefectOptions(failedCase({ detail: '' }), 'high');

    expect(options.evidence.detail).not.toBe('');
    expect(options.evidence.detail).toBe(
      'splitEvenly divides by zero instead of refusing an empty split',
    );
  });

  it('prefers the runner’s own detail when it gave one', () => {
    const options = adversarialDefectOptions(
      failedCase({ detail: 'AssertionError: expected to throw' }),
      'high',
    );

    expect(options.evidence.detail).toBe('AssertionError: expected to throw');
  });

  it('builds a title and description without assuming the case carries either', () => {
    const options = adversarialDefectOptions(failedCase(), 'critical');

    expect(options.title).toContain('zero-ways-is-refused');
    expect(options.title.length).toBeGreaterThan(0);
    expect(options.severity).toBe('critical');
  });

  it('carries the case’s own tracesTo through, unchanged', () => {
    const options = adversarialDefectOptions(
      failedCase({ tracesTo: ['LOAN-3', 'LOAN-4'] }),
      'high',
    );

    expect(options.tracesTo).toStrictEqual(['LOAN-3', 'LOAN-4']);
  });

  it('files without throwing for a case whose detail is empty (the run that found something)', () => {
    // This is the failure mode T4.3.4 exists to rule out: a filing path that
    // passes an empty detail through throws `DefectDataError` on exactly the
    // run that found a defect. Asserted against `fileDefect` and not against
    // the options builder alone, because building options never calls a
    // schema and so could not throw however wrong it was — the assertion
    // that can fail is the one that files (CONV-6).
    expect(() =>
      fileDefect(adversarialDefectOptions(failedCase({ detail: '' }), 'low')),
    ).not.toThrow();
  });
});

describe('nfrDefectOptions (T4.3.4)', () => {
  it('supplies a non-empty detail from the measurement when the provider gave no evidence', () => {
    const options = nfrDefectOptions(belowThresholdRow({ evidence: '' }), 'high');

    expect(options.evidence.detail).not.toBe('');
    expect(options.evidence.detail).toContain('measured 900');
    expect(options.evidence.detail).toContain('no evidence text');
  });

  it('prefers the provider’s own evidence when it gave some', () => {
    const options = nfrDefectOptions(
      belowThresholdRow({ evidence: 'k6 report: p99 900ms' }),
      'high',
    );

    expect(options.evidence.detail).toBe('k6 report: p99 900ms');
  });

  it('traces to the NFR’s own requirement id', () => {
    const options = nfrDefectOptions(belowThresholdRow({ id: 'PERF-9' }), 'medium');

    expect(options.tracesTo).toStrictEqual(['PERF-9']);
    expect(options.evidence.caseId).toBe('PERF-9');
  });

  it('supplies a non-empty detail even with no measurement on record', () => {
    const options = nfrDefectOptions(
      belowThresholdRow({ evidence: '', measured: undefined }),
      'high',
    );

    expect(options.evidence.detail).not.toBe('');
    expect(options.evidence.detail).toContain('no measurement was recorded');
  });
});

describe('defectsFromAdversarialVerdict / defectsFromNfrCoverage (T4.3.4)', () => {
  it('files only the failed rows of a verdict, never a passed or not-reported one', () => {
    const verdict: AdversarialVerdict = {
      rows: [
        failedCase({ id: 'a', outcome: 'passed' }),
        failedCase({ id: 'b', outcome: 'failed' }),
        failedCase({ id: 'c', outcome: 'not-reported' }),
      ],
      defects: [failedCase({ id: 'b', outcome: 'failed' })],
      notReported: [failedCase({ id: 'c', outcome: 'not-reported' })],
      clean: false,
    };

    const entries = defectsFromAdversarialVerdict(verdict, 'high');

    expect(entries.map((entry) => entry.id)).toStrictEqual([adversarialDefectId('b')]);
  });

  it('files only below-threshold rows, never a not-run one', () => {
    const rows: readonly NfrCoverageRow[] = [
      { id: 'FUN-1', verified: true, verifiedBy: ['k6'] },
      { id: 'PERF-1', verified: false, problem: 'not-run', verifiedBy: [] },
      belowThresholdRow({ id: 'PERF-2' }),
    ];

    const entries = defectsFromNfrCoverage(rows, 'high');

    expect(entries.map((entry) => entry.id)).toStrictEqual([nfrDefectId('PERF-2')]);
  });
});

describe('defect ids that would become a path (CONV-4, T4.3.4)', () => {
  it('refuses a case id that would write outside artifacts/defect/', () => {
    // An `AdversarialCaseResult.id` is whatever the tester role returned, and
    // it becomes `artifacts/defect/<id>.md` — so a traversal in it is a
    // filing that writes somewhere nobody named.
    expect(() => adversarialDefectId('../../.mpgm/state')).toThrow(DefectIdError);
    expect(() => nfrDefectId('../../../etc/passwd')).toThrow(DefectIdError);
    expect(() => adversarialDefectId('')).toThrow(DefectIdError);
    // Refused, not sanitised: the message says to fix the id at its source.
    expect(() => nfrDefectId('PERF 2')).toThrow(/at its source/);
  });

  it('accepts the ids the two producers actually use', () => {
    expect(adversarialDefectId('refuses-a-swapped-range')).toBe(
      'defect-adversarial-refuses-a-swapped-range',
    );
    expect(nfrDefectId('PERF-2')).toBe('defect-nfr-PERF-2');
  });
});

describe('fileAndWriteDefect, through a real store (T4.3.4)', () => {
  it('writes under artifacts/defect/, outside any declared produces path', () => {
    const artifacts = store();
    const entries = defectsFromAdversarialVerdict(
      {
        rows: [failedCase()],
        defects: [failedCase()],
        notReported: [],
        clean: false,
      },
      'high',
    );
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error('unreachable: asserted above');
    }

    const { artifact, defect } = fileAndWriteDefect(artifacts, entry.id, entry.file, {
      task: 'run-suite',
      role: 'kernel',
      model: '(none)',
      runId: 'run-1',
    });

    expect(artifact.path.replace(artifacts.root, '')).toContain(
      join('artifacts', 'defect'),
    );
    expect(defectSchema.parse(artifact.data)).toStrictEqual(defect);
    expect(defect.status).toBe('open');

    // Read back off disk through the same store, not the in-memory value.
    const reread = artifacts.read(`artifacts/defect/${entry.id}.md`);
    expect(defectSchema.parse(reread.data).evidence.detail).not.toBe('');
  });

  it('a rerun of the same case versions the same artifact rather than filing a fresh one', () => {
    const artifacts = store();
    const entries = defectsFromAdversarialVerdict(
      { rows: [failedCase()], defects: [failedCase()], notReported: [], clean: false },
      'high',
    );
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error('unreachable: asserted above');
    }
    const producedBy = {
      task: 'run-suite',
      role: 'kernel',
      model: '(none)',
      runId: 'run-1',
    };

    fileAndWriteDefect(artifacts, entry.id, entry.file, producedBy);
    const second = fileAndWriteDefect(artifacts, entry.id, entry.file, {
      ...producedBy,
      runId: 'run-2',
    });

    expect(second.artifact.version).toBe(2);
    expect(second.artifact.id).toBe(entry.id);
  });

  it(
    'reopens rather than refiles when a rerun still fails a defect already ' +
      'fix-pending, so the route and fix stay on record',
    () => {
      const artifacts = store();
      const entries = defectsFromAdversarialVerdict(
        { rows: [failedCase()], defects: [failedCase()], notReported: [], clean: false },
        'high',
      );
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error('unreachable: asserted above');
      }
      const producedBy = {
        task: 'run-suite',
        role: 'kernel',
        model: '(none)',
        runId: 'run-1',
      };

      // v1: filed. v2/v3: routed and a (bad) fix recorded, by hand — the way
      // an operator or a future triage role would, over the artifact this
      // module already filed (module doc, `fileAndWriteDefect`).
      const filed = fileAndWriteDefect(artifacts, entry.id, entry.file, producedBy);
      const basePath = `artifacts/defect/${entry.id}.md`;
      let defect = routeDefect(
        filed.defect,
        { to: 'implement', taskId: 'T-fix' },
        'a real bug',
      );
      artifacts.write({
        id: entry.id,
        basePath,
        schema: 'defect',
        data: defect,
        producedBy: filed.artifact.producedBy,
        tracesTo: defect.tracesTo,
      });
      defect = recordFix(defect, { ref: 'abc1234', summary: 'attempted a fix' });
      artifacts.write({
        id: entry.id,
        basePath,
        schema: 'defect',
        data: defect,
        producedBy: filed.artifact.producedBy,
        tracesTo: defect.tracesTo,
      });

      // The case fails again — the fix did not hold. A naive re-file would
      // overwrite v3 (`fix-pending`, route and fix on record) with a fresh
      // `open` v4, discarding both (CONV-6: this assertion fails against
      // that naive version).
      const reopened = fileAndWriteDefect(artifacts, entry.id, entry.file, {
        ...producedBy,
        runId: 'run-2',
      });

      expect(reopened.artifact.version).toBe(4);
      expect(reopened.defect.status).toBe('reopened');
      if (reopened.defect.status !== 'reopened') {
        throw new Error('unreachable: asserted above');
      }
      expect(reopened.defect.route).toStrictEqual({ to: 'implement', taskId: 'T-fix' });
      expect(reopened.defect.fix).toStrictEqual({
        ref: 'abc1234',
        summary: 'attempted a fix',
      });
      expect(reopened.defect.failedAttempts).toBe(1);

      // Every earlier version is untouched on disk.
      expect(defectSchema.parse(artifacts.read(basePath, 1).data).status).toBe('open');
      expect(defectSchema.parse(artifacts.read(basePath, 2).data).status).toBe('routed');
      expect(defectSchema.parse(artifacts.read(basePath, 3).data).status).toBe(
        'fix-pending',
      );
    },
  );

  it(
    'reopens a verified defect whose case fails again, so the gate sees the ' +
      'regression instead of a closed defect',
    () => {
      const artifacts = store();
      const entries = defectsFromAdversarialVerdict(
        { rows: [failedCase()], defects: [failedCase()], notReported: [], clean: false },
        'high',
      );
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error('unreachable: asserted above');
      }
      const producedBy = {
        task: 'run-suite',
        role: 'kernel',
        model: '(none)',
        runId: 'run-1',
      };
      const basePath = `artifacts/defect/${entry.id}.md`;
      const writeNext = (data: unknown, tracesTo: readonly string[]): void => {
        artifacts.write({
          id: entry.id,
          basePath,
          schema: 'defect',
          data,
          producedBy,
          tracesTo,
        });
      };

      // v1 filed by the phase; v2..v4 the round trip, ending verified — the
      // fix held and the case passed.
      const filed = fileAndWriteDefect(artifacts, entry.id, entry.file, producedBy);
      let defect = routeDefect(filed.defect, { to: 'implement', taskId: 'T-fix' }, 'why');
      writeNext(defect, defect.tracesTo);
      defect = recordFix(defect, { ref: 'abc1234', summary: 'refuses the empty split' });
      writeNext(defect, defect.tracesTo);
      defect = retestDefect(defect, { passed: true, detail: 'the case passes now' });
      writeNext(defect, defect.tracesTo);
      expect(artifacts.latestVersion(basePath)).toBe(4);
      expect(defectSchema.parse(artifacts.read(basePath, 4).data).status).toBe(
        'verified',
      );

      // A later run fails the same case: a regression. Against a version that
      // hands the verified defect straight back, this run produces no new
      // version at all and `blocksGate` reports nothing while the case is
      // failing — which is what both assertions below catch (CONV-6).
      const regressed = fileAndWriteDefect(artifacts, entry.id, entry.file, {
        ...producedBy,
        runId: 'run-2',
      });

      expect(regressed.artifact.version).toBe(5);
      expect(regressed.defect.status).toBe('reopened');
      expect(regressed.defect.failedAttempts).toBe(1);
      // What the phase hands the gate as `GateEvidence.defects` — a
      // high-severity defect that is not `verified` holds it shut.
      expect(blocksGate([regressed.defect])).toHaveLength(1);
      // Read back off disk, and the verified version is still there beneath.
      expect(defectSchema.parse(artifacts.read(basePath, 5).data).status).toBe(
        'reopened',
      );
      expect(defectSchema.parse(artifacts.read(basePath, 4).data).status).toBe(
        'verified',
      );
    },
  );

  it('closes a fix-pending defect whose case passed, and only that status', () => {
    const artifacts = store();
    const producedBy = {
      task: 'run-suite',
      role: 'kernel',
      model: '(none)',
      runId: 'run-1',
    };
    const id = adversarialDefectId('zero-ways-is-refused');
    const basePath = `artifacts/defect/${id}.md`;
    const options = adversarialDefectOptions(failedCase(), 'high');

    // Nothing filed under this id: a passing case is the common case, and it
    // must write nothing rather than invent a defect to close.
    expect(verifyFixedDefect(artifacts, id, 'passed', producedBy)).toBeUndefined();
    expect(artifacts.latestVersion(basePath)).toBe(0);

    // Filed and routed, no fix on record: a pass is the finding not
    // reproducing, not evidence a fix held, so the defect stays where it is.
    const filed = fileAndWriteDefect(artifacts, id, options, producedBy);
    expect(verifyFixedDefect(artifacts, id, 'passed', producedBy)).toBeUndefined();
    let defect = routeDefect(filed.defect, { to: 'implement', taskId: 'T-fix' }, 'why');
    artifacts.write({
      id,
      basePath,
      schema: 'defect',
      data: defect,
      producedBy,
      tracesTo: defect.tracesTo,
    });
    expect(verifyFixedDefect(artifacts, id, 'passed', producedBy)).toBeUndefined();
    expect(artifacts.latestVersion(basePath)).toBe(2);

    // A fix is recorded: now the same case passing is a re-test that held.
    defect = recordFix(defect, { ref: 'abc1234', summary: 'refuses the empty split' });
    artifacts.write({
      id,
      basePath,
      schema: 'defect',
      data: defect,
      producedBy,
      tracesTo: defect.tracesTo,
    });
    const closed = verifyFixedDefect(
      artifacts,
      id,
      'zero-ways-is-refused passed on re-run',
      producedBy,
    );

    expect(closed).toBeDefined();
    if (closed === undefined) {
      throw new Error('unreachable: asserted above');
    }
    expect(closed.defect.status).toBe('verified');
    expect(closed.artifact.version).toBe(4);
    expect(defectSchema.parse(artifacts.read(basePath, 4).data).status).toBe('verified');
    // What the phase then hands the gate: a closed defect holds nothing shut.
    expect(blocksGate([closed.defect])).toStrictEqual([]);

    // Already closed: a second passing run writes nothing more.
    expect(verifyFixedDefect(artifacts, id, 'passed again', producedBy)).toBeUndefined();
    expect(artifacts.latestVersion(basePath)).toBe(4);
  });

  it('names the defect ids a passing case or a met threshold would close', () => {
    const passed = failedCase({ id: 'zero-ways-is-refused', outcome: 'passed' });
    const silent = failedCase({ id: 'never-ran', outcome: 'not-reported' });
    const verdict: AdversarialVerdict = {
      rows: [passed, silent, failedCase({ id: 'still-broken', outcome: 'failed' })],
      defects: [failedCase({ id: 'still-broken', outcome: 'failed' })],
      notReported: [silent],
      clean: false,
    };

    // `not-reported` is not a pass anywhere else in this codebase and is not
    // one here: closing a defect on a case that never ran would be the
    // silence-as-success reading CONV-4 refuses.
    expect(
      defectsToVerifyFromAdversarialVerdict(verdict).map((row) => row.id),
    ).toStrictEqual([adversarialDefectId('zero-ways-is-refused')]);

    expect(
      defectsToVerifyFromNfrCoverage([
        { id: 'FUN-1', verified: true, verifiedBy: ['k6'] },
        { id: 'PERF-1', verified: false, problem: 'not-run', verifiedBy: [] },
        belowThresholdRow({ id: 'PERF-2' }),
      ]).map((row) => row.id),
    ).toStrictEqual([nfrDefectId('FUN-1')]);
  });

  it(
    'leaves a routed (not yet fixed) defect untouched on a rerun, rather ' +
      'than resetting it to open',
    () => {
      const artifacts = store();
      const entries = defectsFromAdversarialVerdict(
        { rows: [failedCase()], defects: [failedCase()], notReported: [], clean: false },
        'high',
      );
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error('unreachable: asserted above');
      }
      const producedBy = {
        task: 'run-suite',
        role: 'kernel',
        model: '(none)',
        runId: 'run-1',
      };

      const filed = fileAndWriteDefect(artifacts, entry.id, entry.file, producedBy);
      const basePath = `artifacts/defect/${entry.id}.md`;
      const routed = routeDefect(
        filed.defect,
        { to: 'implement', taskId: 'T-fix' },
        'a real bug',
      );
      artifacts.write({
        id: entry.id,
        basePath,
        schema: 'defect',
        data: routed,
        producedBy: filed.artifact.producedBy,
        tracesTo: routed.tracesTo,
      });

      // No fix recorded yet — nothing for `retestDefect` to have failed, so
      // a rerun finding the same failure leaves the routed defect exactly as
      // it was (CONV-6: this fails against a naive version that writes a
      // fresh `open` v3 over it).
      const again = fileAndWriteDefect(artifacts, entry.id, entry.file, {
        ...producedBy,
        runId: 'run-2',
      });

      expect(again.artifact.version).toBe(2);
      expect(again.defect.status).toBe('routed');
      expect(artifacts.latestVersion(basePath)).toBe(2);
    },
  );
});
