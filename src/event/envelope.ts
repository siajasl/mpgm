/**
 * Event envelope — the shape every logged event shares (DESIGN §5).
 *
 * `seq` and `ts` are assigned by the store on append; `schemaVersion` records
 * which version of the payload schema the payload was written against, so that
 * old events remain readable after a schema change (ADR-2, upcasters).
 */

/** Any value that survives a JSON round-trip. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** An event as accepted by {@link EventLog.append} — the caller supplies no ordering. */
export interface EventInput<P = unknown> {
  readonly runId: string;
  readonly type: string;
  readonly payload: P;
}

/** An event as read back from the log. */
export interface StoredEvent<P = unknown> {
  readonly seq: number;
  readonly ts: string;
  readonly runId: string;
  readonly type: string;
  /**
   * Payload schema version. Reads report the *current* version because the
   * payload has been upcast; {@link EventLog.readRaw} reports the version the
   * event was written at.
   */
  readonly schemaVersion: number;
  readonly payload: P;
}
