/**
 * Demo worker: appends the synthetic run to a log, one event at a time, and
 * waits to be killed. Prints each committed sequence number so the harness
 * knows exactly how far it got.
 *
 * Timestamps are derived from the sequence number rather than the wall clock,
 * so a run interrupted and resumed produces a byte-identical log to one that
 * was never interrupted. Without that, "identical" could only ever mean
 * "identical apart from the timestamps", which is a much weaker claim.
 */
import {
  BlobStore,
  demoTimestamp,
  EventLog,
  kernelRegistry,
  openDatabase,
  syntheticRun,
} from '../../dist/index.js';

const [dbPath, blobRoot, taskCountArg] = process.argv.slice(2);
const taskCount = Number(taskCountArg);

const db = openDatabase(dbPath);
const blobs = BlobStore.open(blobRoot);

// The clock needs the log's current seq, and the log needs the clock, so the
// reference is threaded through a holder rather than a mutable binding.
const holder = { log: null };
const log = EventLog.attach(db, {
  registry: kernelRegistry(),
  clock: () => demoTimestamp(holder.log.lastSeq + 1),
});
holder.log = log;

const events = syntheticRun('run-1', taskCount, blobs);

// Resume where the log left off: everything already committed is skipped.
for (const event of events.slice(log.lastSeq)) {
  const stored = log.append(event);
  process.stdout.write(`${stored.seq}\n`);
}

process.stdout.write('complete\n');
