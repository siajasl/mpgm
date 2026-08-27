import { z } from 'zod';
import type { ContractSpec } from '../contract/capability.js';
import type { CoverageRow } from '../trace/index-store.js';

/**
 * The `test.nfr` capability (DESIGN §4.7, TST-2, TST-3).
 *
 * The kernel treats the suite runner as an oracle for whether a measurement
 * held, the same way `ci.checks` treats CI as the oracle for whether a check
 * passed: a threshold (SCP-1) is a metric, a value, a unit and how it is
 * measured, and nothing in that shape says whether the value is a ceiling or
 * a floor — a latency threshold and a throughput threshold read the same
 * number in opposite directions. Deciding "within threshold" from the raw
 * measurement here would mean guessing the direction; the provider ran the
 * load test or the scan and already knows. What the kernel decides is
 * coverage: which quantified NFRs a suite ran at all (TST-3 binds every one
 * Scope declared), and of those, which came back passing — rolled into the
 * same verified/unverified report TST-2 asks every requirement to have.
 */

export const nfrRunInput = z.object({
  repo: z.string().min(1),
  ref: z.string().min(1),
  requirementId: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
  measuredBy: z.string().min(1),
});

export type NfrRunInput = z.infer<typeof nfrRunInput>;

export const nfrRunOutput = z.object({
  requirementId: z.string().min(1),
  metric: z.string().min(1),
  measured: z.number(),
  unit: z.string().min(1),
  passed: z.boolean(),
  /**
   * What was measured against — a report, a log, a dashboard link. Empty is a
   * legitimate answer where a provider cannot supply one (mirrors
   * `ci.checks#logs`); it is never a reason to withhold `passed`, because an
   * unlinked verdict is worth less than a linked one, not withheld.
   */
  evidence: z.string().default(''),
});

export type NfrRunOutput = z.infer<typeof nfrRunOutput>;

/**
 * The contract specification. `contracts/test.nfr.md` is the prose half; this
 * is the half the kernel validates against.
 */
export const testNfrContract: ContractSpec = {
  name: 'test.nfr',
  summary: 'Measure one quantified NFR against its Scope threshold (TST-3).',
  operations: [
    {
      name: 'run',
      summary: 'Measure a quantified NFR and report whether it held.',
      input: nfrRunInput,
      output: nfrRunOutput,
      // A rerun is a fresh, independently comparable measurement — there is
      // no prior effect to converge on, only a new reading (unlike
      // `pm.github#apply`, where repeating a call must land on the same
      // state).
      effects: 'idempotent',
    },
  ],
};

/** The minimal shape of a quantified requirement this module needs (SCP-1). */
export interface NfrRequirement {
  readonly id: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly measuredBy: string;
}

/** Why a quantified NFR is not verified. */
export type NfrProblem = 'not-run' | 'below-threshold';

export interface NfrCoverageRow {
  readonly id: string;
  readonly verified: boolean;
  readonly problem?: NfrProblem;
  readonly measured?: number;
  readonly evidence?: string;
}

/**
 * Decide, per quantified NFR, whether a suite ran for it and came back within
 * threshold (TST-3).
 *
 * Pure — the same requirements and reported results always produce the same
 * rows, which is what lets a coverage report be replayed from the log rather
 * than re-asked of a provider whose target may since have changed (mirrors
 * `mergeVerdict` in `src/implement/checks.ts`).
 */
export function nfrCoverage(
  requirements: readonly NfrRequirement[],
  results: readonly NfrRunOutput[],
): readonly NfrCoverageRow[] {
  return requirements.map((requirement) => {
    const result = results.find((entry) => entry.requirementId === requirement.id);

    if (result === undefined) {
      // SCP-1 binds every quantified NFR to TST-3: a requirement no suite
      // reported on is exactly as unverified as one that failed. Reading the
      // absence as "not applicable" is the dangerous answer — the one this
      // function exists to refuse.
      return { id: requirement.id, verified: false, problem: 'not-run' };
    }

    if (!result.passed) {
      return {
        id: requirement.id,
        verified: false,
        problem: 'below-threshold',
        measured: result.measured,
        evidence: result.evidence,
      };
    }

    return {
      id: requirement.id,
      verified: true,
      measured: result.measured,
      evidence: result.evidence,
    };
  });
}

export interface RunNfrSuiteOptions {
  readonly repo: string;
  readonly ref: string;
  readonly requirements: readonly NfrRequirement[];
  /** Typically `(input) => contract.invoke('run', input)` on a bound contract. */
  readonly run: (input: NfrRunInput) => Promise<NfrRunOutput>;
}

/**
 * The runner: call `run` once per quantified NFR Scope declares, and hand
 * what comes back to {@link nfrCoverage}.
 *
 * A provider failing on one requirement is not swallowed into "not-run" for
 * it — that would read identically to a suite nobody configured, which is
 * the ambiguity CONV-4 (fail closed) exists to rule out. It propagates, and a
 * caller that wants partial results decides that for itself by choosing what
 * `run` resolves with rather than by this function guessing on its behalf.
 */
export async function runNfrSuite(
  options: RunNfrSuiteOptions,
): Promise<readonly NfrCoverageRow[]> {
  const results: NfrRunOutput[] = [];
  for (const requirement of options.requirements) {
    // Measured one at a time, deliberately: a load test shares whatever
    // capacity the target has, and running two at once would make each
    // result a measurement of the other's interference rather than of the
    // requirement.
    const result = await options.run({
      repo: options.repo,
      ref: options.ref,
      requirementId: requirement.id,
      metric: requirement.metric,
      value: requirement.value,
      unit: requirement.unit,
      measuredBy: requirement.measuredBy,
    });
    results.push(result);
  }
  return nfrCoverage(options.requirements, results);
}

export interface RequirementCoverageRow {
  readonly id: string;
  readonly verified: boolean;
  /** Nodes that verify it through the trace graph — commits, prior runs. */
  readonly verifiedBy: readonly string[];
  readonly problem?: NfrProblem;
}

export interface RequirementCoverageReport {
  readonly rows: readonly RequirementCoverageRow[];
  readonly verified: number;
  readonly total: number;
}

export interface RequirementCoverageInput {
  /** Every requirement the report covers, functional and non-functional. */
  readonly requirements: readonly { readonly id: string }[];
  /** TST-2's general source: `TraceIndex.coverage(ids)`. */
  readonly graph: readonly CoverageRow[];
  /** TST-3's fresh source: this run's {@link nfrCoverage} rows. */
  readonly nfr: readonly NfrCoverageRow[];
}

/**
 * The requirement-coverage report DESIGN §4.7 asks `test.nfr` for: every
 * requirement, verified or not (TST-2), with a quantified NFR's own fresh run
 * folded in alongside whatever the trace graph already holds.
 *
 * Either source is enough. A quantified NFR this run did not re-measure but a
 * still-current commit already verified is not newly unverified because this
 * run happened to skip it, and a fresh pass counts before anything has been
 * committed to say so — the report is honest about the moment it was taken,
 * not about what has been written down yet.
 */
export function requirementCoverageReport(
  input: RequirementCoverageInput,
): RequirementCoverageReport {
  const graphById = new Map(input.graph.map((row) => [row.id, row]));
  const nfrById = new Map(input.nfr.map((row) => [row.id, row]));

  const rows = input.requirements.map((requirement): RequirementCoverageRow => {
    const graphRow = graphById.get(requirement.id);
    const nfrRow = nfrById.get(requirement.id);
    const verifiedByGraph = graphRow?.verified ?? false;
    const verifiedByNfr = nfrRow?.verified ?? false;
    const verified = verifiedByGraph || verifiedByNfr;

    return {
      id: requirement.id,
      verified,
      verifiedBy: graphRow?.verifiedBy ?? [],
      ...(verified ? {} : nfrRow?.problem === undefined ? {} : { problem: nfrRow.problem }),
    };
  });

  return {
    rows,
    verified: rows.filter((row) => row.verified).length,
    total: rows.length,
  };
}
