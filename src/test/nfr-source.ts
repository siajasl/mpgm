import { z } from 'zod';
import { requirementSchema } from '../schemas.js';
import { nfrRequirementSchema, type NfrRequirement } from './nfr.js';

/**
 * Reading the requirements an `nfr` step measures off the step above it
 * (T4.3.2, `src/phase/runner.ts`).
 *
 * Separate from `./nfr.ts` on purpose: the shape a real project produces is
 * the Scope artifact's (`requirementSchema`, `src/schemas.ts`), and
 * `src/schemas.ts` already imports `./test/nfr.js` for the coverage report an
 * `nfr` step writes. Putting this parse in `nfr.ts` would close that into a
 * module cycle whose evaluation order decides whether a `z.object` exists
 * when another module's top-level `z.union` reaches for it — a failure that
 * appears as `undefined` at import time and has nothing to do with the
 * requirement being parsed.
 */

/**
 * A requirement list as it actually arrives from the step upstream of an
 * `nfr` step.
 *
 * In this project that means the Scope artifact's own `requirements`
 * (`scopeSchema`), not the flat shape {@link nfrRequirementSchema} describes.
 * Scope is what declares quantified thresholds (SCP-1), and it declares them
 * as a discriminated union: a `non-functional` entry nests its
 * `metric`/`value`/`unit`/`measuredBy` under `threshold`, and a `functional`
 * entry carries no threshold at all, because there is nothing to measure.
 * Both element shapes are accepted, the flat one included, because a provider
 * or a session may hand over requirements it already flattened; insisting on
 * the flat one alone made this step parse an array nothing in this repository
 * produces, and the parse is all-or-nothing, so one Scope-shaped element
 * refused the whole list.
 *
 * `.min(1)`: an empty list is not a measurement of nothing, it is the absence
 * of one, and `nfrCoverage` exists to refuse exactly that reading one level
 * down. Making it unrepresentable here (CONV-5) is what stops an `nfr` step
 * whose upstream returned nothing from completing with a clean, zero-row
 * coverage report that an `artifact-exists` gate criterion would then count
 * as met (CONV-4).
 */
export const nfrRequirementSourceSchema = z
  .array(z.union([nfrRequirementSchema, requirementSchema]))
  .min(
    1,
    'an nfr step measures at least one requirement: an empty list is the absence ' +
      'of a measurement, not a clean result, and is refused rather than reported ' +
      'as zero-row coverage (CONV-4)',
  );

export type NfrRequirementSource = z.infer<typeof nfrRequirementSourceSchema>;

/**
 * The quantified requirements in such a list — everything `test.nfr` can be
 * asked to measure.
 *
 * Functional entries are dropped rather than refused: TST-3 binds the
 * *quantified* NFRs to a suite, and a Scope list is mixed by construction, so
 * failing on a functional entry would make a real Scope artifact unmeasurable
 * by this step. Dropping them is only safe because a list that leaves nothing
 * behind is refused by the caller rather than read as nothing to do —
 * `runPhase` blocks the step (`src/phase/runner.ts`) rather than writing a
 * coverage report of no rows.
 */
export function quantifiedRequirements(
  source: NfrRequirementSource,
): readonly NfrRequirement[] {
  const quantified: NfrRequirement[] = [];
  for (const entry of source) {
    if (!('kind' in entry)) {
      quantified.push(entry);
      continue;
    }
    if (entry.kind === 'non-functional') {
      quantified.push({ id: entry.id, ...entry.threshold });
    }
  }
  return quantified;
}
