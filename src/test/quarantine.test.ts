import { describe, expect, it } from 'vitest';
import type { CoverageRow } from '../trace/index-store.js';
import {
  detectAndQuarantine,
  detectFlaky,
  FlakyDetectionDuplicateIdError,
  FlakyDetectionMismatchError,
  FlakyDetectionRunsError,
  quarantinedIds,
  quarantineFlaky,
  withoutQuarantined,
  type QuarantinableCoverageRow,
  type QuarantineLedger,
  type TestRerun,
} from './quarantine.js';
import { requirementCoverageReport, type NfrCoverageRow } from './nfr.js';

function run(entries: readonly [string, TestRerun['outcome']][]): TestRerun[] {
  return entries.map(([id, outcome]) => ({ id, outcome }));
}

describe('detectFlaky (TST-6)', () => {
  it('finds a test whose outcome disagrees across reruns', () => {
    const flaky = detectFlaky([
      run([
        ['stable-case', 'passed'],
        ['flaky-case', 'passed'],
      ]),
      run([
        ['stable-case', 'passed'],
        ['flaky-case', 'failed'],
      ]),
    ]);

    expect(flaky).toEqual([{ id: 'flaky-case', outcomes: ['passed', 'failed'] }]);
  });

  it('does not report a test whose outcome held across every rerun', () => {
    const flaky = detectFlaky([
      run([['stable-case', 'passed']]),
      run([['stable-case', 'passed']]),
      run([['stable-case', 'passed']]),
    ]);

    expect(flaky).toEqual([]);
  });

  // not-reported is itself an outcome, not a hole to skip over: a test that
  // sometimes fails to report at all against unchanged code is exactly as
  // flaky as one that sometimes fails.
  it('treats a run where a test went unreported as a disagreement', () => {
    const flaky = detectFlaky([
      run([['intermittent', 'passed']]),
      run([['intermittent', 'not-reported']]),
    ]);

    expect(flaky).toEqual([{ id: 'intermittent', outcomes: ['passed', 'not-reported'] }]);
  });

  it('refuses fewer than two reruns', () => {
    expect(() => detectFlaky([run([['a', 'passed']])])).toThrow(FlakyDetectionRunsError);
    expect(() => detectFlaky([])).toThrow(FlakyDetectionRunsError);
  });

  // A rerun reporting on a different set of ids is not a rerun of the same
  // suite at all, and comparing outcomes across that gap would attribute the
  // id mismatch itself to whichever ids happen to survive it.
  it('refuses reruns that report on different sets of test ids', () => {
    expect(() => detectFlaky([run([['a', 'passed']]), run([['b', 'passed']])])).toThrow(
      FlakyDetectionMismatchError,
    );
  });

  // A run that reports one id twice is not a rerun disagreeing with itself —
  // it is a single run whose own two reports would otherwise be compared as
  // if they came from separate reruns, producing a false flakiness verdict
  // off evidence gathered inside one run.
  it('refuses a run that reports the same test id more than once', () => {
    expect(() =>
      detectFlaky([
        run([
          ['a', 'passed'],
          ['a', 'failed'],
        ]),
        run([['a', 'passed']]),
      ]),
    ).toThrow(FlakyDetectionDuplicateIdError);
  });

  it('names the duplicated ids and the run index on the duplicate-id error', () => {
    try {
      detectFlaky([
        run([['a', 'passed']]),
        run([
          ['a', 'passed'],
          ['a', 'failed'],
        ]),
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlakyDetectionDuplicateIdError);
      const duplicate = error as FlakyDetectionDuplicateIdError;
      expect(duplicate.ids).toEqual(['a']);
      expect(duplicate.runIndex).toBe(1);
    }
  });

  it('names the expected and actual ids and the run index in the mismatch error', () => {
    try {
      detectFlaky([
        run([['a', 'passed']]),
        run([['a', 'passed']]),
        run([
          ['a', 'passed'],
          ['b', 'passed'],
        ]),
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlakyDetectionMismatchError);
      const mismatch = error as FlakyDetectionMismatchError;
      expect(mismatch.expected).toEqual(['a']);
      expect(mismatch.got).toEqual(['a', 'b']);
      expect(mismatch.runIndex).toBe(2);
    }
  });
});

describe('quarantineFlaky', () => {
  it('appends an entry for a newly flaky test, with the reason and evidence', () => {
    const ledger = quarantineFlaky([], 'abc123', [
      { id: 'flaky-case', outcomes: ['passed', 'failed'] },
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      testId: 'flaky-case',
      ref: 'abc123',
      outcomes: ['passed', 'failed'],
    });
    expect(ledger[0]?.reason).toContain('abc123');
    expect(ledger[0]?.reason).toContain('passed -> failed');
  });

  // Auto-quarantine converges instead of duplicating (PMG-4's rule applied
  // here): a test flagged flaky again on a later pass gets no second row.
  it('does not add a second entry for a test already on the ledger', () => {
    const first = quarantineFlaky([], 'abc123', [
      { id: 'flaky-case', outcomes: ['passed', 'failed'] },
    ]);
    const second = quarantineFlaky(first, 'def456', [
      { id: 'flaky-case', outcomes: ['failed', 'passed'] },
    ]);

    expect(second).toBe(first);
    expect(second).toHaveLength(1);
    expect(second[0]?.ref).toBe('abc123');
  });

  it('leaves an untouched ledger alone when nothing is flaky', () => {
    const ledger: QuarantineLedger = [];
    expect(quarantineFlaky(ledger, 'abc123', [])).toBe(ledger);
  });

  // The same convergence rule quarantineFlaky applies across calls (a test
  // already on the ledger gets no second row) also applies within one call:
  // `flaky` is caller-assembled input, not guaranteed unique by construction,
  // and a naive append would grow two rows for one test from a single call.
  it('does not add two entries for the same test id named twice in one call', () => {
    const ledger = quarantineFlaky([], 'abc123', [
      { id: 'flaky-case', outcomes: ['passed', 'failed'] },
      { id: 'flaky-case', outcomes: ['failed', 'passed', 'failed'] },
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.outcomes).toEqual(['passed', 'failed']);
  });
});

describe('detectAndQuarantine — the auto-quarantine pipeline (TST-6)', () => {
  // Completion criterion (T3.2.3): a flaky test is auto-quarantined.
  it('quarantines a test whose reruns disagreed, with no gate in between', () => {
    const { ledger, flaky } = detectAndQuarantine({
      ledger: [],
      ref: 'commit-1',
      runs: [
        run([
          ['stable', 'passed'],
          ['flaky', 'passed'],
        ]),
        run([
          ['stable', 'passed'],
          ['flaky', 'failed'],
        ]),
      ],
    });

    expect(flaky.map((entry) => entry.id)).toEqual(['flaky']);
    expect(quarantinedIds(ledger)).toEqual(new Set(['flaky']));
  });

  it('quarantines nothing when every rerun agreed', () => {
    const { ledger, flaky } = detectAndQuarantine({
      ledger: [],
      ref: 'commit-1',
      runs: [run([['stable', 'passed']]), run([['stable', 'passed']])],
    });

    expect(flaky).toEqual([]);
    expect(ledger).toEqual([]);
  });
});

function coverageRow(
  overrides: Partial<QuarantinableCoverageRow>,
): QuarantinableCoverageRow {
  return { id: 'REQ-1', verified: true, verifiedBy: ['test-a'], ...overrides };
}

describe('withoutQuarantined (TST-6)', () => {
  it('drops a quarantined id from verifiedBy and flips verified to false when nothing else verifies it', () => {
    const rows = withoutQuarantined(
      [coverageRow({ verifiedBy: ['test-a'] })],
      new Set(['test-a']),
    );

    expect(rows).toEqual([{ id: 'REQ-1', verified: false, verifiedBy: [] }]);
  });

  it('keeps a row verified when another, non-quarantined test still verifies it', () => {
    const rows = withoutQuarantined(
      [coverageRow({ verifiedBy: ['test-a', 'test-b'] })],
      new Set(['test-a']),
    );

    expect(rows).toEqual([{ id: 'REQ-1', verified: true, verifiedBy: ['test-b'] }]);
  });

  it('returns the same row reference when nothing about it is quarantined', () => {
    const row = coverageRow({ verifiedBy: ['test-a'] });
    const rows = withoutQuarantined([row], new Set(['unrelated']));

    expect(rows[0]).toBe(row);
  });

  it('returns the input array unchanged when nothing is quarantined at all', () => {
    const rows: readonly QuarantinableCoverageRow[] = [coverageRow({})];
    expect(withoutQuarantined(rows, new Set())).toBe(rows);
  });
});

function graphRow(id: string, overrides: Partial<CoverageRow> = {}): CoverageRow {
  return { id, verifiedBy: [], tracedBy: [], verified: false, ...overrides };
}

describe('requirementCoverageReport with a quarantine ledger (TST-2, TST-3, TST-6)', () => {
  // Completion criterion (T3.2.3): coverage drops accordingly rather than
  // silently holding. A requirement verified only by a since-quarantined
  // test reports unverified, not verified-on-stale-trust.
  it('drops a requirement to unverified once its only verifying test is quarantined', () => {
    const withoutQuarantine = requirementCoverageReport({
      requirements: [{ id: 'FUN-1' }],
      graph: [graphRow('FUN-1', { verified: true, verifiedBy: ['flaky-case'] })],
      nfr: [],
    });
    expect(withoutQuarantine.rows).toEqual([
      { id: 'FUN-1', verified: true, verifiedBy: ['flaky-case'] },
    ]);
    expect(withoutQuarantine.verified).toBe(1);

    const withQuarantine = requirementCoverageReport({
      requirements: [{ id: 'FUN-1' }],
      graph: [graphRow('FUN-1', { verified: true, verifiedBy: ['flaky-case'] })],
      nfr: [],
      quarantined: new Set(['flaky-case']),
    });

    expect(withQuarantine.rows).toEqual([
      { id: 'FUN-1', verified: false, verifiedBy: [] },
    ]);
    expect(withQuarantine.verified).toBe(0);
  });

  it('excludes a quarantined NFR measuredBy from the combined report as well', () => {
    const nfr: readonly NfrCoverageRow[] = [
      {
        id: 'NFR-1',
        verified: true,
        measured: 180,
        evidence: 'report:1',
        verifiedBy: ['load test at 100 concurrent submitters'],
      },
    ];

    const report = requirementCoverageReport({
      requirements: [{ id: 'NFR-1' }],
      graph: [graphRow('NFR-1')],
      nfr,
      quarantined: new Set(['load test at 100 concurrent submitters']),
    });

    expect(report.rows).toEqual([{ id: 'NFR-1', verified: false, verifiedBy: [] }]);
  });

  it('keeps a requirement verified when a second, non-quarantined source still verifies it', () => {
    const nfr: readonly NfrCoverageRow[] = [
      {
        id: 'NFR-1',
        verified: true,
        measured: 180,
        evidence: 'report:1',
        verifiedBy: ['load test at 100 concurrent submitters'],
      },
    ];

    const report = requirementCoverageReport({
      requirements: [{ id: 'NFR-1' }],
      graph: [graphRow('NFR-1', { verified: true, verifiedBy: ['deadbeef'] })],
      nfr,
      quarantined: new Set(['load test at 100 concurrent submitters']),
    });

    expect(report.rows).toEqual([
      { id: 'NFR-1', verified: true, verifiedBy: ['deadbeef'] },
    ]);
  });

  it('an empty quarantine set changes nothing', () => {
    const withoutSet = requirementCoverageReport({
      requirements: [{ id: 'FUN-1' }],
      graph: [graphRow('FUN-1', { verified: true, verifiedBy: ['abc123'] })],
      nfr: [],
    });
    const withEmptySet = requirementCoverageReport({
      requirements: [{ id: 'FUN-1' }],
      graph: [graphRow('FUN-1', { verified: true, verifiedBy: ['abc123'] })],
      nfr: [],
      quarantined: new Set(),
    });

    expect(withEmptySet).toEqual(withoutSet);
  });
});
