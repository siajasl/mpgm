import { z } from 'zod';

/**
 * Declarative role definitions (AGT-1, DESIGN §4.2).
 *
 * A role is `roles/<name>.md`: YAML frontmatter declaring model, toolset,
 * permissions, budgets and output schema, plus a body that is the system
 * prompt. Everything an agent is allowed to do is stated here rather than
 * assembled at runtime, which is what makes least privilege (AGT-2)
 * reviewable in a diff.
 */

const nonEmpty = z.string().min(1);

/**
 * Tools the role may use. Declared as an allowlist: a role gets nothing it did
 * not ask for, so forgetting to update this list fails closed.
 */
export const toolPolicySchema = z.object({
  allow: z.array(nonEmpty).default([]),
});

/**
 * Path globs the role may read and write. Enforced outside the model
 * (ADR-6, SAF-1) — this is a declaration, not a request.
 */
export const pathPolicySchema = z.object({
  read: z.array(nonEmpty).default([]),
  write: z.array(nonEmpty).default([]),
});

/** Bounds the kernel enforces on every session (AGT-4). */
export const budgetSchema = z.object({
  tokens: z.number().int().positive(),
  costUsd: z.number().positive(),
  steps: z.number().int().positive(),
  wallClockSeconds: z.number().positive(),
});

export const outputSchema = z.object({
  /** Path to the JSON Schema the structured output must satisfy (AGT-3). */
  schema: nonEmpty,
});

export const roleFrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'must be lowercase kebab-case, e.g. "design-critic"',
      ),
    description: nonEmpty,
    /**
     * Default model for the role. The kernel may override it per task at
     * dispatch time (AGT-5, DESIGN §4.2); the override never rewrites this
     * file, so routing changes are not role changes.
     */
    model: nonEmpty,
    tools: toolPolicySchema.default({ allow: [] }),
    paths: pathPolicySchema.default({ read: [], write: [] }),
    budgets: budgetSchema,
    output: outputSchema,
  })
  .strict();

export type RoleFrontmatter = z.infer<typeof roleFrontmatterSchema>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type PathPolicy = z.infer<typeof pathPolicySchema>;
export type Budget = z.infer<typeof budgetSchema>;

export interface Role extends RoleFrontmatter {
  /** The role's system prompt: everything after the frontmatter block. */
  readonly systemPrompt: string;
  /** Where the role was loaded from, for error messages and audit. */
  readonly sourcePath: string;
}
