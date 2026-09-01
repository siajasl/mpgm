import { describe, expect, it } from 'vitest';
import { implementPrompt, type ImplementTask } from './loop.js';

const TASK: ImplementTask = {
  id: 'T4.1.1',
  title: 'env.provision contract and IaC for test and staging',
  completionCriteria: ['An environment comes up and down from repository config alone.'],
  tracesTo: ['DEP-1', 'DEP-4'],
  milestone: 'M4.1',
};

const fresh = implementPrompt(TASK, 'mpgm/T4.1.1');
const staged = implementPrompt(TASK, 'mpgm/T4.1.1', { commits: 0, uncommitted: true });
const committed = implementPrompt(TASK, 'mpgm/T4.1.1', {
  commits: 3,
  uncommitted: false,
});

describe('what every implementer is told', () => {
  it('names the task, its criteria and the branch to commit on', () => {
    for (const prompt of [fresh, staged, committed]) {
      expect(prompt).toContain('T4.1.1');
      expect(prompt).toContain('An environment comes up and down');
      expect(prompt).toContain('mpgm/T4.1.1');
      expect(prompt).toContain('DEP-1, DEP-4');
    }
  });

  it('asks for the ending commit and an honest completeness flag', () => {
    for (const prompt of [fresh, staged, committed]) {
      expect(prompt).toMatch(/Report the commit you ended at in `ref`/);
      expect(prompt).toMatch(/set `complete` honestly/);
    }
  });
});

describe('a checkout handed over mid-task', () => {
  it('says nothing to a session starting from an empty one', () => {
    // Nothing to describe, and describing it would send an agent looking for
    // work that is not there.
    expect(fresh).not.toContain('This checkout is not empty');
    expect(
      implementPrompt(TASK, 'mpgm/T4.1.1', { commits: 0, uncommitted: false }),
    ).not.toContain('This checkout is not empty');
  });

  it('describes uncommitted work, which is what T4.1.1 actually left', () => {
    // The session ran out of turns with every file written and staged and none
    // committed. A replacement told only "implement this" finds a tree full of
    // changes it did not make and no account of where they came from.
    expect(staged).toContain('This checkout is not empty');
    expect(staged).toContain('changes written but not committed');
    expect(staged).not.toContain('commit(s) on the branch');
  });

  it('describes commits already made, and does not invent uncommitted ones', () => {
    expect(committed).toContain('3 commit(s) on the branch already');
    expect(committed).not.toContain('changes written but not committed');
  });

  it('describes both when both are there', () => {
    const both = implementPrompt(TASK, 'mpgm/T4.1.1', {
      commits: 2,
      uncommitted: true,
    });

    expect(both).toContain('2 commit(s) on the branch already');
    expect(both).toContain('changes written but not committed');
    expect(both).toMatch(/already, and changes written/);
  });

  it('tells it to read before writing, and not to start again', () => {
    // The failure mode this exists to prevent: re-deriving work the task has
    // already been paid for.
    expect(staged).toMatch(/Read what is there before you write anything/);
    expect(staged).toMatch(/starting again spends\s+that twice/);
  });

  it('does not turn inherited work into something to be rubber-stamped', () => {
    // "Do not discard it" must not read as "commit it unexamined". What gets
    // committed is reviewed and has to pass CI, so leaving something broken in
    // place costs a round rather than saving one.
    expect(staged).toMatch(/It may be finished, nearly\s+finished, or wrong/);
    expect(staged).toMatch(/Committing is not agreeing/);
    expect(staged).toMatch(/fix what is wrong, finish what is unfinished/);
  });
});
