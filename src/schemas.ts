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

/**
 * The design stances the Design phase generates candidates for (DSG-1).
 *
 * These ids are shared between three places that must agree: the fan-out
 * lenses that generate one candidate each, the panel ballot the judges vote
 * on, and this enum. A test asserts the playbook and this list match, because
 * a ballot offering an option nobody generated is a vote for nothing.
 */
export const designStances = ['simplest', 'most-operable', 'most-extensible'] as const;

const stance = z.enum(designStances);

/** One candidate architecture (DSG-1). */
export const designCandidateSchema = z.object({
  stance,
  name: z.string().min(1),
  summary: z.string().min(1),
  components: z
    .array(z.object({ name: z.string().min(1), responsibility: z.string().min(1) }))
    .min(1),
  keyDecisions: z.array(z.string().min(1)).min(1),
  /**
   * What this candidate buys and what it costs. A candidate with no stated
   * cost has not been thought about; it has been advocated for.
   */
  tradeOffs: z
    .array(z.object({ gain: z.string().min(1), cost: z.string().min(1) }))
    .min(1),
  risks: z.array(z.string().min(1)),
  /** Requirement ids this candidate is answering. */
  tracesTo: z.array(z.string().min(1)).min(1),
});

/** The candidates side by side, as the judges receive them. */
export const designCandidatesSchema = z
  .object({
    summary: z.string().min(1),
    // DSG-1 requires at least two candidates for a significant decision. One
    // candidate is not a choice, it is a proposal with a vote attached.
    candidates: z.array(designCandidateSchema).min(2),
    comparison: z
      .array(
        z.object({
          dimension: z.string().min(1),
          assessment: z.array(z.object({ stance, note: z.string().min(1) })).min(2),
        }),
      )
      .min(1),
  })
  .refine(
    (set) =>
      new Set(set.candidates.map((candidate) => candidate.stance)).size ===
      set.candidates.length,
    'each candidate must take a different stance — two candidates with the same ' +
      'stance are one candidate described twice',
  );

/** One judge's ballot (ORC-4 panel). */
export const designVerdictSchema = z.object({
  /** The panel ballot field. The kernel counts this; nothing else. */
  pick: stance,
  reasoning: z.string().min(1),
  /** What would change this judge's mind, recorded whether or not it wins. */
  reservations: z.array(z.string().min(1)),
});

/** One architecture decision record (DSG-1). */
export const adrSchema = z.object({
  id: z.string().regex(/^ADR-[0-9]+$/, 'e.g. ADR-1'),
  title: z.string().min(1),
  context: z.string().min(1),
  decision: z.string().min(1),
  /** What else was considered and why it lost. An ADR without this is a memo. */
  alternatives: z
    .array(z.object({ option: z.string().min(1), whyNot: z.string().min(1) }))
    .min(1),
  consequences: z.array(z.string().min(1)).min(1),
  tracesTo: z.array(z.string().min(1)).min(1),
});

/** Cross-cutting concerns DSG-2 requires a design to address. */
export const requiredConcerns = [
  'authn',
  'authz',
  'observability',
  'failure-modes',
] as const;

const concern = z.enum([...requiredConcerns, 'security', 'other']);

/**
 * The Design artifact (DSG-1, DSG-2, DSG-4).
 *
 * Every element carries `tracesTo`, so an element that traces to no
 * requirement is unrepresentable rather than merely discouraged — DSG-4 calls
 * that gold-plating, and the cheapest place to catch it is the schema.
 */
export const designSchema = z
  .object({
    chosen: stance,
    summary: z.string().min(1),
    components: z
      .array(
        z.object({
          name: z.string().min(1),
          responsibility: z.string().min(1),
          tracesTo: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    interfaces: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(['api', 'schema', 'event']),
          contract: z.string().min(1),
          tracesTo: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    dataModel: z
      .array(
        z.object({
          entity: z.string().min(1),
          fields: z.array(z.string().min(1)).min(1),
          notes: z.string(),
        }),
      )
      .min(1),
    technologies: z
      .array(
        z.object({
          choice: z.string().min(1),
          why: z.string().min(1),
          tracesTo: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    crossCutting: z
      .array(
        z.object({
          concern,
          approach: z.string().min(1),
          tracesTo: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    adrs: z.array(adrSchema).min(1),
  })
  .refine(
    (design) =>
      requiredConcerns.every((required) =>
        design.crossCutting.some((entry) => entry.concern === required),
      ),
    `the design must address every cross-cutting concern DSG-2 names: ${requiredConcerns.join(', ')}`,
  )
  .refine(
    (design) => new Set(design.adrs.map((adr) => adr.id)).size === design.adrs.length,
    'ADR ids must be unique',
  );

/**
 * Prior-art survey (DEF-3).
 *
 * Every entry carries its source, because the reason to research prior art is
 * to give the project material it can go and check. `gaps` is not optional
 * either: a survey that reports only what it found reads as though the space
 * were covered, and what nobody has built is often the more useful half.
 */
export const priorArtSchema = z.object({
  summary: z.string().min(1),
  systems: z
    .array(
      z.object({
        name: z.string().min(1),
        whatItDoes: z.string().min(1),
        /** Why it is relevant to *this* project, not why it is interesting. */
        relevance: z.string().min(1),
        source: z.object({
          title: z.string().min(1),
          url: z.url(),
          /** Whether this is the project's own material or commentary on it. */
          kind: z.enum(['primary', 'secondary']),
        }),
      }),
    )
    .min(1),
  /** What was looked for and not found. */
  gaps: z.array(z.string().min(1)).min(1),
});

/**
 * One plan task (PLN-1).
 *
 * A task is a unit of work sized for one agent session, so it carries what a
 * session needs to know it is finished: criteria that decide the question, and
 * the dependencies that must land first.
 */
export const planTaskSchema = z.object({
  id: z.string().regex(/^T[0-9]+(?:\.[0-9]+)+$/, 'e.g. T2.1.3'),
  title: z.string().min(1),
  /**
   * How to tell it is done. At least one: a task whose completion is a matter
   * of opinion cannot close, and cannot be reported as closed either.
   */
  completionCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)),
  /** Design elements or requirement ids this task advances (ART-2). */
  tracesTo: z.array(z.string().min(1)).min(1),
});

/** One milestone: a group of tasks with something demonstrable at the end. */
export const milestoneSchema = z.object({
  id: z.string().regex(/^M[0-9]+(?:\.[0-9]+)*$/, 'e.g. M2.1'),
  title: z.string().min(1),
  /**
   * What must demonstrably work when the milestone closes (PLN-3).
   * Deliberately not a date: an estimate is not a verification.
   */
  verification: z.string().min(1),
  /** The risk id this milestone attacks, if it exists to attack one (PLN-2). */
  validatesRisk: z.string().nullable(),
  tasks: z.array(planTaskSchema).min(1),
});

/** A grouping of milestones within the plan (PLN-1). */
export const planPhaseSchema = z.object({
  id: z.string().regex(/^P[0-9]+$/, 'e.g. P3'),
  title: z.string().min(1),
  intent: z.string().min(1),
  milestones: z.array(milestoneSchema).min(1),
});

const riskSchema = z.object({
  id: z.string().regex(/^R[0-9]+$/, 'e.g. R4'),
  assumption: z.string().min(1),
  /** Milestone ids that settle it. PLN-2 wants these early, not eventually. */
  validatedBy: z.array(z.string().min(1)).min(1),
});

interface PlanShape {
  readonly risks: readonly { id: string; validatedBy: readonly string[] }[];
  readonly phases: readonly {
    readonly milestones: readonly {
      readonly id: string;
      readonly validatesRisk: string | null;
      readonly tasks: readonly { id: string; dependsOn: readonly string[] }[];
    }[];
  }[];
}

const allTasks = (
  plan: PlanShape,
): readonly { id: string; dependsOn: readonly string[] }[] =>
  plan.phases.flatMap((phase) =>
    phase.milestones.flatMap((milestone) => milestone.tasks),
  );

const allMilestones = (
  plan: PlanShape,
): readonly { id: string; validatesRisk: string | null }[] =>
  plan.phases.flatMap((phase) => phase.milestones);

/**
 * Kahn's algorithm, kept here rather than imported from the playbook loader:
 * that one throws a load error naming a YAML file, and this is a validation
 * failure the producing agent has to be told about and given a retry for.
 */
function isAcyclic(
  tasks: readonly { id: string; dependsOn: readonly string[] }[],
): boolean {
  if (tasks.some((task) => task.dependsOn.includes(task.id))) {
    return false;
  }
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id);
    if (ready.length === 0) {
      return false;
    }
    for (const id of ready) {
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) {
        deps.delete(id);
      }
    }
  }
  return true;
}

/**
 * The Plan artifact (PLN-1..3).
 *
 * The structural obligations are refinements rather than gate criteria
 * because a plan that fails them cannot be scheduled at all: a cycle means no
 * task ever becomes ready, and the phase would present as one that silently
 * does nothing. Unrepresentable beats checked.
 */
export const planSchema = z
  .object({
    summary: z.string().min(1),
    risks: z.array(riskSchema).min(1),
    phases: z.array(planPhaseSchema).min(1),
  })
  .refine(
    (plan) =>
      new Set(allTasks(plan).map((task) => task.id)).size === allTasks(plan).length,
    'task ids must be unique across the whole plan — a duplicate makes every ' +
      'dependency on it ambiguous',
  )
  .refine(
    (plan) =>
      new Set(allMilestones(plan).map((entry) => entry.id)).size ===
      allMilestones(plan).length,
    'milestone ids must be unique across the whole plan',
  )
  .refine((plan) => {
    const known = new Set(allTasks(plan).map((task) => task.id));
    return allTasks(plan).every((task) =>
      task.dependsOn.every((dependency) => known.has(dependency)),
    );
  }, 'every dependency must name a task the plan declares')
  .refine((plan) => {
    const known = new Set(allMilestones(plan).map((entry) => entry.id));
    return plan.risks.every((risk) => risk.validatedBy.every((id) => known.has(id)));
  }, 'every risk must be validated by a milestone the plan declares (PLN-2)')
  .refine((plan) => {
    // PLN-2 asks for the riskiest assumptions to be front-loaded, and the
    // cheapest structural half of that is: no milestone claims to attack a
    // risk nobody wrote down.
    const declared = new Set(plan.risks.map((risk) => risk.id));
    return allMilestones(plan).every(
      (milestone) =>
        milestone.validatesRisk === null || declared.has(milestone.validatesRisk),
    );
  }, 'a milestone may only claim to validate a risk the plan declares (PLN-2)')
  .refine((plan) => isAcyclic(allTasks(plan)), 'task dependencies form a cycle');

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
    'prior-art': priorArtSchema,
    plan: planSchema,
    'design-candidate': designCandidateSchema,
    'design-candidates': designCandidatesSchema,
    'design-verdict': designVerdictSchema,
    design: designSchema,
    'elicitation.turn': elicitationOutputSchema,
  });
}

/** Schemas the artifact store validates and migrates against. */
export function projectArtifactSchemas(): ArtifactSchemaRegistry {
  return new ArtifactSchemaRegistry([
    defineArtifactSchema('definition', definitionSchema),
    defineArtifactSchema('findings', findingsSchema),
    defineArtifactSchema('scope', scopeSchema),
    defineArtifactSchema('prior-art', priorArtSchema),
    defineArtifactSchema('plan', planSchema),
    defineArtifactSchema('design-candidates', designCandidatesSchema),
    defineArtifactSchema('design', designSchema),
    defineArtifactSchema('elicitation', elicitationSchema),
  ]);
}
