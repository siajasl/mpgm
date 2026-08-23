/**
 * Crashes in one of the two windows that intent-before-effect exists to cover.
 *
 *   mode "before" — EffectIntended is durable, the effect has NOT happened.
 *   mode "after"  — EffectIntended is durable, the effect HAS happened, but
 *                   EffectCompleted was never written.
 *
 * The "after" case is the dangerous one: the log alone cannot tell it apart
 * from "before", so a naive retry would perform the effect twice.
 *
 * The side effect is creating a marker file, which the parent's effect-check
 * can observe. Runs against the build; see crash-writer.mjs for why.
 */
import { writeFileSync } from 'node:fs';
import { EventLog, kernelRegistry, openDatabase } from '../../../dist/index.js';

const [dbPath, markerPath, mode] = process.argv.slice(2);

const db = openDatabase(dbPath);
const log = EventLog.attach(db, { registry: kernelRegistry() });

log.append({
  runId: 'run-1',
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'operator' },
});
log.append({
  runId: 'run-1',
  type: 'TaskDispatched',
  payload: { taskId: 'T1.1.5', role: 'implementer', model: 'claude-opus-5' },
});

log.append({
  runId: 'run-1',
  type: 'EffectIntended',
  payload: {
    intentId: 'intent-fixed-0001',
    taskId: 'T1.1.5',
    contract: 'demo.effect',
    operation: 'createMarker',
    params: { marker: markerPath },
  },
});

if (mode === 'after') {
  writeFileSync(markerPath, 'the effect happened');
}

// Announce arrival at the crash window, then wait to be killed.
// EffectCompleted is deliberately never written.
process.stdout.write('ready\n');

setInterval(() => {
  // Hold the event loop open so the parent can SIGKILL us.
}, 50);
