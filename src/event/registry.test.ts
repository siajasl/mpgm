import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventValidationError, UnknownEventTypeError, UpcastError } from './errors.js';
import { defineEvent, EventRegistry, type Upcaster } from './registry.js';
import { z } from 'zod';

/**
 * A fixture type with real version history. The kernel catalog is all v1, so
 * the upcaster chain is exercised here rather than by inventing fake schema
 * history in production code.
 *
 *   v1 { name }                 →
 *   v2 { name, count }          (count defaults to 0)
 *   v3 { fullName, count }      (name is renamed)
 */
const addCount: Upcaster = (payload) => ({ ...(payload as object), count: 0 });

const renameName: Upcaster = (payload) => {
  const { name, ...rest } = payload as { name: string };
  return { ...rest, fullName: name };
};

const versioned = defineEvent(
  'Versioned',
  z.object({ fullName: z.string(), count: z.number() }),
  [addCount, renameName],
);

const registry = new EventRegistry([versioned]);

describe('EventRegistry versioning', () => {
  it('derives the version from the upcaster chain', () => {
    expect(versioned.version).toBe(3);
    expect(registry.currentVersion('Versioned')).toBe(3);
    expect(defineEvent('Fresh', z.object({})).version).toBe(1);
  });

  it('round-trips any v1 payload up to the current version', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(registry.upcast('Versioned', 1, { name })).toStrictEqual({
          fullName: name,
          count: 0,
        });
      }),
    );
  });

  it('resumes the chain from an intermediate version', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), (name, count) => {
        expect(registry.upcast('Versioned', 2, { name, count })).toStrictEqual({
          fullName: name,
          count,
        });
      }),
    );
  });

  it('validates without migrating when already current', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), (fullName, count) => {
        const payload = { fullName, count };

        expect(registry.upcast('Versioned', 3, payload)).toStrictEqual(payload);
      }),
    );
  });

  it('upcasting is deterministic — the same input always yields the same output', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(registry.upcast('Versioned', 1, { name })).toStrictEqual(
          registry.upcast('Versioned', 1, { name }),
        );
      }),
    );
  });

  it('rejects a version outside the known range', () => {
    expect(() => registry.upcast('Versioned', 0, {})).toThrow(UpcastError);
    expect(() => registry.upcast('Versioned', 4, {})).toThrow(UpcastError);
  });

  it('wraps a throwing upcaster rather than leaking its error', () => {
    const broken = new EventRegistry([
      defineEvent('Broken', z.object({}), [
        () => {
          throw new Error('boom');
        },
      ]),
    ]);

    expect(() => broken.upcast('Broken', 1, {})).toThrow(UpcastError);
  });

  it('names the registered types when an unknown one is used', () => {
    expect(() => registry.get('Nope')).toThrow(UnknownEventTypeError);
    expect(() => registry.get('Nope')).toThrow(/Versioned/);
  });

  it('reports which field failed validation', () => {
    expect(() => registry.validate('Versioned', { fullName: 1, count: 0 })).toThrow(
      EventValidationError,
    );
    expect(() => registry.validate('Versioned', { fullName: 1, count: 0 })).toThrow(
      /fullName/,
    );
  });

  it('refuses duplicate definitions', () => {
    expect(() => new EventRegistry([versioned, versioned])).toThrow(/duplicate/);
  });
});
