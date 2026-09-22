import { describe, expect, it } from 'vitest';
import {
  earnsDeclarationRound,
  renderDeclarationRound,
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
    ...overrides,
  };
}

describe('when a round should ask for a declaration rather than for rework', () => {
  it('asks when an approved change is refused only for a declaration', () => {
    // T4.1.6 and T4.1.4b both: the reviewer approved and the gate refused over
    // a convention the author's result did not name.
    expect(earnsDeclarationRound(input())).toBe(true);
  });

  it('asks even for a deviation an earlier round already put to the author', () => {
    // The condition this replaces read a re-report as the author ignoring it.
    // T4.1.4b's round-three session did what the rework prompt asks first and
    // fixed the departure; the reviewer approved and reported it anyway, since
    // it reports what it finds and is not told what was declared. Nothing in
    // the loop can tell a fix apart from silence, so it must not try.
    expect(earnsDeclarationRound(input())).toBe(true);
  });

  it('does not ask when the reviewer still wants the change altered', () => {
    // A reviewer asking for changes has given the author work, and work is
    // what the review budget bounds.
    expect(earnsDeclarationRound(input({ approved: false }))).toBe(false);
  });

  it('does not ask when anything but a declaration is also refusing', () => {
    // A stale verdict or a reviewer sharing the author's role is not something
    // a declaration fixes, so a round spent asking for one is a round wasted.
    expect(
      earnsDeclarationRound(
        input({ decision: refused('undeclared-deviation', 'checks-are-stale') }),
      ),
    ).toBe(false);
    expect(earnsDeclarationRound(input({ decision: refused('changes-requested') }))).toBe(
      false,
    );
  });

  it('does not ask when nothing was refused at all', () => {
    // Fails closed on a decision that refuses with an empty list: an approval
    // with no refusals has no declaration to ask for.
    expect(earnsDeclarationRound(input({ decision: refused() }))).toBe(false);
  });

  it('does not ask about a change the gate already allows', () => {
    expect(
      earnsDeclarationRound(
        input({ decision: { allowed: true, refusals: [], reasons: [] } }),
      ),
    ).toBe(false);
  });
});

describe('what the author is told', () => {
  const rendered = renderDeclarationRound(['CONV-1 (one logical change per commit)']);

  it('names the deviation and says the change is otherwise ready', () => {
    expect(rendered).toContain('CONV-1 (one logical change per commit)');
    expect(rendered).toMatch(/reviewer approved this change/);
  });

  it('names the field, and what does not count as declaring', () => {
    // Four runs of T4.1.4b put the argument in a design document, a contract
    // and a refusal message, and never in the field the merge reads.
    expect(rendered).toContain('`deviations` field');
    expect(rendered).toContain('`convention`');
    expect(rendered).toContain('`why`');
    expect(rendered).toMatch(/commit message is not a\s+declaration/);
    expect(rendered).toMatch(/design document/);
  });

  it('says a fix does not stop the reviewer reporting the departure', () => {
    // The belief that it does is what wasted this round in T4.1.4b: an author
    // that has just fixed something has every reason to think it is answered.
    expect(rendered).toMatch(/already fixed the departure/);
    expect(rendered).toMatch(/declare it anyway/);
    expect(rendered).toMatch(/not told what you declared/);
  });

  it('forbids using the round to improve anything else', () => {
    // A round granted to close the task is not one to reopen it with: every
    // line added is a line the next review has to look at.
    expect(rendered).toMatch(/Do not take this round as an invitation/);
    expect(rendered).toMatch(/not one to reopen it\s+with/);
  });

  it('names no convention the caller did not give it', () => {
    // Harness code; conventions live in a project's knowledge base. Asserted as
    // "every id present was passed in" rather than "CONV-6 is absent", which
    // would pass however the text were written.
    const mentioned = new Set(rendered.match(/\bCONV-[0-9]+\b/g) ?? []);
    expect([...mentioned]).toStrictEqual(['CONV-1']);
  });
});
