/** Base class for every error raised by the event log. */
export class EventLogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** An event type was used that the registry does not know about. */
export class UnknownEventTypeError extends EventLogError {
  constructor(
    readonly type: string,
    known: readonly string[],
  ) {
    super(
      `unknown event type '${type}'. Registered types: ${known.join(', ') || '(none)'}`,
    );
  }
}

/** A payload failed schema validation. */
export class EventValidationError extends EventLogError {
  constructor(
    readonly type: string,
    readonly issues: readonly string[],
  ) {
    super(`payload for event '${type}' failed validation: ${issues.join('; ')}`);
  }
}

/** A stored payload could not be migrated to the current schema version. */
export class UpcastError extends EventLogError {
  constructor(
    readonly type: string,
    readonly fromVersion: number,
    readonly toVersion: number,
    options?: ErrorOptions,
  ) {
    super(
      `failed to upcast event '${type}' from schema version ${String(fromVersion)} to ${String(toVersion)}`,
      options,
    );
  }
}

/** An attempt was made to mutate the append-only log. */
export class AppendOnlyViolationError extends EventLogError {}
