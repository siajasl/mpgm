import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { ArtifactSchemaRegistry } from './schema-registry.js';

/**
 * Versioned artifacts in git (ADR-3, ART-1).
 *
 * Each version is its own file — `brief.v1.md`, `brief.v2.md` — rather than
 * successive commits to one path. Immutability then holds on the filesystem
 * rather than only in review: writing over a gated version fails because the
 * store refuses to touch that file at all, and an earlier version stays
 * readable without going through git history.
 *
 * Frontmatter carries the metadata and the authoritative `data`; the markdown
 * body is a rendering of that data, present so artifacts diff and grep like
 * prose. On any disagreement the frontmatter wins — the body is derived.
 */

export class ArtifactStoreError extends Error {}

/** Attempted edit of a version that a gate has approved (ART-1, ADR-3). */
export class GatedArtifactError extends ArtifactStoreError {
  constructor(
    readonly artifactId: string,
    readonly version: number,
  ) {
    super(
      `artifact '${artifactId}' version ${String(version)} is gated and cannot be edited. ` +
        `Create a successor version instead.`,
    );
  }
}

export const provenanceSchema = z.object({
  /** Task that produced it. */
  task: z.string().min(1),
  role: z.string().min(1),
  /** Model resolved at dispatch (DESIGN §4.2). */
  model: z.string().min(1),
  runId: z.string().min(1),
});

export type Provenance = z.infer<typeof provenanceSchema>;

export const frontmatterSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    schema: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    /** Requirement / design ids this artifact serves (ART-1, ART-2). */
    tracesTo: z.array(z.string().min(1)).default([]),
    producedBy: provenanceSchema,
    /** Version this one supersedes, if any. */
    supersedes: z.number().int().positive().nullable().default(null),
    data: z.unknown(),
  })
  .strict();

export interface Artifact {
  readonly id: string;
  readonly version: number;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly tracesTo: readonly string[];
  readonly producedBy: Provenance;
  readonly supersedes: number | null;
  /** Schema-validated, migrated to the current schema version. */
  readonly data: unknown;
  readonly path: string;
}

export interface WriteRequest {
  readonly id: string;
  /** Declared base path from the playbook, e.g. `artifacts/definition/brief.md`. */
  readonly basePath: string;
  readonly schema: string;
  readonly data: unknown;
  readonly producedBy: Provenance;
  readonly tracesTo?: readonly string[];
}

/** Whether a given artifact version has been approved at a gate. */
export interface GateOracle {
  isGated(artifactId: string, version: number): boolean;
}

/** A gate oracle backed by an explicit set, for tests and for pre-gate phases. */
export class StaticGateOracle implements GateOracle {
  readonly #gated: ReadonlySet<string>;

  constructor(gated: readonly { id: string; version: number }[] = []) {
    this.#gated = new Set(gated.map((entry) => `${entry.id}@${String(entry.version)}`));
  }

  isGated(artifactId: string, version: number): boolean {
    return this.#gated.has(`${artifactId}@${String(version)}`);
  }
}

export interface ArtifactStoreOptions {
  readonly root: string;
  readonly schemas: ArtifactSchemaRegistry;
  readonly gates?: GateOracle;
}

export class ArtifactStore {
  readonly #root: string;
  readonly #schemas: ArtifactSchemaRegistry;
  readonly #gates: GateOracle;

  constructor(options: ArtifactStoreOptions) {
    this.#root = resolve(options.root);
    this.#schemas = options.schemas;
    this.#gates = options.gates ?? new StaticGateOracle();
  }

  /** `artifacts/definition/brief.md` + version 2 → `<root>/artifacts/definition/brief.v2.md`. */
  pathFor(basePath: string, version: number): string {
    const extension = extname(basePath) || '.md';
    const stem = basename(basePath, extension);
    return join(this.#root, dirname(basePath), `${stem}.v${String(version)}${extension}`);
  }

  /** Highest version present on disk, or 0 if none. */
  latestVersion(basePath: string): number {
    const directory = join(this.#root, dirname(basePath));
    if (!existsSync(directory)) {
      return 0;
    }
    const extension = extname(basePath) || '.md';
    const stem = basename(basePath, extension);
    const pattern = new RegExp(
      `^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.v(\\d+)${extension.replace('.', '\\.')}$`,
    );

    let latest = 0;
    for (const entry of readdirSync(directory)) {
      const match = pattern.exec(entry);
      if (match?.[1] !== undefined) {
        latest = Math.max(latest, Number(match[1]));
      }
    }
    return latest;
  }

  /**
   * Write version 1, or the next version after the latest.
   *
   * A gated version is never overwritten: the successor is a new file, and the
   * gated one stays exactly as it was approved.
   */
  write(request: WriteRequest): Artifact {
    const latest = this.latestVersion(request.basePath);

    // Always a new file. Whether the previous version was gated is irrelevant
    // here — a successor never touches it either way. The gate check belongs
    // on overwrite(), which is the operation that would destroy it.
    return this.#writeVersion(request, latest + 1, latest > 0 ? latest : null);
  }

  /**
   * Overwrite an existing version in place. Refused once that version is
   * gated (ART-1); use {@link write} to create a successor.
   */
  overwrite(request: WriteRequest, version: number): Artifact {
    if (this.#gates.isGated(request.id, version)) {
      throw new GatedArtifactError(request.id, version);
    }
    const path = this.pathFor(request.basePath, version);
    if (!existsSync(path)) {
      throw new ArtifactStoreError(
        `artifact '${request.id}' has no version ${String(version)} to overwrite`,
      );
    }
    const existing = this.read(request.basePath, version);
    return this.#writeVersion(request, version, existing.supersedes);
  }

  read(basePath: string, version?: number): Artifact {
    const resolved = version ?? this.latestVersion(basePath);
    if (resolved === 0) {
      throw new ArtifactStoreError(`no artifact versions found at '${basePath}'`);
    }

    const path = this.pathFor(basePath, resolved);
    if (!existsSync(path)) {
      throw new ArtifactStoreError(`artifact file not found: ${path}`);
    }

    const contents = readFileSync(path, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    if (match === null) {
      throw new ArtifactStoreError(`artifact at ${path} has no frontmatter`);
    }

    const parsed = frontmatterSchema.safeParse(parseYaml(match[1] ?? ''));
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ArtifactStoreError(
        `artifact at ${path} has invalid frontmatter: ${issues}`,
      );
    }

    const frontmatter = parsed.data;
    // Migrate on read (ART-3). Data written against an older schema is brought
    // forward deliberately rather than reinterpreted by accident.
    const data = this.#schemas.migrate(
      frontmatter.schema,
      frontmatter.schemaVersion,
      frontmatter.data,
    );

    return {
      id: frontmatter.id,
      version: frontmatter.version,
      schema: frontmatter.schema,
      schemaVersion: this.#schemas.currentVersion(frontmatter.schema),
      tracesTo: frontmatter.tracesTo,
      producedBy: frontmatter.producedBy,
      supersedes: frontmatter.supersedes,
      data,
      path,
    };
  }

  #writeVersion(
    request: WriteRequest,
    version: number,
    supersedes: number | null,
  ): Artifact {
    // Validate before anything reaches disk (ART-3).
    const data = this.#schemas.validate(request.schema, request.data);
    const schemaVersion = this.#schemas.currentVersion(request.schema);
    const path = this.pathFor(request.basePath, version);

    const frontmatter = {
      id: request.id,
      version,
      schema: request.schema,
      schemaVersion,
      tracesTo: [...(request.tracesTo ?? [])],
      producedBy: request.producedBy,
      supersedes,
      data,
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${renderBody(request.id, data)}\n`,
      'utf8',
    );

    return {
      id: request.id,
      version,
      schema: request.schema,
      schemaVersion,
      tracesTo: frontmatter.tracesTo,
      producedBy: request.producedBy,
      supersedes,
      data,
      path,
    };
  }
}

/**
 * Render artifact data as markdown.
 *
 * Derived, never authoritative — the frontmatter `data` is the source. This
 * exists so artifacts read as prose in a diff and stay greppable by agents
 * (ADR-3), not as a second copy of the truth.
 */
export function renderBody(id: string, data: unknown): string {
  const lines: string[] = [`# ${id}`, ''];

  if (data === null || typeof data !== 'object') {
    lines.push(String(data));
    return lines.join('\n');
  }

  for (const [key, value] of Object.entries(data)) {
    lines.push(`## ${key}`, '');
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`- ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`);
      }
    } else if (value !== null && typeof value === 'object') {
      lines.push('```json', JSON.stringify(value, null, 2), '```');
    } else {
      lines.push(String(value));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
