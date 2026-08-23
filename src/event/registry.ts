import type { ZodType } from 'zod';
import { EventValidationError, UnknownEventTypeError, UpcastError } from './errors.js';

/**
 * Migrates a payload from one schema version to the next. Upcasters run in
 * order and must be pure: replay re-derives state by re-reading the log
 * (ORC-3), so an upcaster that consults the clock or the network would make
 * two reads of the same log disagree.
 */
export type Upcaster = (payload: unknown) => unknown;

export interface EventDefinition<T = unknown> {
  readonly type: string;
  /** Current payload schema version. Always `upcasters.length + 1`. */
  readonly version: number;
  readonly schema: ZodType<T>;
  /** `upcasters[i]` migrates a payload from version `i + 1` to version `i + 2`. */
  readonly upcasters: readonly Upcaster[];
}

/**
 * Declare an event type.
 *
 * The version is derived from the number of upcasters rather than stated
 * separately, so the chain length and the version cannot drift apart: adding a
 * new schema version means adding the upcaster that reaches it.
 */
export function defineEvent<T>(
  type: string,
  schema: ZodType<T>,
  upcasters: readonly Upcaster[] = [],
): EventDefinition<T> {
  return { type, version: upcasters.length + 1, schema, upcasters };
}

/** A set of event definitions, keyed by type name. */
export class EventRegistry {
  readonly #definitions: ReadonlyMap<string, EventDefinition>;

  constructor(definitions: readonly EventDefinition[]) {
    const map = new Map<string, EventDefinition>();
    for (const definition of definitions) {
      if (map.has(definition.type)) {
        throw new Error(`duplicate event definition for type '${definition.type}'`);
      }
      map.set(definition.type, definition);
    }
    this.#definitions = map;
  }

  get types(): readonly string[] {
    return [...this.#definitions.keys()].sort();
  }

  has(type: string): boolean {
    return this.#definitions.has(type);
  }

  get(type: string): EventDefinition {
    const definition = this.#definitions.get(type);
    if (definition === undefined) {
      throw new UnknownEventTypeError(type, this.types);
    }
    return definition;
  }

  currentVersion(type: string): number {
    return this.get(type).version;
  }

  /** Validate a payload against the type's current schema. */
  validate(type: string, payload: unknown): unknown {
    const definition = this.get(type);
    const result = definition.schema.safeParse(payload);
    if (!result.success) {
      throw new EventValidationError(
        type,
        result.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      );
    }
    return result.data;
  }

  /**
   * Migrate a payload written at `fromVersion` up to the current version, then
   * validate it. A payload already at the current version is validated only.
   */
  upcast(type: string, fromVersion: number, payload: unknown): unknown {
    const definition = this.get(type);

    if (fromVersion < 1 || fromVersion > definition.version) {
      throw new UpcastError(type, fromVersion, definition.version);
    }

    let migrated = payload;
    for (let version = fromVersion; version < definition.version; version += 1) {
      const upcaster = definition.upcasters[version - 1];
      if (upcaster === undefined) {
        throw new UpcastError(type, fromVersion, definition.version);
      }
      try {
        migrated = upcaster(migrated);
      } catch (cause) {
        throw new UpcastError(type, fromVersion, definition.version, { cause });
      }
    }

    return this.validate(type, migrated);
  }
}
