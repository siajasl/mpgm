import { isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
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

/**
 * Tools whose input names a network destination the session wants to fetch.
 *
 * SAF-1 lists network destinations alongside tools and paths, and for a role
 * that reads untrusted content (SAF-3) this is the control that matters most:
 * a page can ask an agent to fetch a URL, and the agent has no way to know it
 * should not. It does not get to decide.
 */
const FETCH_TOOLS: Readonly<Record<string, string>> = {
  WebFetch: 'url',
};

/**
 * Tools that reach the network without naming a destination.
 *
 * A search returns content from hosts the allowlist never saw, so the
 * allowlist does not bound what comes back — it bounds what the agent can
 * then go and *retrieve*, which is the step that turns a planted link into a
 * request. A role with no network allowance at all cannot search either.
 */
const SEARCH_TOOLS: readonly string[] = ['WebSearch'];

/**
 * Tools the kernel itself requires, allowed regardless of the role's toolset.
 *
 * `StructuredOutput` is the carrier the SDK uses to return a session's final
 * result when `outputFormat` is a JSON schema — it is the mechanism by which a
 * task produces its output at all, not a capability the role exercises. Denying
 * it makes every task fail validation and then exhaust its retries, which is
 * exactly what the M1.2 live demo did. It touches nothing outside the session,
 * so allowing it grants no reach.
 */
export const KERNEL_TOOLS: readonly string[] = ['StructuredOutput'];

export interface RolePolicyOptions {
  /** Project root. Paths outside it are denied whatever the globs say. */
  readonly root: string;
  /** Defaults to {@link KERNEL_TOOLS}. */
  readonly alwaysAllow?: readonly string[];
}

export class RolePolicy {
  readonly #role: Role;
  readonly #root: string;
  readonly #alwaysAllow: readonly string[];

  constructor(role: Role, options: RolePolicyOptions) {
    this.#role = role;
    this.#root = resolve(options.root);
    this.#alwaysAllow = options.alwaysAllow ?? KERNEL_TOOLS;
  }

  get roleName(): string {
    return this.#role.name;
  }

  decide(toolName: string, input: Record<string, unknown>): ToolDecision {
    // 0. Kernel infrastructure. The role's toolset governs what the agent may
    //    reach out and touch; it does not govern how the session hands its
    //    answer back.
    if (this.#alwaysAllow.includes(toolName)) {
      return { behavior: 'allow' };
    }

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

    // 3. Network destinations (SAF-1).
    const fetchField = FETCH_TOOLS[toolName];
    if (fetchField !== undefined) {
      return this.#checkDestination(toolName, input, fetchField);
    }

    if (SEARCH_TOOLS.includes(toolName) && this.#role.network.allow.length === 0) {
      return {
        behavior: 'deny',
        reason:
          `tool '${toolName}' reaches the network, and role '${this.#role.name}' ` +
          `declares no network allowance`,
      };
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

  #checkDestination(
    toolName: string,
    input: Record<string, unknown>,
    field: string,
  ): ToolDecision {
    const raw = input[field];
    if (typeof raw !== 'string') {
      return {
        behavior: 'deny',
        reason: `tool '${toolName}' supplied no string '${field}', so its destination cannot be checked`,
      };
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {
        behavior: 'deny',
        reason: `tool '${toolName}' supplied '${raw}', which is not a URL`,
      };
    }

    // Plaintext is refused before the host is even considered: it is readable
    // and rewritable in transit, and an allowlisted host reached over http is
    // an allowlisted host in name only.
    if (url.protocol !== 'https:') {
      return {
        behavior: 'deny',
        reason:
          `tool '${toolName}' requested '${url.protocol}//${url.host}'; only https ` +
          `destinations are permitted`,
      };
    }

    const allowed = this.#role.network.allow;
    const host = url.hostname.toLowerCase();
    if (!allowed.some((pattern) => matchesGlob(host, pattern.toLowerCase()))) {
      return {
        behavior: 'deny',
        reason:
          `host '${host}' is not in role '${this.#role.name}' network allowlist ` +
          `(${allowed.join(', ') || 'none'})`,
      };
    }

    return { behavior: 'allow' };
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
      // Name the root. Several tools require an absolute path, so an agent
      // that is told only "outside the project root" has to guess at one --
      // in the M1.2 demo that cost two turns of an eight-step budget before
      // it found the right prefix.
      return {
        behavior: 'deny',
        reason:
          `path '${raw}' resolves outside the project root '${this.#root}'. ` +
          `Paths must be inside it; relative paths resolve from it.`,
      };
    }

    // Git's own metadata is never writable, whatever a role declares. An
    // implementation task's worktree is its sandbox precisely because the
    // branch it is on is not the trunk (IMP-1) — and an agent that can write
    // `.git/HEAD` or `.git/config` can change which branch that is. Git
    // operations belong to the kernel, so no role loses anything it should
    // have had.
    if (mode === 'write' && (rel === '.git' || rel.split(sep)[0] === '.git')) {
      return {
        behavior: 'deny',
        reason:
          `tool '${toolName}' may not write '${rel}': git metadata is never writable, ` +
          `whatever a role declares. Git operations go through the kernel.`,
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
