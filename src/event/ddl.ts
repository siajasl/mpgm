/**
 * Event log DDL (ADR-2).
 *
 * Append-only is enforced by the database, not by the calling convention: the
 * triggers below make UPDATE and DELETE fail even for a process that bypasses
 * {@link EventLog}. The log is the single authoritative write path, so the
 * guarantee belongs where it cannot be routed around.
 */
export const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT    NOT NULL,
  run_id         TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  payload        TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS events_by_type ON events (type, seq);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'event log is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'event log is append-only: DELETE is not permitted');
END;
`;
