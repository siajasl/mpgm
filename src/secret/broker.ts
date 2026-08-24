import { matchesGlob } from 'node:path';
import { z } from 'zod';
import {
  defaultKeyRules,
  defaultValueRules,
  Redactor,
  type RedactionRule,
} from '../redaction.js';
import type { ToolDecision, ToolGate } from '../agent/session.js';

/**
 * The secret broker (SAF-2, ADR-6, DESIGN §7).
 *
 * Agents name credentials; they never hold them. A role's prompt, its context
 * and its session environment contain only symbolic references, and the real
 * value is substituted into a tool call at the boundary — after the kernel has
 * decided that *this* tool may receive *this* secret — so there is no moment
 * at which the model has seen it.
 *
 * Two layers, in this order:
 *
 * 1. **The value is not there.** The session's environment is scrubbed, so
 *    `printenv` returns nothing to leak, and a reference the kernel refuses to
 *    resolve stays a literal placeholder rather than becoming a value.
 * 2. **If it escapes anyway, it does not persist.** The broker knows the exact
 *    values, so redaction at log-write is exact rather than heuristic. The log
 *    is append-only: a secret written into it cannot later be removed.
 *
 * The first layer is the control. The second exists because the first is a
 * claim about a system with subprocesses in it.
 */

export class SecretError extends Error {}

/** `${secret:github-token}` — what an agent writes. */
export const SECRET_REFERENCE = /\$\{secret:([a-z0-9][a-z0-9._-]*)\}/g;

export function secretReference(name: string): string {
  return `\${secret:${name}}`;
}

/**
 * Below this length an exact-match redaction rule does more harm than good:
 * a four-character "secret" would blank every incidental occurrence of those
 * characters in every log line. A credential this short is either not a
 * credential or a problem in its own right, so the declaration is refused
 * rather than quietly handled either way.
 */
export const MIN_SECRET_LENGTH = 8;

export const secretDeclarationSchema = z.object({
  /** The symbolic name agents use. */
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be lowercase kebab-case'),
  /** Environment variable of the *kernel* process holding the real value. */
  env: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an upper-case environment name'),
  /**
   * Tool-name globs that may receive it. At least one: a secret no tool may
   * use is dead configuration that reads like a control.
   *
   * `Bash` is conspicuously not a sensible entry. A shell that can interpolate
   * a credential can also print it, and the tool boundary stops being a
   * boundary.
   */
  tools: z.array(z.string().min(1)).min(1),
  description: z.string().default(''),
});

export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;

/** What a caller writes: `description` is optional until the schema fills it. */
export type SecretDeclarationInput = z.input<typeof secretDeclarationSchema>;

export interface SecretBrokerOptions {
  readonly declarations: readonly SecretDeclarationInput[];
  /** Where values come from. Defaults to the kernel's own environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Why a reference was not resolved. */
export type RefusalReason = 'unknown-secret' | 'tool-not-permitted' | 'not-configured';

export interface SecretRefusal {
  readonly name: string;
  readonly reason: RefusalReason;
  readonly detail: string;
}

export interface Resolution {
  readonly input: Record<string, unknown>;
  /** Names substituted. Values are never reported. */
  readonly injected: readonly string[];
  readonly refusals: readonly SecretRefusal[];
}

/** Every `${secret:…}` name appearing anywhere in a value. */
export function referencedSecrets(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(SECRET_REFERENCE)) {
        if (match[1] !== undefined) {
          found.add(match[1]);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return [...found].sort();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SecretBroker {
  readonly #declarations: ReadonlyMap<string, SecretDeclaration>;
  /** Name → real value. Never returned, never logged, never rendered. */
  readonly #values: ReadonlyMap<string, string>;

  constructor(options: SecretBrokerOptions) {
    const env = options.env ?? process.env;
    const declarations = new Map<string, SecretDeclaration>();
    const values = new Map<string, string>();

    for (const raw of options.declarations) {
      const declaration = secretDeclarationSchema.parse(raw);
      if (declarations.has(declaration.name)) {
        throw new SecretError(`secret '${declaration.name}' is declared twice`);
      }
      declarations.set(declaration.name, declaration);

      const value = env[declaration.env];
      if (value === undefined || value === '') {
        // Not an error: a project declares every secret it might need, and a
        // given run may legitimately not have all of them. Using one that is
        // absent is what fails, and it fails at the tool call, naming it.
        continue;
      }
      if (value.length < MIN_SECRET_LENGTH) {
        throw new SecretError(
          `secret '${declaration.name}' (${declaration.env}) is shorter than ` +
            `${String(MIN_SECRET_LENGTH)} characters; redacting it would blank ` +
            `unrelated text, and not redacting it would leave it in the log`,
        );
      }
      values.set(declaration.name, value);
    }

    this.#declarations = declarations;
    this.#values = values;
  }

  names(): string[] {
    return [...this.#declarations.keys()].sort();
  }

  declaration(name: string): SecretDeclaration | undefined {
    return this.#declarations.get(name);
  }

  /** Whether a value is actually available for this name. */
  available(name: string): boolean {
    return this.#values.has(name);
  }

  /** Whether the named secret may be given to this tool. */
  permits(name: string, toolName: string): boolean {
    return (
      this.#declarations
        .get(name)
        ?.tools.some((pattern) => matchesGlob(toolName, pattern)) ?? false
    );
  }

  #refusalFor(name: string, toolName: string): SecretRefusal | undefined {
    const declaration = this.#declarations.get(name);
    if (declaration === undefined) {
      return {
        name,
        reason: 'unknown-secret',
        detail: `no secret named '${name}' is declared`,
      };
    }
    if (!this.permits(name, toolName)) {
      return {
        name,
        reason: 'tool-not-permitted',
        detail:
          `secret '${name}' may be given to ${declaration.tools.join(', ')}, ` +
          `not to '${toolName}'`,
      };
    }
    if (!this.#values.has(name)) {
      return {
        name,
        reason: 'not-configured',
        detail: `secret '${name}' is declared but ${declaration.env} is not set`,
      };
    }
    return undefined;
  }

  /**
   * Substitute the references a tool call is entitled to.
   *
   * A reference the broker refuses is left exactly as written. Substituting a
   * placeholder for an empty string would hand the tool a call that looks
   * valid and is not, and the failure would surface somewhere with no
   * connection to the credential.
   */
  resolve(toolName: string, input: Record<string, unknown>): Resolution {
    const injected = new Set<string>();
    const refusals: SecretRefusal[] = [];

    const substitute = (text: string): string =>
      text.replace(SECRET_REFERENCE, (whole, name: string) => {
        const refusal = this.#refusalFor(name, toolName);
        if (refusal !== undefined) {
          if (!refusals.some((seen) => seen.name === name)) {
            refusals.push(refusal);
          }
          return whole;
        }
        injected.add(name);
        return this.#values.get(name) ?? whole;
      });

    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        return substitute(node);
      }
      if (Array.isArray(node)) {
        return node.map(walk);
      }
      if (typeof node === 'object' && node !== null) {
        return Object.fromEntries(
          Object.entries(node).map(([key, value]) => [key, walk(value)]),
        );
      }
      return node;
    };

    return {
      input: walk(input) as Record<string, unknown>,
      injected: [...injected].sort(),
      refusals,
    };
  }

  /**
   * The environment a session may be given.
   *
   * Every declared secret's variable is removed, and so is any *other*
   * variable holding the same value — an alias set by a wrapper script would
   * otherwise carry the credential straight past the scrub, and `printenv`
   * would print it (ADR-6).
   */
  environment(
    base: Readonly<Record<string, string | undefined>>,
  ): Record<string, string | undefined> {
    const banned = new Set(this.#values.values());
    const stripped = new Set([...this.#declarations.values()].map((entry) => entry.env));
    const result: Record<string, string | undefined> = {};

    for (const [key, value] of Object.entries(base)) {
      if (stripped.has(key)) {
        continue;
      }
      if (typeof value === 'string' && banned.has(value)) {
        continue;
      }
      result[key] = value;
    }
    return result;
  }

  /**
   * Exact-match redaction rules for every value the broker holds.
   *
   * The marker names the secret — `[redacted:secret:github-token]` — so an
   * operator reading the log can tell *which* credential got somewhere it
   * should not have, which is the first thing they will need to know, without
   * the log containing it.
   */
  redactionRules(): RedactionRule[] {
    return (
      [...this.#values.entries()]
        // Longest first, so a secret that contains another is redacted whole
        // rather than leaving its prefix behind as a marker plus a fragment.
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([name, value]) => ({
          name: `secret:${name}`,
          pattern: new RegExp(escapeForRegExp(value), 'g'),
        }))
    );
  }

  /** A redactor for the event log: exact secrets first, then the patterns. */
  redactor(): Redactor {
    return new Redactor({
      valueRules: [...this.redactionRules(), ...defaultValueRules],
      keyRules: defaultKeyRules,
    });
  }

  /**
   * Wrap a tool gate so that permitted references are resolved and refused
   * ones stop the call.
   *
   * A refusal is a denial, not a shrug. An agent putting a credential
   * reference somewhere it may not go is either confused or being steered, and
   * both are worth stopping and recording rather than letting through with the
   * placeholder intact (CONV-4).
   */
  gate(inner: ToolGate): ToolGate {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolDecision> => {
      const decision = await inner(toolName, input);
      if (decision.behavior !== 'allow') {
        return decision;
      }

      const referenced = referencedSecrets(input);
      if (referenced.length === 0) {
        return decision;
      }

      const resolution = this.resolve(toolName, input);
      const refusal = resolution.refusals[0];
      if (refusal !== undefined) {
        return { behavior: 'deny', reason: `secret broker: ${refusal.detail}` };
      }

      return { behavior: 'allow', updatedInput: resolution.input };
    };
  }
}
