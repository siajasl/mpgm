import { schedule, type SchedulableStep } from '../orchestrator/scheduler.js';
import type { Plan } from './replan.js';

/**
 * Loading a gated Plan artifact as an executable task graph (PLN-1, R6).
 *
 * From the Implement phase onward the plan *is* the kernel's task graph
 * (DESIGN §2), so the artifact has to be schedulable rather than descriptive.
 * This is the step that turns one into the other, and the dry run is how a
 * plan is checked before anything is dispatched against it.
 */

export interface IngestedTask extends SchedulableStep {
  readonly id: string;
  readonly title: string;
  readonly milestone: string;
  readonly phase: string;
  /** Dependencies the plan wrote down. */
  readonly declaredDependsOn: readonly string[];
  /**
   * Dependencies the milestone structure implies.
   *
   * Milestones are gated: a milestone closes when its tasks are merged, its
   * checks are green and its verification is demonstrated (PLAN §4). So the
   * next milestone's tasks wait for this one's — and since plan phases are
   * strictly ordered, the same rule carries phase order with it. Kept separate
   * from the declared ones so a reader can tell what the plan said from what
   * its shape implied.
   */
  readonly orderedAfter: readonly string[];
  readonly dependsOn: readonly string[];
  readonly completionCriteria: readonly string[];
  readonly tracesTo: readonly string[];
}

export interface PlanGraph {
  readonly tasks: readonly IngestedTask[];
  /** Milestone ids in the order the plan puts them. */
  readonly milestones: readonly string[];
}

export class PlanIngestError extends Error {}

/** Turn a validated plan into the graph the scheduler runs. */
export function ingestPlan(plan: Plan): PlanGraph {
  const tasks: IngestedTask[] = [];
  const milestones: string[] = [];
  let previousMilestoneTasks: string[] = [];

  for (const phase of plan.phases) {
    for (const milestone of phase.milestones) {
      milestones.push(milestone.id);
      const orderedAfter = previousMilestoneTasks;
      const here: string[] = [];

      for (const task of milestone.tasks) {
        here.push(task.id);
        tasks.push({
          id: task.id,
          title: task.title,
          milestone: milestone.id,
          phase: phase.id,
          declaredDependsOn: task.dependsOn,
          orderedAfter,
          dependsOn: [...new Set([...task.dependsOn, ...orderedAfter])],
          completionCriteria: task.completionCriteria,
          tracesTo: task.tracesTo,
        });
      }

      previousMilestoneTasks = here;
    }
  }

  return { tasks, milestones };
}

export interface DryRunReport {
  /** Every task, in the order the scheduler took them. */
  readonly order: readonly string[];
  /** Tasks that were ready together, in rounds — what would run in parallel. */
  readonly waves: readonly (readonly string[])[];
  /** Always zero. A dry run proves the graph schedules; it runs nothing. */
  readonly dispatched: number;
  readonly concurrency: number;
  readonly milestones: readonly string[];
}

/**
 * Schedule the plan without dispatching anything (R6).
 *
 * Uses the real scheduler with a runner that does nothing, so what is being
 * checked is that *this* scheduler accepts the graph — a bespoke simulation
 * would prove the plan schedulable under a scheduler nobody runs.
 */
export async function dryRunPlan(
  graph: PlanGraph,
  concurrency = 4,
): Promise<DryRunReport> {
  const order: string[] = [];

  const report = await schedule<IngestedTask, true>({
    steps: graph.tasks,
    concurrency,
    run: (task) => {
      order.push(task.id);
      return Promise.resolve({ status: 'completed', value: true });
    },
  });

  if (report.status !== 'completed') {
    throw new PlanIngestError(
      `the plan did not schedule: ${report.status}` +
        (report.blocked.length > 0
          ? ` (${report.blocked.map((entry) => entry.id).join(', ')})`
          : '') +
        (report.skipped.length > 0
          ? `; never reached: ${report.skipped.join(', ')}`
          : ''),
    );
  }

  return {
    order,
    waves: dependencyWaves(graph),
    // Nothing is dispatched, by construction: the runner above records an id
    // and returns. Reported so the demo can assert it rather than trust it.
    dispatched: 0,
    concurrency,
    milestones: graph.milestones,
  };
}

/**
 * Tasks grouped by how deep they are in the dependency graph.
 *
 * Not what the scheduler does — it is bounded by concurrency and takes work as
 * it frees up — but it is what an operator wants to see: how much of the plan
 * could run at once if nothing else were in the way.
 */
export function dependencyWaves(graph: PlanGraph): string[][] {
  const remaining = new Map(
    graph.tasks.map((task) => [task.id, new Set(task.dependsOn)]),
  );
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id);

    if (ready.length === 0) {
      throw new PlanIngestError(
        `task dependencies form a cycle among: ${[...remaining.keys()].sort().join(', ')}`,
      );
    }

    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) {
        deps.delete(id);
      }
    }
  }

  return waves;
}

/**
 * Tasks whose dependencies are all complete.
 *
 * The ready set, which is what the implement loop asks for and what the board
 * shows in its `ready` column. Ordering follows declaration order, so two runs
 * over the same plan pick the same task first (ORC-3).
 */
export function readyTasks(
  graph: PlanGraph,
  completed: ReadonlySet<string>,
): IngestedTask[] {
  return graph.tasks.filter(
    (task) =>
      !completed.has(task.id) &&
      task.dependsOn.every((dependency) => completed.has(dependency)),
  );
}
