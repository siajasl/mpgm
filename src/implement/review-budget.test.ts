import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../event/envelope.js';
import { priorReviewBudgetOf, redirectAuthorizesContinuation } from './review-budget.js';

const ALWAYS_REACHABLE = () => true;
const NEVER_REACHABLE = () => false;

/** A minimal `ChangeReviewed` event, the only type this reads. */
function changeReviewed(
  payload: {
    readonly taskId: string;
    readonly ref?: string;
    readonly approved: boolean;
    readonly declaredDeviations?: readonly string[];
    readonly undeclaredDeviations?: readonly string[];
  },
  options: { readonly seq?: number; readonly runId?: string } = {},
): StoredEvent {
  return {
    seq: options.seq ?? 0,
    ts: new Date().toISOString(),
    runId: options.runId ?? 'r',
    type: 'ChangeReviewed',
    schemaVersion: 1,
    payload: { ref: 'deadbeef', ...payload },
  };
}

describe('priorReviewBudgetOf', () => {
  it('answers a fresh task as having spent nothing', () => {
    const budget = priorReviewBudgetOf([], 'r', 'T1', 1, ALWAYS_REACHABLE);
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
    const budget = priorReviewBudgetOf(events, 'r', 'T1', 1, ALWAYS_REACHABLE);
    expect(budget.roundsSoFar).toBe(0);
  });

  it('ignores another run’s rounds entirely, even for the same task (T4.3.17)', () => {
    const events = [
      changeReviewed({ taskId: 'T1', approved: false }, { runId: 'abandoned-run' }),
    ];
    const budget = priorReviewBudgetOf(events, 'r', 'T1', 1, ALWAYS_REACHABLE);
    expect(budget.roundsSoFar).toBe(0);
    expect(budget.declared.size).toBe(0);
  });

  it('counts a plain rejection as a spent round, nothing more', () => {
    const events = [changeReviewed({ taskId: 'T1', approved: false })];
    const budget = priorReviewBudgetOf(events, 'r', 'T1', 2, ALWAYS_REACHABLE);
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

      const budget = priorReviewBudgetOf(
        [round1, round2],
        'r',
        'T1',
        1,
        ALWAYS_REACHABLE,
      );

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
    const budget = priorReviewBudgetOf(events, 'r', 'T1', 1, ALWAYS_REACHABLE);
    expect(budget.lastRoundAllowed).toBe(true);
  });

  it(
    'does not carry a declaration whose round reviewed a commit the branch ' +
      'no longer contains (T4.3.17)',
    () => {
      const events = [
        changeReviewed({
          taskId: 'T1',
          ref: 'rewritten-commit',
          approved: true,
          declaredDeviations: ['CONV-1'],
          undeclaredDeviations: [],
        }),
      ];
      // The round still counts — the session ran and the budget it spent is
      // real — but nothing it declared is trusted, because the caller
      // answers that its commit is gone.
      const budget = priorReviewBudgetOf(events, 'r', 'T1', 2, NEVER_REACHABLE);
      expect(budget.roundsSoFar).toBe(1);
      expect(budget.declared.size).toBe(0);
    },
  );

  it(
    'pins a documented gap: a round decideMerge would have refused as ' +
      'review-is-stale is replayed as allowed (T4.3.17)',
    () => {
      // `ChangeReviewed` is appended before `decideMerge` runs, so a round
      // can be logged exactly like this — approved, nothing left
      // undeclared — and still have been the round `isReworkable` sent back
      // for naming a commit that was not the tip. Nothing in the stored
      // payload distinguishes it from a round that genuinely cleared the
      // gate, which is the gap the doc above now states rather than hides.
      const events = [
        changeReviewed({
          taskId: 'T1',
          ref: 'stale-ref-not-the-tip',
          approved: true,
          declaredDeviations: [],
          undeclaredDeviations: [],
        }),
      ];
      const budget = priorReviewBudgetOf(events, 'r', 'T1', 1, ALWAYS_REACHABLE);
      // What the gap actually produces: this reads as a round the gate
      // allowed, though `decideMerge` itself refused it `review-is-stale`
      // and the loop stopped there without granting anything.
      expect(budget.lastRoundAllowed).toBe(true);
    },
  );
});

describe('redirectAuthorizesContinuation', () => {
  function intervened(
    payload: { readonly action: string; readonly taskId?: string },
    options: { readonly seq: number; readonly runId?: string },
  ): StoredEvent {
    return {
      seq: options.seq,
      ts: new Date().toISOString(),
      runId: options.runId ?? 'r',
      type: 'OperatorIntervened',
      schemaVersion: 2,
      payload,
    };
  }

  it('answers false when no round has run yet', () => {
    const events = [intervened({ action: 'redirect', taskId: 'T1' }, { seq: 1 })];
    expect(redirectAuthorizesContinuation(events, 'r', 'T1', undefined)).toBe(false);
  });

  it('answers false for a redirect logged before the exhausted round', () => {
    const events = [intervened({ action: 'redirect', taskId: 'T1' }, { seq: 1 })];
    expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(false);
  });

  it('answers true for a redirect logged after the exhausted round', () => {
    const events = [intervened({ action: 'redirect', taskId: 'T1' }, { seq: 9 })];
    expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(true);
  });

  it('answers false for a redirect from a different run', () => {
    const events = [
      intervened({ action: 'redirect', taskId: 'T1' }, { seq: 9, runId: 'other-run' }),
    ];
    expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(false);
  });

  it('answers false for a redirect naming a different task', () => {
    const events = [intervened({ action: 'redirect', taskId: 'T2' }, { seq: 9 })];
    expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(false);
  });

  it('ignores a pause or resume logged after the exhausted round', () => {
    const events = [intervened({ action: 'pause' }, { seq: 9 })];
    expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(false);
  });

  function dispatched(seq: number, taskId = 'T1', runId = 'r'): StoredEvent {
    return {
      seq,
      ts: new Date().toISOString(),
      runId,
      type: 'TaskDispatched',
      schemaVersion: 1,
      payload: { taskId, role: 'implementer', model: 'claude' },
    };
  }

  it(
    'does not re-authorize once the granted round has dispatched, even if ' +
      'it never reached a review (T4.3.17)',
    () => {
      const redirect = intervened({ action: 'redirect', taskId: 'T1' }, { seq: 9 });
      // The redirect at seq 9 authorizes the round that dispatches at seq
      // 10 — but that round blocks (CI, a kill, a conflict) before ever
      // appending `ChangeReviewed`, so `afterSeq` (still 5, the old
      // exhausted round) has not moved. Without consuming on the dispatch
      // itself, this same redirect would authorize indefinitely.
      const events = [redirect, dispatched(10)];
      expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(false);
    },
  );

  it(
    'still authorizes when the dispatch it is consumed against belongs to ' +
      'a different task or run (T4.3.17)',
    () => {
      const redirect = intervened({ action: 'redirect', taskId: 'T1' }, { seq: 9 });
      const events = [redirect, dispatched(10, 'T2'), dispatched(11, 'T1', 'other-run')];
      expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(true);
    },
  );

  it(
    'does not re-authorize once the granted round dispatched a trunk ' +
      'catch-up conflict resolver, which runs under a session-only suffix ' +
      'rather than the bare task id (T4.3.17)',
    () => {
      const redirect = intervened({ action: 'redirect', taskId: 'T1' }, { seq: 9 });
      // `catchUpAndResolve` dispatches its conflict resolver under
      // `${taskId}-catchup`, not `taskId` itself, and can refuse or block
      // before the round ever dispatches under the bare id — the leak a
      // review of this task found: without matching the suffix, this same
      // redirect would keep reading as fresh on every later invocation.
      const events = [redirect, dispatched(10, 'T1-catchup')];
      expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(false);
    },
  );

  it(
    'does not treat an unrelated task whose id merely starts with the ' +
      'same prefix as a dispatch of this one (T4.3.17)',
    () => {
      const redirect = intervened({ action: 'redirect', taskId: 'T1' }, { seq: 9 });
      // 'T10' starts with 'T1' but not with 'T1-', so it must not consume a
      // redirect that names 'T1'.
      const events = [redirect, dispatched(10, 'T10')];
      expect(redirectAuthorizesContinuation(events, 'r', 'T1', 5)).toBe(true);
    },
  );
});
