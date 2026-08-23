import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { Projector } from './projector.js';
import { SnapshotStore } from './snapshot-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '__fixtures__', 'crash-writer.mjs');
const builtPackage = join(here, '..', '..', 'dist', 'index.js');

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-crash-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CrashResult {
  readonly reportedSeqs: number[];
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** Run the writer until it has committed `killAfter` events, then SIGKILL it. */
async function crashAfter(
  dbPath: string,
  interval: number,
  killAfter: number,
): Promise<CrashResult> {
  const child = spawn(process.execPath, [fixture, dbPath, String(interval)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const reportedSeqs: number[] = [];
  let pending = '';
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        reportedSeqs.push(Number(line));
      }
    }
    if (reportedSeqs.length >= killAfter) {
      // SIGKILL cannot be caught, blocked, or handled: the process stops
      // mid-instruction with no chance to flush or clean up.
      child.kill('SIGKILL');
    }
  });

  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.on('exit', (_code, exitSignal) => {
      resolve(exitSignal);
    });
    child.on('error', reject);
  });

  return { reportedSeqs, signal, stderr };
}

describe('crash and resume', () => {
  beforeAll(() => {
    if (!existsSync(builtPackage)) {
      throw new Error(
        `dist/index.js is missing — the crash fixture runs against the build. ` +
          `Run 'npm run build' first (the check script and CI already do).`,
      );
    }
  });

  // Arbitrary kill points, including one that lands between snapshots and one
  // that lands on a snapshot boundary.
  for (const killAfter of [7, 12, 25]) {
    it(`resumes identically after SIGKILL at ~${String(killAfter)} events`, async () => {
      const dbPath = tempDbPath();
      const interval = 5;

      const crash = await crashAfter(dbPath, interval, killAfter);

      expect(crash.stderr).toBe('');
      expect(crash.signal).toBe('SIGKILL');
      expect(crash.reportedSeqs.length).toBeGreaterThanOrEqual(killAfter);

      // Reopen exactly as a restarting kernel would.
      const db = openDatabase(dbPath);
      try {
        const log = EventLog.attach(db, { registry: kernelRegistry() });
        const snapshots = SnapshotStore.attach(db);
        const projector = new Projector({ log, snapshots, interval });

        const resumed = projector.project();

        // 1. Every append the child reported as committed is durable.
        const lastReported = crash.reportedSeqs.at(-1) ?? 0;
        expect(log.lastSeq).toBeGreaterThanOrEqual(lastReported);

        // 2. No torn or partial rows: the log reads cleanly end to end.
        expect(log.readRaw()).toHaveLength(log.lastSeq);

        // 3. The point of the task — resuming via snapshot plus tail gives
        //    exactly the state a full fold of the log gives.
        expect(resumed).toStrictEqual(projector.rebuild());
        expect(resumed.lastSeq).toBe(log.lastSeq);

        // 4. Resuming twice is stable.
        expect(projector.project()).toStrictEqual(resumed);
      } finally {
        db.close();
      }
    }, 30_000);
  }

  it('a killed run is indistinguishable from a clean one with the same events', async () => {
    const dbPath = tempDbPath();
    const crash = await crashAfter(dbPath, 5, 15);
    expect(crash.signal).toBe('SIGKILL');

    const crashedDb = openDatabase(dbPath);
    try {
      const crashedLog = EventLog.attach(crashedDb, { registry: kernelRegistry() });
      const crashedState = new Projector({
        log: crashedLog,
        snapshots: SnapshotStore.attach(crashedDb),
        interval: 5,
      }).project();

      // Replay the surviving events into a fresh log and fold that.
      const cleanDb = openDatabase(MEMORY);
      try {
        // Replay reuses the timestamps the log recorded. `ts` is data in the
        // log, not something the fold reads from a clock — that is precisely
        // why replaying a run is reproducible (ORC-3).
        const survivors = crashedLog.read();
        let cursor = 0;
        const cleanLog = EventLog.attach(cleanDb, {
          registry: kernelRegistry(),
          clock: () => survivors[cursor++]?.ts ?? '',
        });
        cleanLog.appendMany(
          survivors.map((event) => ({
            runId: event.runId,
            type: event.type,
            payload: event.payload,
          })),
        );
        const cleanState = new Projector({
          log: cleanLog,
          snapshots: SnapshotStore.attach(cleanDb),
          interval: 5,
        }).project();

        expect(crashedState).toStrictEqual(cleanState);
      } finally {
        cleanDb.close();
      }
    } finally {
      crashedDb.close();
    }
  }, 30_000);
});
