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

/**
 * How much more a round costs one tier up, measured rather than invented
 * (T4.3.2, T4.3.8).
 *
 * T4.3.2's rework: two Sonnet rounds cost $5.64 and $1.06, and the third —
 * escalated to Opus, per T4.2.13 — cost $8.0142675 against an implementer
 * budget of $8 that had not moved. That is roughly eight times the round
 * immediately before it, on an allowance sized for the tier that round ran
 * on. One incident is a floor, not a distribution, and this multiplier is
 * kept here rather than folded into a bigger number in `roles/freeze.json`
 * until the eval harness (T5.2.1a) has more than one escalated round to fit
 * a real ratio to.
 */
export const ESCALATION_COST_MULTIPLIER = 8;

/**
 * What escalating one tier is expected to need, given what the weaker tier
 * actually spent on the round right before it.
 *
 * Not a forecast of what the stronger tier will spend — nothing here has
 * seen it run — but a threshold below which dispatching it is known, from
 * `ESCALATION_COST_MULTIPLIER`'s own measurement, to end the same way
 * T4.3.2's Opus round did: started on the full allowance and truncated at
 * the cap. `precedingRoundCostUsd` is read off this task's own event log
 * (`implement/loop.ts`), not off a table of prices, because the kernel has
 * no such table — the SDK is the only thing that knows what a session
 * actually cost.
 */
export function estimateEscalatedCostUsd(precedingRoundCostUsd: number): number {
  return precedingRoundCostUsd * ESCALATION_COST_MULTIPLIER;
}
