import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Location of a transient, process-local database. */
export const MEMORY = ':memory:';

/**
 * Open the kernel database, creating parent directories as needed.
 *
 * WAL keeps readers from blocking the appending writer, and `synchronous=FULL`
 * means a committed transaction survives power loss — the guarantee crash-safe
 * resume rests on (ORC-5, NFR-1). Neither applies to an in-memory database.
 */
export function openDatabase(location: string): DatabaseSync {
  if (location !== MEMORY) {
    mkdirSync(dirname(location), { recursive: true });
  }

  const db = new DatabaseSync(location);

  if (location !== MEMORY) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  }
  db.exec('PRAGMA foreign_keys = ON');

  return db;
}
