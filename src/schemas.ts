import { z } from 'zod';
import { OutputSchemaRegistry } from './agent/output-registry.js';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from './artifact/schema-registry.js';
import {
  conclusionsSchema,
  elicitationOutputSchema,
  exchangeSchema,
} from './elicit/session.js';

/**
 * The project's own schemas.
 *
 * Session output and stored artifact share a shape wherever a task writes what
 * it returns, so both registries are built from the same zod definitions —
 * a task cannot produce something its artifact would reject.
 */

/** The Definition artifact (DEF-1). */
export const definitionSchema = conclusionsSchema;

/** Adversarial review output (DEF-2). */
export const findingsSchema = z.object({
  findings: z.array(
    z.object({
      about: z.string().min(1),
      issue: z.string().min(1),
      resolution: z.string(),
      status: z.enum(['resolved', 'accepted', 'open']),
    }),
  ),
  summary: z.string().min(1),
  /**
   * The reviewer's attestation that nothing is left open. The gate reads this
   * field directly, so it is a claim the reviewer makes rather than something
   * inferred from the fact that the task finished.
   */
  allResolved: z.boolean(),
});

/**
 * A quantified threshold for a non-functional requirement (SCP-1).
 *
 * `measuredBy` is not decoration: TST-3 has to build a suite from this, and a
 * threshold nobody can say how to measure is a number, not a requirement.
 */
export const thresholdSchema = z.object({
  metric: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
  measuredBy: z.string().min(1),
});

/** MoSCoW prioritisation (SCP-2). */
export const priorities = ['must', 'should', 'could', 'wont'] as const;

const requirementCommon = {
  /** Stable identifier, e.g. `ORC-1`. Downstream artifacts trace to it (ART-2). */
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,5}-[0-9]+$/, 'e.g. ORC-1, SAF-12'),
  statement: z.string().min(1),
  /** Why it exists, traced to the Definition it was derived from. */
  rationale: z.string().min(1),
  priority: z.enum(priorities),
  /**
   * How to tell whether it has been met (SCP-1: each requirement testable).
   * At least one, because a requirement nobody can check is a wish.
   */
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  /** Definition goals, constraints or stakeholders this derives from. */
  tracesTo: z.array(z.string().min(1)).min(1),
};

/**
 * One requirement (SCP-1).
 *
 * Split on `kind` so that a non-functional requirement *cannot* be expressed
 * without a quantified threshold: SCP-1 makes those thresholds binding on the
 * Test gate (TST-3), and a schema that merely asks for one politely is a
 * schema that will eventually be handed "fast enough".
 */
export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('functional'), ...requirementCommon }),
  z.object({
    kind: z.literal('non-functional'),
    ...requirementCommon,
    threshold: thresholdSchema,
  }),
]);

/** The Scope artifact: the derived requirement set (SCP-1..3). */
export const scopeSchema = z
  .object({
    summary: z.string().min(1),
    requirements: z.array(requirementSchema).min(1),
    /**
     * What this project is explicitly not doing, and why (SCP-2). At least
     * one: the Definition's non-goals map straight onto it, and a scope with
     * nothing outside it has not been scoped.
     */
    outOfScope: z
      .array(z.object({ item: z.string().min(1), why: z.string().min(1) }))
      .min(1),
  })
  .refine(
    (scope) =>
      new Set(scope.requirements.map((requirement) => requirement.id)).size ===
      scope.requirements.length,
    'requirement ids must be unique — downstream artifacts trace to them (ART-2)',
  );

/** The elicitation record: conclusions plus the dialogue that produced them. */
export const elicitationSchema = z.object({
  conclusions: conclusionsSchema,
  transcript: z.array(exchangeSchema),
});

/** Schemas a session may be asked to satisfy, keyed as roles name them. */
export function projectOutputSchemas(): OutputSchemaRegistry {
  return new OutputSchemaRegistry({
    definition: definitionSchema,
    findings: findingsSchema,
    scope: scopeSchema,
    'elicitation.turn': elicitationOutputSchema,
  });
}

/** Schemas the artifact store validates and migrates against. */
export function projectArtifactSchemas(): ArtifactSchemaRegistry {
  return new ArtifactSchemaRegistry([
    defineArtifactSchema('definition', definitionSchema),
    defineArtifactSchema('findings', findingsSchema),
    defineArtifactSchema('scope', scopeSchema),
    defineArtifactSchema('elicitation', elicitationSchema),
  ]);
}
