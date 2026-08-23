import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import type { EventInput } from '../event/envelope.js';
import { EventLog } from '../event/store.js';
import { DEFAULT_SNAPSHOT_INTERVAL, Projector } from './projector.js';
import { REDUCER_VERSION } from './reduce.js';
import { SnapshotStore } from './snapshot-store.js';

const RUN = 'run-1';

function harness(interval: number) {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, {
    registry: kernelRegistry(),
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  const snapshots = SnapshotStore.attach(db);
  const projector = new Projector({ log, snapshots, interval });
  return { db, log, snapshots, projector };
}

function phaseEvents(count: number): EventInput[] {
  return [
    { runId: RUN, type: 'RunStarted', payload: { project: 'mpgm', operator: 'op' } },
    ...Array.from({ length: count }, (_, index) => ({
      runId: RUN,
      type: 'PhaseEntered',
      payload: { phase: index % 2 === 0 ? 'definition' : 'scope' },
    })),
  ];
}

describe('Projector', () => {
  it('resuming from a snapshot equals folding the whole log', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 10 }),
        (count, interval) => {
          const { db, log, projector } = harness(interval);
          try {
            log.appendMany(phaseEvents(count));

            // First pass writes snapshots; second pass resumes from them.
            projector.project();

            expect(projector.project()).toStrictEqual(projector.rebuild());
          } finally {
            db.close();
          }
        },
      ),
    );
  });

  it('writes a snapshot every interval events', () => {
    const { db, log, snapshots, projector } = harness(5);
    try {
      log.appendMany(phaseEvents(19)); // 20 events including RunStarted
      projector.project();

      expect(snapshots.count()).toBe(4); // seq 5, 10, 15, 20
      expect(snapshots.latest(REDUCER_VERSION)?.seq).toBe(20);
    } finally {
      db.close();
    }
  });

  it('picks up new events appended after a projection', () => {
    const { db, log, projector } = harness(3);
    try {
      log.appendMany(phaseEvents(5));
      const first = projector.project();

      log.appendMany([
        { runId: RUN, type: 'PhaseEntered', payload: { phase: 'design' } },
      ]);
      const second = projector.project();

      expect(second.lastSeq).toBe(first.lastSeq + 1);
      expect(second).toStrictEqual(projector.rebuild());
    } finally {
      db.close();
    }
  });

  it('ignores snapshots written by a different reducer version', () => {
    const { db, log, snapshots, projector } = harness(5);
    try {
      log.appendMany(phaseEvents(9));

      // A snapshot from another reducer, claiming state the log does not support.
      snapshots.put({
        seq: 10,
        ts: '2026-01-01T00:00:00.000Z',
        reducerVersion: REDUCER_VERSION + 1,
        state: { lastSeq: 10, runs: {} },
      });

      expect(projector.project()).toStrictEqual(projector.rebuild());
    } finally {
      db.close();
    }
  });

  it('projects an empty log to the empty state', () => {
    const { db, projector } = harness(5);
    try {
      expect(projector.project()).toStrictEqual({ lastSeq: 0, runs: {} });
    } finally {
      db.close();
    }
  });

  it('rejects a nonsensical interval', () => {
    const { db, log, snapshots } = harness(1);
    try {
      expect(() => new Projector({ log, snapshots, interval: 0 })).toThrow(/at least 1/);
    } finally {
      db.close();
    }
  });

  it('defaults to the documented interval', () => {
    expect(DEFAULT_SNAPSHOT_INTERVAL).toBe(100);
  });
});

describe('SnapshotStore', () => {
  it('keeps only the newest snapshots when pruned', () => {
    const { db, log, snapshots, projector } = harness(2);
    try {
      log.appendMany(phaseEvents(19));
      projector.project();
      const latest = snapshots.latest(REDUCER_VERSION)?.seq;

      const removed = snapshots.prune(3);

      expect(snapshots.count()).toBe(3);
      expect(removed).toBeGreaterThan(0);
      expect(snapshots.latest(REDUCER_VERSION)?.seq).toBe(latest);
    } finally {
      db.close();
    }
  });

  it('still resumes correctly after pruning', () => {
    const { db, log, snapshots, projector } = harness(2);
    try {
      log.appendMany(phaseEvents(19));
      projector.project();
      snapshots.prune(1);

      expect(projector.project()).toStrictEqual(projector.rebuild());
    } finally {
      db.close();
    }
  });

  it('refuses to prune everything', () => {
    const { db, snapshots } = harness(2);
    try {
      expect(() => snapshots.prune(0)).toThrow(/at least one/);
    } finally {
      db.close();
    }
  });
});
