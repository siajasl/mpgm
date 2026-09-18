import { describe, expect, it } from 'vitest';
import { scopeSchema } from '../schemas.js';
import { nfrRequirementSourceSchema, quantifiedRequirements } from './nfr-source.js';

const SCOPE = scopeSchema.parse({
  summary: 'a service that answers, and answers quickly',
  requirements: [
    {
      kind: 'functional',
      id: 'FUN-1',
      statement: 'the service answers GET /health',
      rationale: 'the deploy gate reads it',
      priority: 'must',
      acceptanceCriteria: ['200 with a body'],
      tracesTo: ['GOAL-1'],
    },
    {
      kind: 'non-functional',
      id: 'PERF-1',
      statement: 'p95 latency stays under 300ms',
      rationale: 'the operator notices anything slower',
      priority: 'must',
      acceptanceCriteria: ['a load test reports p95 under 300ms'],
      tracesTo: ['GOAL-2'],
      threshold: { metric: 'p95-latency', value: 300, unit: 'ms', measuredBy: 'k6' },
    },
  ],
  outOfScope: [{ item: 'authentication', why: 'a later milestone' }],
});

describe('the requirements an nfr step reads (T4.3.2)', () => {
  it('parses the Scope artifact’s own requirements, mixed kinds and all', () => {
    // The shape this project actually produces. Parsing only the flat
    // `{id, metric, value, unit, measuredBy}` shape refused every Scope list
    // there is, because the parse is all-or-nothing and a functional entry
    // has no threshold to flatten.
    const parsed = nfrRequirementSourceSchema.safeParse(SCOPE.requirements);
    expect(parsed.success).toBe(true);
    expect(parsed.success && quantifiedRequirements(parsed.data)).toStrictEqual([
      { id: 'PERF-1', metric: 'p95-latency', value: 300, unit: 'ms', measuredBy: 'k6' },
    ]);
  });

  it('still accepts an already-flattened list', () => {
    const flat = [
      { id: 'PERF-2', metric: 'p99-latency', value: 500, unit: 'ms', measuredBy: 'k6' },
    ];
    const parsed = nfrRequirementSourceSchema.safeParse(flat);
    expect(parsed.success && quantifiedRequirements(parsed.data)).toStrictEqual(flat);
  });

  it('refuses an empty list rather than measuring nothing and calling it coverage (CONV-4)', () => {
    const parsed = nfrRequirementSourceSchema.safeParse([]);
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.message).toMatch(
      /measures at least one requirement/,
    );
  });

  it('refuses an element that is neither shape', () => {
    // A threshold with no unit is not a threshold anyone can measure
    // against, and the refusal is what makes it visible rather than a row
    // reported in whatever unit the provider felt like.
    const parsed = nfrRequirementSourceSchema.safeParse([
      { id: 'PERF-3', metric: 'p50-latency', value: 100, measuredBy: 'k6' },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('leaves nothing behind for a list with nothing quantified in it', () => {
    // The caller — `runPhase` — is what turns this into a refusal; the
    // projection itself must not invent a row for a functional requirement
    // `test.nfr` has no threshold to measure.
    const functionalOnly = nfrRequirementSourceSchema.parse([SCOPE.requirements[0]]);
    expect(quantifiedRequirements(functionalOnly)).toStrictEqual([]);
  });
});
