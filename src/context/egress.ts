import { z } from 'zod';

/**
 * Data-egress classes (SAF-6).
 *
 * A project declares what may be sent to a model provider; the harness
 * enforces it at context assembly, which is the last point before content
 * leaves the machine.
 */
export const EGRESS_CLASSES = ['public', 'internal', 'restricted'] as const;

export type EgressClass = (typeof EGRESS_CLASSES)[number];

export const egressClassSchema = z.enum(EGRESS_CLASSES);

/** Ordered least to most sensitive. */
const RANK: Readonly<Record<EgressClass, number>> = {
  public: 0,
  internal: 1,
  restricted: 2,
};

export interface EgressPolicy {
  /** Most sensitive class that may reach a model provider. */
  readonly maxClass: EgressClass;
  /**
   * Class assumed for content carrying no label.
   *
   * Defaults to `internal`: SAF-6 is about data the operator has *classified*
   * as sensitive, and defaulting to `restricted` would withhold an entire
   * unlabelled knowledge base, which reads as the harness being broken rather
   * than as a policy in force. A project that wants fail-closed sets this to
   * `restricted` and labels deliberately.
   */
  readonly unlabelled: EgressClass;
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  maxClass: 'internal',
  unlabelled: 'internal',
};

export function classOf(
  label: EgressClass | undefined,
  policy: EgressPolicy,
): EgressClass {
  return label ?? policy.unlabelled;
}

/** May content of this class be sent to a model provider? */
export function permitted(label: EgressClass | undefined, policy: EgressPolicy): boolean {
  return RANK[classOf(label, policy)] <= RANK[policy.maxClass];
}
