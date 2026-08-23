import { z } from 'zod';

/**
 * Phase playbooks (`phases/<name>.yaml`) — DESIGN §2, EXT-3.
 *
 * A playbook is how a project states what a phase *does* without forking the
 * harness: which tasks run, in what order, which role executes each, what
 * artifacts they produce, and what the gate requires before the phase can
 * close. The kernel reads this; it has no phase logic of its own.
 */

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case, e.g. "draft-brief"');

const nonEmpty = z.string().min(1);

/** An artifact the phase produces (ADR-3: markdown + frontmatter, in git). */
export const artifactTemplateSchema = z
  .object({
    /** Output-schema id the producing task's result must satisfy (AGT-3). */
    schema: nonEmpty,
    /** Repo-relative path, versioned by the artifact store (ART-1). */
    path: nonEmpty,
    description: nonEmpty,
  })
  .strict();

/**
 * An artifact the phase reads but does not produce — typically written by an
 * earlier phase, or by an operator dialogue outside any playbook.
 */
export const inputTemplateSchema = z
  .object({
    schema: nonEmpty,
    path: nonEmpty,
    description: nonEmpty,
    /** When false, a task consuming it cannot run until it exists. */
    optional: z.boolean().default(false),
  })
  .strict();

/** One task the phase dispatches. */
export const taskTemplateSchema = z
  .object({
    id: identifier,
    /** Role that executes it, resolved against the role registry (AGT-1). */
    role: identifier,
    description: nonEmpty,
    /** Instruction for the session. Context is assembled around it (CTX-2). */
    prompt: nonEmpty,
    /** Task ids that must complete first. */
    dependsOn: z.array(identifier).default([]),
    /** Artifact id this task produces, if any. */
    produces: identifier.optional(),
    /** Input artifact ids this task reads, in addition to its dependencies. */
    consumes: z.array(identifier).default([]),
  })
  .strict();

/**
 * A gate exit criterion.
 *
 * `artifact-exists` the kernel can check itself; `agent-assertion` is a claim
 * a task must have made. Both are recorded, and neither approves the gate on
 * its own — approval is an operator decision unless the project has configured
 * otherwise (HIL-1).
 */
export const gateCriterionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: identifier,
      kind: z.literal('artifact-exists'),
      description: nonEmpty,
      artifact: identifier,
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('agent-assertion'),
      description: nonEmpty,
      /** Task whose output carries the assertion. */
      fromTask: identifier,
      /**
       * Boolean field of that task's output holding the assertion.
       *
       * Required, because a criterion satisfied merely by the task having run
       * is not a criterion — it passes even when the work concluded that the
       * gate should not open.
       */
      field: z.string().min(1),
    })
    .strict(),
]);

export const gateSchema = z
  .object({
    id: identifier,
    description: nonEmpty,
    criteria: z.array(gateCriterionSchema).min(1),
    /**
     * Whether meeting every criterion closes the gate without an operator.
     * Defaults to false: HIL-1 permits auto-approval only where the operator
     * has configured it, so silence means ask.
     */
    autoApprove: z.boolean().default(false),
  })
  .strict();

export const playbookSchema = z
  .object({
    phase: identifier,
    description: nonEmpty,
    inputs: z.record(identifier, inputTemplateSchema).default({}),
    artifacts: z.record(identifier, artifactTemplateSchema).default({}),
    tasks: z.array(taskTemplateSchema).min(1),
    gate: gateSchema,
  })
  .strict();

export type ArtifactTemplate = z.infer<typeof artifactTemplateSchema>;
export type InputTemplate = z.infer<typeof inputTemplateSchema>;
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
export type GateCriterion = z.infer<typeof gateCriterionSchema>;
export type GateDefinition = z.infer<typeof gateSchema>;
export type PlaybookDefinition = z.infer<typeof playbookSchema>;

export interface Playbook extends PlaybookDefinition {
  /** Where it was loaded from, for error messages and audit. */
  readonly sourcePath: string;
  /** Task ids in a dependency-respecting order. */
  readonly order: readonly string[];
}
