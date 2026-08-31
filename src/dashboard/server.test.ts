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
