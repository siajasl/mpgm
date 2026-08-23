import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { roleFrontmatterSchema, type Role } from './definition.js';

/**
 * A role file could not be loaded. Every message names the file, the field and
 * what was expected — a role that fails to load stops a run, so the error has
 * to be enough to fix it without opening the loader (PLAN T1.2.1).
 */
export class RoleLoadError extends Error {
  constructor(
    readonly sourcePath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${sourcePath}: ${detail}`, options);
    this.name = 'RoleLoadError';
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

interface SplitFile {
  readonly frontmatter: string;
  readonly body: string;
}

function splitFrontmatter(sourcePath: string, contents: string): SplitFile {
  const match = FRONTMATTER.exec(contents);
  if (match === null) {
    throw new RoleLoadError(
      sourcePath,
      'missing YAML frontmatter. A role file must begin with a line containing ' +
        'exactly "---", followed by the frontmatter, followed by a closing "---".',
    );
  }

  return {
    frontmatter: match[1] ?? '',
    body: contents.slice(match[0].length),
  };
}

/** Parse a role from file contents. Exposed so callers can validate before writing. */
export function parseRole(sourcePath: string, contents: string): Role {
  const { frontmatter, body } = splitFrontmatter(sourcePath, contents);

  let raw: unknown;
  try {
    raw = parseYaml(frontmatter);
  } catch (cause) {
    const where =
      cause instanceof YAMLParseError && cause.linePos !== undefined
        ? ` at line ${String(cause.linePos[0].line)}`
        : '';
    throw new RoleLoadError(
      sourcePath,
      `frontmatter is not valid YAML${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (raw === null || typeof raw !== 'object') {
    throw new RoleLoadError(sourcePath, 'frontmatter must be a YAML mapping of fields');
  }

  const parsed = roleFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new RoleLoadError(sourcePath, `invalid role frontmatter:\n${issues}`);
  }

  const systemPrompt = body.trim();
  if (systemPrompt.length === 0) {
    throw new RoleLoadError(
      sourcePath,
      'role body is empty. The body after the frontmatter is the system prompt.',
    );
  }

  return { ...parsed.data, systemPrompt, sourcePath };
}

/** Load one role file. */
export function loadRoleFile(sourcePath: string): Role {
  let contents: string;
  try {
    contents = readFileSync(sourcePath, 'utf8');
  } catch (cause) {
    throw new RoleLoadError(sourcePath, 'could not be read', { cause });
  }

  const role = parseRole(sourcePath, contents);
  const expected = basename(sourcePath).replace(/\.md$/, '');

  if (role.name !== expected) {
    throw new RoleLoadError(
      sourcePath,
      `declares name '${role.name}' but the file is named '${expected}.md'. ` +
        `Roles are referenced by file name, so the two must agree.`,
    );
  }

  return role;
}

export class RoleRegistry {
  readonly #roles: ReadonlyMap<string, Role>;

  constructor(roles: readonly Role[]) {
    const map = new Map<string, Role>();
    for (const role of roles) {
      const existing = map.get(role.name);
      if (existing !== undefined) {
        throw new RoleLoadError(
          role.sourcePath,
          `duplicate role '${role.name}', already defined by ${existing.sourcePath}`,
        );
      }
      map.set(role.name, role);
    }
    this.#roles = map;
  }

  /** Load every `*.md` in a directory. */
  static fromDirectory(directory: string): RoleRegistry {
    let entries: string[];
    try {
      entries = readdirSync(directory)
        .filter((entry) => entry.endsWith('.md'))
        .sort();
    } catch (cause) {
      throw new RoleLoadError(directory, 'role directory could not be read', { cause });
    }

    return new RoleRegistry(entries.map((entry) => loadRoleFile(join(directory, entry))));
  }

  get names(): readonly string[] {
    return [...this.#roles.keys()];
  }

  has(name: string): boolean {
    return this.#roles.has(name);
  }

  get(name: string): Role {
    const role = this.#roles.get(name);
    if (role === undefined) {
      throw new RoleLoadError(
        name,
        `no such role. Loaded roles: ${this.names.join(', ') || '(none)'}`,
      );
    }
    return role;
  }
}
