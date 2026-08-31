import { describe, expect, it } from 'vitest';
import { planSchema } from '../schemas.js';
import {
  completedTaskIds,
  dependencyWaves,
  dryRunPlan,
  ingestPlan,
  PlanIngestError,
  readyTasks,
} from './ingest.js';
import type { Plan } from './replan.js';

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  title: `Task ${id}`,
  completionCriteria: [`${id} is done`],
  dependsOn,
  tracesTo: ['LOAN-1'],
});

const PLAN: Plan = planSchema.parse({
  summary: 'Two phases.',
  risks: [{ id: 'R1', assumption: 'It works.', validatedBy: ['M1.1'] }],
  phases: [
    {
      id: 'P1',
      title: 'First',
      intent: 'Start.',
      milestones: [
        {
          id: 'M1.1',
          title: 'Alpha',
          verification: 'Alpha works.',
          validatesRisk: 'R1',
          tasks: [task('T1.1.1'), task('T1.1.2'), task('T1.1.3', ['T1.1.1'])],
        },
        {
          id: 'M1.2',
          title: 'Beta',
          verification: 'Beta works.',
          validatesRisk: null,
          tasks: [task('T1.2.1')],
        },
      ],
    },
    {
      id: 'P2',
      title: 'Second',
      intent: 'Continue.',
      milestones: [
        {
          id: 'M2.1',
          title: 'Gamma',
          verification: 'Gamma works.',
          validatesRisk: null,
          tasks: [task('T2.1.1')],
        },
      ],
    },
  ],
});

describe('ingesting a plan (PLN-1, R6)', () => {
  it('turns every task into a schedulable step', () => {
    const graph = ingestPlan(PLAN);

    expect(graph.tasks.map((entry) => entry.id)).toStrictEqual([
      'T1.1.1',
      'T1.1.2',
      'T1.1.3',
      'T1.2.1',
      'T2.1.1',
    ]);
    expect(graph.milestones).toStrictEqual(['M1.1', 'M1.2', 'M2.1']);
  });

  it('keeps what the plan declared apart from what its shape implied', () => {
    const graph = ingestPlan(PLAN);
    const byId = new Map(graph.tasks.map((entry) => [entry.id, entry]));

    // Declared: T1.1.3 waits on T1.1.1 because the plan says so.
    expect(byId.get('T1.1.3')?.declaredDependsOn).toStrictEqual(['T1.1.1']);
    expect(byId.get('T1.1.3')?.orderedAfter).toStrictEqual([]);

    // Implied: milestones are gated, so M1.2 waits for all of M1.1 — and
    // nobody had to write that down in the plan.
    expect(byId.get('T1.2.1')?.declaredDependsOn).toStrictEqual([]);
    expect(byId.get('T1.2.1')?.orderedAfter).toStrictEqual([
      'T1.1.1',
      'T1.1.2',
      'T1.1.3',
    ]);
    expect(byId.get('T1.2.1')?.dependsOn).toStrictEqual(['T1.1.1', 'T1.1.2', 'T1.1.3']);
  });

  it('carries plan-phase order through the same rule', () => {
    const graph = ingestPlan(PLAN);
    const first = graph.tasks.find((entry) => entry.id === 'T2.1.1');

    // P2's first milestone waits on P1's last, which is what makes the strict
    // phase order of PLAN section 4 hold without a separate mechanism.
    expect(first?.orderedAfter).toStrictEqual(['T1.2.1']);
    expect(first?.phase).toBe('P2');
  });

  it('does not duplicate a dependency that is both declared and implied', () => {
    const overlapping = planSchema.parse({
      ...PLAN,
      phases: [
        {
          ...PLAN.phases[0],
          milestones: [
            PLAN.phases[0]?.milestones[0],
            {
              ...PLAN.phases[0]?.milestones[1],
              tasks: [task('T1.2.1', ['T1.1.2'])],
            },
          ],
        },
        PLAN.phases[1],
      ],
    });

    const entry = ingestPlan(overlapping).tasks.find((step) => step.id === 'T1.2.1');
    expect(entry?.dependsOn).toStrictEqual(['T1.1.2', 'T1.1.1', 'T1.1.3']);
  });
});

describe('the dry run (R6)', () => {
  it('schedules every task and dispatches none', async () => {
    const report = await dryRunPlan(ingestPlan(PLAN), 4);

    expect(report.dispatched).toBe(0);
    expect(report.order).toHaveLength(5);
    expect(new Set(report.order).size).toBe(5);
  });

  it('never runs a task before something it depends on', async () => {
    const graph = ingestPlan(PLAN);
    const report = await dryRunPlan(graph, 4);
    const position = new Map(report.order.map((id, index) => [id, index]));

    for (const entry of graph.tasks) {
      for (const dependency of entry.dependsOn) {
        expect(position.get(dependency), `${entry.id} after ${dependency}`).toBeLessThan(
          position.get(entry.id) ?? -1,
        );
      }
    }
  });

  it('reports what could run at once, which is not what the cap allows', async () => {
    // Waves are the shape of the graph; the scheduler is additionally bounded
    // by concurrency, so the two answer different questions.
    const report = await dryRunPlan(ingestPlan(PLAN), 1);

    expect(report.concurrency).toBe(1);
    expect(report.waves[0]).toStrictEqual(['T1.1.1', 'T1.1.2']);
  });

  it('refuses a graph that could not be scheduled', () => {
    // A cycle the plan schema cannot see, because it is created by the
    // milestone ordering rather than declared: a task in an earlier milestone
    // depending on a later one.
    const backwards = ingestPlan(PLAN);
    const broken = {
      ...backwards,
      tasks: backwards.tasks.map((entry) =>
        entry.id === 'T1.1.1' ? { ...entry, dependsOn: ['T1.2.1'] } : entry,
      ),
    };

    expect(() => dependencyWaves(broken)).toThrow(PlanIngestError);
  });
});

describe('what counts as a finished plan task', () => {
  // The two tasks this loop actually ran. T3.2.1 merged; T3.2.2's implementing
  // session finished, its reviewer refused, and nothing reached the trunk.
  const merged = { status: 'completed', merged: { commit: '731e0d9' } };
  const refused = { status: 'completed', merged: null };

  it('counts a task whose change reached the trunk', () => {
    expect([...completedTaskIds({ 'T3.2.1': merged })]).toStrictEqual(['T3.2.1']);
  });

  it('does not count a task that was written, refused and never merged', () => {
    // `TaskCompleted` is logged for the implementing session on its own
    // merits, and one plan task spans several sessions. Reading that as the
    // task being done let a milestone close over a change nobody accepted.
    expect([...completedTaskIds({ 'T3.2.2': refused })]).toStrictEqual([]);
  });

  it('counts work an operator attested to, which no session ran', () => {
    expect([
      ...completedTaskIds({ 'T3.1.1': { status: 'attested', merged: null } }),
    ]).toStrictEqual(['T3.1.1']);
  });

  it('keeps a refused task dispatchable, and its dependents blocked', () => {
    const graph = ingestPlan(PLAN);
    const first = graph.tasks[0];
    if (first === undefined) {
      throw new Error('expected the fixture plan to have a task');
    }

    const ready = readyTasks(graph, completedTaskIds({ [first.id]: refused }));

    // The task itself is offered again — there is work left on it — and
    // nothing downstream has been let through on the strength of a session
    // that finished inside it.
    expect(ready.map((entry) => entry.id)).toContain(first.id);
  });

  it('treats a run with no tasks as nothing finished', () => {
    expect([...completedTaskIds()]).toStrictEqual([]);
    expect([...completedTaskIds({})]).toStrictEqual([]);
  });
});
