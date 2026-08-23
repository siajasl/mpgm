import type { EventLog } from '../event/store.js';
import { emptyState, type KernelState } from './kernel-state.js';
import { fold, reduce, REDUCER_VERSION } from './reduce.js';
import type { SnapshotStore } from './snapshot-store.js';

/** Default number of events between snapshots. */
export const DEFAULT_SNAPSHOT_INTERVAL = 100;

export interface ProjectorOptions {
  readonly log: EventLog;
  readonly snapshots: SnapshotStore;
  /** Events between snapshots. Defaults to {@link DEFAULT_SNAPSHOT_INTERVAL}. */
  readonly interval?: number;
}

/**
 * Derives kernel state from the log (DESIGN §6).
 *
 * A restart calls {@link project}, which resumes from the newest usable
 * snapshot and folds only the tail. {@link rebuild} ignores snapshots entirely
 * and folds from seq 1. The two must always agree — that equivalence is the
 * whole safety argument for keeping snapshots at all, and it is asserted in
 * the tests rather than assumed.
 */
export class Projector {
  readonly #log: EventLog;
  readonly #snapshots: SnapshotStore;
  readonly #interval: number;

  constructor(options: ProjectorOptions) {
    this.#log = options.log;
    this.#snapshots = options.snapshots;
    this.#interval = options.interval ?? DEFAULT_SNAPSHOT_INTERVAL;

    if (this.#interval < 1) {
      throw new Error('snapshot interval must be at least 1');
    }
  }

  /** Resume from the newest usable snapshot plus the tail, snapshotting as it goes. */
  project(): KernelState {
    const snapshot = this.#snapshots.latest(REDUCER_VERSION);
    let state = snapshot?.state ?? emptyState;

    for (const event of this.#log.read({ fromSeq: state.lastSeq + 1 })) {
      state = reduce(state, event);

      if (state.lastSeq % this.#interval === 0) {
        this.#snapshots.put({
          seq: state.lastSeq,
          // The event's own timestamp, not the wall clock: projecting the same
          // log twice must produce the same snapshot rows.
          ts: event.ts,
          reducerVersion: REDUCER_VERSION,
          state,
        });
      }
    }

    return state;
  }

  /** Fold the entire log from scratch, ignoring snapshots. */
  rebuild(): KernelState {
    return fold(this.#log.read());
  }
}
