import { describe, expect, it } from 'vitest';
import type { DashboardRun, DashboardSummary } from './projection.js';
import { errorPage, runDetailPage, runListPage, traceGraphPage } from './render.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

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
});

describe('errorPage', () => {
  it('reports the status and escapes the message', () => {
    const html = errorPage(404, `no run '<script>x</script>' in the log`);
    expect(html).toContain('404');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});
