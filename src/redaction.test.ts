import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultValueRules, marker, Redactor } from './redaction.js';

/** Secrets shaped like the real thing, one per default value rule. */
const secrets = {
  'anthropic-key': fc
    .stringMatching(/^[A-Za-z0-9_-]{24,40}$/)
    .map((tail) => `sk-ant-${tail}`),
  'github-token': fc.stringMatching(/^[A-Za-z0-9]{20,36}$/).map((tail) => `ghp_${tail}`),
  'aws-access-key-id': fc.stringMatching(/^[0-9A-Z]{16}$/).map((tail) => `AKIA${tail}`),
  'api-key': fc.stringMatching(/^[A-Za-z0-9]{24,40}$/).map((tail) => `sk-${tail}`),
} as const;

const anySecret = fc.oneof(
  ...Object.entries(secrets).map(([name, arb]) =>
    arb.map((value) => ({ name, value }) as const),
  ),
);

describe('Redactor', () => {
  it('removes every secret shape the default rules cover', () => {
    fc.assert(
      fc.property(anySecret, fc.string(), fc.string(), (secret, before, after) => {
        const redacted = new Redactor().redactString(`${before}${secret.value}${after}`);

        expect(redacted).not.toContain(secret.value);
        expect(redacted).toContain(marker(secret.name));
      }),
    );
  });

  it('is idempotent — redacting a redacted payload changes nothing', () => {
    fc.assert(
      fc.property(anySecret, (secret) => {
        const redactor = new Redactor();
        const once = redactor.redactString(`token is ${secret.value}`);

        expect(redactor.redactString(once)).toBe(once);
      }),
    );
  });

  it('reaches secrets nested anywhere in a payload', () => {
    fc.assert(
      fc.property(anySecret, (secret) => {
        const redacted = new Redactor().redact({
          outer: { list: [{ deep: `key=${secret.value}` }] },
        });

        expect(JSON.stringify(redacted)).not.toContain(secret.value);
      }),
    );
  });

  it('redacts by key name whatever the value type', () => {
    const redacted = new Redactor().redact({
      password: 12345,
      apiKey: { nested: 'value' },
      note: 'kept',
    });

    expect(redacted).toStrictEqual({
      password: marker('secret-key-name'),
      apiKey: marker('secret-key-name'),
      note: 'kept',
    });
  });

  it('does not mutate its input', () => {
    const input = { token: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' };
    const snapshot = structuredClone(input);

    new Redactor().redact(input);

    expect(input).toStrictEqual(snapshot);
  });

  it('rejects rules that would silently misbehave', () => {
    expect(() => new Redactor({ valueRules: [{ name: 'x', pattern: /a/ }] })).toThrow(
      /global flag/,
    );
    expect(() => new Redactor({ keyRules: [{ name: 'x', pattern: /a/g }] })).toThrow(
      /must not carry the global flag/,
    );
  });

  it('ships a rule for every secret shape the fixtures cover', () => {
    const ruleNames = new Set(defaultValueRules.map((rule) => rule.name));

    for (const name of Object.keys(secrets)) {
      expect(ruleNames).toContain(name);
    }
  });
});
