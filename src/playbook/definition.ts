import { z } from 'zod';
import { egressClassSchema } from '../context/egress.js';

/**
 * Phase playbooks (`phases/<name>.yaml`) — DESIGN §2, EXT-3.
 *
 * A playbook is how a project states what a phase *does* without forking the
 * harness: which tasks run, in what order, which role executes each, what
 * artifacts they produce, and what the gate requires before the phase can
 * close. The kernel reads this; it has no phase logic of its own.
 *
 * A `tasks:` entry is either an ordinary task or one of the ORC-4 pattern
 * nodes — `fan-out`, `pipeline`, `critic-of`, `panel` — which the kernel
 * expands into ordinary tasks before scheduling (DESIGN §4.1). The patterns
 * are declarations, not machinery: nothing downstream of expansion knows a
 * task came from a panel rather than being written out by hand.
 */

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case, e.g. "draft-brief"');

const nonEmpty = z.string().min(1);

/**
 * How many agents a fan-out or panel may dispatch.
 *
 * Lower bound 2, because a fan-out of one is a task and a panel of one is an
 * opinion. Upper bound because the count is a multiplier on spend, and the
 * difference between `count: 4` and a typo'd `count: 40` is otherwise only
 * visible on the invoice.
 */
const agentCount = z.number().int().min(2).max(16);

/** An artifact the phase produces (ADR-3: markdown + frontmatter, in git). */
export const artifactTemplateSchema = z
  .object({
    /** Output-schema id the producing task's result must satisfy (AGT-3). */
    schema: nonEmpty,
    /** Repo-relative path, versioned by the artifact store (ART-1). */
    path: nonEmpty,
    description: nonEmpty,
    /**
     * Data-egress class the produced artifact carries (SAF-6). Declared per
     * artifact because sensitivity is a property of what a phase produces,
     * not of the phase: a threat model and a glossary come out of the same
     * playbook. Omitted means the artifact store's default.
     */
    egress: egressClassSchema.optional(),
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

/** Fields every node shares, whatever its kind. */
const nodeCommon = {
  id: identifier,
  description: nonEmpty,
  /** Node ids that must complete first. */
  dependsOn: z.array(identifier).default([]),
  /** Input artifact ids this node reads, in addition to its dependencies. */
  consumes: z.array(identifier).default([]),
};

/** One ordinary task the phase dispatches: one role, one session. */
export const taskTemplateSchema = z
  .object({
    ...nodeCommon,
    kind: z.literal('task'),
    /** Role that executes it, resolved against the role registry (AGT-1). */
    role: identifier,
    /** Instruction for the session. Context is assembled around it (CTX-2). */
    prompt: nonEmpty,
    /** Artifact id this task produces, if any. */
    produces: identifier.optional(),
    /**
     * Whether this task may write knowledge-base documents (CTX-4).
     *
     * Off by default and declared per task rather than per role, so that a
     * role which happens to notice a convention cannot rewrite the knowledge
     * base from any task it is given.
     */
    updatesKb: z.boolean().default(false),
  })
  .strict();

/**
 * How the members of a fan-out or panel are distinguished from one another.
 *
 * `count` alone gives independent samples of the same question. `lenses` gives
 * each member a different question — the same shape, but the members are no
 * longer interchangeable, which is what DSG-3's four review lenses need.
 * Exactly one of the two is supplied; the loader rejects both or neither.
 */
const memberSchema = z
  .object({
    role: identifier,
    prompt: nonEmpty,
    count: agentCount.optional(),
    lenses: z.array(nonEmpty).min(2).max(16).optional(),
  })
  .strict();

/**
 * `fan-out{n}/collect` — n members work the same problem independently, and a
 * collector reads all n results.
 *
 * Members produce no artifacts. Exactly one task writes each artifact (the
 * loader enforces it), and n concurrent writers to one path is the one thing
 * the artifact store's version chain cannot represent. The collector is where
 * the fan-out's conclusion becomes an artifact.
 */
export const fanOutNodeSchema = z
  .object({
    ...nodeCommon,
    kind: z.literal('fan-out'),
    workers: memberSchema,
    collect: z
      .object({
        role: identifier,
        prompt: nonEmpty,
        produces: identifier.optional(),
      })
      .strict(),
  })
  .strict();

/** One stage of a pipeline. */
export const pipelineStageSchema = z
  .object({
    id: identifier,
    role: identifier,
    description: nonEmpty,
    prompt: nonEmpty,
    produces: identifier.optional(),
  })
  .strict();

/**
 * `pipeline` — stages run in order, each reading what the previous produced.
 *
 * Two stages minimum: a pipeline of one is a task with extra syntax.
 */
export const pipelineNodeSchema = z
  .object({
    ...nodeCommon,
    kind: z.literal('pipeline'),
    stages: z.array(pipelineStageSchema).min(2),
  })
  .strict();

/**
 * `critic-of <node>` — adversarial review of another node's result (ORC-4).
 *
 * The critic's role must differ from the role that produced the target. A
 * reviewer running the same role as the author shares its blind spots, so an
 * approval from it is evidence of consistency, not of correctness.
 *
 * With `lenses`, the review fans out: one critic per lens, none of them able
 * to see the others, and a collector that merges their findings. That is what
 * DSG-3 asks for — a review covering scalability, security, operability and
 * simplicity is four reviews, not one reviewer with a longer checklist, and a
 * single critic told to cover all four will spend its attention unevenly.
 * `collect` accompanies `lenses`, and the node's own `produces` moves onto it.
 */
export const criticNodeSchema = z
  .object({
    ...nodeCommon,
    kind: z.literal('critic-of'),
    /** Node whose result is under review. */
    target: identifier,
    role: identifier,
    prompt: nonEmpty,
    produces: identifier.optional(),
    lenses: z.array(nonEmpty).min(2).max(16).optional(),
    collect: z
      .object({
        role: identifier,
        prompt: nonEmpty,
        produces: identifier.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * What each judge is asked to return, and how the kernel reads it.
 *
 * `approval` is a boolean field; `choice` is a field naming one of a fixed set
 * of options. Anything else a judge returns in that field is a spoiled ballot
 * — counted as an abstention, never as assent.
 */
export const ballotSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approval'), field: nonEmpty }).strict(),
  z
    .object({
      type: z.literal('choice'),
      field: nonEmpty,
      options: z.array(nonEmpty).min(2),
    })
    .strict(),
]);

export const voteRuleSchema = z.enum(['majority', 'unanimous', 'plurality']);

/**
 * `panel{n, vote}` — n judges vote, and the *kernel* counts (ORC-4).
 *
 * The tally is arithmetic over validated outputs, not another session. A panel
 * whose result is summarised by a further agent is not a panel; it is one more
 * opinion, with the judges as its context.
 */
export const panelNodeSchema = z
  .object({
    ...nodeCommon,
    kind: z.literal('panel'),
    judges: memberSchema,
    ballot: ballotSchema,
    vote: voteRuleSchema,
    /** Artifact written from the tally, if the phase wants one. */
    produces: identifier.optional(),
  })
  .strict();

/**
 * A node with no `kind` is an ordinary task.
 *
 * Defaulted rather than required so that a playbook using no pattern reads as
 * a plain list of tasks, which is what most phases are.
 */
export const playbookNodeSchema = z.preprocess(
  (raw) =>
    typeof raw === 'object' && raw !== null && !('kind' in raw)
      ? { ...raw, kind: 'task' }
      : raw,
  z.discriminatedUnion('kind', [
    taskTemplateSchema,
    fanOutNodeSchema,
    pipelineNodeSchema,
    criticNodeSchema,
    panelNodeSchema,
  ]),
);

/**
 * A gate exit criterion.
 *
 * `artifact-exists` and `vote-carried` the kernel can check itself;
 * `agent-assertion` is a claim a task must have made. None of them approves
 * the gate on its own — approval is an operator decision unless the project
 * has configured otherwise (HIL-1).
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
      /** Node whose output carries the assertion. */
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
  z
    .object({
      id: identifier,
      kind: z.literal('vote-carried'),
      description: nonEmpty,
      /** Panel node whose tally must have carried. */
      panel: identifier,
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('traces-resolve'),
      description: nonEmpty,
      /**
       * Artifact whose citations must all resolve.
       *
       * Checked against the derived trace index (ADR-4) rather than by the
       * schema, because whether `LOAN-9` exists is a fact about other
       * artifacts — the citing one is well-formed either way (DSG-4, ART-2).
       */
      artifact: identifier,
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
    tasks: z.array(playbookNodeSchema).min(1),
    gate: gateSchema,
  })
  .strict();

export type ArtifactTemplate = z.infer<typeof artifactTemplateSchema>;
export type InputTemplate = z.infer<typeof inputTemplateSchema>;
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
export type FanOutNode = z.infer<typeof fanOutNodeSchema>;
export type PipelineNode = z.infer<typeof pipelineNodeSchema>;
export type PipelineStage = z.infer<typeof pipelineStageSchema>;
export type CriticNode = z.infer<typeof criticNodeSchema>;
export type PanelNode = z.infer<typeof panelNodeSchema>;
export type Ballot = z.infer<typeof ballotSchema>;
export type VoteRule = z.infer<typeof voteRuleSchema>;
export type PlaybookNode = z.infer<typeof playbookNodeSchema>;
export type MemberSpec = z.infer<typeof memberSchema>;
export type GateCriterion = z.infer<typeof gateCriterionSchema>;
export type GateDefinition = z.infer<typeof gateSchema>;
export type PlaybookDefinition = z.infer<typeof playbookSchema>;
