import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../contract/capability.js';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import type { EventInput } from '../event/envelope.js';
import { EventLog } from '../event/store.js';
import { planSchema } from '../schemas.js';
import { fold } from '../state/reduce.js';
import type { RunState } from '../state/kernel-state.js';
import {
  columnFor,
  desiredProjection,
  TASK_COLUMNS,
  taskIdFromBody,
  taskMarker,
} from './projection.js';
import { githubPmProvider, observeBoard } from './github-provider.js';
import { PmProjector } from './projector.js';
import {
  applyOperations,
  EMPTY_PROJECTION,
  pmGithubContract,
  reconcile,
  type ObservedProjection,
  type PmOperation,
} from './reconcile.js';

const PLAN = planSchema.parse({
  summary: 'Build the loan service.',
  risks: [{ id: 'R1', assumption: 'Members will use it.', validatedBy: ['M1.1'] }],
  phases: [
    {
      id: 'P1',
      title: 'Walking skeleton',
      intent: 'One loan, end to end.',
      milestones: [
        {
          id: 'M1.1',
          title: 'Record a loan',
          verification: 'A loan is recorded and shown back.',
          validatesRisk: 'R1',
          tasks: [
            {
              id: 'T1.1.1',
              title: 'Loan store',
              completionCriteria: ['a loan round-trips'],
              dependsOn: [],
              tracesTo: ['LOAN-1'],
            },
            {
              id: 'T1.1.2',
              title: 'Loan view',
              completionCriteria: ['a member sees their loans'],
              dependsOn: ['T1.1.1'],
              tracesTo: ['LOAN-2'],
            },
          ],
        },
      ],
    },
  ],
});

const RUN = 'run-1';

function runState(events: readonly EventInput[]): RunState {
  const log = EventLog.open(MEMORY, { registry: kernelRegistry() });
  try {
    log.appendMany([
      { runId: RUN, type: 'RunStarted', payload: { project: 'loans', operator: 'o' } },
      ...events,
    ]);
    const state = fold(log.read()).runs[RUN];
    if (state === undefined) {
      throw new Error('no run state');
    }
    return state;
  } finally {
    log.close();
  }
}

const dispatch = (taskId: string, role = 'implementer'): EventInput => ({
  runId: RUN,
  type: 'TaskDispatched',
  payload: { taskId, role, model: 'claude-sonnet-5' },
});

describe('desiredProjection', () => {
  it('derives labels, milestones and one issue per plan task', () => {
    const desired = desiredProjection(PLAN);

    expect(desired.labels.map((entry) => entry.name)).toEqual([
      'type:task',
      'phase:P1',
      'milestone:M1.1',
    ]);
    expect(desired.milestones).toEqual([
      {
        title: 'M1.1 — Record a loan',
        description: 'A loan is recorded and shown back. (validates R1)',
      },
    ]);
    expect(desired.issues.map((issue) => issue.key)).toEqual(['T1.1.1', 'T1.1.2']);
  });

  it('marks each issue with its task id, which is what makes it findable', () => {
    const [issue] = desiredProjection(PLAN).issues;

    expect(taskIdFromBody(issue?.body ?? '')).toBe('T1.1.1');
  });

  it('starts a task with unmet dependencies in backlog and the rest ready', () => {
    const desired = desiredProjection(PLAN);

    expect(desired.issues.map((issue) => issue.column)).toEqual(['ready', 'backlog']);
  });

  it('labels a task with the role it was dispatched to, once one exists', () => {
    const desired = desiredProjection(PLAN, {
      run: runState([dispatch('T1.1.1', 'loan-implementer')]),
    });

    expect(desired.labels.map((entry) => entry.name)).toContain('role:loan-implementer');
    expect(desired.issues[0]?.labels).toContain('role:loan-implementer');
    // The task nobody dispatched carries no role label rather than a guess.
    expect(desired.issues[1]?.labels.some((name) => name.startsWith('role:'))).toBe(
      false,
    );
  });
});

describe('columnFor', () => {
  const completed = new Set(['T1.1.1']);

  it('follows task state through the loop', () => {
    expect(columnFor('T9', [], undefined, completed)).toBe('ready');
    expect(columnFor('T9', ['T0'], undefined, completed)).toBe('backlog');
    expect(columnFor('T1.1.1', [], runState([dispatch('T1.1.1')]), completed)).toBe(
      'in-progress',
    );
  });

  it('is blocked when the task is blocked', () => {
    const run = runState([
      dispatch('T1.1.1'),
      {
        runId: RUN,
        type: 'BudgetExceeded',
        payload: { taskId: 'T1.1.1', kind: 'repairs', limit: 3, observed: 3 },
      },
    ]);

    expect(columnFor('T1.1.1', [], run, completed)).toBe('blocked');
  });

  // The one wrong answer that matters: a completed session whose change is
  // still in review is not done.
  it('does not call a change done until it has merged', () => {
    const reviewed = runState([
      dispatch('T1.1.1'),
      {
        runId: RUN,
        type: 'ChecksReported',
        payload: { taskId: 'T1.1.1', ref: 'abc', mergeable: true, summary: 'green' },
      },
      {
        runId: RUN,
        type: 'TaskCompleted',
        payload: { taskId: 'T1.1.1', artifactRefs: [] },
      },
    ]);
    expect(columnFor('T1.1.1', [], reviewed, completed)).toBe('in-review');

    const merged = runState([
      dispatch('T1.1.1'),
      {
        runId: RUN,
        type: 'ChecksReported',
        payload: { taskId: 'T1.1.1', ref: 'abc', mergeable: true, summary: 'green' },
      },
      {
        runId: RUN,
        type: 'TaskCompleted',
        payload: { taskId: 'T1.1.1', artifactRefs: [] },
      },
      {
        runId: RUN,
        type: 'ChangeMerged',
        payload: {
          taskId: 'T1.1.1',
          branch: 'mpgm/T1.1.1',
          into: 'main',
          commit: 'def',
          reviewTaskId: 'T1.1.1-review',
        },
      },
    ]);
    expect(columnFor('T1.1.1', [], merged, completed)).toBe('done');
  });

  it('calls a task with no implement loop done when it completes', () => {
    const run = runState([
      dispatch('T1.1.1', 'analyst'),
      {
        runId: RUN,
        type: 'TaskCompleted',
        payload: { taskId: 'T1.1.1', artifactRefs: [] },
      },
    ]);

    expect(columnFor('T1.1.1', [], run, completed)).toBe('done');
  });
});

describe('reconcile (PMG-4)', () => {
  let next = 100;
  const numbers = () => (next += 1);

  function bootstrap(observed: ObservedProjection = EMPTY_PROJECTION, run?: RunState) {
    const desired = desiredProjection(PLAN, run === undefined ? {} : { run });
    const operations = reconcile(desired, observed);
    return { operations, board: applyOperations(observed, operations, numbers) };
  }

  it('bootstraps a greenfield repository', () => {
    const { operations } = bootstrap();

    expect(
      operations.filter((operation) => operation.kind === 'create-board'),
    ).toHaveLength(1);
    expect(
      operations.filter((operation) => operation.kind === 'create-label'),
    ).toHaveLength(3);
    expect(
      operations.filter((operation) => operation.kind === 'create-milestone'),
    ).toHaveLength(1);
    expect(
      operations.filter((operation) => operation.kind === 'create-issue'),
    ).toHaveLength(2);
  });

  // The T3.1.7 completion criterion: re-bootstrap converges without duplicates.
  it('does nothing at all the second time', () => {
    const { board } = bootstrap();

    expect(reconcile(desiredProjection(PLAN), board)).toEqual([]);
    expect(board.issues).toHaveLength(2);
  });

  it('converges even after being run three times over', () => {
    let board = bootstrap().board;
    board = bootstrap(board).board;
    board = bootstrap(board).board;

    expect(board.issues.map((issue) => issue.key)).toEqual(['T1.1.1', 'T1.1.2']);
    expect(reconcile(desiredProjection(PLAN), board)).toEqual([]);
  });

  // The other completion criterion: a task state change is reflected.
  it('moves an issue when the task starts', () => {
    const { board } = bootstrap();
    const run = runState([dispatch('T1.1.1')]);

    const operations = reconcile(desiredProjection(PLAN, { run }), board);
    const move = operations.find((operation) => operation.kind === 'move-issue');

    expect(move).toMatchObject({ key: 'T1.1.1', from: 'ready', to: 'in-progress' });
    expect(applyOperations(board, operations, numbers).issues[0]?.column).toBe(
      'in-progress',
    );
  });

  it('closes the issue when the change merges, and reopens nothing after', () => {
    let board = bootstrap().board;
    const run = runState([
      dispatch('T1.1.1'),
      {
        runId: RUN,
        type: 'TaskCompleted',
        payload: { taskId: 'T1.1.1', artifactRefs: [] },
      },
      {
        runId: RUN,
        type: 'ChangeMerged',
        payload: {
          taskId: 'T1.1.1',
          branch: 'mpgm/T1.1.1',
          into: 'main',
          commit: 'abc',
          reviewTaskId: 'r',
        },
      },
    ]);

    board = applyOperations(
      board,
      reconcile(desiredProjection(PLAN, { run }), board),
      numbers,
    );

    expect(board.issues[0]).toMatchObject({ column: 'done', state: 'closed' });
    // T1.1.2 becomes ready now its dependency is complete.
    expect(board.issues[1]?.column).toBe('ready');
    expect(reconcile(desiredProjection(PLAN, { run }), board)).toEqual([]);
  });

  it('repairs an external edit rather than duplicating around it (PMG-3)', () => {
    const { board } = bootstrap();
    const tampered: ObservedProjection = {
      ...board,
      issues: board.issues.map((issue) =>
        issue.key === 'T1.1.1'
          ? { ...issue, title: 'someone renamed this', labels: ['wontfix'] }
          : issue,
      ),
    };

    const operations = reconcile(desiredProjection(PLAN), tampered);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: 'update-issue',
      key: 'T1.1.1',
      // The existing issue is updated, not replaced by a second one.
      number: board.issues[0]?.number,
    });
    expect(
      reconcile(desiredProjection(PLAN), applyOperations(tampered, operations, numbers)),
    ).toEqual([]);
  });

  it('leaves issues the plan does not mention alone', () => {
    const { board } = bootstrap();
    const withStranger: ObservedProjection = {
      ...board,
      issues: [
        ...board.issues,
        {
          key: 'SOMEBODY-ELSE',
          number: 999,
          title: 'a human opened this',
          body: '',
          labels: [],
          milestone: '',
          column: 'backlog',
          state: 'open',
        },
      ],
    };

    expect(reconcile(desiredProjection(PLAN), withStranger)).toEqual([]);
  });
});

describe('PmProjector through the contract', () => {
  /** An in-memory board standing in for GitHub. */
  function provider(board: { current: ObservedProjection }) {
    let next = 200;
    return {
      observe: () => Promise.resolve(board.current),
      apply: (input: never) => {
        const { operations } = input as { operations: PmOperation[] };
        board.current = applyOperations(board.current, operations, () => (next += 1));
        return Promise.resolve({ applied: operations.length, issues: {} });
      },
    };
  }

  function projector(board: { current: ObservedProjection }) {
    const registry = new CapabilityRegistry();
    return new PmProjector({
      contract: registry.bind(pmGithubContract, provider(board)),
      repo: 'siajasl/loans',
    });
  }

  it('bootstraps, then reports convergence without writing again', async () => {
    const board = { current: EMPTY_PROJECTION };
    const subject = projector(board);

    const first = await subject.sync(PLAN);
    expect(first.converged).toBe(false);
    expect(first.applied).toBe(first.operations.length);
    expect(board.current.issues).toHaveLength(2);

    const second = await subject.sync(PLAN);
    expect(second.converged).toBe(true);
    expect(second.applied).toBe(0);
    expect(board.current.issues).toHaveLength(2);
  });

  it('reflects a task state change on the next sync', async () => {
    const board = { current: EMPTY_PROJECTION };
    const subject = projector(board);
    await subject.sync(PLAN);

    await subject.sync(PLAN, runState([dispatch('T1.1.1')]));

    expect(board.current.issues[0]).toMatchObject({
      key: 'T1.1.1',
      column: 'in-progress',
    });
  });

  it('refuses to link a pull request to a task with no issue', async () => {
    const board = { current: EMPTY_PROJECTION };

    await expect(projector(board).linkPullRequest('T9.9.9', 42)).rejects.toThrow(
      /no issue on the board/,
    );
  });

  it('links a pull request once the board knows the task', async () => {
    const board = { current: EMPTY_PROJECTION };
    const subject = projector(board);
    await subject.sync(PLAN);

    await expect(subject.linkPullRequest('T1.1.1', 42)).resolves.toBeUndefined();
  });
});

describe('the GitHub provider', () => {
  interface Call {
    readonly args: readonly string[];
    readonly stdin: string | undefined;
  }

  function recording(responses: Readonly<Record<string, string>>) {
    const calls: Call[] = [];
    const api = (args: readonly string[], stdin?: string): Promise<string> => {
      calls.push({ args, stdin });
      const path = args.find((argument) => argument.startsWith('repos/')) ?? '';
      const key = Object.keys(responses).find((candidate) => path.startsWith(candidate));
      return Promise.resolve(key === undefined ? '{}' : (responses[key] ?? '{}'));
    };
    return { api, calls };
  }

  const boardLabels = TASK_COLUMNS.map((column) => ({ name: `status:${column}` }));

  it('reports only issues carrying a task marker', async () => {
    const { api } = recording({
      'repos/o/r/labels': JSON.stringify([
        [...boardLabels, { name: 'type:task', color: '0e8a16', description: 'A task' }],
      ]),
      'repos/o/r/milestones': JSON.stringify([
        [{ number: 1, title: 'M1.1 — x', description: 'v' }],
      ]),
      'repos/o/r/issues': JSON.stringify([
        [
          {
            number: 5,
            title: 'T1.1.1 — Loan store',
            body: `${taskMarker('T1.1.1')}\nwhatever`,
            state: 'open',
            labels: [{ name: 'type:task' }, { name: 'status:in-progress' }],
            milestone: { title: 'M1.1 — x' },
          },
          { number: 6, title: 'a human opened this', body: 'no marker', state: 'open' },
          {
            number: 7,
            title: 'a pull request',
            body: taskMarker('T1.1.2'),
            state: 'open',
            pull_request: {},
          },
        ],
      ]),
    });

    const observed = await observeBoard('o/r', { api });

    expect(observed.issues).toHaveLength(1);
    expect(observed.issues[0]).toMatchObject({
      key: 'T1.1.1',
      number: 5,
      column: 'in-progress',
      state: 'open',
    });
    // Status labels are the provider's own bookkeeping and never surface.
    expect(observed.issues[0]?.labels).toEqual(['type:task']);
    expect(observed.labels.map((label) => label.name)).toEqual(['type:task']);
    expect(observed.columns).toEqual([...TASK_COLUMNS]);
  });

  it('sends a request body on stdin rather than the command line', async () => {
    const { api, calls } = recording({
      'repos/o/r/milestones': JSON.stringify([[]]),
    });
    const provider = githubPmProvider({ api });

    await (provider.apply as (input: unknown) => Promise<unknown>)({
      repo: 'o/r',
      operations: [
        {
          kind: 'create-label',
          label: { name: 'type:task', color: '0e8a16', description: 'A task' },
        },
      ],
    });

    const created = calls.find((call) => call.args.includes('repos/o/r/labels'));
    expect(created?.args).toContain('--input');
    expect(created?.stdin).toContain('"name":"type:task"');
    // The body is nowhere in the argv, which is world-readable in the process
    // table.
    expect(created?.args.join(' ')).not.toContain('type:task"');
  });

  it('creates the column labels when it is asked to create the board', async () => {
    const { api, calls } = recording({ 'repos/o/r/milestones': JSON.stringify([[]]) });
    const provider = githubPmProvider({ api });

    await (provider.apply as (input: unknown) => Promise<unknown>)({
      repo: 'o/r',
      operations: [{ kind: 'create-board', title: 'mpgm plan', columns: TASK_COLUMNS }],
    });

    const names = calls
      .filter((call) => call.stdin !== undefined)
      .map((call) => JSON.parse(call.stdin ?? '{}') as { name?: string })
      .map((body) => body.name);
    expect(names).toEqual(TASK_COLUMNS.map((column) => `status:${column}`));
  });

  it('moves an issue by swapping its status label and setting its state', async () => {
    const { api, calls } = recording({ 'repos/o/r/milestones': JSON.stringify([[]]) });
    const provider = githubPmProvider({ api });

    await (provider.apply as (input: unknown) => Promise<unknown>)({
      repo: 'o/r',
      operations: [
        {
          kind: 'move-issue',
          key: 'T1.1.1',
          number: 5,
          from: 'in-progress',
          to: 'done',
          state: 'closed',
        },
      ],
    });

    expect(calls.some((call) => call.stdin?.includes('"state":"closed"') === true)).toBe(
      true,
    );
    expect(
      calls.some(
        (call) =>
          call.args.includes('DELETE') &&
          call.args.some((argument) => argument.endsWith('labels/status:in-progress')),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.stdin?.includes('status:done') === true)).toBe(true);
  });
});
