import type { DatabaseSync } from 'node:sqlite';
import type { KernelState } from './kernel-state.js';

/**
 * Snapshots are a cache of the reducer's output, never a second source of
 * truth: the event log alone is authoritative (ADR-2). They may be pruned or
 * discarded at any time, which is why this table carries no append-only
 * triggers — unlike `events`.
 */
export const SNAPSHOTS_DDL = `
CREATE TABLE IF NOT EXISTS snapshots (
  seq             INTEGER PRIMARY KEY,
  ts              TEXT    NOT NULL,
  reducer_version INTEGER NOT NULL,
  state           TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS snapshots_by_version ON snapshots (reducer_version, seq);
`;

export interface Snapshot {
  readonly seq: number;
  readonly ts: string;
  readonly reducerVersion: number;
  readonly state: KernelState;
}

interface SnapshotRow {
  readonly seq: number;
  readonly ts: string;
  readonly reducer_version: number;
  readonly state: string;
}

export class SnapshotStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static attach(db: DatabaseSync): SnapshotStore {
    db.exec(SNAPSHOTS_DDL);
    return new SnapshotStore(db);
  }

  /** Record state as of `seq`. Replaces any snapshot already held at that seq. */
  put(snapshot: Snapshot): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO snapshots (seq, ts, reducer_version, state)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        snapshot.seq,
        snapshot.ts,
        snapshot.reducerVersion,
        JSON.stringify(snapshot.state),
      );
  }

  /**
   * Newest snapshot written by the given reducer version, or null.
   *
   * Filtering on the version is what makes it safe to change the reducer: a
   * snapshot produced by different fold logic is not a valid starting point
   * for this one, and resuming from it would silently diverge from the log.
   */
  latest(reducerVersion: number): Snapshot | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM snapshots
         WHERE reducer_version = ?
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(reducerVersion) as unknown as SnapshotRow | undefined;

    if (row === undefined) {
      return null;
    }

    return {
      seq: row.seq,
      ts: row.ts,
      reducerVersion: row.reducer_version,
      state: JSON.parse(row.state) as KernelState,
    };
  }

  count(): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM snapshots')
      .get() as unknown as {
      n: number;
    };
    return row.n;
  }

  /** Drop all but the newest `keep` snapshots. Returns how many were removed. */
  prune(keep: number): number {
    if (keep < 1) {
      throw new Error('prune must keep at least one snapshot');
    }
    const before = this.count();
    this.#db
      .prepare(
        `DELETE FROM snapshots
         WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT ?)`,
      )
      .run(keep);
    return before - this.count();
  }
}
