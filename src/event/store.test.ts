import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { kernelRegistry } from './catalog.js';
import { EventValidationError, UnknownEventTypeError } from './errors.js';
import { defineEvent, EventRegistry, type Upcaster } from './registry.js';
import type { EventInput, StoredEvent } from './envelope.js';
import { marker, Redactor } from '../redaction.js';
import { EventLog } from './store.js';

const FIXED_TS = '2026-01-01T00:00:00.000Z';
const fixedClock = (): string => FIXED_TS;

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-log-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function openMemoryLog(): EventLog {
  return EventLog.open(':memory:', { registry: kernelRegistry(), clock: fixedClock });
}

/**
 * A stand-in for the real reducer, which arrives at T1.1.3. All this needs to
 * do is be a pure function of the event sequence, so that a difference in the
 * fold implies a difference in the log.
 */
function fold(events: readonly StoredEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

const arbEventInput: fc.Arbitrary<EventInput> = fc.oneof(
  fc.record({
    runId: fc.constant('run-1'),
    type: fc.constant('PhaseEntered'),
    payload: fc.record({ phase: fc.constantFrom('definition', 'scope', 'design') }),
  }),
  fc.record({
    runId: fc.constant('run-1'),
    type: fc.constant('TaskDispatched'),
    payload: fc.record({
      taskId: fc.stringMatching(/^T[0-9]\.[0-9]\.[0-9]$/),
      role: fc.constantFrom('analyst', 'implementer'),
      model: fc.constantFrom('claude-opus-5', 'claude-sonnet-5'),
    }),
  }),
);

describe('EventLog append and read', () => {
  it('assigns strictly increasing sequence numbers', () => {
    const log = openMemoryLog();
    const first = log.append({
      runId: 'run-1',
      type: 'PhaseEntered',
      payload: { phase: 'definition' },
    });
    const second = log.append({
      runId: 'run-1',
      type: 'PhaseEntered',
      payload: { phase: 'scope' },
    });

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(log.lastSeq).toBe(second.seq);
    log.close();
  });

  it('appending the same events twice yields identical logs and identical folds', () => {
    fc.assert(
      fc.property(fc.array(arbEventInput, { maxLength: 40 }), (inputs) => {
        const a = openMemoryLog();
        const b = openMemoryLog();
        try {
          a.appendMany(inputs);
          b.appendMany(inputs);

          expect(a.readRaw()).toStrictEqual(b.readRaw());
          expect(fold(a.read())).toStrictEqual(fold(b.read()));
        } finally {
          a.close();
          b.close();
        }
      }),
    );
  });

  it('reads back in sequence order and filters by run and type', () => {
    const log = openMemoryLog();
    log.appendMany([
      { runId: 'run-1', type: 'PhaseEntered', payload: { phase: 'definition' } },
      { runId: 'run-2', type: 'PhaseEntered', payload: { phase: 'scope' } },
      { runId: 'run-1', type: 'GateApproved', payload: { gateId: 'g1', by: 'operator' } },
    ]);

    expect(log.read({ runId: 'run-1' }).map((e) => e.type)).toStrictEqual([
      'PhaseEntered',
      'GateApproved',
    ]);
    expect(log.read({ type: 'PhaseEntered' })).toHaveLength(2);
    expect(log.read({ fromSeq: 3 })).toHaveLength(1);
    expect(log.read({ limit: 1 })).toHaveLength(1);
    log.close();
  });

  it('rejects unknown types and invalid payloads without writing a row', () => {
    const log = openMemoryLog();

    expect(() => log.append({ runId: 'r', type: 'Nope', payload: {} })).toThrow(
      UnknownEventTypeError,
    );
    expect(() =>
      log.append({ runId: 'r', type: 'PhaseEntered', payload: { phase: '' } }),
    ).toThrow(EventValidationError);
    expect(log.lastSeq).toBe(0);
    log.close();
  });

  it('appendMany is atomic — one bad event writes none of the batch', () => {
    const log = openMemoryLog();

    expect(() =>
      log.appendMany([
        { runId: 'r', type: 'PhaseEntered', payload: { phase: 'definition' } },
        { runId: 'r', type: 'PhaseEntered', payload: { phase: '' } },
      ]),
    ).toThrow(EventValidationError);
    expect(log.lastSeq).toBe(0);
    log.close();
  });
});

describe('EventLog redaction (SAF-6)', () => {
  it('redacts before the row is written, not on the way out', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{24,40}$/), (tail) => {
        const secret = `sk-ant-${tail}`;
        const log = openMemoryLog();
        try {
          log.append({
            runId: 'run-1',
            type: 'ToolCallLogged',
            payload: {
              taskId: 'T1.1.2',
              tool: 'Bash',
              decision: 'allowed',
              detail: `export ANTHROPIC_API_KEY=${secret}`,
            },
          });

          // readRaw bypasses every read-path transform, so this asserts the
          // secret is absent from storage itself.
          const stored = JSON.stringify(log.readRaw());

          expect(stored).not.toContain(secret);
          expect(stored).toContain(marker('anthropic-key'));
        } finally {
          log.close();
        }
      }),
    );
  });

  it('honours a custom rule set', () => {
    const log = EventLog.open(':memory:', {
      registry: kernelRegistry(),
      clock: fixedClock,
      redactor: new Redactor({
        valueRules: [{ name: 'internal-id', pattern: /INT-[0-9]{4}/g }],
        keyRules: [],
      }),
    });

    log.append({
      runId: 'run-1',
      type: 'OperatorIntervened',
      payload: { action: 'redirect', detail: 'ticket INT-4242' },
    });

    expect(JSON.stringify(log.readRaw())).toContain(marker('internal-id'));
    log.close();
  });
});

describe('EventLog append-only enforcement', () => {
  it('refuses UPDATE and DELETE at the database level', () => {
    const path = tempDbPath();
    const log = EventLog.open(path, { registry: kernelRegistry(), clock: fixedClock });
    log.append({
      runId: 'run-1',
      type: 'PhaseEntered',
      payload: { phase: 'definition' },
    });
    log.close();

    // Reach past EventLog entirely: the guarantee must hold for any writer.
    const raw = new DatabaseSync(path);
    try {
      expect(() => {
        raw.exec("UPDATE events SET type = 'Tampered'");
      }).toThrow(/append-only/);
      expect(() => {
        raw.exec('DELETE FROM events');
      }).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });
});

describe('EventLog schema evolution', () => {
  const addCount: Upcaster = (payload) => ({ ...(payload as object), count: 0 });
  const renameName: Upcaster = (payload) => {
    const { name, ...rest } = payload as { name: string };
    return { ...rest, fullName: name };
  };

  const registryV1 = new EventRegistry([
    defineEvent('Thing', z.object({ name: z.string().min(1) })),
  ]);
  const registryV3 = new EventRegistry([
    defineEvent('Thing', z.object({ fullName: z.string().min(1), count: z.number() }), [
      addCount,
      renameName,
    ]),
  ]);

  it('reads events written before a schema change, upcast to current', () => {
    const path = tempDbPath();

    const oldLog = EventLog.open(path, { registry: registryV1, clock: fixedClock });
    oldLog.append({ runId: 'run-1', type: 'Thing', payload: { name: 'kernel' } });
    oldLog.close();

    const newLog = EventLog.open(path, { registry: registryV3, clock: fixedClock });
    try {
      const [raw] = newLog.readRaw();
      const [migrated] = newLog.read();

      // Stored bytes are untouched — the log really is append-only.
      expect(raw?.schemaVersion).toBe(1);
      expect(raw?.payload).toStrictEqual({ name: 'kernel' });

      // Readers see the current shape.
      expect(migrated?.schemaVersion).toBe(3);
      expect(migrated?.payload).toStrictEqual({ fullName: 'kernel', count: 0 });
    } finally {
      newLog.close();
    }
  });

  it('survives a restart with the log intact', () => {
    const path = tempDbPath();

    const first = EventLog.open(path, { registry: kernelRegistry(), clock: fixedClock });
    first.appendMany([
      {
        runId: 'run-1',
        type: 'RunStarted',
        payload: { project: 'mpgm', operator: 'op' },
      },
      { runId: 'run-1', type: 'PhaseEntered', payload: { phase: 'definition' } },
    ]);
    const before = first.readRaw();
    first.close();

    const second = EventLog.open(path, { registry: kernelRegistry(), clock: fixedClock });
    try {
      expect(second.readRaw()).toStrictEqual(before);
      expect(second.lastSeq).toBe(2);
    } finally {
      second.close();
    }
  });
});
