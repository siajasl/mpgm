import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../event/envelope.js';
import { priorReviewBudgetOf } from './review-budget.js';

/** A minimal `ChangeReviewed` event, the only type this reads. */
function changeReviewed(payload: {
  readonly taskId: string;
  readonly approved: boolean;
  readonly declaredDeviations?: readonly string[];
  readonly undeclaredDeviations?: readonly string[];
}): StoredEvent {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    runId: 'r',
    type: 'ChangeReviewed',
    schemaVersion: 1,
    payload,
  };
}

describe('priorReviewBudgetOf', () => {
  it('answers a fresh task as having spent nothing', () => {
    const budget = priorReviewBudgetOf([], 'T1', 1);
    expect(budget.roundsSoFar).toBe(0);
    expect(budget.declared.size).toBe(0);
    expect(budget.extensionSpent).toBe(false);
    expect(budget.attempts).toBe(1);
    expect(budget.lastRoundAllowed).toBe(false);
  });

  it('ignores another task’s rounds entirely', () => {
    const events = [
      changeReviewed({ taskId: 'T2', approved: false, undeclaredDeviations: ['CONV-1'] }),
    ];
    const budget = priorReviewBudgetOf(events, 'T1', 1);
    expect(budget.roundsSoFar).toBe(0);
  });

  it('counts a plain rejection as a spent round, nothing more', () => {
    const events = [changeReviewed({ taskId: 'T1', approved: false })];
    const budget = priorReviewBudgetOf(events, 'T1', 2);
    expect(budget.roundsSoFar).toBe(1);
    expect(budget.extensionSpent).toBe(false);
    expect(budget.attempts).toBe(2);
  });

  it(
    'replays the once-per-task declaration grace exactly as the loop would ' +
      'have granted it (T4.3.17)',
    () => {
      // Round 1 of a budget of 1: approved, with CONV-1 undeclared — the
      // shape that earns the grace at the cap.
      const round1 = changeReviewed({
        taskId: 'T1',
        approved: true,
        declaredDeviations: [],
        undeclaredDeviations: ['CONV-1'],
      });
      // The grace round: the author declares CONV-1. Round 2 (the new cap)
      // approves again, reporting CONV-1 (now declared) and a fresh CONV-6
      // (not), so only CONV-6 is undeclared.
      const round2 = changeReviewed({
        taskId: 'T1',
        approved: true,
        declaredDeviations: ['CONV-1'],
        undeclaredDeviations: ['CONV-6'],
      });

      const budget = priorReviewBudgetOf([round1, round2], 'T1', 1);

      expect(budget.roundsSoFar).toBe(2);
      // The extension was spent granting round 1's grace, not available for
      // round 2's fresh CONV-6 — same as `implementTask`'s own bound.
      expect(budget.extensionSpent).toBe(true);
      expect(budget.attempts).toBe(2);
      // What round 1's grace actually bought: CONV-1 is remembered as
      // declared, not merely that a round happened.
      expect([...budget.declared.keys()]).toStrictEqual(['CONV-1']);
      // Round 2 still has something undeclared (CONV-6), so the gate would
      // not have allowed it.
      expect(budget.lastRoundAllowed).toBe(false);
    },
  );

  it('reports the last round allowed when nothing is left undeclared', () => {
    const events = [
      changeReviewed({
        taskId: 'T1',
        approved: true,
        declaredDeviations: [],
        undeclaredDeviations: [],
      }),
    ];
    const budget = priorReviewBudgetOf(events, 'T1', 1);
    expect(budget.lastRoundAllowed).toBe(true);
  });
});
