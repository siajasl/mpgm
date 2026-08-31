import { describe, expect, it } from 'vitest';
import {
  blocksGate,
  DefectDataError,
  defectSchema,
  DefectLifecycleError,
  designReopenRequest,
  fileDefect,
  recordFix,
  retestDefect,
  routeDefect,
  type Defect,
  type FileDefectOptions,
} from './defect.js';

/**
 * TST-5's round trip: file -> route -> fix -> re-test, with re-test able to
 * come back either way. The "done when" this task was set (PLAN T3.2.4) is
 * literally "a defect round-trips through fix and re-test" — the tests below
 * are that round trip, once failing back to open and once holding.
 */

/**
 * Narrows a {@link Defect} to one status branch, the same way the domain
 * functions themselves narrow after a `status !==` guard — asserting the
 * status is also the check that the transition landed where it was supposed
 * to, so this is not narrowing bolted on around an assertion but the
 * assertion itself.
 */
function assertStatus<S extends Defect['status']>(
  defect: Defect,
  status: S,
): asserts defect is Extract<Defect, { status: S }> {
  expect(defect.status).toBe(status);
}

const evidence = (caseId = 'zero-split-refused') => ({
  kind: 'adversarial',
  caseId,
  detail: `splitEvenly(0, 3) returned an array instead of refusing`,
});

const filing: FileDefectOptions = {
  title: 'splitEvenly divides by zero instead of refusing an empty split',
  severity: 'high',
  description: 'An adversarial case caught splitEvenly accepting a zero amount.',
  evidence: evidence(),
  tracesTo: ['LOAN-3'],
};

describe('fileDefect (TST-5)', () => {
  it('files an open defect carrying its evidence and requirement trace', () => {
    const defect = fileDefect(filing);

    expect(defect.status).toBe('open');
    expect(defect.tracesTo).toEqual(['LOAN-3']);
    expect(defect.evidence).toEqual(evidence());
    expect(defect.failedAttempts).toBe(0);
    expect(defect.history).toEqual([{ status: 'open', detail: filing.description }]);
  });

  it('refuses a defect that traces to no requirement', () => {
    expect(() => fileDefect({ ...filing, tracesTo: [] })).toThrow(DefectDataError);
  });

  it('refuses a defect with an empty description', () => {
    // Empty is not a symptom (CONV-3) — a filed defect must say what was seen.
    expect(() => fileDefect({ ...filing, description: '' })).toThrow(DefectDataError);
  });
});

describe('the round trip: route -> fix -> re-test (TST-5)', () => {
  it('round-trips through a fix that does not hold, then one that does', () => {
    const filed = fileDefect(filing);

    // Routed to Implement — TST-5's first destination.
    const routed = routeDefect(
      filed,
      { to: 'implement', taskId: 'T3.1.9' },
      'implementation bug, not a design assumption',
    );
    assertStatus(routed, 'routed');
    expect(routed.route).toEqual({ to: 'implement', taskId: 'T3.1.9' });

    // A fix lands.
    const fixPending = recordFix(routed, {
      ref: 'abc123',
      summary: 'refuse an empty split instead of returning one',
    });
    expect(fixPending.status).toBe('fix-pending');

    // Re-test against the same evidence: it does not hold.
    const stillBroken = retestDefect(fixPending, {
      passed: false,
      detail: 'splitEvenly(0, 3) still returns [] instead of throwing',
    });
    assertStatus(stillBroken, 'reopened');
    expect(stillBroken.failedAttempts).toBe(1);
    // The failed attempt is not discarded — it stays as evidence for the
    // next route, in both the current fields and the history.
    expect(stillBroken.route).toEqual({ to: 'implement', taskId: 'T3.1.9' });
    expect(stillBroken.fix).toEqual({
      ref: 'abc123',
      summary: 'refuse an empty split instead of returning one',
    });
    expect(stillBroken.history.map((entry) => entry.status)).toEqual([
      'open',
      'routed',
      'fix-pending',
      'reopened',
    ]);

    // Routed again to a *different* target — this time it lands. Re-routing
    // to a different route (rather than the same one, as the Design case
    // below does) is what makes the "which route did the failed attempt run
    // under" question below non-trivial to answer from the top-level `route`
    // field alone.
    const reRouted = routeDefect(
      stillBroken,
      { to: 'implement', taskId: 'T3.1.10' },
      'first fix missed the zero-amount case entirely; a different task owns the retry',
    );
    const secondFix = recordFix(reRouted, {
      ref: 'def456',
      summary: 'actually refuse a zero amount this time',
    });
    const verified = retestDefect(secondFix, {
      passed: true,
      detail: 'splitEvenly(0, 3) now throws',
    });

    assertStatus(verified, 'verified');
    // Verified on the second round trip: one round trip failed before this
    // one held, so `failedAttempts` reads 1 (not 2 — the round trip that
    // held is not a failed attempt).
    expect(verified.failedAttempts).toBe(1);
    // A held re-test closes the defect, but does not itself become a
    // requirement-verification claim — a closed defect must not be readable
    // as "LOAN-3 is verified" by the trace graph (see defect.ts's module
    // doc, and the coverage test below).
    expect(verified).not.toHaveProperty('verifies');
    expect(verified.fix).toEqual({
      ref: 'def456',
      summary: 'actually refuse a zero amount this time',
    });
    expect(verified.history.map((entry) => entry.status)).toEqual([
      'open',
      'routed',
      'fix-pending',
      'reopened',
      'routed',
      'fix-pending',
      'verified',
    ]);
    // The first, failed fix's ref is not lost once the second route replaces
    // it — `routed` carries no `fix` field, so the only place `abc123`
    // survives after `reRouted` is the `reopened` history entry that named
    // it at the moment it failed.
    const reopenedEntry = reRouted.history.find((entry) => entry.status === 'reopened');
    expect(reopenedEntry?.ref).toBe('abc123');
    // Nor is the route the failed attempt ran under — `reRouted.route` is
    // now `T3.1.10`, so the only structured place `T3.1.9` (the route that
    // failed) survives is the `reopened` entry that carried it forward
    // before the second `routeDefect` call overwrote the top-level field.
    expect(reopenedEntry?.route).toEqual({ to: 'implement', taskId: 'T3.1.9' });
    // And the new `routed` entry records the route just chosen, so the
    // history alone (without reading top-level `route`, which the next
    // transition will itself overwrite) can say which task each attempt ran
    // under.
    const routedEntries = verified.history.filter((entry) => entry.status === 'routed');
    expect(routedEntries.map((entry) => entry.route)).toEqual([
      { to: 'implement', taskId: 'T3.1.9' },
      { to: 'implement', taskId: 'T3.1.10' },
    ]);
  });

  it('routes to Design instead, and hands ORC-6 a reopen request naming what changed', () => {
    const filed = fileDefect({
      ...filing,
      title: 'the split invariant assumed in DSG-2 does not hold under a zero amount',
    });

    const routed = routeDefect(
      filed,
      { to: 'design', phase: 'design', changed: ['C-4', 'ADR-3'] },
      'the fix requires revisiting the split component design, not just its code',
    );

    const request = designReopenRequest(routed, {
      runId: 'run-7',
      reason: 'defect DEF-9 traced the fix to the split component design',
    });
    expect(request).toEqual({
      runId: 'run-7',
      phase: 'design',
      reason: 'defect DEF-9 traced the fix to the split component design',
      changed: ['C-4', 'ADR-3'],
    });

    const fixPending = recordFix(routed, {
      ref: 'design@2',
      summary: 'component C-4 redesigned to refuse a zero-amount split',
    });
    const verified = retestDefect(fixPending, { passed: true, detail: 'holds now' });
    expect(verified.status).toBe('verified');
  });

  it('routes to Design with no stated `changed`, leaving ORC-6 its own default', () => {
    // A filer who cannot say what a Design defect calls into question must
    // be able to say so, rather than being forced to guess a `changed` set —
    // a too-narrow guess would narrow the ORC-6 cascade below the safe
    // default `ReopenRequest.changed: undefined` already means.
    const filed = fileDefect({
      ...filing,
      title: 'something about the split design looks wrong, but not sure what yet',
    });

    const routed = routeDefect(
      filed,
      { to: 'design', phase: 'design' },
      'looks like a design assumption is wrong, but which one is unclear',
    );

    const request = designReopenRequest(routed, {
      runId: 'run-8',
      reason: 'defect DEF-10: unclear which design assumption failed',
    });
    // No `changed` was stated, so none is invented — `reopenPhase` reads this
    // as "treat the whole of what the phase's gate approved as open to
    // question" (ORC-6), not as an empty, no-op set.
    expect(request.changed).toBeUndefined();
  });
});

describe("CONV-5: a defect's history must end where its own status says it is", () => {
  it('refuses a verified defect whose history stops at open', () => {
    const malformed = {
      status: 'verified',
      title: filing.title,
      severity: filing.severity,
      description: filing.description,
      evidence: filing.evidence,
      tracesTo: filing.tracesTo,
      failedAttempts: 0,
      route: { to: 'implement', taskId: 'T1' },
      fix: { ref: 'abc123', summary: 'a fix' },
      // Never records being routed, fixed or retested — exactly the
      // out-of-band-patch shape TST-5's round trip exists to rule out, and
      // which the union alone (constraining only `route`/`fix` presence)
      // does not catch.
      history: [{ status: 'open', detail: 'filed' }],
    };

    const result = defectSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it('accepts the real round trip, whose history always ends at its own status', () => {
    const filed = fileDefect(filing);
    const routed = routeDefect(filed, { to: 'implement', taskId: 'T1' }, 'why');
    const fixPending = recordFix(routed, { ref: 'r', summary: 's' });
    const verified = retestDefect(fixPending, { passed: true, detail: 'holds' });

    expect(defectSchema.safeParse(verified).success).toBe(true);
  });
});

describe('lifecycle refusals (CONV-4)', () => {
  it('refuses to route an already-routed defect', () => {
    const routed = routeDefect(
      fileDefect(filing),
      { to: 'implement', taskId: 'T1' },
      'why',
    );
    expect(() =>
      routeDefect(routed, { to: 'implement', taskId: 'T2' }, 'why again'),
    ).toThrow(DefectLifecycleError);
  });

  it('refuses to record a fix for a defect nothing has routed', () => {
    expect(() =>
      recordFix(fileDefect(filing), { ref: 'abc', summary: 'a patch nobody routed' }),
    ).toThrow(DefectLifecycleError);
  });

  it('refuses to retest a defect with no fix pending', () => {
    const routed = routeDefect(
      fileDefect(filing),
      { to: 'implement', taskId: 'T1' },
      'why',
    );
    expect(() => retestDefect(routed, { passed: true, detail: 'n/a' })).toThrow(
      DefectLifecycleError,
    );
  });

  it('refuses routing with no stated reason', () => {
    expect(() =>
      routeDefect(fileDefect(filing), { to: 'implement', taskId: 'T1' }, ''),
    ).toThrow(DefectDataError);
  });

  it('refuses a design reopen request for a defect routed to Implement', () => {
    const routed = routeDefect(
      fileDefect(filing),
      { to: 'implement', taskId: 'T1' },
      'why',
    );
    expect(() => designReopenRequest(routed, { runId: 'run-1', reason: 'why' })).toThrow(
      DefectDataError,
    );
  });

  it('refuses a design reopen request for an unrouted defect', () => {
    expect(() =>
      designReopenRequest(fileDefect(filing), { runId: 'run-1', reason: 'why' }),
    ).toThrow(DefectLifecycleError);
  });

  it('refuses a design reopen request with no stated reason, same as routeDefect', () => {
    const routed = routeDefect(
      fileDefect(filing),
      { to: 'design', phase: 'design', changed: ['C-4'] },
      'why',
    );
    expect(() => designReopenRequest(routed, { runId: 'run-1', reason: '' })).toThrow(
      DefectDataError,
    );
  });
});

describe('blocksGate (Test-phase gate: "no open critical/high defects")', () => {
  // Walks the round trip exactly as far as `status` asks and no further, so
  // each branch returns the status it was asked for rather than falling
  // through to whichever transition happens to run last — a helper that
  // silently answered 'verified' for 'fix-pending' or 'reopened' would make
  // every blocksGate assertion below pass regardless of what it claims to
  // exercise.
  const asDefect = (severity: Defect['severity'], status: Defect['status']): Defect => {
    const base = fileDefect({ ...filing, severity });
    if (status === 'open') {
      return base;
    }
    const routed = routeDefect(base, { to: 'implement', taskId: 'T1' }, 'why');
    if (status === 'routed') {
      return routed;
    }
    const fixPending = recordFix(routed, { ref: 'r', summary: 's' });
    if (status === 'fix-pending') {
      return fixPending;
    }
    if (status === 'reopened') {
      return retestDefect(fixPending, { passed: false, detail: 'still broken' });
    }
    return retestDefect(fixPending, { passed: true, detail: 'holds' });
  };

  it('blocks on an open critical or high defect', () => {
    const open = [asDefect('critical', 'open'), asDefect('medium', 'open')];
    expect(blocksGate(open).map((defect) => defect.severity)).toEqual(['critical']);
  });

  it('does not block on a verified critical defect', () => {
    const verified = asDefect('critical', 'verified');
    expect(blocksGate([verified])).toEqual([]);
  });

  it('still blocks on a critical defect mid-round-trip (routed but not yet verified)', () => {
    const routed = asDefect('high', 'routed');
    expect(blocksGate([routed])).toEqual([routed]);
  });

  it('still blocks on a critical defect whose fix has not been retested yet', () => {
    const fixPending = asDefect('high', 'fix-pending');
    expect(blocksGate([fixPending])).toEqual([fixPending]);
  });

  it('still blocks on a critical defect reopened after a fix that did not hold', () => {
    const reopened = asDefect('high', 'reopened');
    expect(blocksGate([reopened])).toEqual([reopened]);
  });
});
