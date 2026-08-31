import { describe, expect, it } from 'vitest';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import type { RunState } from '../state/kernel-state.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { TraceIndex } from '../trace/index-store.js';
import { allSummaries, runProjection, summaryOf, traceGraph } from './projection.js';

const RUN = 'run-1';

function harness() {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, {
    registry: kernelRegistry(),
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  const projector = new Projector({ log, snapshots: SnapshotStore.attach(db) });
  const traces = TraceIndex.attach(db);
  return { db, log, projector, traces };
}

function requireRun(
  state: { runs: Readonly<Record<string, RunState>> },
  runId: string,
): RunState {
  const run = state.runs[runId];
  if (run === undefined) {
    throw new Error(`test setup: expected run '${runId}' to be folded`);
  }
  return run;
}

describe('runProjection / summaryOf', () => {
  it('reports a dispatched task and a pending gate as blocked-free but awaiting approval', () => {
    const { db, log, projector } = harness();
    try {
      log.appendMany([
        { runId: RUN, type: 'RunStarted', payload: { project: 'mpgm', operator: 'op' } },
        {
          runId: RUN,
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'engineer', model: 'claude-sonnet-5' },
        },
        {
          runId: RUN,
          type: 'GatePresented',
          payload: { gateId: 'G1', phase: 'scope', artifactRefs: [] },
        },
        {
          runId: RUN,
          type: 'GatePresented',
          payload: { gateId: 'G2', phase: 'design', artifactRefs: [] },
        },
        {
          runId: RUN,
          type: 'GateApproved',
          payload: { gateId: 'G2', by: 'op' },
        },
      ]);

      const run = requireRun(projector.project(), RUN);
      const projection = runProjection(run);

      expect(projection.tasks).toEqual([
        expect.objectContaining({ taskId: 'T1', status: 'dispatched', blocked: false }),
      ]);
      // G1 is still presented and G2 has been decided — asserting both sides
      // is what stops `awaitingApproval` from being hardcoded true and still
      // passing (a mutation the previous version of this suite let through).
      const g1 = projection.gates.find((gate) => gate.gateId === 'G1');
      const g2 = projection.gates.find((gate) => gate.gateId === 'G2');
      expect(g1).toEqual(
        expect.objectContaining({
          gateId: 'G1',
          status: 'presented',
          awaitingApproval: true,
        }),
      );
      expect(g2).toEqual(
        expect.objectContaining({
          gateId: 'G2',
          status: 'approved',
          awaitingApproval: false,
        }),
      );

      const summary = summaryOf(run);
      expect(summary.pendingApprovals).toBe(1);
      expect(summary.blockedTasks).toBe(0);
    } finally {
      db.close();
    }
  });

  it('lists a destructive call awaiting confirmation, and drops the wait once confirmed', () => {
    const { db, log, projector } = harness();
    try {
      log.appendMany([
        { runId: RUN, type: 'RunStarted', payload: { project: 'mpgm', operator: 'op' } },
        {
          runId: RUN,
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'engineer', model: 'claude-sonnet-5' },
        },
        {
          runId: RUN,
          type: 'DryRunRecorded',
          payload: {
            taskId: 'T1',
            tool: 'deploy',
            fingerprint: 'fp-1',
            summary: 'would deploy',
          },
        },
      ]);

      const beforeConfirm = runProjection(requireRun(projector.project(), RUN));
      expect(beforeConfirm.destructiveCalls).toEqual([
        expect.objectContaining({ fingerprint: 'fp-1', dryRun: true, confirmedBy: null }),
      ]);

      log.appendMany([
        {
          runId: RUN,
          type: 'DestructiveOpConfirmed',
          payload: { taskId: 'T1', tool: 'deploy', fingerprint: 'fp-1', by: 'op' },
        },
      ]);

      const afterConfirm = runProjection(requireRun(projector.project(), RUN));
      expect(afterConfirm.destructiveCalls).toEqual([
        expect.objectContaining({ fingerprint: 'fp-1', dryRun: true, confirmedBy: 'op' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('marks a blocked task as blocked', () => {
    const { db, log, projector } = harness();
    try {
      log.appendMany([
        { runId: RUN, type: 'RunStarted', payload: { project: 'mpgm', operator: 'op' } },
        {
          runId: RUN,
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'engineer', model: 'claude-sonnet-5' },
        },
        {
          runId: RUN,
          type: 'BudgetExceeded',
          payload: { taskId: 'T1', kind: 'repairs', limit: 3, observed: 3 },
        },
      ]);

      const run = requireRun(projector.project(), RUN);
      const projection = runProjection(run);
      expect(projection.tasks[0]?.status).toBe('blocked');
      expect(projection.tasks[0]?.blocked).toBe(true);
      expect(summaryOf(run).blockedTasks).toBe(1);
    } finally {
      db.close();
    }
  });

  it('lists every run known to the log', () => {
    const { db, log, projector } = harness();
    try {
      log.appendMany([
        { runId: 'run-a', type: 'RunStarted', payload: { project: 'p', operator: 'op' } },
        { runId: 'run-b', type: 'RunStarted', payload: { project: 'p', operator: 'op' } },
      ]);

      const summaries = allSummaries(projector.project());
      expect(summaries.map((entry) => entry.runId).sort()).toEqual(['run-a', 'run-b']);
    } finally {
      db.close();
    }
  });
});

describe('traceGraph', () => {
  it('reflects what the index currently holds, live', () => {
    const { db, traces } = harness();
    try {
      expect(traceGraph(traces)).toEqual({ nodes: [], links: [] });

      traces.indexCommit({
        sha: 'abc123',
        subject: 'Fix the loan bug',
        body: 'Traces-To: LOAN-1',
      });

      const graph = traceGraph(traces);
      expect(graph.nodes).toEqual([
        expect.objectContaining({ id: 'abc123', kind: 'commit' }),
      ]);
      expect(graph.links).toEqual([
        expect.objectContaining({ src: 'abc123', dst: 'LOAN-1', relation: 'traces-to' }),
      ]);
    } finally {
      db.close();
    }
  });
});
