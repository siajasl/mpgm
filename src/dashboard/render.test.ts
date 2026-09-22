import { describe, expect, it } from 'vitest';
import type { RunGateRates } from '../state/gate-rates.js';
import type { AggregateMetric, RunMetrics } from '../state/metrics.js';
import type { DashboardRun, DashboardSummary } from './projection.js';
import { errorPage, runDetailPage, runListPage, traceGraphPage } from './render.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

function emptyMetric(overrides: Partial<AggregateMetric> = {}): AggregateMetric {
  return {
    tasks: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    retries: 0,
    completed: 0,
    blocked: 0,
    attested: 0,
    dispatched: 0,
    superseded: 0,
    successRate: null,
    avgLatencyMs: null,
    ...overrides,
  };
}

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: 'run-1',
    overall: emptyMetric(),
    byPhase: {},
    byRole: {},
    byTask: {},
    ...overrides,
  };
}

function rates(overrides: Partial<RunGateRates> = {}): RunGateRates {
  return {
    runId: 'run-1',
    phaseGate: { decided: 0, rejected: 0, rate: null },
    mergeGate: {
      attempts: 0,
      refusals: 0,
      rate: null,
      unobservable: [],
      budgetExhausted: 0,
    },
    rework: { reviewed: 0, reworked: 0, rate: null },
    escapedDefects: {
      runId: 'run-1',
      merged: 0,
      escaped: 0,
      rate: null,
      filed: 0,
      unrouted: 0,
      undated: 0,
    },
    ...overrides,
  };
}

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    runId: 'run-1',
    project: 'mpgm',
    control: 'running',
    currentPhase: 'design',
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 1.2345 },
    blockedTasks: 0,
    pendingApprovals: 0,
    ...overrides,
  };
}

function run(overrides: Partial<DashboardRun> = {}): DashboardRun {
  return {
    runId: 'run-1',
    project: 'mpgm',
    control: 'running',
    currentPhase: 'design',
    phaseHistory: ['definition', 'scope', 'design'],
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 1.2345 },
    interventions: 0,
    tasks: [],
    gates: [],
    effects: [],
    votes: [],
    destructiveCalls: [],
    metrics: metrics(),
    rates: rates(),
    ...overrides,
  };
}

describe('runListPage', () => {
  it('renders a live run: the row shown is exactly the projection data passed in', () => {
    const html = runListPage([
      summary({
        runId: 'run-1',
        currentPhase: 'design',
        usage: { ...ZERO_USAGE, costUsd: 1.2345 },
      }),
    ]);
    expect(html).toContain('run-1');
    expect(html).toContain('design');
    expect(html).toContain('$1.2345');
    expect(html).toContain('href="/runs/run-1"');
  });

  it('reflects a later summary rather than the earlier one — a re-render is not a cache', () => {
    const before = runListPage([
      summary({ currentPhase: 'design', pendingApprovals: 0 }),
    ]);
    const after = runListPage([summary({ currentPhase: 'test', pendingApprovals: 1 })]);
    expect(before).not.toContain('>test<');
    expect(after).toContain('>test<');
    expect(after).toContain('class="awaiting"');
  });

  it('flags a run with pending approvals or blocked tasks rather than reporting them silently', () => {
    const clean = runListPage([summary({ blockedTasks: 0, pendingApprovals: 0 })]);
    const dirty = runListPage([summary({ blockedTasks: 2, pendingApprovals: 3 })]);
    expect(clean).not.toContain('class="blocked"');
    expect(clean).not.toContain('class="awaiting"');
    expect(dirty).toContain('class="blocked"');
    expect(dirty).toContain('class="awaiting"');
  });

  it('says so, rather than an empty table, when the log has no runs', () => {
    const html = runListPage([]);
    expect(html).toContain('no runs in the log');
    expect(html).not.toContain('<table>');
  });

  it('escapes summary content instead of interpolating it as HTML', () => {
    const html = runListPage([
      summary({
        project: '<script>alert(1)</script>',
        currentPhase: '"><b>x</b>',
      }),
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('"><b>x</b>');
  });

  it('carries a refresh directive so a page left open keeps polling the log', () => {
    const html = runListPage([summary()]);
    expect(html).toContain('http-equiv="refresh"');
  });
});

describe('runDetailPage', () => {
  it('renders a live run: state, approvals and spend all come from the projection', () => {
    const html = runDetailPage(
      run({
        runId: 'run-7',
        control: 'paused',
        currentPhase: 'implement',
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 3.5 },
        tasks: [
          {
            taskId: 'T1',
            role: 'engineer',
            model: 'claude-sonnet-5',
            status: 'blocked',
            blocked: true,
            checks: null,
            review: null,
            merged: null,
            usage: ZERO_USAGE,
          },
        ],
        gates: [
          {
            gateId: 'G1',
            phase: 'design',
            status: 'presented',
            decidedBy: null,
            reason: 'awaiting design review',
            awaitingApproval: true,
          },
        ],
      }),
    );

    expect(html).toContain('run-7');
    expect(html).toContain('paused');
    expect(html).toContain('implement');
    expect(html).toContain('$3.5000');
    expect(html).toContain('T1');
    expect(html).toContain('class="blocked"');
    expect(html).toContain('G1');
    expect(html).toContain('awaiting design review');
    expect(html).toContain('class="awaiting"');
  });

  it('a gate decided since the last render loses its awaiting-approval highlight', () => {
    const gate = (awaiting: boolean) =>
      run({
        gates: [
          {
            gateId: 'G1',
            phase: 'design',
            status: awaiting ? 'presented' : 'approved',
            decidedBy: awaiting ? null : 'operator',
            reason: 'r',
            awaitingApproval: awaiting,
          },
        ],
      });
    expect(runDetailPage(gate(true))).toContain('class="awaiting"');
    expect(runDetailPage(gate(false))).not.toContain('class="awaiting"');
  });

  it('escapes task and gate content instead of interpolating it as HTML', () => {
    const html = runDetailPage(
      run({
        tasks: [
          {
            taskId: '<img src=x onerror=alert(1)>',
            role: 'engineer',
            model: 'm',
            status: 'dispatched',
            blocked: false,
            checks: null,
            review: null,
            merged: null,
            usage: ZERO_USAGE,
          },
        ],
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('says so, rather than an empty table, when a run has no tasks or gates', () => {
    const html = runDetailPage(run());
    expect(html).toContain('no tasks yet');
    expect(html).toContain('no gates yet');
  });

  it('escapes gate content instead of interpolating it as HTML', () => {
    const html = runDetailPage(
      run({
        gates: [
          {
            gateId: '<img src=x onerror=alert(2)>',
            phase: 'design',
            status: 'presented',
            decidedBy: '<b>op</b>',
            reason: '<script>alert(3)</script>',
            awaitingApproval: true,
          },
        ],
      }),
    );
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toContain('<b>op</b>');
    expect(html).not.toContain('<script>alert(3)</script>');
  });

  it('escapes destructive-call content instead of interpolating it as HTML', () => {
    const html = runDetailPage(
      run({
        destructiveCalls: [
          {
            fingerprint: 'f1',
            tool: '<script>alert(4)</script>',
            taskId: '<b>T1</b>',
            dryRun: false,
            confirmedBy: '"><i>op</i>',
            confirmedSeq: 1,
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(4)</script>');
    expect(html).toContain('&lt;script&gt;alert(4)&lt;/script&gt;');
    expect(html).not.toContain('<b>T1</b>');
    expect(html).not.toContain('<i>op</i>');
  });
});

describe('runDetailPage metrics (T4.2.6)', () => {
  it('renders the per-phase and per-role figures, not just the section headings above them', () => {
    const html = runDetailPage(
      run({
        metrics: metrics({
          overall: emptyMetric({
            tasks: 3,
            costUsd: 4.5,
            inputTokens: 100,
            outputTokens: 50,
            retries: 2,
            completed: 2,
            blocked: 1,
            successRate: 2 / 3,
            avgLatencyMs: 1500,
          }),
          byPhase: {
            implement: emptyMetric({
              tasks: 2,
              costUsd: 3,
              completed: 2,
              successRate: 1,
              avgLatencyMs: 1000,
            }),
          },
          byRole: {
            engineer: emptyMetric({
              tasks: 2,
              costUsd: 3,
              completed: 1,
              blocked: 1,
              successRate: 0.5,
              avgLatencyMs: 2000,
            }),
          },
        }),
      }),
    );

    // A panel that renders the "By phase"/"By role" headings and no data
    // would satisfy a test that only looked for those strings (CONV-6) — so
    // this asserts the figures themselves: the labels, the money, the
    // latency and the computed percentages.
    expect(html).toContain('implement');
    expect(html).toContain('engineer');
    expect(html).toContain('$3.0000');
    expect(html).toContain('1000ms');
    expect(html).toContain('2000ms');
    expect(html).toContain('67%'); // overall success: 2 completed / 3 settled
    expect(html).toContain('50%'); // role success: 1 completed / 2 settled
  });

  it('renders a null success rate or latency as "-", never as 0%/0ms, when no task has settled', () => {
    // computeRunMetrics returns null rather than 0 for exactly this reason
    // (src/state/metrics.ts): an empty bucket has nothing to report, and a
    // panel printing 0% would report total failure for a run that has not
    // failed at all.
    const html = runDetailPage(
      run({ metrics: metrics({ overall: emptyMetric({ tasks: 1, dispatched: 1 }) }) }),
    );
    // A bare `'0%'`/`'0ms'` substring check would also match the page's own
    // `width: 100%` CSS rule — `>0%<`/`>0ms<` pins it to a rendered cell.
    expect(html).not.toMatch(/>0%</);
    expect(html).not.toMatch(/>0ms</);
    expect(html).toContain('<td>-</td>');

    // The two checks above cannot fail on `successText` alone:
    // `percent(rate)` never puts `<` directly against the digits it
    // prints (it always reads `0% (0/0)`, not `>0%<`), and the bare
    // `<td>-</td>` check is satisfied by the Quality-rates table's null
    // cells even if the Metrics table's success cell prints something
    // else entirely. Pin the assertion to the Overall row's own cells:
    // a regression that drops the null guard and renders
    // `percent(metric.successRate ?? 0)` prints `0% (0/0)` here, which
    // this catches even though neither `/>0%</` nor `<td>-</td>` would.
    expect(html).not.toContain('0% (0/0)');
    const overallRow = /<tr>\s*<td>run<\/td>[\s\S]*?<\/tr>/.exec(html)?.[0];
    expect(overallRow).toBeDefined();
    const overallCells = [...(overallRow ?? '').matchAll(/<td>([^<]*)<\/td>/g)].map(
      (m) => m[1],
    );
    expect(overallCells.at(-1)).toBe('-'); // success
    expect(overallCells.at(-3)).toBe('-'); // avg latency
  });
});

describe('runDetailPage quality rates (T4.2.6)', () => {
  it('renders the phase-gate, merge-gate, rework and escaped-defect figures', () => {
    const html = runDetailPage(
      run({
        rates: rates({
          phaseGate: { decided: 4, rejected: 1, rate: 0.25 },
          mergeGate: {
            attempts: 10,
            refusals: 3,
            rate: 0.3,
            unobservable: ['no-review'],
            budgetExhausted: 1,
          },
          rework: { reviewed: 5, reworked: 2, rate: 0.4 },
          escapedDefects: {
            runId: 'run-1',
            merged: 8,
            escaped: 1,
            rate: 0.125,
            filed: 2,
            unrouted: 1,
            undated: 0,
          },
        }),
      }),
    );

    expect(html).toContain('25%');
    expect(html).toContain('30%');
    expect(html).toContain('40%');
    expect(html).toContain('13%');
    expect(html).toContain('no-review');
  });

  it('renders every rate as "-" rather than 0%, when nothing has been decided, reviewed or filed yet', () => {
    const html = runDetailPage(run({ rates: rates() }));
    expect(html).not.toMatch(/>0%</);
    expect(html.match(/<td>-<\/td>/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('traceGraphPage', () => {
  it('renders the nodes and links the index currently holds', () => {
    const html = traceGraphPage({
      nodes: [
        { id: 'abc123', kind: 'commit', label: 'Fix the loan bug', source: 'abc123' },
      ],
      links: [{ src: 'abc123', dst: 'LOAN-1', relation: 'traces-to', source: 'abc123' }],
    });
    expect(html).toContain('abc123');
    expect(html).toContain('LOAN-1');
    expect(html).toContain('traces-to');
  });

  it('escapes node and link content instead of interpolating it as HTML', () => {
    const html = traceGraphPage({
      nodes: [
        {
          id: '<script>alert(5)</script>',
          kind: 'commit',
          label: '<b>label</b>',
          source: '<i>source</i>',
        },
      ],
      links: [
        {
          src: '<script>alert(5)</script>',
          dst: '<b>DST-1</b>',
          relation: 'traces-to',
          source: '<i>source</i>',
        },
      ],
    });
    expect(html).not.toContain('<script>alert(5)</script>');
    expect(html).toContain('&lt;script&gt;alert(5)&lt;/script&gt;');
    expect(html).not.toContain('<b>label</b>');
    expect(html).not.toContain('<b>DST-1</b>');
    expect(html).not.toContain('<i>source</i>');
  });
});

describe('errorPage', () => {
  it('reports the status and escapes the message', () => {
    const html = errorPage(404, `no run '<script>x</script>' in the log`);
    expect(html).toContain('404');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});
