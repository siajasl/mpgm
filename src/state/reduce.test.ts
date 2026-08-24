import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { kernelEvents, kernelRegistry } from '../event/catalog.js';
import type { EventInput, StoredEvent } from '../event/envelope.js';
import { MEMORY } from '../database.js';
import { EventLog } from '../event/store.js';
import { emptyState } from './kernel-state.js';
import { fold, reduce, UnhandledEventError, UnknownRunError } from './reduce.js';

const RUN = 'run-1';

function logWith(inputs: readonly EventInput[]): StoredEvent[] {
  const log = EventLog.open(MEMORY, {
    registry: kernelRegistry(),
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  try {
    log.appendMany(inputs);
    return log.read();
  } finally {
    log.close();
  }
}

const runStartedInput: EventInput = {
  runId: RUN,
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'operator' },
};

describe('reduce', () => {
  it('has a case for every event in the catalog', () => {
    // One valid instance of every catalog event, in dependency order. If a new
    // event type is added without a fixture here the coverage assertion fails;
    // if it is added without a reducer case the fold throws. Either way, state
    // cannot silently drift away from the log.
    const everyEvent: EventInput[] = [
      runStartedInput,
      { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
      {
        runId: RUN,
        type: 'TaskDispatched',
        payload: { taskId: 'T1', role: 'implementer', model: 'claude-opus-5' },
      },
      {
        runId: RUN,
        type: 'SessionUsage',
        payload: { taskId: 'T1', inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
      },
      {
        runId: RUN,
        type: 'ToolCallLogged',
        payload: {
          taskId: 'T1',
          tool: 'Bash',
          decision: 'allowed',
          detail: '',
          outputBlob: null,
        },
      },
      {
        runId: RUN,
        type: 'ValidationFailed',
        payload: { taskId: 'T1', attempt: 1, issues: ['nope'] },
      },
      {
        runId: RUN,
        type: 'BudgetExceeded',
        payload: { taskId: 'T1', kind: 'cost', limit: 1, observed: 2 },
      },
      { runId: RUN, type: 'TaskCompleted', payload: { taskId: 'T1', artifactRefs: [] } },
      {
        runId: RUN,
        type: 'ChecksReported',
        payload: {
          taskId: 'T1',
          ref: 'abc1234',
          mergeable: false,
          summary: 'failing: test',
          blocking: ['test: failing (test (node 24.x))'],
        },
      },
      {
        runId: RUN,
        type: 'ChangeReviewed',
        payload: {
          taskId: 'T1',
          reviewTaskId: 'T1-review',
          reviewerRole: 'code-reviewer',
          ref: 'abc1234',
          approved: true,
          summary: 'reads correctly and the tests can fail',
          findings: 1,
          deviations: ['CONV-6'],
          undeclaredDeviations: ['CONV-6'],
        },
      },
      {
        runId: RUN,
        type: 'ChangeMerged',
        payload: {
          taskId: 'T1',
          branch: 'mpgm/T1',
          into: 'main',
          commit: 'def5678',
          reviewTaskId: 'T1-review',
        },
      },
      {
        runId: RUN,
        type: 'DryRunRecorded',
        payload: {
          taskId: 'T1',
          tool: 'mcp__deploy__release',
          fingerprint: 'f1',
          summary: 'would replace 3 pods',
        },
      },
      {
        runId: RUN,
        type: 'DestructiveOpConfirmed',
        payload: {
          taskId: 'T1',
          tool: 'mcp__deploy__release',
          fingerprint: 'f1',
          by: 'operator',
          reason: 'the simulated effect is the intended one',
        },
      },
      {
        runId: RUN,
        type: 'KnowledgeBaseUpdated',
        payload: {
          taskId: 'T1',
          path: 'kb/conventions/testing.md',
          title: 'Testing conventions',
          rationale: 'the review found the convention undocumented',
        },
      },
      {
        runId: RUN,
        type: 'PlanRevised',
        payload: {
          fromVersion: 1,
          toVersion: 2,
          rationale: 'split T1.1.1 in two',
          deltas: [{ kind: 'task-split', at: 'T1.1.1' }],
        },
      },
      {
        runId: RUN,
        type: 'VoteTallied',
        payload: {
          taskId: 'p1-tally',
          node: 'p1',
          rule: 'majority',
          carried: true,
          summary: '2/3 in favour',
          ballots: [
            { judge: 'p1-judge-1', value: true },
            { judge: 'p1-judge-2', value: true },
            { judge: 'p1-judge-3', value: null },
          ],
        },
      },
      {
        runId: RUN,
        type: 'GatePresented',
        payload: { gateId: 'g1', phase: 'implement', artifactRefs: [] },
      },
      { runId: RUN, type: 'GateApproved', payload: { gateId: 'g1', by: 'operator' } },
      {
        runId: RUN,
        type: 'GateRejected',
        payload: { gateId: 'g1', by: 'operator', reason: 'no' },
      },
      { runId: RUN, type: 'GateInvalidated', payload: { gateId: 'g1', cause: 'reopen' } },
      {
        runId: RUN,
        type: 'PhaseReopened',
        payload: { phase: 'scope', reason: 'change' },
      },
      {
        runId: RUN,
        type: 'EffectIntended',
        payload: {
          intentId: 'i1',
          taskId: 'T1',
          contract: 'pm.github',
          operation: 'createPullRequest',
          params: { branch: 'dev-T1' },
        },
      },
      { runId: RUN, type: 'EffectCompleted', payload: { intentId: 'i1', outcome: 'ok' } },
      { runId: RUN, type: 'EffectFailed', payload: { intentId: 'i1', reason: 'retry' } },
      {
        runId: RUN,
        type: 'EffectEscalated',
        payload: { intentId: 'i1', reason: 'unknown outcome' },
      },
      {
        runId: RUN,
        type: 'OperatorIntervened',
        payload: { action: 'redirect', detail: '' },
      },
    ];

    const covered = new Set(everyEvent.map((event) => event.type));
    const catalogued = kernelEvents.map((definition) => definition.type);

    expect([...covered].sort()).toStrictEqual([...catalogued].sort());
    expect(() => fold(logWith(everyEvent))).not.toThrow();
  });

  it('throws on an event type it does not handle', () => {
    const rogue: StoredEvent = {
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      runId: RUN,
      type: 'NotInTheReducer',
      schemaVersion: 1,
      payload: {},
    };

    expect(() => reduce(emptyState, rogue)).toThrow(UnhandledEventError);
  });

  it('rejects events for a run that was never started', () => {
    const [first] = logWith([runStartedInput]);
    if (first === undefined) {
      throw new Error('expected RunStarted to be logged');
    }
    const orphan: StoredEvent = {
      ...first,
      runId: 'other',
      type: 'PhaseEntered',
      payload: { phase: 'x' },
    };

    expect(() => reduce(emptyState, orphan)).toThrow(UnknownRunError);
  });

  it('does not mutate the state it is given', () => {
    const events = logWith([runStartedInput]);
    const before = structuredClone(emptyState);

    fold(events);

    expect(emptyState).toStrictEqual(before);
  });

  it('is deterministic — the same events always fold to the same state', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('definition', 'scope', 'design'), { maxLength: 20 }),
        (phases) => {
          const events = logWith([
            runStartedInput,
            ...phases.map((phase) => ({
              runId: RUN,
              type: 'PhaseEntered',
              payload: { phase },
            })),
          ]);

          expect(fold(events)).toStrictEqual(fold(events));
        },
      ),
    );
  });

  it('folding in one pass equals folding in two halves', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (count) => {
        const events = logWith([
          runStartedInput,
          ...Array.from({ length: count }, () => ({
            runId: RUN,
            type: 'PhaseEntered',
            payload: { phase: 'definition' },
          })),
        ]);
        const split = Math.floor(events.length / 2);

        expect(fold(events)).toStrictEqual(
          fold(events.slice(split), fold(events.slice(0, split))),
        );
      }),
    );
  });

  it('tracks the lifecycle of a task through to completion', () => {
    const state = fold(
      logWith([
        runStartedInput,
        { runId: RUN, type: 'PhaseEntered', payload: { phase: 'implement' } },
        {
          runId: RUN,
          type: 'TaskDispatched',
          payload: { taskId: 'T1.1.3', role: 'implementer', model: 'claude-opus-5' },
        },
        {
          runId: RUN,
          type: 'SessionUsage',
          payload: { taskId: 'T1.1.3', inputTokens: 100, outputTokens: 50, costUsd: 0.5 },
        },
        {
          runId: RUN,
          type: 'ToolCallLogged',
          payload: {
            taskId: 'T1.1.3',
            tool: 'Bash',
            decision: 'denied',
            detail: 'rm -rf',
            outputBlob: null,
          },
        },
        {
          runId: RUN,
          type: 'ValidationFailed',
          payload: { taskId: 'T1.1.3', attempt: 1, issues: ['bad shape'] },
        },
        {
          runId: RUN,
          type: 'TaskCompleted',
          payload: {
            taskId: 'T1.1.3',
            artifactRefs: [{ path: 'artifacts/a.md', commit: 'abc123' }],
          },
        },
      ]),
    );

    const task = state.runs[RUN]?.tasks['T1.1.3'];

    expect(task?.status).toBe('completed');
    expect(task?.model).toBe('claude-opus-5');
    expect(task?.deniedToolCalls).toBe(1);
    expect(task?.validationFailures).toBe(1);
    expect(task?.artifactRefs).toStrictEqual([
      { path: 'artifacts/a.md', commit: 'abc123' },
    ]);
    expect(state.runs[RUN]?.usage).toStrictEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.5,
    });
  });

  it('records gate decisions with who made them', () => {
    const state = fold(
      logWith([
        runStartedInput,
        {
          runId: RUN,
          type: 'GatePresented',
          payload: { gateId: 'g1', phase: 'definition', artifactRefs: [] },
        },
        { runId: RUN, type: 'GateApproved', payload: { gateId: 'g1', by: 'operator' } },
      ]),
    );

    expect(state.runs[RUN]?.gates.g1).toMatchObject({
      status: 'approved',
      decidedBy: 'operator',
    });
  });

  it('marks a task blocked when its budget is exceeded', () => {
    const state = fold(
      logWith([
        runStartedInput,
        {
          runId: RUN,
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: RUN,
          type: 'BudgetExceeded',
          payload: { taskId: 'T1', kind: 'tokens', limit: 100, observed: 250 },
        },
      ]),
    );

    expect(state.runs[RUN]?.tasks.T1?.status).toBe('blocked');
  });
});
