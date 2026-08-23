/**
 * Appends events forever until it is killed, snapshotting as it goes.
 *
 * Runs against the built package rather than the sources because Node strips
 * TypeScript types but does not resolve a `.js` specifier to a `.ts` file, so
 * the sources cannot be imported directly by a subprocess.
 *
 * Prints the sequence number of each committed append so the parent knows
 * exactly how far the child got before SIGKILL.
 */
import {
  EventLog,
  kernelRegistry,
  openDatabase,
  Projector,
  SnapshotStore,
} from '../../../dist/index.js';

const [dbPath, intervalArg] = process.argv.slice(2);
const interval = Number(intervalArg);

const db = openDatabase(dbPath);
const log = EventLog.attach(db, { registry: kernelRegistry() });
const snapshots = SnapshotStore.attach(db);
const projector = new Projector({ log, snapshots, interval });

log.append({
  runId: 'run-1',
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'operator' },
});

// Bounded only so a failure to kill cannot spin forever; the parent always
// kills long before this.
for (let index = 0; index < 5000; index += 1) {
  const event = log.append({
    runId: 'run-1',
    type: 'PhaseEntered',
    payload: { phase: index % 2 === 0 ? 'definition' : 'scope' },
  });

  if (event.seq % interval === 0) {
    projector.project();
  }

  process.stdout.write(`${event.seq}\n`);
}
