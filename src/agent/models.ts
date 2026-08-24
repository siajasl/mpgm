/**
 * Model tiers (AGT-5, PLAN §3).
 *
 * The model is a dispatch-time session parameter, never part of a role
 * (DESIGN §4.2) — which is what lets the repair loop re-run a task on a
 * stronger model without that being a role change, and so without touching
 * the role freeze or AGT-6.
 *
 * The ordering is the only claim this module makes, and it is a weak one: a
 * higher tier is more capable and more expensive, nothing more.
 */

/** Weakest to strongest. Ids are prefixes, so dated releases match. */
export const MODEL_TIERS = [
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/** Where a model sits, or undefined if it is not one this table ranks. */
export function tierOf(model: string): number | undefined {
  const index = MODEL_TIERS.findIndex((tier) => model.startsWith(tier));
  return index === -1 ? undefined : index;
}

/**
 * One step up the table.
 *
 * A model the table does not rank comes back unchanged. Guessing which way is
 * up for an unfamiliar id would silently re-run a task on something nobody
 * chose — and the caller can see that nothing moved, which is the honest
 * signal that escalation was not available.
 */
export function escalateModel(model: string): string {
  const tier = tierOf(model);
  if (tier === undefined || tier >= MODEL_TIERS.length - 1) {
    return model;
  }
  return MODEL_TIERS[tier + 1] ?? model;
}

export function canEscalate(model: string): boolean {
  return escalateModel(model) !== model;
}
