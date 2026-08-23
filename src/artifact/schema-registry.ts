import type { ZodType } from 'zod';

/**
 * Artifact schemas and their migrations (ART-3).
 *
 * Same discipline as event upcasters (ADR-2): the current version is derived
 * from the migration chain, so the two cannot drift. A breaking schema change
 * is a migration, never a silent reinterpretation of old files.
 */

/** Migrates artifact data from one schema version to the next. Must be pure. */
export type ArtifactMigration = (data: unknown) => unknown;

export interface ArtifactSchema<T = unknown> {
  /** Family name, e.g. `definition`. Recorded in artifact frontmatter. */
  readonly family: string;
  /** Current version. Always `migrations.length + 1`. */
  readonly version: number;
  readonly schema: ZodType<T>;
  /** `migrations[i]` takes version `i + 1` to version `i + 2`. */
  readonly migrations: readonly ArtifactMigration[];
}

export function defineArtifactSchema<T>(
  family: string,
  schema: ZodType<T>,
  migrations: readonly ArtifactMigration[] = [],
): ArtifactSchema<T> {
  return { family, version: migrations.length + 1, schema, migrations };
}

export class ArtifactSchemaError extends Error {}

export class ArtifactSchemaRegistry {
  readonly #schemas: ReadonlyMap<string, ArtifactSchema>;

  constructor(schemas: readonly ArtifactSchema[]) {
    const map = new Map<string, ArtifactSchema>();
    for (const schema of schemas) {
      if (map.has(schema.family)) {
        throw new ArtifactSchemaError(`duplicate artifact schema '${schema.family}'`);
      }
      map.set(schema.family, schema);
    }
    this.#schemas = map;
  }

  get families(): readonly string[] {
    return [...this.#schemas.keys()].sort();
  }

  get(family: string): ArtifactSchema {
    const schema = this.#schemas.get(family);
    if (schema === undefined) {
      throw new ArtifactSchemaError(
        `no artifact schema '${family}'. Registered: ${this.families.join(', ') || '(none)'}`,
      );
    }
    return schema;
  }

  currentVersion(family: string): number {
    return this.get(family).version;
  }

  validate(family: string, data: unknown): unknown {
    const definition = this.get(family);
    const result = definition.schema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ArtifactSchemaError(`artifact data failed '${family}' schema: ${issues}`);
    }
    return result.data;
  }

  /**
   * Migrate data written against `fromVersion` up to the current version, then
   * validate. Data at an unknown version is refused rather than guessed at —
   * ART-3 requires migration, not silent acceptance.
   */
  migrate(family: string, fromVersion: number, data: unknown): unknown {
    const definition = this.get(family);

    if (fromVersion < 1 || fromVersion > definition.version) {
      throw new ArtifactSchemaError(
        `artifact '${family}' is at schema version ${String(fromVersion)}, but this build ` +
          `knows versions 1..${String(definition.version)}`,
      );
    }

    let migrated = data;
    for (let version = fromVersion; version < definition.version; version += 1) {
      const migration = definition.migrations[version - 1];
      if (migration === undefined) {
        throw new ArtifactSchemaError(
          `no migration from '${family}' schema version ${String(version)} to ${String(version + 1)}`,
        );
      }
      migrated = migration(migrated);
    }

    return this.validate(family, migrated);
  }
}
