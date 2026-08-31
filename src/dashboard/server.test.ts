import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { TraceIndex } from '../trace/index-store.js';
import { DashboardServer } from './server.js';

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

const openServers: DashboardServer[] = [];
const openDbs: { close(): void }[] = [];

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close();
  }
  for (const db of openDbs.splice(0)) {
    db.close();
  }
});

async function start(): Promise<{
  base: string;
  log: EventLog;
  server: DashboardServer;
  traces: TraceIndex;
}> {
  const { db, log, projector, traces } = harness();
  openDbs.push(db);
  const server = new DashboardServer({ projector, traces });
  openServers.push(server);
  const port = await server.listen(0);
  return { base: `http://127.0.0.1:${String(port)}`, log, server, traces };
}

describe('DashboardServer', () => {
  it('serves live run data: a later request reflects events appended after the first', async () => {
    const { base, log } = await start();

    log.appendMany([
      { runId: RUN, type: 'RunStarted', payload: { project: 'mpgm', operator: 'op' } },
      {
        runId: RUN,
        type: 'TaskDispatched',
        payload: { taskId: 'T1', role: 'engineer', model: 'claude-sonnet-5' },
      },
    ]);

    const before = (await (await fetch(`${base}/runs/${RUN}`)).json()) as {
      tasks: unknown[];
      gates: unknown[];
    };
    expect(before.tasks).toHaveLength(1);
    expect(before.gates).toHaveLength(0);

    // Nothing restarted the server between requests — this event committed
    // after the first fetch, so seeing it in the second is exactly what
    // "live" means here rather than a snapshot taken at listen() time.
    log.appendMany([
      {
        runId: RUN,
        type: 'GatePresented',
        payload: { gateId: 'G1', phase: 'scope', artifactRefs: [] },
      },
    ]);

    const after = (await (await fetch(`${base}/runs/${RUN}`)).json()) as {
      gates: { gateId: string; awaitingApproval: boolean }[];
    };
    expect(after.gates).toHaveLength(1);
    expect(after.gates[0]?.gateId).toBe('G1');
    expect(after.gates[0]?.awaitingApproval).toBe(true);

    const list = (await (await fetch(`${base}/runs`)).json()) as {
      runs: { runId: string; pendingApprovals: number }[];
    };
    expect(list.runs.map((entry) => entry.runId)).toEqual([RUN]);
    expect(list.runs[0]?.pendingApprovals).toBe(1);

    // A decided gate must flip `awaitingApproval` back to false — asserting
    // only the presented case would still pass if the field were hardcoded
    // true, which is exactly the gap a mutation would find.
    log.appendMany([
      { runId: RUN, type: 'GateApproved', payload: { gateId: 'G1', by: 'op' } },
    ]);

    const decided = (await (await fetch(`${base}/runs/${RUN}`)).json()) as {
      gates: { gateId: string; status: string; awaitingApproval: boolean }[];
    };
    expect(decided.gates[0]).toEqual(
      expect.objectContaining({
        gateId: 'G1',
        status: 'approved',
        awaitingApproval: false,
      }),
    );

    const listAfterDecision = (await (await fetch(`${base}/runs`)).json()) as {
      runs: { runId: string; pendingApprovals: number }[];
    };
    expect(listAfterDecision.runs[0]?.pendingApprovals).toBe(0);
  });

  it('finds a run whose id needs percent-decoding, the same id `/runs` lists it under', async () => {
    const { base, log } = await start();
    const runId = 'run with spaces';

    log.appendMany([
      { runId, type: 'RunStarted', payload: { project: 'mpgm', operator: 'op' } },
    ]);

    const list = (await (await fetch(`${base}/runs`)).json()) as {
      runs: { runId: string }[];
    };
    expect(list.runs.map((entry) => entry.runId)).toEqual([runId]);

    // The id `/runs` reports is exactly the one an operator would encode
    // into the detail URL — a route that never decodes it back would 404
    // here even though the run above is real.
    const response = await fetch(`${base}/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runId: string };
    expect(body.runId).toBe(runId);
  });

  it('404s a run the log has never heard of', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/runs/no-such-run`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('no-such-run');
  });

  it('404s an unknown route', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/nonsense`);
    expect(response.status).toBe(404);
  });

  it('refuses to be written to: a POST gets 405, not silent acceptance', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/runs`, { method: 'POST' });
    expect(response.status).toBe(405);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('read-only');
  });

  it('answers a projector failure with 500 rather than dying: the server keeps serving', async () => {
    const { db, traces } = harness();
    openDbs.push(db);

    // The dashboard shares the kernel's own projector and database, so a
    // read can fail for reasons entirely outside this handler — a writer
    // holding the lock, a snapshot row that fails to parse. This stub
    // stands in for any of those: what matters is that `project()` throws.
    const throwingProjector = {
      project(): never {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    } as unknown as Projector;

    const server = new DashboardServer({ projector: throwingProjector, traces });
    openServers.push(server);
    const port = await server.listen(0);
    const base = `http://127.0.0.1:${String(port)}`;

    const response = await fetch(`${base}/runs`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('SQLITE_BUSY');

    // Uncaught, that throw would have propagated out of the request
    // listener and taken the process down with it. It did not: a route
    // that never touches the projector still answers on the same server.
    const traceResponse = await fetch(`${base}/trace`);
    expect(traceResponse.status).toBe(200);
  });

  it('serves the trace graph', async () => {
    const { base, traces } = await start();

    traces.indexCommit({
      sha: 'abc123',
      subject: 'Fix the loan bug',
      body: 'Traces-To: LOAN-1',
    });

    const graph = (await (await fetch(`${base}/trace`)).json()) as {
      nodes: { id: string }[];
      links: { src: string; dst: string }[];
    };
    expect(graph.nodes.map((node) => node.id)).toEqual(['abc123']);
    expect(graph.links).toEqual([
      expect.objectContaining({ src: 'abc123', dst: 'LOAN-1' }),
    ]);
  });
});
