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
   * Defaults to `restricted`, which withholds it. An unlabelled file is not
   * one somebody classified as safe; it is one nobody classified at all, and
   * SAF-6 asks that operator-restricted material not reach a provider without
   * explicit allowance — which unlabelled material by definition lacks. The
   * cost of this default is normally paid by content of unknown provenance
   * only: everything the harness itself writes is labelled at the point of
   * writing, so an artifact or knowledge-base document reaching this check
   * unlabelled came from somewhere else.
   *
   * A project that would rather send what it has not classified sets this to
   * `internal`. What is withheld is always reported (see `withheld` in the
   * context assembler), so the failure mode is visible rather than silent.
   */
  readonly unlabelled: EgressClass;
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  maxClass: 'internal',
  unlabelled: 'restricted',
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
