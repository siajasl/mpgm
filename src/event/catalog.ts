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

/**
 * A reference to content in the blob store (ADR-2). Large tool outputs and
 * session transcripts are offloaded there so the log stays small while replay
 * still has the full bytes available.
 */
export const blobRefSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
  size: z.number().int().nonnegative(),
});

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
    /**
     * Full tool output, offloaded to the blob store. Null when the output was
     * small enough to keep in `detail`.
     */
    outputBlob: blobRefSchema.nullable(),
  }),
  // v1 predates the blob store; those events carry no offloaded output.
  [(payload) => ({ ...(payload as object), outputBlob: null })],
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

/**
 * Intent-before-effect (DESIGN §6).
 *
 * A side-effectful step records its intention *before* acting, so a crash
 * between the two leaves evidence. On resume each pending intent is resolved
 * through its contract rather than blindly retried — the failure mode this
 * exists to prevent is deploying, pushing or paying twice.
 */
export const effectIntended = defineEvent(
  'EffectIntended',
  z.object({
    intentId: nonEmpty,
    taskId: nonEmpty,
    /** Capability contract, e.g. `pm.github` (ADR-7). */
    contract: nonEmpty,
    operation: nonEmpty,
    params: z.record(z.string(), z.unknown()),
  }),
);

export const effectCompleted = defineEvent(
  'EffectCompleted',
  z.object({ intentId: nonEmpty, outcome: nonEmpty }),
);

export const effectFailed = defineEvent(
  'EffectFailed',
  z.object({ intentId: nonEmpty, reason: z.string().default('') }),
);

/** Resume could not determine whether the effect landed; an operator must say. */
export const effectEscalated = defineEvent(
  'EffectEscalated',
  z.object({ intentId: nonEmpty, reason: nonEmpty }),
);

export const operatorIntervened = defineEvent(
  'OperatorIntervened',
  z.object({ action: nonEmpty, detail: z.string().default('') }),
);

/** Every kernel event type currently defined. */
export const kernelEvents = [
  budgetExceeded,
  effectCompleted,
  effectEscalated,
  effectFailed,
  effectIntended,
  gateApproved,
  gateInvalidated,
  gatePresented,
  gateRejected,
  operatorIntervened,
  phaseEntered,
  phaseReopened,
  runStarted,
  sessionUsage,
  taskCompleted,
  taskDispatched,
  toolCallLogged,
  validationFailed,
];

/** Registry over the full kernel catalog. */
export function kernelRegistry(): EventRegistry {
  return new EventRegistry(kernelEvents);
}
