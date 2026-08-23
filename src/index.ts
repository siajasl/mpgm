/**
 * mpgm — an agentic harness driving the full SDLC via Claude Agent SDK
 * sessions under a single operator.
 *
 * The event log (ADR-2, DESIGN §5) is the kernel's single authoritative write
 * path. The state fold and snapshots land at T1.1.3, blob offload at T1.1.4,
 * and intent-before-effect at T1.1.5.
 */

export type { EventInput, JsonValue, StoredEvent } from './event/envelope.js';
export {
  AppendOnlyViolationError,
  EventLogError,
  EventValidationError,
  UnknownEventTypeError,
  UpcastError,
} from './event/errors.js';
export type { EventDefinition, Upcaster } from './event/registry.js';
export { defineEvent, EventRegistry } from './event/registry.js';
export type { ArtifactRef } from './event/catalog.js';
export { artifactRefSchema, kernelEvents, kernelRegistry } from './event/catalog.js';
export type { RedactionRule, RedactorOptions } from './redaction.js';
export { defaultKeyRules, defaultValueRules, marker, Redactor } from './redaction.js';
export type { Clock, EventLogOptions, ReadOptions } from './event/store.js';
export { EventLog } from './event/store.js';

/** Package version. Kept in step with package.json by test. */
export const VERSION = '0.1.0';
