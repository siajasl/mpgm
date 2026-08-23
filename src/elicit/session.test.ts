import { describe, expect, it } from 'vitest';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
} from '../agent/session.js';
import { scriptedSuccess } from '../agent/scripted-provider.js';
import { parseRole } from '../role/loader.js';
import { ScriptedIo } from './io.js';
import {
  conclusionsSchema,
  elicit,
  ElicitationError,
  elicitationTurnSchema,
} from './session.js';

const role = parseRole(
  'elicitor.md',
  [
    '---',
    'name: elicitor',
    'description: Runs the operator elicitation dialogue.',
    'model: claude-sonnet-5',
    'tools: { allow: [] }',
    'budgets: { tokens: 100000, costUsd: 2, steps: 6, wallClockSeconds: 600 }',
    'output: { schema: elicitation.turn }',
    '---',
    'You elicit project intent from the operator.',
  ].join('\n'),
);

const conclusions = {
  problem: 'Loans are tracked on paper and get lost.',
  goals: ['Digitise loan records'],
  nonGoals: ['Replace the catalogue system'],
  stakeholders: ['Librarians', 'Members'],
  constraints: ['Must run on the existing intranet'],
  assumptions: ['Member records already exist'],
  successMetrics: ['No lost loan records over a term'],
};

/** Replays scripted turns and records the prompts it was given. */
class TurnProvider implements AgentSessionProvider {
  readonly prompts: string[] = [];
  readonly #turns: unknown[];

  constructor(turns: readonly unknown[]) {
    this.#turns = [...turns];
  }

  run(request: SessionRequest): Promise<SessionResult> {
    this.prompts.push(request.prompt);
    const next = this.#turns.shift();
    if (next === undefined) {
      throw new Error('TurnProvider ran out of turns');
    }
    return Promise.resolve(scriptedSuccess(next));
  }
}

describe('elicitation dialogue', () => {
  it('asks questions until it has conclusions', async () => {
    const provider = new TurnProvider([
      {
        kind: 'question',
        question: 'What problem are you solving?',
        rationale: 'Scope.',
      },
      { kind: 'question', question: 'Who uses it?', rationale: '' },
      { kind: 'conclusions', conclusions },
    ]);
    const io = new ScriptedIo(['Loans get lost.', 'Librarians and members.']);

    const result = await elicit({ provider, role, io });

    expect(result.conclusions).toStrictEqual(conclusions);
    expect(result.turns).toBe(3);
    expect(io.asked.map((entry) => entry.question)).toStrictEqual([
      'What problem are you solving?',
      'Who uses it?',
    ]);
    expect(result.transcript).toStrictEqual([
      { question: 'What problem are you solving?', answer: 'Loans get lost.' },
      { question: 'Who uses it?', answer: 'Librarians and members.' },
    ]);
  });

  it('feeds the dialogue so far into each turn', async () => {
    const provider = new TurnProvider([
      { kind: 'question', question: 'What problem?', rationale: '' },
      { kind: 'conclusions', conclusions },
    ]);

    await elicit({
      provider,
      role,
      io: new ScriptedIo(['Loans get lost.']),
      brief: 'A library tool.',
    });

    expect(provider.prompts[0]).toContain('A library tool.');
    expect(provider.prompts[0]).toContain('(nothing asked yet)');
    // The second turn sees the operator's answer.
    expect(provider.prompts[1]).toContain('Q: What problem?');
    expect(provider.prompts[1]).toContain('A: Loans get lost.');
  });

  it('shows the operator why a question is being asked', async () => {
    const provider = new TurnProvider([
      {
        kind: 'question',
        question: 'Any deadline?',
        rationale: 'Constraints shape scope.',
      },
      { kind: 'conclusions', conclusions },
    ]);
    const io = new ScriptedIo(['End of term.']);

    await elicit({ provider, role, io });

    expect(io.asked[0]?.rationale).toBe('Constraints shape scope.');
  });

  it('presses for conclusions once the question limit is reached', async () => {
    const provider = new TurnProvider([
      { kind: 'question', question: 'One?', rationale: '' },
      { kind: 'conclusions', conclusions },
    ]);

    await elicit({ provider, role, io: new ScriptedIo(['yes']), maxQuestions: 1 });

    expect(provider.prompts[1]).toContain('You have reached the question limit');
  });

  it('stops rather than looping forever when it will not converge', async () => {
    const question = { kind: 'question', question: 'Again?', rationale: '' };
    const provider = new TurnProvider([question, question, question]);

    await expect(
      elicit({
        provider,
        role,
        io: new ScriptedIo(['a', 'b', 'c']),
        maxQuestions: 2,
      }),
    ).rejects.toThrow(/did not converge within 2 questions/);
  });

  it('rejects a turn that is neither a question nor conclusions', async () => {
    const provider = new TurnProvider([{ kind: 'musing', thought: 'hmm' }]);

    await expect(elicit({ provider, role, io: new ScriptedIo([]) })).rejects.toThrow(
      ElicitationError,
    );
  });

  it('rejects conclusions missing a required field', async () => {
    const { successMetrics: _dropped, ...incomplete } = conclusions;
    const provider = new TurnProvider([{ kind: 'conclusions', conclusions: incomplete }]);

    await expect(elicit({ provider, role, io: new ScriptedIo([]) })).rejects.toThrow(
      /successMetrics/,
    );
  });

  it('surfaces a session that did not complete', async () => {
    const failing: AgentSessionProvider = {
      run: () =>
        Promise.resolve(
          scriptedSuccess(undefined, {
            termination: 'budget_exceeded',
            errorMessage: 'spent',
          }),
        ),
    };

    await expect(
      elicit({ provider: failing, role, io: new ScriptedIo([]) }),
    ).rejects.toThrow(/budget_exceeded/);
  });

  it('rejects a nonsensical question limit', async () => {
    await expect(
      elicit({
        provider: new TurnProvider([]),
        role,
        io: new ScriptedIo([]),
        maxQuestions: 0,
      }),
    ).rejects.toThrow(/at least 1/);
  });
});

describe('schemas', () => {
  it('covers every DEF-1 field', () => {
    expect(Object.keys(conclusionsSchema.shape).sort()).toStrictEqual([
      'assumptions',
      'constraints',
      'goals',
      'nonGoals',
      'problem',
      'stakeholders',
      'successMetrics',
    ]);
  });

  it('discriminates on kind, so a shapeless result cannot pass', () => {
    expect(elicitationTurnSchema.safeParse({ question: 'no kind' }).success).toBe(false);
  });
});
