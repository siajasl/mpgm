import { describe, expect, it } from 'vitest';
import {
  projectArtifactSchemas,
  projectOutputSchemas,
  requirementSchema,
  scopeSchema,
} from './schemas.js';

const functional = {
  kind: 'functional' as const,
  id: 'FUN-1',
  statement: 'The service accepts a job over HTTP.',
  rationale: 'Derived from the Definition goal "submit work remotely".',
  priority: 'must' as const,
  acceptanceCriteria: ['POST /jobs with a valid body returns 202'],
  tracesTo: ['goal: submit work remotely'],
};

const nonFunctional = {
  kind: 'non-functional' as const,
  id: 'NFR-1',
  statement: 'A job is acknowledged quickly under normal load.',
  rationale: 'Derived from the Definition constraint on operator wait time.',
  priority: 'should' as const,
  acceptanceCriteria: ['p95 acknowledgement latency stays within the threshold'],
  tracesTo: ['constraint: operators will not wait'],
  threshold: {
    metric: 'p95 acknowledgement latency',
    value: 200,
    unit: 'ms',
    measuredBy: 'load test at 100 concurrent submitters',
  },
};

const scope = {
  summary: 'Requirements derived from the Definition.',
  requirements: [functional, nonFunctional],
  outOfScope: [{ item: 'A web UI', why: 'The Definition names the CLI as the surface.' }],
};

describe('the requirement schema (SCP-1)', () => {
  it('accepts a functional and a non-functional requirement', () => {
    expect(requirementSchema.safeParse(functional).success).toBe(true);
    expect(requirementSchema.safeParse(nonFunctional).success).toBe(true);
  });

  it('will not express a non-functional requirement without a threshold', () => {
    const { threshold: _omitted, ...unquantified } = nonFunctional;

    // Not a warning and not a lint: SCP-1 makes these thresholds binding on the
    // Test gate (TST-3), so "fast enough" must be unrepresentable rather than
    // merely discouraged.
    expect(requirementSchema.safeParse(unquantified).success).toBe(false);
  });

  it('rejects a threshold nobody can say how to measure', () => {
    const vague = {
      ...nonFunctional,
      threshold: { ...nonFunctional.threshold, measuredBy: '' },
    };

    expect(requirementSchema.safeParse(vague).success).toBe(false);
  });

  it('rejects a requirement with no way to tell whether it has been met', () => {
    expect(
      requirementSchema.safeParse({ ...functional, acceptanceCriteria: [] }).success,
    ).toBe(false);
  });

  it('rejects a requirement traced to nothing', () => {
    expect(requirementSchema.safeParse({ ...functional, tracesTo: [] }).success).toBe(
      false,
    );
  });

  it('rejects an id that downstream artifacts could not cite', () => {
    expect(requirementSchema.safeParse({ ...functional, id: 'req one' }).success).toBe(
      false,
    );
  });
});

describe('the scope schema (SCP-2, SCP-3)', () => {
  it('accepts a complete requirement set', () => {
    expect(scopeSchema.safeParse(scope).success).toBe(true);
  });

  it('rejects duplicate requirement ids', () => {
    const clashing = {
      ...scope,
      requirements: [functional, { ...nonFunctional, id: 'FUN-1' }],
    };
    const result = scopeSchema.safeParse(clashing);

    // Two requirements sharing an id means every downstream trace to it is
    // ambiguous (ART-2).
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unique');
  });

  it('requires an explicit scope boundary', () => {
    expect(scopeSchema.safeParse({ ...scope, outOfScope: [] }).success).toBe(false);
  });

  it('requires at least one requirement', () => {
    expect(scopeSchema.safeParse({ ...scope, requirements: [] }).success).toBe(false);
  });
});

describe('schema registration', () => {
  it('registers scope as both a session output and a stored artifact', () => {
    expect(projectOutputSchemas().has('scope')).toBe(true);
    expect(projectArtifactSchemas().families).toContain('scope');
  });

  it('derives a JSON Schema the structured-output tool can accept', () => {
    // The requirement union is nested inside an object rather than at the top
    // level: a top-level union emits `oneOf` with no `type`, which the API
    // rejects only once the session has been dispatched.
    const json = projectOutputSchemas().jsonSchema('scope');

    expect(json.type).toBe('object');
    expect(json).not.toHaveProperty('$schema');
    const requirements = (json.properties as Record<string, { items?: unknown }>)
      .requirements;
    expect(requirements?.items).toHaveProperty('oneOf');
  });
});
