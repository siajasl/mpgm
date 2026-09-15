import type { Artifact } from '../artifact/store.js';
import type { StoredEvent } from '../event/envelope.js';
import type { MergeRefusal } from '../implement/merge.js';
import {
  computeEscapedDefectRate,
  type EscapedDefectRate,
} from './escaped-defect-rate.js';

/**
 * Gate rejection, rework and escaped-defect rates, per run, in log order
 * (OBS-4, DESIGN §4.5).
 *
 * "Gate rejection rate" says nothing until it says which gate (glossary,
 * "Gate"). This kernel has two an operator or a rate could mean, and this
 * module reports them separately rather than summed, because an operator
 * refusing a phase artifact (`GateRejected`, HIL-1) and CI refusing a merge
 * (`decideMerge`, `../implement/merge.ts`) are different failures with
 * different remedies — a run that shows one number could not tell you which
 * of the two had gone wrong.
 *
 * Nothing here adds an event or keeps a tally beside the loop. The phase-gate,
 * merge-gate and rework figures are folded from the run's own event slice,
 * the same way `computeRunMetrics` (`./metrics.ts`, OBS-2) already is — a
 * counter kept alongside `implement/loop.ts` would be a second source of
 * truth for exactly what the log already holds (ADR-2). The escaped-defect
 * figure (T4.2.2b, `./escaped-defect-rate.ts`) differs only in *where* it
 * reads from: a Defect is an artifact, not an event (the catalog has no
 * defect event and adds none for this), so it is read through the artifact
 * store instead — still folded from the one place each fact already lives
 * (events in the log, artifacts in git, ADR-3), never a tally this module
 * keeps of its own.
 */

/**
 * The phase gate — an operator's approve/reject of a phase's artifacts
 * (HIL-1, `GateApproved`/`GateRejected`).
 *
 * `decided` is `GateApproved` plus `GateRejected` events, not gates
 * `GatePresented`: a gate still waiting on an operator is not a rejection
 * that has yet to happen, and counting it in the denominator would shrink
 * the rate for no reason but a decision nobody has made.
 *
 * Counted as events, not as the folded `GateState.status` a run holds one of
 * per gate id: a gate that was rejected, reopened and re-presented, and then
 * approved, is one rejection and one approval over its lifetime, and the
 * folded status alone would show only the final `approved` and erase the
 * rejection that happened first.
 */
export interface PhaseGateRate {
  readonly decided: number;
  readonly rejected: number;
  /** `rejected / decided`. Null when nothing has been decided yet. */
  readonly rate: number | null;
}

/**
 * The merge gate — `decideMerge`'s per-check-kind refusal of one task's
 * change (`../implement/merge.ts`, IMP-1/3).
 *
 * `decideMerge` returns a `MergeDecision` and nothing writes it to the log
 * (glossary, "Gate"), so this is reconstructed rather than read: from
 * `ChecksReported` (a settled CI verdict — every red one is a change
 * `decideMerge` would refuse for `checks-not-green`, the same test the
 * function itself applies) and `ChangeReviewed` (a review that asked for
 * changes is `changes-requested`; an approving review that still names an
 * undeclared deviation is `undeclared-deviation` — `implement/loop.ts`
 * dispatches a fresh session on both, so both are refusals the change was
 * sent back for).
 *
 * `BudgetExceeded{kind: 'repairs' | 'reviews'}` is read too, because it is
 * the event that marks a task giving up on the merge gate entirely — but it
 * adds no count of its own. By the time either fires, every refusal it
 * represents has already been written as a `ChecksReported` or
 * `ChangeReviewed` on the way there (a repairs budget exhausts only after
 * every attempt it bounds has reported red; a reviews budget exhausts only
 * after every round it bounds has been sent back). Counting it again would
 * double the refusals it is the last event of, so `budgetExhausted` below is
 * kept only as a count for a reader to see, not folded into `refusals`.
 *
 * `unobservable` names the `MergeRefusal` cases nothing in the log can show:
 * `checks-are-stale` and `review-is-stale` compare a verdict or a review's
 * `ref` against the change's ref *at merge time*, which the log never
 * records; `no-review` and `reviewer-not-independent` are properties of a
 * `decideMerge` call that itself goes unlogged. Naming them is the point —
 * a rate silent about what it cannot see would imply the taxonomy is fully
 * observable, and it is not.
 */
export interface MergeGateRate {
  /** Every settled CI verdict, plus every review taken. */
  readonly attempts: number;
  /** Of those, the ones `decideMerge` would have refused. */
  readonly refusals: number;
  /** `refusals / attempts`. Null when neither has happened yet. */
  readonly rate: number | null;
  /** `MergeRefusal` cases this reconstruction cannot see (see above). */
  readonly unobservable: readonly MergeRefusal[];
  /**
   * Count of `BudgetExceeded{kind: 'repairs' | 'reviews'}` this run. Already
   * reflected in `refusals` via the events that preceded each — see above.
   */
  readonly budgetExhausted: number;
}

/**
 * Review rounds that sent a change back to its author.
 *
 * Not `AggregateMetric.retries` (`./metrics.ts`), which folds `ValidationFailed`
 * retries, CI repair rounds and review-rework rounds into one figure — a task
 * repaired three times for CI and never sent back by a reviewer reports 3
 * there and 0 here, and the two numbers are supposed to disagree.
 *
 * A round is rework when its `ChangeReviewed` has `approved: false`, or has
 * `approved: true` with a non-empty `undeclaredDeviations` — `implement/
 * loop.ts` dispatches a fresh session on both (`track('rework', ...)`), and
 * the second shape is the declaration-only round T4.2.4 spent twelve sessions
 * and $29.52 on. A rate that read `approved` alone would miss it.
 */
export interface ReworkRate {
  readonly reviewed: number;
  readonly reworked: number;
  /** `reworked / reviewed`. Null when no review has been taken yet. */
  readonly rate: number | null;
}

export interface RunGateRates {
  readonly runId: string;
  readonly phaseGate: PhaseGateRate;
  readonly mergeGate: MergeGateRate;
  readonly rework: ReworkRate;
  /** OBS-4, T4.2.2b — see `./escaped-defect-rate.ts` for how this is read and attributed. */
  readonly escapedDefects: EscapedDefectRate;
}

/**
 * `MergeRefusal` cases `decideMerge` can return that nothing in the log lets
 * this reconstruction see (see {@link MergeGateRate}).
 */
export const UNOBSERVABLE_MERGE_REFUSALS: readonly MergeRefusal[] = [
  'checks-are-stale',
  'no-review',
  'reviewer-not-independent',
  'review-is-stale',
];

interface ChecksReportedPayload {
  readonly mergeable: boolean;
}

interface ChangeReviewedPayload {
  readonly approved: boolean;
  readonly undeclaredDeviations: readonly string[];
}

interface BudgetExceededPayload {
  readonly kind: string;
}

/**
 * Gate rejection, rework and escaped-defect rates for one run (OBS-4).
 *
 * `events` need not already be filtered to `runId` — every case below checks
 * it, the same guard `computeRunMetrics` applies — but a caller handing in
 * every run's events gets exactly that run's figures back either way. It
 * should, however, cover every run and not just `runId`'s own: the escaped-
 * defect figure needs to see a `ChangeMerged` that may belong to a different
 * run than `runId` (`./escaped-defect-rate.ts`'s own doc explains why), and a
 * caller that pre-filters to `runId` would silently starve that lookup.
 *
 * `defects` is every Defect artifact the caller has read from the artifact
 * store (e.g. `ArtifactStore.list('artifacts/defect')`), defaulted to empty
 * for callers with nothing to hand in — a run with no defect artifacts on
 * disk is exactly what this reports as `escapedDefects.rate === null`
 * (module doc, `./escaped-defect-rate.ts`) rather than a clean `0%`.
 */
export function computeGateRates(
  runId: string,
  events: readonly StoredEvent[],
  defects: readonly Artifact[] = [],
): RunGateRates {
  let gatesDecided = 0;
  let gatesRejected = 0;
  let checksAttempts = 0;
  let checksRefusals = 0;
  let reviewsTaken = 0;
  let reviewRefusals = 0;
  let budgetExhausted = 0;

  for (const event of events) {
    if (event.runId !== runId) {
      continue;
    }
    switch (event.type) {
      case 'GateApproved': {
        gatesDecided += 1;
        break;
      }
      case 'GateRejected': {
        gatesDecided += 1;
        gatesRejected += 1;
        break;
      }
      case 'ChecksReported': {
        const payload = event.payload as ChecksReportedPayload;
        checksAttempts += 1;
        if (!payload.mergeable) {
          checksRefusals += 1;
        }
        break;
      }
      case 'ChangeReviewed': {
        const payload = event.payload as ChangeReviewedPayload;
        reviewsTaken += 1;
        if (!payload.approved || payload.undeclaredDeviations.length > 0) {
          reviewRefusals += 1;
        }
        break;
      }
      case 'BudgetExceeded': {
        const payload = event.payload as BudgetExceededPayload;
        if (payload.kind === 'repairs' || payload.kind === 'reviews') {
          budgetExhausted += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  const mergeAttempts = checksAttempts + reviewsTaken;
  const mergeRefusals = checksRefusals + reviewRefusals;

  return {
    runId,
    phaseGate: {
      decided: gatesDecided,
      rejected: gatesRejected,
      rate: gatesDecided === 0 ? null : gatesRejected / gatesDecided,
    },
    mergeGate: {
      attempts: mergeAttempts,
      refusals: mergeRefusals,
      rate: mergeAttempts === 0 ? null : mergeRefusals / mergeAttempts,
      unobservable: UNOBSERVABLE_MERGE_REFUSALS,
      budgetExhausted,
    },
    rework: {
      reviewed: reviewsTaken,
      reworked: reviewRefusals,
      rate: reviewsTaken === 0 ? null : reviewRefusals / reviewsTaken,
    },
    escapedDefects: computeEscapedDefectRate(runId, events, defects),
  };
}
