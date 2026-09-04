import { describe, expect, it } from 'vitest';
import {
  earnsAnotherRound,
  markShown,
  renderLateDeviation,
  unseenDeviations,
  type LateDeviationInput,
} from './late-deviation.js';
import type { MergeDecision } from './merge.js';

function refused(...refusals: MergeDecision['refusals']): MergeDecision {
  return { allowed: false, refusals, reasons: refusals.map(String) };
}

function input(overrides: Partial<LateDeviationInput> = {}): LateDeviationInput {
  return {
    decision: refused('undeclared-deviation'),
    approved: true,
    undeclared: ['CONV-1 (one logical change per commit)'],
    shown: new Set<string>(),
    ...overrides,
  };
}

describe('when a late deviation earns another round', () => {
  it('grants one when an approved change is refused only for a deviation never shown', () => {
    // T4.1.6 exactly: the reviewer approved, called its remaining points minor,
    // and the gate refused over a CONV-1 that first appeared in round three.
    expect(earnsAnotherRound(input())).toBe(true);
  });

  it('matches a deviation by its convention id, however the reviewer phrased it', () => {
    // One round reports 'CONV-1', the next 'CONV-1 (one logical change per
    // commit)'. Comparing the strings would call the second one new.
    expect(earnsAnotherRound(input({ shown: new Set(['CONV-1']) }))).toBe(false);
  });
});

describe('when it does not', () => {
  it('refuses when the reviewer still wants the change altered', () => {
    // The author has work to do, and work is what the attempt budget bounds.
    expect(earnsAnotherRound(input({ approved: false }))).toBe(false);
  });

  it('refuses when the author was already shown it and stayed silent', () => {
    // Silence is an answer. The grace is for what nobody said, not what was
    // ignored.
    expect(earnsAnotherRound(input({ shown: new Set(['CONV-1']) }))).toBe(false);
  });

  it('refuses when anything else is also holding the merge', () => {
    // Another round does not fix a stale verdict or a reviewer sharing the
    // author's role, so granting one would spend an attempt on nothing.
    expect(
      earnsAnotherRound(
        input({ decision: refused('undeclared-deviation', 'review-is-stale') }),
      ),
    ).toBe(false);
    expect(earnsAnotherRound(input({ decision: refused('changes-requested') }))).toBe(
      false,
    );
  });

  it('refuses when the merge was allowed, or refused for no stated reason', () => {
    expect(
      earnsAnotherRound(
        input({ decision: { allowed: true, refusals: [], reasons: [] } }),
      ),
    ).toBe(false);
    expect(earnsAnotherRound(input({ decision: refused() }))).toBe(false);
  });

  it('refuses when there is no undeclared deviation at all', () => {
    expect(earnsAnotherRound(input({ undeclared: [] }))).toBe(false);
  });
});

describe('what counts as unseen', () => {
  it('keeps only what no earlier round put in front of the author', () => {
    const shown = new Set(['CONV-1']);
    expect(unseenDeviations(['CONV-1 (commits)', 'CONV-6 (tests)'], shown)).toStrictEqual(
      ['CONV-6 (tests)'],
    );
  });

  it('records by id, so the next round recognises a reworded report', () => {
    const shown = new Set<string>();
    markShown(shown, ['CONV-1 (one logical change per commit)']);
    expect(shown.has('CONV-1')).toBe(true);
    expect(unseenDeviations(['CONV-1 — commits'], shown)).toStrictEqual([]);
  });

  it('falls back to the whole entry when it names no convention id', () => {
    const shown = new Set<string>();
    markShown(shown, ['the house style about blank lines']);
    expect(unseenDeviations(['the house style about blank lines'], shown)).toStrictEqual(
      [],
    );
    expect(unseenDeviations(['something else entirely'], shown)).toHaveLength(1);
  });
});

describe('what the author is told', () => {
  const rendered = renderLateDeviation(['CONV-1 (one logical change per commit)']);

  it('names the deviation and says why the round exists', () => {
    expect(rendered).toContain('CONV-1 (one logical change per commit)');
    expect(rendered).toMatch(/never given the chance to declare it/);
  });

  it('says declaring is a legitimate answer, not a way out', () => {
    expect(rendered).toMatch(/Declare the deviation if you\s+stand behind it/);
    expect(rendered).toContain('IMP-4');
  });

  it('forbids using the round to improve anything else', () => {
    // A round granted to close the task is not one to reopen it with: every
    // line added is a line the next review has to look at.
    expect(rendered).toMatch(/Do not take this round as an invitation/);
    expect(rendered).toMatch(/not one to reopen it with/);
  });

  it('names no convention the caller did not give it', () => {
    // Harness code; conventions live in a project's knowledge base. Asserted as
    // "every id present was passed in" rather than "CONV-6 is absent", which
    // would pass however the text were written.
    const mentioned = new Set(rendered.match(/\bCONV-[0-9]+\b/g) ?? []);
    expect([...mentioned]).toStrictEqual(['CONV-1']);
  });
});
