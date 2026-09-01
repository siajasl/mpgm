import { describe, expect, it } from 'vitest';
import { reviewPrompt, type ImplementTask } from './loop.js';

const TASK: ImplementTask = {
  id: 'T3.2.6',
  title: 'Sample service as a deployable web service',
  completionCriteria: ['The service builds and its tests are green in its own repo.'],
  tracesTo: ['IMP-1', 'IMP-2'],
  milestone: 'M3.2',
};

const first = reviewPrompt(TASK, 'abc123', 'main');
const later = reviewPrompt(TASK, 'def456', 'main', true);

describe('what every review is told', () => {
  it('names the task, what it had to satisfy, and the commit to review', () => {
    for (const prompt of [first, later]) {
      expect(prompt).toContain('T3.2.6');
      expect(prompt).toContain('The service builds and its tests are green');
      expect(prompt).toContain('git diff main...');
    }
    expect(first).toContain('abc123');
    expect(later).toContain('def456');
  });

  it('binds the approval to the commit, so a moved change is reviewed again', () => {
    for (const prompt of [first, later]) {
      expect(prompt).toMatch(/travels no\s+further/);
    }
  });
});

describe('whose the branch’s commit structure is', () => {
  it('says nothing when the loop did not make the extra commits', () => {
    // An author who split a fresh change into three commits made that choice
    // themselves. Excusing it would throw away a real finding, so the prompt
    // claims nothing unless the loop is the reason.
    expect(first).not.toContain('one commit per review round');
    expect(first).not.toContain('came back from review');
  });

  it('covers rework inherited from an earlier run of the task', () => {
    // The first version of this keyed on the round number, which missed a
    // reused checkout: its *first* round already carries an earlier run's
    // rework commits. T3.2.6's re-run hit exactly that, and its first review
    // reported the departure again.
    expect(later).toContain('including rounds from an earlier');
    expect(later).toMatch(/picked up where it left off/);
  });

  it('tells a review whose commits they are', () => {
    // T3.2.6's third review approved the change and refused it anyway, over a
    // one-commit-per-change convention it saw broken by the four commits the
    // loop had itself made — on the last attempt, so the author never got the
    // chance to declare a departure it had not made.
    expect(later).toContain('one commit per review round');
    expect(later).toMatch(/loop's doing\s+rather than the author's/);
    expect(later).toMatch(/do not report the number of commits as a departure/);
  });

  it('still holds the author to what each commit says', () => {
    // Only the *count* is the loop's. A convention about commit messages has
    // a second half — that the body explains why — and that half is the
    // author's on every commit, rework ones included. Excusing the whole
    // convention would lose it.
    expect(later).toMatch(/What each commit \*says\* is still the author's/);
    expect(later).toMatch(/does not explain why it changed what it did is a finding/);
  });

  it('names no convention, because the reviewed project may have none', () => {
    // `loop.ts` is harness code; conventions live in a project's knowledge
    // base, and library-loans has no CONV-1 of its own. Asserted as "no
    // convention-shaped id appears at all" rather than "CONV-1 is absent",
    // which would pass however the text were written, since this function is
    // given no conventions to name.
    for (const prompt of [first, later]) {
      expect(prompt).not.toMatch(/\b[A-Z][A-Z0-9]*-\d+\b/);
    }
  });
});
