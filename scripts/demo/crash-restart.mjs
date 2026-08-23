/**
 * M1.1 verification — scripted crash/restart demo.
 *
 * Runs a synthetic workload (no LLM) three ways and compares them:
 *
 *   1. clean          — one uninterrupted pass
 *   2. crashed        — killed with SIGKILL at several arbitrary points and
 *                       resumed each time until complete
 *   3. replayed       — the crashed log re-appended into a fresh database
 *
 * All three must agree byte-for-byte, on both the stored log and the folded
 * state. Exits non-zero on any mismatch, so it works as a gate.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BlobStore,
  demoTimestamp,
  EventLog,
  hashContent,
  kernelRegistry,
  openDatabase,
  Projector,
  SnapshotStore,
} from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, 'worker.mjs');

const TASK_COUNT = 30;
const SNAPSHOT_INTERVAL = 10;
/** Stop crashing once this few events remain, so the kill always lands. */
const MIN_REMAINING = 6;

const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`);
    failures.push(label);
  }
}

/** Run the worker; kill it after `killAfter` commits, or let it finish. */
function runWorker(dbPath, blobRoot, killAfter) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [worker, dbPath, blobRoot, String(TASK_COUNT)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let committed = 0;
    let pending = '';
    let completed = false;
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line === 'complete') {
          completed = true;
        } else if (line.length > 0) {
          committed += 1;
          if (killAfter !== null && committed >= killAfter) {
            child.kill('SIGKILL');
          }
        }
      }
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ committed, completed, signal, code, stderr });
    });
  });
}

function openState(dbPath) {
  const db = openDatabase(dbPath);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: SNAPSHOT_INTERVAL,
  });
  return { db, log, projector };
}

/** Strip stored rows back to appendable inputs. */
function toInputs(rows) {
  return rows.map((row) => ({ runId: row.runId, type: row.type, payload: row.payload }));
}

/** Stable digest of a value, for byte-for-byte comparison. */
function digest(value) {
  return hashContent(Buffer.from(JSON.stringify(value), 'utf8'));
}

const root = mkdtempSync(join(tmpdir(), 'mpgm-m11-demo-'));

try {
  // ---------------------------------------------------------------- clean run
  process.stdout.write('\nClean run\n');
  const cleanDir = join(root, 'clean');
  const cleanResult = await runWorker(
    join(cleanDir, 'state.db'),
    join(cleanDir, 'blobs'),
    null,
  );
  check(
    'worker completed without interruption',
    cleanResult.completed,
    cleanResult.stderr,
  );

  const clean = openState(join(cleanDir, 'state.db'));
  const cleanState = clean.projector.project();
  const cleanLog = clean.log.readRaw();
  check(
    'folded state matches a full rebuild',
    digest(cleanState) === digest(clean.projector.rebuild()),
  );
  process.stdout.write(
    `  ${String(cleanLog.length)} events, state digest ${digest(cleanState).slice(0, 12)}\n`,
  );
  clean.db.close();

  // -------------------------------------------------------------- crashed run
  process.stdout.write(
    '\nCrashed run — SIGKILL at arbitrary points, resumed each time\n',
  );
  const crashDir = join(root, 'crashed');
  const crashDb = join(crashDir, 'state.db');
  const crashBlobs = join(crashDir, 'blobs');

  // Kill points are derived from how much work is left, so every round really
  // does get interrupted. A fixed schedule silently stops crashing once the
  // remaining events fall below the next threshold.
  const total = cleanLog.length;
  for (let round = 0; round < 10; round += 1) {
    const probe = openState(crashDb);
    const seq = probe.log.lastSeq;
    probe.db.close();

    const remaining = total - seq;
    if (remaining <= MIN_REMAINING) {
      break;
    }
    const killAfter = Math.max(3, Math.floor(remaining / 2));

    const result = await runWorker(crashDb, crashBlobs, killAfter);
    check(
      `killed after ${String(killAfter)} of ${String(remaining)} remaining commits`,
      result.signal === 'SIGKILL',
      result.stderr,
    );

    // Restart exactly as the kernel would, and verify the resume is coherent.
    const restarted = openState(crashDb);
    const resumed = restarted.projector.project();
    check(
      `  resume equals full rebuild at seq ${String(resumed.lastSeq)}`,
      digest(resumed) === digest(restarted.projector.rebuild()),
    );
    check(
      '  resuming twice is stable',
      digest(resumed) === digest(restarted.projector.project()),
    );
    check('  no torn rows', restarted.log.readRaw().length === restarted.log.lastSeq);
    restarted.db.close();
  }

  const finish = await runWorker(crashDb, crashBlobs, null);
  check('resumed run reaches completion', finish.completed, finish.stderr);

  const crashed = openState(crashDb);
  const crashedState = crashed.projector.project();
  const crashedLog = crashed.log.readRaw();
  crashed.db.close();

  // ------------------------------------------------------- crashed == clean
  process.stdout.write('\nCrashed run versus clean run\n');
  check(
    'stored logs are byte-for-byte identical',
    digest(crashedLog) === digest(cleanLog),
  );
  check(
    'folded states are byte-for-byte identical',
    digest(crashedState) === digest(cleanState),
  );

  // ------------------------------------------------------------------ replay
  process.stdout.write('\nReplay from log\n');
  const replayDir = join(root, 'replay');
  const replayDb = openDatabase(join(replayDir, 'state.db'));
  const replayHolder = { log: null };
  const replayLog = EventLog.attach(replayDb, {
    registry: kernelRegistry(),
    clock: () => demoTimestamp(replayHolder.log.lastSeq + 1),
  });
  replayHolder.log = replayLog;
  for (const event of toInputs(crashedLog)) {
    replayLog.append(event);
  }
  const replayProjector = new Projector({
    log: replayLog,
    snapshots: SnapshotStore.attach(replayDb),
    interval: SNAPSHOT_INTERVAL,
  });
  const replayState = replayProjector.project();
  const replayRows = replayLog.readRaw();
  replayDb.close();

  check(
    'replayed log is byte-for-byte identical',
    digest(replayRows) === digest(crashedLog),
  );
  check(
    'replayed state is byte-for-byte identical',
    digest(replayState) === digest(crashedState),
  );

  // Blob content is addressed by hash, so a replay stores no new blobs.
  const replayBlobs = BlobStore.open(join(crashDir, 'blobs'));
  check('blob store deduplicated across runs', replayBlobs.count() === TASK_COUNT);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nM1.1 verification passed\n\n'
    : `\nM1.1 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
