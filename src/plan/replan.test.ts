import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { ArtifactStore } from '../artifact/store.js';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { planSchema } from '../schemas.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { applyReplan, completedTasks } from './apply.js';
import { classifyReplan, type Plan, type ReplanProposal } from './replan.js';

/**
 * The PLN-4 decision table.
 *
 * One line: reordering or splitting tasks within a milestone is autonomous;
 * milestones, plan phases and design assumptions are the operator's.
 */

const task = (
  id: string,
  overrides: Partial<{
    title: string;
    completionCriteria: string[];
    dependsOn: string[];
    tracesTo: string[];
  }> = {},
) => ({
  id,
  title: `Task ${id}`,
  completionCriteria: [`${id} is demonstrably done`],
  dependsOn: [] as string[],
  tracesTo: ['LOAN-1'],
  ...overrides,
});

const BASE: Plan = planSchema.parse({
  summary: 'A plan.',
  risks: [{ id: 'R1', assumption: 'One writer is enough.', validatedBy: ['M1.1'] }],
  phases: [
    {
      id: 'P1',
      title: 'Skeleton',
      intent: 'Prove the risky parts.',
      milestones: [
        {
          id: 'M1.1',
          title: 'Loans',
          verification: 'A loan survives a restart.',
          validatesRisk: 'R1',
          tasks: [task('T1.1.1'), task('T1.1.2', { dependsOn: ['T1.1.1'] })],
        },
        {
          id: 'M1.2',
          title: 'Views',
          verification: 'A member sees their loans.',
          validatesRisk: null,
          tasks: [task('T1.2.1', { tracesTo: ['LOAN-3'] })],
        },
      ],
    },
  ],
});

/** Structural surgery on a copy, so each case states exactly one change. */
function revise(mutate: (plan: Plan) => void): Plan {
  const copy = structuredClone(BASE);
  mutate(copy);
  return copy;
}

const propose = (plan: Plan, splits?: ReplanProposal['splits']): ReplanProposal => ({
  plan,
  rationale: 'because',
  ...(splits === undefined ? {} : { splits }),
});

const milestone = (plan: Plan, id: string) => {
  const found = plan.phases
    .flatMap((phase) => phase.milestones)
    .find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no milestone ${id} in fixture`);
  }
  return found;
};

describe('the PLN-4 decision table', () => {
  it('calls an identical plan no change at all', () => {
    const result = classifyReplan(BASE, propose(structuredClone(BASE)));

    expect(result.verdict).toBe('autonomous');
    expect(result.deltas).toStrictEqual([]);
    expect(result.reason).toMatch(/identical/);
  });

  const autonomous = [
    {
      name: 'reordering tasks within a milestone',
      mutate: (plan: Plan) => {
        const target = milestone(plan, 'M1.1');
        target.tasks = [
          { ...task('T1.1.2'), dependsOn: [] },
          { ...task('T1.1.1'), dependsOn: ['T1.1.2'] },
        ];
      },
    },
    {
      name: 'adding a task to an existing milestone',
      mutate: (plan: Plan) => {
        milestone(plan, 'M1.1').tasks.push(task('T1.1.3'));
      },
    },
  ] as const;

  for (const scenario of autonomous) {
    it(`applies ${scenario.name} without an operator`, () => {
      const result = classifyReplan(BASE, propose(revise(scenario.mutate)));

      expect(result.verdict).toBe('autonomous');
      expect(result.deltas.every((delta) => delta.verdict === 'autonomous')).toBe(true);
    });
  }

  const gated = [
    {
      name: 'adding a milestone',
      kind: 'milestone-structure',
      mutate: (plan: Plan) => {
        plan.phases[0]?.milestones.push({
          id: 'M1.3',
          title: 'Extra',
          verification: 'Something works.',
          validatesRisk: null,
          tasks: [task('T1.3.1')],
        });
      },
    },
    {
      name: 'removing a milestone',
      kind: 'milestone-structure',
      mutate: (plan: Plan) => {
        const phase = plan.phases[0];
        if (phase !== undefined) {
          phase.milestones = phase.milestones.slice(0, 1);
        }
      },
    },
    {
      name: 'adding a plan phase',
      kind: 'phase-structure',
      mutate: (plan: Plan) => {
        plan.phases.push({
          id: 'P2',
          title: 'Breadth',
          intent: 'Widen it.',
          milestones: [
            {
              id: 'M2.1',
              title: 'More',
              verification: 'More works.',
              validatesRisk: null,
              tasks: [task('T2.1.1')],
            },
          ],
        });
      },
    },
    {
      name: 'changing what a milestone must demonstrate',
      kind: 'milestone-verification',
      mutate: (plan: Plan) => {
        milestone(plan, 'M1.1').verification = 'The tasks are done.';
      },
    },
    {
      name: 'moving a task between milestones',
      kind: 'task-moved',
      mutate: (plan: Plan) => {
        const from = milestone(plan, 'M1.1');
        const moved = from.tasks[1];
        from.tasks = from.tasks.slice(0, 1);
        if (moved !== undefined) {
          milestone(plan, 'M1.2').tasks.push({ ...moved, dependsOn: [] });
        }
      },
    },
    {
      name: 'removing a task',
      kind: 'task-removed',
      mutate: (plan: Plan) => {
        const target = milestone(plan, 'M1.1');
        target.tasks = target.tasks.slice(0, 1);
      },
    },
    {
      name: 'restating what a task must achieve',
      kind: 'task-restated',
      mutate: (plan: Plan) => {
        const target = milestone(plan, 'M1.1').tasks[0];
        if (target !== undefined) {
          target.completionCriteria = ['it basically works'];
        }
      },
    },
    {
      name: 'changing what a task serves',
      kind: 'task-retraced',
      mutate: (plan: Plan) => {
        const target = milestone(plan, 'M1.1').tasks[0];
        if (target !== undefined) {
          target.tracesTo = ['NFR-9'];
        }
      },
    },
    {
      name: 'changing the declared risks',
      kind: 'risk-structure',
      mutate: (plan: Plan) => {
        plan.risks = [
          { id: 'R1', assumption: 'Something else entirely.', validatedBy: ['M1.1'] },
        ];
      },
    },
    {
      name: 'making a dependency cross a milestone boundary',
      kind: 'task-reordered',
      mutate: (plan: Plan) => {
        const target = milestone(plan, 'M1.2').tasks[0];
        if (target !== undefined) {
          target.dependsOn = ['T1.1.2'];
        }
      },
    },
  ] as const;

  for (const scenario of gated) {
    it(`sends ${scenario.name} to the Plan gate`, () => {
      const result = classifyReplan(BASE, propose(revise(scenario.mutate)));

      expect(result.verdict).toBe('gate');
      expect(result.deltas.map((delta) => delta.kind)).toContain(scenario.kind);
      expect(result.reason).toMatch(/need the Plan gate/);
    });
  }
});

describe('splitting a task', () => {
  const split = (plan: Plan): void => {
    const target = milestone(plan, 'M1.1');
    target.tasks = [
      task('T1.1.1a'),
      task('T1.1.1b'),
      { ...task('T1.1.2'), dependsOn: ['T1.1.1b'] },
    ];
  };

  it('is autonomous when the claim holds', () => {
    const result = classifyReplan(
      BASE,
      propose(revise(split), [{ from: 'T1.1.1', into: ['T1.1.1a', 'T1.1.1b'] }]),
    );

    expect(result.verdict).toBe('autonomous');
    expect(result.deltas.map((delta) => delta.kind)).toContain('task-split');
  });

  it('is a removal when nobody claims it', () => {
    // The diff is identical; only the declaration distinguishes a split from a
    // task being dropped and two other things appearing.
    const result = classifyReplan(BASE, propose(revise(split)));

    expect(result.verdict).toBe('gate');
    expect(result.deltas.map((delta) => delta.kind)).toContain('task-removed');
  });

  it('is refused when the parts do not cover what the original served', () => {
    const dropping = revise((plan) => {
      const target = milestone(plan, 'M1.1');
      target.tasks = [
        task('T1.1.1a', { tracesTo: ['NFR-2'] }),
        task('T1.1.1b', { tracesTo: ['NFR-2'] }),
        { ...task('T1.1.2'), dependsOn: ['T1.1.1b'] },
      ];
    });

    // A "split" that quietly drops LOAN-1 is a removal wearing a better name.
    const result = classifyReplan(
      BASE,
      propose(dropping, [{ from: 'T1.1.1', into: ['T1.1.1a', 'T1.1.1b'] }]),
    );

    expect(result.verdict).toBe('gate');
    expect(result.deltas.find((delta) => delta.kind === 'task-split')?.detail).toMatch(
      /claim does not hold/,
    );
  });

  it('is refused when a part lands in another milestone', () => {
    const scattered = revise((plan) => {
      const target = milestone(plan, 'M1.1');
      target.tasks = [task('T1.1.1a'), { ...task('T1.1.2'), dependsOn: ['T1.1.1a'] }];
      milestone(plan, 'M1.2').tasks.push(task('T1.1.1b'));
    });

    const result = classifyReplan(
      BASE,
      propose(scattered, [{ from: 'T1.1.1', into: ['T1.1.1a', 'T1.1.1b'] }]),
    );

    expect(result.verdict).toBe('gate');
  });
});

describe('completed work is preserved (PLN-4)', () => {
  it('gates a change to a task that is already done', () => {
    const reordered = revise((plan) => {
      const target = milestone(plan, 'M1.1').tasks[1];
      if (target !== undefined) {
        target.dependsOn = [];
      }
    });

    const free = classifyReplan(BASE, propose(reordered));
    expect(free.verdict).toBe('autonomous');

    // The same diff, once T1.1.2 has actually been done.
    const done = classifyReplan(BASE, propose(reordered), new Set(['T1.1.2']));
    expect(done.verdict).toBe('gate');
    expect(done.disturbsCompleted).toStrictEqual(['T1.1.2']);
  });

  it('refuses to split a task that is already done', () => {
    const target = revise((plan) => {
      const owner = milestone(plan, 'M1.1');
      owner.tasks = [
        task('T1.1.1a'),
        task('T1.1.1b'),
        { ...task('T1.1.2'), dependsOn: ['T1.1.1b'] },
      ];
    });

    const result = classifyReplan(
      BASE,
      propose(target, [{ from: 'T1.1.1', into: ['T1.1.1a', 'T1.1.1b'] }]),
      new Set(['T1.1.1']),
    );

    expect(result.verdict).toBe('gate');
    expect(result.disturbsCompleted).toStrictEqual(['T1.1.1']);
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-replan-'));
  tempDirs.push(dir);
  return dir;
}

describe('applying a replan', () => {
  const schemas = new ArtifactSchemaRegistry([defineArtifactSchema('plan', planSchema)]);
  const producedBy = {
    task: 'replan',
    role: 'planner',
    model: 'claude-sonnet-5',
    runId: 'run-1',
  };

  function harness() {
    const db = openDatabase(MEMORY);
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    const projector = new Projector({
      log,
      snapshots: SnapshotStore.attach(db),
      interval: 50,
    });
    const artifacts = new ArtifactStore({ root: newRoot(), schemas });
    log.append({
      runId: 'run-1',
      type: 'RunStarted',
      payload: { project: 'mpgm', operator: 'op' },
    });
    const current = artifacts.write({
      id: 'plan',
      basePath: 'artifacts/plan/plan.md',
      schema: 'plan',
      data: BASE,
      producedBy,
    });
    return { db, log, projector, artifacts, current };
  }

  it('writes a successor version and logs it', () => {
    const { db, log, projector, artifacts, current } = harness();
    try {
      const outcome = applyReplan({
        log,
        artifacts,
        runId: 'run-1',
        current,
        basePath: 'artifacts/plan/plan.md',
        proposal: propose(
          revise((plan) => {
            milestone(plan, 'M1.1').tasks.push(task('T1.1.3'));
          }),
        ),
        producedBy,
      });

      expect(outcome.classification.verdict).toBe('autonomous');
      expect(outcome.applied?.version).toBe(2);

      const revisions = projector.project().runs['run-1']?.planRevisions ?? [];
      expect(revisions).toStrictEqual([
        { fromVersion: 1, toVersion: 2, rationale: 'because', deltas: 1 },
      ]);
      expect(log.read({ type: 'PlanRevised' })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('leaves the plan on record untouched when the gate is needed', () => {
    const { db, log, projector, artifacts, current } = harness();
    try {
      const outcome = applyReplan({
        log,
        artifacts,
        runId: 'run-1',
        current,
        basePath: 'artifacts/plan/plan.md',
        proposal: propose(
          revise((plan) => {
            const phase = plan.phases[0];
            if (phase !== undefined) {
              phase.milestones = phase.milestones.slice(0, 1);
            }
          }),
        ),
        producedBy,
      });

      expect(outcome.applied).toBeNull();
      expect(outcome.directive).toMatch(/mpgm reopen plan/);
      // A rejected suggestion must not cost the project its approval, so
      // nothing is written and nothing is logged until the operator acts.
      expect(artifacts.latestVersion('artifacts/plan/plan.md')).toBe(1);
      expect(log.read({ type: 'PlanRevised' })).toStrictEqual([]);
      expect(projector.project().runs['run-1']?.planRevisions).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('reads completed work from folded state', () => {
    const { db, log, projector } = harness();
    try {
      log.appendMany([
        {
          runId: 'run-1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1.1.1', role: 'implementer', model: 'claude-sonnet-5' },
        },
        {
          runId: 'run-1',
          type: 'TaskCompleted',
          payload: { taskId: 'T1.1.1', artifactRefs: [] },
        },
        {
          runId: 'run-1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1.1.2', role: 'implementer', model: 'claude-sonnet-5' },
        },
      ]);

      expect([...completedTasks(projector.project(), 'run-1')]).toStrictEqual(['T1.1.1']);
    } finally {
      db.close();
    }
  });
});
