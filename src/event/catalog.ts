import { z } from 'zod';
import { defineEvent, EventRegistry } from './registry.js';

/**
 * The kernel event catalog (DESIGN §5).
 *
 * Every type starts at schema version 1. Payloads are deliberately narrow:
 * schema growth is what the upcaster machinery in {@link EventRegistry} exists
 * to absorb (ADR-2), so it is cheaper to add fields with an upcaster later than
 * to speculate about them now.
 */

/**
 * A reference to an artifact in git. The log stores the reference, never the
 * content — artifacts live in git only (ADR-3, DESIGN §5).
 */
export const artifactRefSchema = z.object({
  path: z.string().min(1),
  commit: z.string().min(1),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

const nonEmpty = z.string().min(1);

export const runStarted = defineEvent(
  'RunStarted',
  z.object({ project: nonEmpty, operator: nonEmpty }),
);

export const phaseEntered = defineEvent('PhaseEntered', z.object({ phase: nonEmpty }));

export const taskDispatched = defineEvent(
  'TaskDispatched',
  z.object({
    taskId: nonEmpty,
    role: nonEmpty,
    /**
     * Model resolved for this session. The model is a dispatch-time parameter
     * (DESIGN §4.2): role default, overridden by the task-class routing table.
     * Recording it here is what makes replay and eval attribution possible.
     */
    model: nonEmpty,
  }),
);

export const sessionUsage = defineEvent(
  'SessionUsage',
  z.object({
    taskId: nonEmpty,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
);

export const toolCallLogged = defineEvent(
  'ToolCallLogged',
  z.object({
    taskId: nonEmpty,
    tool: nonEmpty,
    /** Denials are logged, not just blocked (SAF-1, PLAN T1.2.4). */
    decision: z.enum(['allowed', 'denied']),
    detail: z.string().default(''),
  }),
);

export const taskCompleted = defineEvent(
  'TaskCompleted',
  z.object({ taskId: nonEmpty, artifactRefs: z.array(artifactRefSchema) }),
);

export const validationFailed = defineEvent(
  'ValidationFailed',
  z.object({
    taskId: nonEmpty,
    attempt: z.number().int().positive(),
    issues: z.array(z.string()),
  }),
);

export const gatePresented = defineEvent(
  'GatePresented',
  z.object({
    gateId: nonEmpty,
    phase: nonEmpty,
    artifactRefs: z.array(artifactRefSchema),
  }),
);

export const gateApproved = defineEvent(
  'GateApproved',
  z.object({ gateId: nonEmpty, by: nonEmpty }),
);

export const gateRejected = defineEvent(
  'GateRejected',
  z.object({ gateId: nonEmpty, by: nonEmpty, reason: z.string().default('') }),
);

export const phaseReopened = defineEvent(
  'PhaseReopened',
  z.object({ phase: nonEmpty, reason: z.string().default('') }),
);

export const gateInvalidated = defineEvent(
  'GateInvalidated',
  z.object({ gateId: nonEmpty, cause: nonEmpty }),
);

export const budgetExceeded = defineEvent(
  'BudgetExceeded',
  z.object({
    taskId: nonEmpty,
    kind: z.enum(['tokens', 'cost', 'steps', 'wallClock']),
    limit: z.number().nonnegative(),
    observed: z.number().nonnegative(),
  }),
);

export const operatorIntervened = defineEvent(
  'OperatorIntervened',
  z.object({ action: nonEmpty, detail: z.string().default('') }),
);

/** Every kernel event type currently defined. */
export const kernelEvents = [
  runStarted,
  phaseEntered,
  taskDispatched,
  sessionUsage,
  toolCallLogged,
  taskCompleted,
  validationFailed,
  gatePresented,
  gateApproved,
  gateRejected,
  phaseReopened,
  gateInvalidated,
  budgetExceeded,
  operatorIntervened,
];

/** Registry over the full kernel catalog. */
export function kernelRegistry(): EventRegistry {
  return new EventRegistry(kernelEvents);
}
