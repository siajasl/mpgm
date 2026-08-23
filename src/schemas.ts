import { z } from 'zod';
import { OutputSchemaRegistry } from './agent/output-registry.js';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from './artifact/schema-registry.js';
import {
  conclusionsSchema,
  elicitationTurnSchema,
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
});

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
    'elicitation.turn': elicitationTurnSchema,
  });
}

/** Schemas the artifact store validates and migrates against. */
export function projectArtifactSchemas(): ArtifactSchemaRegistry {
  return new ArtifactSchemaRegistry([
    defineArtifactSchema('definition', definitionSchema),
    defineArtifactSchema('findings', findingsSchema),
    defineArtifactSchema('elicitation', elicitationSchema),
  ]);
}
