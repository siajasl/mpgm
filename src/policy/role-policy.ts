import { isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import type { Role } from '../role/definition.js';
import type { ToolDecision } from '../agent/session.js';

/**
 * Per-role tool and path policy, enforced outside the model (ADR-6, SAF-1).
 *
 * The model is never asked to respect its permissions; the kernel answers
 * every `canUseTool` call from the role's declaration. A prompt that talks the
 * agent into attempting a forbidden tool still gets a denial, because the
 * decision was never the agent's to make.
 */

/** Tools whose input names a file the session wants to read. */
const READ_PATH_TOOLS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Glob: 'path',
  Grep: 'path',
};

/** Tools whose input names a file the session wants to modify. */
const WRITE_PATH_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

export interface RolePolicyOptions {
  /** Project root. Paths outside it are denied whatever the globs say. */
  readonly root: string;
}

export class RolePolicy {
  readonly #role: Role;
  readonly #root: string;

  constructor(role: Role, options: RolePolicyOptions) {
    this.#role = role;
    this.#root = resolve(options.root);
  }

  get roleName(): string {
    return this.#role.name;
  }

  decide(toolName: string, input: Record<string, unknown>): ToolDecision {
    // 1. Tool allowlist. Absence is denial: a role gets only what it declared
    //    (AGT-2), so forgetting to add a tool fails closed rather than open.
    if (!this.#role.tools.allow.includes(toolName)) {
      return {
        behavior: 'deny',
        reason:
          `tool '${toolName}' is not in role '${this.#role.name}' toolset ` +
          `(${this.#role.tools.allow.join(', ') || 'none'})`,
      };
    }

    // 2. Path allowlist for the filesystem tools we understand.
    const writeField = WRITE_PATH_TOOLS[toolName];
    if (writeField !== undefined) {
      return this.#checkPath(toolName, input, writeField, 'write');
    }

    const readField = READ_PATH_TOOLS[toolName];
    if (readField !== undefined) {
      return this.#checkPath(toolName, input, readField, 'read');
    }

    // Allowlisted, and not a filesystem tool this policy models. The OS
    // sandbox is the second layer for those (ADR-6).
    return { behavior: 'allow' };
  }

  /** A gate suitable for {@link SessionRequest.canUseTool}. */
  gate(onDecision?: (tool: string, decision: ToolDecision) => void) {
    return (toolName: string, input: Record<string, unknown>): Promise<ToolDecision> => {
      const decision = this.decide(toolName, input);
      onDecision?.(toolName, decision);
      return Promise.resolve(decision);
    };
  }

  #checkPath(
    toolName: string,
    input: Record<string, unknown>,
    field: string,
    mode: 'read' | 'write',
  ): ToolDecision {
    const raw = input[field];

    if (raw === undefined || raw === null) {
      // Glob and Grep may omit a path and mean "the working directory".
      return mode === 'read' && (toolName === 'Glob' || toolName === 'Grep')
        ? // The project root itself, which path.matchesGlob spells as ''.
          this.#matchGlobs('', mode, toolName)
        : {
            behavior: 'deny',
            reason: `tool '${toolName}' supplied no '${field}', so its target cannot be checked`,
          };
    }

    if (typeof raw !== 'string') {
      return {
        behavior: 'deny',
        reason: `tool '${toolName}' supplied a non-string '${field}'`,
      };
    }

    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(this.#root, raw);
    const rel = relative(this.#root, absolute);

    // Containment first, then globs. Normalising before matching is what stops
    // 'artifacts/../../etc/passwd' from satisfying 'artifacts/**'. An empty
    // relative path is the root itself -- inside, not outside -- so only '..'
    // and absolute results escape.
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        behavior: 'deny',
        reason: `path '${raw}' resolves outside the project root`,
      };
    }

    return this.#matchGlobs(rel, mode, toolName);
  }

  #matchGlobs(rel: string, mode: 'read' | 'write', toolName: string): ToolDecision {
    const globs = mode === 'write' ? this.#role.paths.write : this.#role.paths.read;

    if (globs.some((glob) => matchesGlob(rel, glob))) {
      return { behavior: 'allow' };
    }

    return {
      behavior: 'deny',
      reason:
        `tool '${toolName}' may not ${mode} '${rel || '.'}': role '${this.#role.name}' ` +
        `declares ${mode} access to ${globs.join(', ') || 'nothing'}`,
    };
  }
}
