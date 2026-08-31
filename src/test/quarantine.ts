/**
 * Flaky detection and quarantine ledger (TST-6, DESIGN §4.7).
 *
 * DESIGN §4.7 puts this next to `test.nfr`: "A quarantine ledger tracks flaky
 * tests (TST-6): quarantined tests are excluded from coverage claims and
 * raised as maintenance tasks." Two things follow from "excluded", and this
 * module is both of them.
 *
 * First, flakiness is a fact about *disagreement*, not about a single run —
 * a test that failed once is a failing test, not a flaky one, and calling it
 * flaky on one data point is a guess dressed as a detection. {@link
 * detectFlaky} only has an opinion once it has been given at least two
 * independently comparable reruns of the same suite against the same code,
 * and it is deliberately strict about what "the same suite" means: a rerun
 * that reports on a different set of ids is not a rerun of anything this
 * module can compare (CONV-4, mirroring `AdversarialResultMismatchError`).
 *
 * Second, once a test is quarantined, that has to reach the coverage report
 * that TST-2 asks every requirement for — not just a list somewhere a person
 * has to remember to cross-reference. A requirement whose only `verifiedBy`
 * was a since-quarantined test drops back to unverified rather than holding
 * on evidence that no longer counts as evidence; that is what "quarantined
 * tests are excluded from coverage claims" means operationally, and what
 * {@link withoutQuarantined} does to any coverage row shaped like one (TST-2:
 * `CoverageRow` in `src/trace/index-store.ts`; TST-3: `NfrCoverageRow` and
 * `RequirementCoverageRow` in `src/test/nfr.ts`).
 *
 * Quarantine here is auto — {@link detectAndQuarantine} goes straight from a
 * disagreement to a ledger entry, with no operator gate in between, the same
 * way `ci.checks` requires no operator to notice a check reported red. What
 * a person can act on is `reason`, kept on the entry in the terms TST-5 asks
 * a defect to be filed in: what was seen, not just that something was.
 */

/** One test's outcome on one rerun. `not-reported` is itself an outcome, not
 * an absence — a test that sometimes fails to report at all against
 * unchanged code is exactly as flaky as one that sometimes fails. */
export type RerunOutcome = 'passed' | 'failed' | 'not-reported';

/** One test's result within one rerun of a suite. */
export interface TestRerun {
  readonly id: string;
  readonly outcome: RerunOutcome;
}

/**
 * Raised when {@link detectFlaky} is given fewer than two reruns.
 *
 * Flakiness is a disagreement between runs; a single run has nothing to
 * disagree with itself about, so nothing can be called flaky from it. Reading
 * one run as "not flaky" would be a real answer to a question this module was
 * not asked, and reading it as "flaky" would be worse — so it refuses outright
 * rather than guess either way (CONV-3, CONV-4).
 */
export class FlakyDetectionRunsError extends Error {
  readonly runs: number;

  constructor(runs: number) {
    super(
      `detectFlaky needs at least 2 reruns of the same suite against the ` +
        `same code to compare, got ${String(runs)}. A single run has nothing ` +
        `to disagree with itself about, so nothing can be called flaky from ` +
        `it (CONV-3).`,
    );
    this.name = 'FlakyDetectionRunsError';
    this.runs = runs;
  }
}

/**
 * Raised when two reruns handed to {@link detectFlaky} report on different
 * sets of test ids.
 *
 * A disagreement in *which* tests ran is not evidence about whether any one
 * of them is flaky — it means the two runs are not reruns of the same suite
 * at all: a suite edited between runs, a runner picking up a different file,
 * a rerun against a different ref entirely. Comparing outcomes across that
 * gap would attribute the id mismatch itself to whichever ids happen to
 * survive it, silently. Refusing is the same refusal
 * `AdversarialResultMismatchError` makes when a run reports a case the suite
 * never declared (CONV-4).
 */
export class FlakyDetectionMismatchError extends Error {
  readonly expected: readonly string[];
  readonly got: readonly string[];
  readonly runIndex: number;

  constructor(expected: readonly string[], got: readonly string[], runIndex: number) {
    super(
      `rerun ${String(runIndex)} reported on a different set of test ids than ` +
        `rerun 0 did, so they are not comparable reruns of the same suite. ` +
        `Rerun 0 reported: ${expected.join(', ') || '(none)'}. Rerun ` +
        `${String(runIndex)} reported: ${got.join(', ') || '(none)'}. Refusing ` +
        `to detect flakiness across a set of ids that itself disagrees ` +
        `(CONV-4).`,
    );
    this.name = 'FlakyDetectionMismatchError';
    this.expected = expected;
    this.got = got;
    this.runIndex = runIndex;
  }
}

/** A test whose outcome disagreed across the reruns it was compared over. */
export interface FlakyTest {
  readonly id: string;
  /** One outcome per rerun, in the order the reruns were given. */
  readonly outcomes: readonly RerunOutcome[];
}

/**
 * Find tests whose outcome disagreed across a set of reruns of the same
 * suite against the same code (TST-6).
 *
 * Pure — the same reruns always produce the same flaky set, which is what
 * lets a quarantine decision replay from a log instead of being re-derived
 * from a suite that may since have changed (mirrors `nfrCoverage` and
 * `adversarialVerdict`).
 *
 * A test not seen at all is not in the result: {@link
 * FlakyDetectionMismatchError} has already refused any rerun whose id set
 * disagrees with the first, so by the time this loop runs, every rerun
 * reports on the same ids and "not seen" cannot happen.
 */
export function detectFlaky(
  runs: readonly (readonly TestRerun[])[],
): readonly FlakyTest[] {
  if (runs.length < 2) {
    throw new FlakyDetectionRunsError(runs.length);
  }

  const first = runs[0] ?? [];
  const expectedIds = first.map((rerun) => rerun.id);
  const expectedSet = new Set(expectedIds);

  runs.forEach((run, index) => {
    const gotIds = run.map((rerun) => rerun.id);
    const gotSet = new Set(gotIds);
    const agrees =
      gotSet.size === expectedSet.size && expectedIds.every((id) => gotSet.has(id));
    if (!agrees) {
      throw new FlakyDetectionMismatchError(expectedIds, gotIds, index);
    }
  });

  const outcomesById = new Map<string, RerunOutcome[]>();
  for (const run of runs) {
    for (const rerun of run) {
      const outcomes = outcomesById.get(rerun.id) ?? [];
      outcomes.push(rerun.outcome);
      outcomesById.set(rerun.id, outcomes);
    }
  }

  const flaky: FlakyTest[] = [];
  for (const id of expectedIds) {
    const outcomes = outcomesById.get(id) ?? [];
    if (new Set(outcomes).size > 1) {
      flaky.push({ id, outcomes });
    }
  }
  return flaky;
}

/** One test's entry in the quarantine ledger. */
export interface QuarantineEntry {
  readonly testId: string;
  /** The ref (commit/tag) the reruns that caught this were measured against. */
  readonly ref: string;
  /** The disagreeing outcomes that earned quarantine — the evidence. */
  readonly outcomes: readonly RerunOutcome[];
  /** Human-readable account of the evidence (TST-5's "what was seen"). */
  readonly reason: string;
}

/**
 * The quarantine ledger: every test currently quarantined, and why.
 *
 * Append-only and read as a whole, the same shape as the kernel's own event
 * log (DESIGN §5) — a ledger entry is never edited or removed once written,
 * because the point of "tracked" (TST-6) is that a quarantine decision stays
 * legible after the fact, not just current. There is no un-quarantine
 * operation here: TST-6 asks that a flaky test be detected, quarantined and
 * tracked, and nothing in that asks this module to also decide when a test
 * has earned its way back — that is a maintenance decision (DESIGN §4.7's
 * "raised as maintenance tasks"), made by a person or a later task, not by
 * rerunning the same detector until it happens to agree with itself once.
 */
export type QuarantineLedger = readonly QuarantineEntry[];

/** The ids currently quarantined, for filtering coverage. */
export function quarantinedIds(ledger: QuarantineLedger): ReadonlySet<string> {
  return new Set(ledger.map((entry) => entry.testId));
}

function reasonFor(test: FlakyTest, ref: string): string {
  return (
    `outcomes disagreed across ${String(test.outcomes.length)} reruns against ` +
    `${ref}: ${test.outcomes.join(' -> ')}`
  );
}

/**
 * Auto-quarantine: append a ledger entry for every flaky test not already
 * quarantined.
 *
 * No operator gate sits between detection and quarantine — a flaky test is
 * quarantined the moment {@link detectFlaky} finds it, the same way a red
 * `ci.checks` verdict blocks a merge without anyone approving that it should.
 * What stays for a person to act on is the entry's `reason`.
 *
 * Idempotent against a test already on the ledger: a test flagged flaky again
 * on a later run gets no second entry, the same "converges instead of
 * duplicating" rule the PM projector applies to its own reconcile pass
 * (PMG-4) — a ledger that grew a fresh row every time the same test failed
 * to settle would bury the one row that mattered under duplicates of it.
 */
export function quarantineFlaky(
  ledger: QuarantineLedger,
  ref: string,
  flaky: readonly FlakyTest[],
): QuarantineLedger {
  const already = quarantinedIds(ledger);
  const additions = flaky
    .filter((test) => !already.has(test.id))
    .map((test): QuarantineEntry => ({
      testId: test.id,
      ref,
      outcomes: test.outcomes,
      reason: reasonFor(test, ref),
    }));
  return additions.length === 0 ? ledger : [...ledger, ...additions];
}

export interface DetectAndQuarantineOptions {
  readonly ledger: QuarantineLedger;
  /** The ref the reruns were measured against, recorded on any new entry. */
  readonly ref: string;
  /** At least two reruns of the same suite against `ref` (see {@link detectFlaky}). */
  readonly runs: readonly (readonly TestRerun[])[];
}

export interface DetectAndQuarantineResult {
  readonly ledger: QuarantineLedger;
  /** What was newly found flaky on this pass — a subset of `ledger`'s new rows. */
  readonly flaky: readonly FlakyTest[];
}

/**
 * The whole of the auto-quarantine pipeline: detect, then quarantine what was
 * found (TST-6).
 *
 * Kept as one call because splitting detection from quarantining is where a
 * caller could quietly drop the second half — running the detector and never
 * folding its result into the ledger is indistinguishable, from outside, from
 * a suite that was never rerun at all.
 */
export function detectAndQuarantine(
  options: DetectAndQuarantineOptions,
): DetectAndQuarantineResult {
  const flaky = detectFlaky(options.runs);
  return { ledger: quarantineFlaky(options.ledger, options.ref, flaky), flaky };
}

/** The shape of a coverage row {@link withoutQuarantined} can filter. */
export interface QuarantinableCoverageRow {
  readonly id: string;
  readonly verified: boolean;
  readonly verifiedBy: readonly string[];
}

/**
 * Recompute coverage rows with quarantined tests removed from `verifiedBy`
 * (TST-6: "a quarantined test MUST NOT silently satisfy TST-2 coverage").
 *
 * Generic over any row shaped like {@link QuarantinableCoverageRow} — the
 * general trace-graph rows TST-2 reads (`CoverageRow`,
 * `src/trace/index-store.ts`) and the NFR/combined rows TST-3 reads
 * (`NfrCoverageRow`, `RequirementCoverageRow`, `src/test/nfr.ts`) are all one
 * fold away from this shape, so one function does the exclusion for both
 * rather than three copies of the same filter drifting apart.
 *
 * A row untouched by quarantine (nothing in its `verifiedBy` is quarantined)
 * is returned unchanged, not a shallow copy of itself — the common case, and
 * cheap to keep that way. A row that loses everything from `verifiedBy` has
 * `verified` recomputed rather than left `true`: that recomputation is the
 * entire point (`verified: false` is what "coverage drops accordingly" means)
 * — the failure mode this function exists to rule out is a `verified: true`
 * row whose only evidence was a test the ledger no longer trusts, which is
 * coverage silently holding on evidence that stopped counting.
 */
export function withoutQuarantined<T extends QuarantinableCoverageRow>(
  rows: readonly T[],
  quarantined: ReadonlySet<string>,
): readonly T[] {
  if (quarantined.size === 0) {
    return rows;
  }
  return rows.map((row) => {
    const verifiedBy = row.verifiedBy.filter((id) => !quarantined.has(id));
    if (verifiedBy.length === row.verifiedBy.length) {
      return row;
    }
    return { ...row, verifiedBy, verified: verifiedBy.length > 0 };
  });
}
