import type { JsonValue } from './event/envelope.js';

/**
 * Log-write redaction (SAF-6).
 *
 * Model and tool outputs are logged in full (ADR-2), which means the event log
 * is exactly where a leaked credential would come to rest permanently — the log
 * is append-only, so a secret written into it cannot later be deleted. Redaction
 * therefore happens on the write path, before the row is inserted, rather than
 * on the read path where it would be a display concern only.
 */

export interface RedactionRule {
  /** Short label; appears in the replacement marker. */
  readonly name: string;
  /** Must carry the global flag so every occurrence is replaced. */
  readonly pattern: RegExp;
}

/** Marker substituted for redacted content. */
export function marker(name: string): string {
  return `[redacted:${name}]`;
}

/**
 * Patterns matched against string *values* anywhere in a payload.
 *
 * Deliberately unanchored. A word boundary would make `0sk-<key>` slip through
 * unredacted, and a miss here is permanent — the log cannot be rewritten. These
 * rules are tuned to over-match: a false positive costs a redaction marker in a
 * transcript, a false negative costs a leaked credential forever.
 */
export const defaultValueRules: readonly RedactionRule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/g },
  { name: 'api-key', pattern: /sk-[A-Za-z0-9]{24,}/g },
];

/**
 * Patterns matched against object *keys*. A match redacts the whole value,
 * whatever its type — `{"password": 1234}` is as much a leak as a string.
 */
export const defaultKeyRules: readonly RedactionRule[] = [
  {
    name: 'secret-key-name',
    pattern:
      /^(?:password|passwd|secret|token|credential|authorization|auth|api[_-]?key|access[_-]?key|private[_-]?key)$/i,
  },
];

export interface RedactorOptions {
  readonly valueRules?: readonly RedactionRule[];
  readonly keyRules?: readonly RedactionRule[];
}

/**
 * Applies redaction rules to a JSON payload, returning a new value. Pure and
 * idempotent: redacting an already-redacted payload is a no-op, because no
 * marker matches any rule.
 */
export class Redactor {
  readonly #valueRules: readonly RedactionRule[];
  readonly #keyRules: readonly RedactionRule[];

  constructor(options: RedactorOptions = {}) {
    this.#valueRules = options.valueRules ?? defaultValueRules;
    this.#keyRules = options.keyRules ?? defaultKeyRules;

    for (const rule of this.#valueRules) {
      if (!rule.pattern.global) {
        throw new Error(
          `redaction rule '${rule.name}' needs the global flag, or only the first match is replaced`,
        );
      }
    }

    for (const rule of this.#keyRules) {
      // Key rules are matched with RegExp.test, which advances lastIndex on a
      // global regex — the same key would then match only every other time.
      if (rule.pattern.global) {
        throw new Error(
          `key redaction rule '${rule.name}' must not carry the global flag`,
        );
      }
    }
  }

  /** Replace every rule match inside a single string. */
  redactString(value: string): string {
    let out = value;
    for (const rule of this.#valueRules) {
      out = out.replace(rule.pattern, marker(rule.name));
    }
    return out;
  }

  /** Replace every rule match anywhere in a payload. */
  redact(value: JsonValue): JsonValue {
    if (typeof value === 'string') {
      return this.redactString(value);
    }

    if (Array.isArray(value)) {
      // Array.isArray widens to any[]; within JsonValue the only array member
      // is readonly JsonValue[], so this narrowing is sound.
      return (value as readonly JsonValue[]).map((item) => this.redact(item));
    }

    if (typeof value === 'object' && value !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [key, nested] of Object.entries(value)) {
        const keyRule = this.#keyRules.find((rule) => rule.pattern.test(key));
        out[key] = keyRule === undefined ? this.redact(nested) : marker(keyRule.name);
      }
      return out;
    }

    return value;
  }
}
