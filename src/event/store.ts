import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventInput, JsonValue, StoredEvent } from './envelope.js';
import { EventLogError } from './errors.js';
import type { EventRegistry } from './registry.js';
import { Redactor } from '../redaction.js';
import { EVENTS_DDL } from './ddl.js';

/** Returns the timestamp recorded on an appended event. */
export type Clock = () => string;

export interface EventLogOptions {
  readonly registry: EventRegistry;
  /** Defaults to a {@link Redactor} with the standard rule set. */
  readonly redactor?: Redactor;
  /** Defaults to the wall clock in ISO-8601 UTC. Injectable so runs are reproducible. */
  readonly clock?: Clock;
}

export interface ReadOptions {
  readonly runId?: string;
  readonly type?: string;
  /** Inclusive lower bound on `seq`. */
  readonly fromSeq?: number;
  readonly limit?: number;
}

interface EventRow {
  readonly seq: number;
  readonly ts: string;
  readonly run_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly payload: string;
}

const defaultClock: Clock = () => new Date().toISOString();

/**
 * Append-only event log over SQLite (ADR-2).
 *
 * The write path is: validate against the current schema, redact (SAF-6), then
 * insert. Validation runs first so schema errors are reported against what the
 * caller actually passed; redaction runs second so no secret reaches the file.
 * Because redaction only ever substitutes one string for another, the payload
 * still satisfies its schema afterwards.
 *
 * The read path is the mirror image: parse, upcast from the stored schema
 * version to the current one, then validate.
 */
export class EventLog {
  readonly #db: DatabaseSync;
  readonly #registry: EventRegistry;
  readonly #redactor: Redactor;
  readonly #clock: Clock;

  private constructor(db: DatabaseSync, options: EventLogOptions) {
    this.#db = db;
    this.#registry = options.registry;
    this.#redactor = options.redactor ?? new Redactor();
    this.#clock = options.clock ?? defaultClock;
  }

  /**
   * Open (creating if absent) a log at `location`, or `':memory:'` for a
   * transient one. Parent directories are created as needed.
   */
  static open(location: string, options: EventLogOptions): EventLog {
    if (location !== ':memory:') {
      mkdirSync(dirname(location), { recursive: true });
    }

    const db = new DatabaseSync(location);

    // WAL keeps readers from blocking the appending writer; FULL synchronous
    // means a committed append survives a power loss, which is the guarantee
    // crash-safe resume rests on (ORC-5, NFR-1).
    if (location !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(EVENTS_DDL);

    return new EventLog(db, options);
  }

  /** Append one event, returning it as stored. */
  append<P>(input: EventInput<P>): StoredEvent {
    const [event] = this.appendMany([input]);
    if (event === undefined) {
      throw new EventLogError('append produced no event');
    }
    return event;
  }

  /**
   * Append several events in a single transaction: either every event lands or
   * none does, so a crash mid-batch cannot leave a partial step in the log.
   */
  appendMany(inputs: readonly EventInput[]): StoredEvent[] {
    const prepared = inputs.map((input) => {
      const validated = this.#registry.validate(input.type, input.payload);
      const redacted = this.#redactor.redact(validated as JsonValue);
      return {
        ts: this.#clock(),
        runId: input.runId,
        type: input.type,
        schemaVersion: this.#registry.currentVersion(input.type),
        payload: redacted,
      };
    });

    const statement = this.#db.prepare(
      `INSERT INTO events (ts, run_id, type, schema_version, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const appended: StoredEvent[] = [];
    this.#db.exec('BEGIN');
    try {
      for (const row of prepared) {
        const result = statement.run(
          row.ts,
          row.runId,
          row.type,
          row.schemaVersion,
          JSON.stringify(row.payload),
        );
        appended.push({ ...row, seq: Number(result.lastInsertRowid) });
      }
      this.#db.exec('COMMIT');
    } catch (cause) {
      this.#db.exec('ROLLBACK');
      throw cause;
    }

    return appended;
  }

  /** Read events in `seq` order, upcast to the current schema version. */
  read(options: ReadOptions = {}): StoredEvent[] {
    return this.readRaw(options).map((event) => ({
      ...event,
      schemaVersion: this.#registry.currentVersion(event.type),
      payload: this.#registry.upcast(event.type, event.schemaVersion, event.payload),
    }));
  }

  /**
   * Read events exactly as stored — no upcasting, no validation. Intended for
   * migration tooling and for tests that need to observe what was written.
   */
  readRaw(options: ReadOptions = {}): StoredEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.runId !== undefined) {
      clauses.push('run_id = ?');
      params.push(options.runId);
    }
    if (options.type !== undefined) {
      clauses.push('type = ?');
      params.push(options.type);
    }
    if (options.fromSeq !== undefined) {
      clauses.push('seq >= ?');
      params.push(options.fromSeq);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit === undefined ? '' : 'LIMIT ?';
    if (options.limit !== undefined) {
      params.push(options.limit);
    }

    const rows = this.#db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq ${limit}`)
      .all(...params) as unknown as EventRow[];

    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      runId: row.run_id,
      type: row.type,
      schemaVersion: row.schema_version,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  /** Highest assigned sequence number, or 0 when the log is empty. */
  get lastSeq(): number {
    const row = this.#db
      .prepare('SELECT MAX(seq) AS seq FROM events')
      .get() as unknown as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  close(): void {
    this.#db.close();
  }
}
