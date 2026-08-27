import { describe, expect, it } from 'vitest';
import { BoundContract, CapabilityRegistry, ContractError } from '../contract/capability.js';
import type { CoverageRow } from '../trace/index-store.js';
import {
  nfrCoverage,
  requirementCoverageReport,
  runNfrSuite,
  testNfrContract,
  type NfrCoverageRow,
  type NfrRequirement,
  type NfrRunOutput,
} from './nfr.js';

const latency: NfrRequirement = {
  id: 'NFR-1',
  metric: 'p95 acknowledgement latency',
  value: 200,
  unit: 'ms',
  measuredBy: 'load test at 100 concurrent submitters',
};

const throughput: NfrRequirement = {
  id: 'NFR-2',
  metric: 'sustained throughput',
  value: 500,
  unit: 'rps',
  measuredBy: 'load test at steady state for 10 minutes',
};

function result(overrides: Partial<NfrRunOutput> & { requirementId: string }): NfrRunOutput {
  return {
    metric: 'x',
    measured: 0,
    unit: 'ms',
    passed: true,
    evidence: '',
    ...overrides,
  };
}

describe('nfrCoverage (TST-3)', () => {
  it('verifies a requirement whose reported measurement passed', () => {
    const rows = nfrCoverage(
      [latency],
      [result({ requirementId: 'NFR-1', measured: 180, passed: true, evidence: 'report:1' })],
    );

    expect(rows).toEqual([
      { id: 'NFR-1', verified: true, measured: 180, evidence: 'report:1' },
    ]);
  });

  // Completion criterion (T3.2.1): the coverage report lists verified and
  // unverified requirements.
  it('lists both a verified and an unverified requirement in one report', () => {
    const rows = nfrCoverage(
      [latency, throughput],
      [
        result({ requirementId: 'NFR-1', measured: 180, passed: true }),
        result({ requirementId: 'NFR-2', measured: 300, passed: false, evidence: 'report:2' }),
      ],
    );

    expect(rows.find((row) => row.id === 'NFR-1')).toMatchObject({ verified: true });
    expect(rows.find((row) => row.id === 'NFR-2')).toMatchObject({
      verified: false,
      problem: 'below-threshold',
      evidence: 'report:2',
    });
  });

  // SCP-1 binds every quantified NFR to TST-3: absence is not success — the
  // same rule ci.checks enforces for merge checks.
  it('reports a requirement no suite ran as unverified, not as inapplicable', () => {
    const rows = nfrCoverage([latency, throughput], [result({ requirementId: 'NFR-1' })]);

    expect(rows.find((row) => row.id === 'NFR-2')).toEqual({
      id: 'NFR-2',
      verified: false,
      problem: 'not-run',
    });
  });

  it('marks a failing measurement unverified even with no other requirements', () => {
    const rows = nfrCoverage(
      [latency],
      [result({ requirementId: 'NFR-1', measured: 400, passed: false })],
    );

    expect(rows).toEqual([
      { id: 'NFR-1', verified: false, problem: 'below-threshold', measured: 400, evidence: '' },
    ]);
  });
});

describe('runNfrSuite', () => {
  it('calls the runner once per quantified requirement and reports coverage', async () => {
    const calls: string[] = [];
    const rows = await runNfrSuite({
      repo: 'o/r',
      ref: 'abc',
      requirements: [latency, throughput],
      run: (input) => {
        calls.push(input.requirementId);
        return Promise.resolve(
          result({
            requirementId: input.requirementId,
            passed: input.requirementId === 'NFR-1',
          }),
        );
      },
    });

    expect(calls).toEqual(['NFR-1', 'NFR-2']);
    expect(rows.map((row) => [row.id, row.verified])).toEqual([
      ['NFR-1', true],
      ['NFR-2', false],
    ]);
  });

  it('propagates a provider failure rather than reading it as not-run', async () => {
    await expect(
      runNfrSuite({
        repo: 'o/r',
        ref: 'abc',
        requirements: [latency],
        run: () => Promise.reject(new Error('load-test harness unreachable')),
      }),
    ).rejects.toThrow('load-test harness unreachable');
  });
});

function graphRow(id: string, overrides: Partial<CoverageRow> = {}): CoverageRow {
  return { id, verifiedBy: [], tracedBy: [], verified: false, ...overrides };
}

describe('requirementCoverageReport (TST-2 + TST-3)', () => {
  it('lists a verified and an unverified requirement together', () => {
    const nfr: readonly NfrCoverageRow[] = [
      { id: 'NFR-1', verified: true, measured: 180, evidence: 'report:1' },
      { id: 'NFR-2', verified: false, problem: 'not-run' },
    ];

    const report = requirementCoverageReport({
      requirements: [{ id: 'FUN-1' }, { id: 'NFR-1' }, { id: 'NFR-2' }],
      graph: [
        graphRow('FUN-1', { verified: true, verifiedBy: ['abc123'] }),
        graphRow('NFR-1'),
        graphRow('NFR-2'),
      ],
      nfr,
    });

    expect(report.total).toBe(3);
    expect(report.verified).toBe(2);
    expect(report.rows).toEqual([
      { id: 'FUN-1', verified: true, verifiedBy: ['abc123'] },
      { id: 'NFR-1', verified: true, verifiedBy: [] },
      { id: 'NFR-2', verified: false, verifiedBy: [], problem: 'not-run' },
    ]);
  });

  // A prior commit's `Verifies:` trailer still counts even when this run did
  // not re-measure the requirement — the report is not allowed to regress a
  // requirement to unverified just because this pass skipped it.
  it('keeps a requirement verified from the trace graph even without a fresh run', () => {
    const report = requirementCoverageReport({
      requirements: [{ id: 'NFR-1' }],
      graph: [graphRow('NFR-1', { verified: true, verifiedBy: ['deadbeef'] })],
      nfr: [],
    });

    expect(report.rows).toEqual([
      { id: 'NFR-1', verified: true, verifiedBy: ['deadbeef'] },
    ]);
  });

  // And the reverse: a fresh pass counts before anything has been committed.
  it('verifies a requirement from a fresh run before the graph has caught up', () => {
    const report = requirementCoverageReport({
      requirements: [{ id: 'NFR-1' }],
      graph: [graphRow('NFR-1')],
      nfr: [{ id: 'NFR-1', verified: true, measured: 150, evidence: 'report:1' }],
    });

    expect(report.rows).toEqual([{ id: 'NFR-1', verified: true, verifiedBy: [] }]);
  });
});

describe('test.nfr contract', () => {
  it('validates what a provider returns', async () => {
    const registry = new CapabilityRegistry();
    const bound = registry.bind(testNfrContract, {
      run: () => Promise.resolve({ requirementId: 'NFR-1', passed: 'yes' }),
    });

    await expect(
      bound.invoke('run', {
        repo: 'o/r',
        ref: 'abc',
        requirementId: 'NFR-1',
        metric: 'p95 latency',
        value: 200,
        unit: 'ms',
        measuredBy: 'load test',
      }),
    ).rejects.toThrow(ContractError);
  });

  it('refuses a provider that does not implement the contract', () => {
    expect(() => new BoundContract(testNfrContract, {})).toThrow(ContractError);
  });

  it('refuses to guess when no provider is bound', () => {
    expect(() => new CapabilityRegistry().require('test.nfr')).toThrow(ContractError);
  });

  it('defaults evidence to empty rather than requiring one', () => {
    const output = testNfrContract.operations.find((op) => op.name === 'run')?.output;
    const parsed = output?.parse({
      requirementId: 'NFR-1',
      metric: 'p95 latency',
      measured: 180,
      unit: 'ms',
      passed: true,
    }) as { evidence: string };

    expect(parsed.evidence).toBe('');
  });
});
