import { describe, expect, it } from 'vitest';
import type { Ballot } from '../playbook/definition.js';
import { tally, TallyError, type ApprovalTally, type ChoiceTally } from './tally.js';

const approval: Ballot = { type: 'approval', field: 'approve' };
const choice: Ballot = {
  type: 'choice',
  field: 'pick',
  options: ['event-sourced', 'crud', 'hybrid'],
};

const votes = (...values: unknown[]): (readonly [string, unknown])[] =>
  values.map((value, index) => [`judge-${String(index + 1)}`, value] as const);

describe('approval ballots', () => {
  it('carries on a majority', () => {
    const result = tally(
      approval,
      'majority',
      votes({ approve: true }, { approve: true }, { approve: false }),
    ) as ApprovalTally;

    expect(result.carried).toBe(true);
    expect(result.inFavour).toBe(2);
    expect(result.against).toBe(1);
    expect(result.summary).toContain('2/3 in favour');
  });

  it('does not carry on a tie', () => {
    const result = tally(
      approval,
      'majority',
      votes({ approve: true }, { approve: false }),
    ) as ApprovalTally;

    // Half is not a majority. A gate that opens on a split panel is a gate
    // that opens whenever one judge is having a good day.
    expect(result.carried).toBe(false);
  });

  it('counts abstentions in the denominator', () => {
    const result = tally(
      approval,
      'majority',
      votes({ approve: true }, { approve: true }, {}, {}, { note: 'no vote' }),
    ) as ApprovalTally;

    expect(result.abstained).toBe(3);
    expect(result.judges).toBe(5);
    // Two votes in favour out of five judges is not a majority, however few of
    // the others managed to answer.
    expect(result.carried).toBe(false);
  });

  it('treats a non-boolean vote as a spoiled ballot, never as assent', () => {
    const result = tally(
      approval,
      'unanimous',
      votes({ approve: 'yes' }, { approve: true }),
    ) as ApprovalTally;

    expect(result.carried).toBe(false);
    expect(result.ballots[0]).toMatchObject({ value: null });
    expect(result.ballots[0]?.spoiled).toMatch(/no boolean 'approve'/);
  });

  it('requires every judge for a unanimous rule', () => {
    const all = votes({ approve: true }, { approve: true }, { approve: true });
    expect((tally(approval, 'unanimous', all) as ApprovalTally).carried).toBe(true);

    const one = votes({ approve: true }, { approve: true }, { approve: false });
    expect((tally(approval, 'unanimous', one) as ApprovalTally).carried).toBe(false);
  });

  it('refuses to be counted by plurality', () => {
    expect(() => tally(approval, 'plurality', votes({ approve: true }))).toThrow(
      TallyError,
    );
  });
});

describe('choice ballots', () => {
  it('elects the option with the most votes', () => {
    const result = tally(
      choice,
      'plurality',
      votes({ pick: 'event-sourced' }, { pick: 'event-sourced' }, { pick: 'crud' }),
    ) as ChoiceTally;

    expect(result.winner).toBe('event-sourced');
    expect(result.carried).toBe(true);
    expect(result.counts).toStrictEqual({ 'event-sourced': 2, crud: 1, hybrid: 0 });
  });

  it('reports a tie as a tie rather than picking the first option', () => {
    const result = tally(
      choice,
      'plurality',
      votes({ pick: 'crud' }, { pick: 'event-sourced' }),
    ) as ChoiceTally;

    expect(result.tied).toBe(true);
    expect(result.winner).toBeNull();
    expect(result.carried).toBe(false);
    expect(result.summary).toContain('tied');
  });

  it('spoils a vote for an option that was not on the ballot', () => {
    const result = tally(
      choice,
      'plurality',
      votes({ pick: 'something else' }, { pick: 'crud' }, { pick: 'crud' }),
    ) as ChoiceTally;

    expect(result.abstained).toBe(1);
    expect(result.ballots[0]?.spoiled).toMatch(/not one of/);
    expect(result.winner).toBe('crud');
  });

  it('carries nothing when every ballot is spoiled', () => {
    const result = tally(choice, 'plurality', votes({}, {}, {})) as ChoiceTally;

    expect(result.winner).toBeNull();
    expect(result.carried).toBe(false);
    expect(result.summary).toContain('no valid ballots');
  });

  it('refuses a majority rule, which is undefined over more than two options', () => {
    expect(() => tally(choice, 'majority', votes({ pick: 'crud' }))).toThrow(
      /Use 'plurality'/,
    );
  });
});

describe('tally determinism', () => {
  it('is a pure function of the ballots, so replay recomputes it', () => {
    const cast = votes({ approve: true }, { approve: false }, { approve: true });
    const first = tally(approval, 'majority', cast);
    const second = tally(approval, 'majority', cast);

    expect(second).toStrictEqual(first);
  });
});
