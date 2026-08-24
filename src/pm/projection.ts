import type { z } from 'zod';
import type { planSchema } from '../schemas.js';
import type { RunState } from '../state/kernel-state.js';

/**
 * What the GitHub projection should look like (PMG-1, DESIGN section 4.8).
 *
 * A pure function of the gated Plan artifact and folded kernel state. That is
 * the whole design: the board is derived state (PMG-3), so there is nothing to
 * "keep in sync" — there is a desired shape, and a diff against what is there.
 * Bootstrap and reconcile are then the same operation run against different
 * starting points, which is why re-running either converges instead of
 * duplicating (PMG-4).
 */

export type Plan = z.infer<typeof planSchema>;

/** Board columns, following task state (PMG-1). */
export type TaskColumn =
  'backlog' | 'ready' | 'in-progress' | 'in-review' | 'blocked' | 'done';

export const TASK_COLUMNS: readonly TaskColumn[] = [
  'backlog',
  'ready',
  'in-progress',
  'in-review',
  'blocked',
  'done',
];

export interface DesiredLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface DesiredMilestone {
  readonly title: string;
  readonly description: string;
}

export interface DesiredIssue {
  /** The plan task id. Also the marker written into the body. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly milestone: string;
  readonly column: TaskColumn;
  readonly state: 'open' | 'closed';
}

export interface DesiredProjection {
  readonly boardTitle: string;
  readonly columns: readonly TaskColumn[];
  readonly labels: readonly DesiredLabel[];
  readonly milestones: readonly DesiredMilestone[];
  readonly issues: readonly DesiredIssue[];
}

/**
 * The marker that makes an issue findable again.
 *
 * Idempotency rests entirely on this: a provider re-running the bootstrap
 * looks up the issue by its task id rather than by title, so retitling a task
 * updates an issue instead of creating a second one (PMG-4).
 */
export function taskMarker(taskId: string): string {
  return `<!-- mpgm:task=${taskId} -->`;
}

export function taskIdFromBody(body: string): string | undefined {
  return /<!-- mpgm:task=([^\s>]+) -->/.exec(body)?.[1];
}

/** Colours are cosmetic; fixed so a reconcile does not churn them. */
const LABEL_COLOURS: Readonly<Record<string, string>> = {
  phase: '1d76db',
  milestone: '5319e7',
  type: '0e8a16',
  role: 'fbca04',
};

function label(kind: string, value: string, description: string): DesiredLabel {
  return {
    name: `${kind}:${value}`,
    color: LABEL_COLOURS[kind] ?? 'ededed',
    description,
  };
}

function issueBody(
  task: {
    id: string;
    title: string;
    completionCriteria: readonly string[];
    tracesTo: readonly string[];
    dependsOn: readonly string[];
  },
  milestone: { id: string; title: string },
): string {
  const lines = [
    taskMarker(task.id),
    '',
    `**${task.id}** — ${task.title}`,
    '',
    '**Done when**',
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    '',
    `**Traces to:** ${task.tracesTo.join(', ')}`,
  ];
  if (task.dependsOn.length > 0) {
    lines.push(`**Depends on:** ${task.dependsOn.join(', ')}`);
  }
  lines.push('', `Part of ${milestone.id} — ${milestone.title}.`);
  lines.push(
    '',
    'Maintained by mpgm from the gated Plan artifact; edits here are overwritten.',
  );
  return lines.join('\n');
}

/**
 * Which column a task belongs in.
 *
 * `done` needs care. A task that went through the implement loop is done when
 * its change **merged**, not when its session finished — a completed session
 * whose change is still in review is not done, and showing it as done is the
 * one wrong answer that matters. A task that never entered the loop (nothing
 * checked, nothing reviewed) is done when it completes, because nothing else
 * is ever going to happen to it.
 */
export function columnFor(
  taskId: string,
  dependsOn: readonly string[],
  run: RunState | undefined,
  completed: ReadonlySet<string>,
): TaskColumn {
  const state = run?.tasks[taskId];
  if (state === undefined) {
    return dependsOn.every((dependency) => completed.has(dependency))
      ? 'ready'
      : 'backlog';
  }
  if (state.status === 'blocked') {
    return 'blocked';
  }
  if (state.merged !== null) {
    return 'done';
  }
  if (state.status === 'completed') {
    return state.review === null && state.checks === null ? 'done' : 'in-review';
  }
  return 'in-progress';
}

export interface ProjectionOptions {
  readonly boardTitle?: string;
  readonly run?: RunState;
}

/** The projection the board should hold, given a plan and what has happened. */
export function desiredProjection(
  plan: Plan,
  options: ProjectionOptions = {},
): DesiredProjection {
  const run = options.run;
  const completed = new Set(
    Object.values(run?.tasks ?? {})
      .filter((task) => task.status === 'completed')
      .map((task) => task.taskId),
  );

  const labels: DesiredLabel[] = [
    label('type', 'task', 'A task from the gated Plan (PLN-1)'),
  ];
  const milestones: DesiredMilestone[] = [];
  const issues: DesiredIssue[] = [];
  const roles = new Set<string>();

  for (const phase of plan.phases) {
    labels.push(label('phase', phase.id, phase.title));
    for (const milestone of phase.milestones) {
      labels.push(label('milestone', milestone.id, milestone.title));
      milestones.push({
        title: `${milestone.id} — ${milestone.title}`,
        description: `${milestone.verification}${
          milestone.validatesRisk === null
            ? ''
            : ` (validates ${milestone.validatesRisk})`
        }`,
      });

      for (const task of milestone.tasks) {
        const column = columnFor(task.id, task.dependsOn, run, completed);
        const role = run?.tasks[task.id]?.role;
        if (role !== undefined) {
          roles.add(role);
        }
        issues.push({
          key: task.id,
          title: `${task.id} — ${task.title}`,
          body: issueBody(task, milestone),
          labels: [
            'type:task',
            `phase:${phase.id}`,
            `milestone:${milestone.id}`,
            ...(role === undefined ? [] : [`role:${role}`]),
          ],
          milestone: `${milestone.id} — ${milestone.title}`,
          column,
          state: column === 'done' ? 'closed' : 'open',
        });
      }
    }
  }

  // Role labels come from the kernel rather than the plan: a plan task does
  // not name a role, the dispatcher resolves one (DESIGN section 4.2). PMG-1
  // also asks for a priority label; the Plan schema carries no priority, and
  // inventing one here would put a field on the board that nothing decides.
  for (const role of [...roles].sort()) {
    labels.push(label('role', role, `Dispatched to the ${role} role`));
  }

  return {
    boardTitle: options.boardTitle ?? 'mpgm plan',
    columns: TASK_COLUMNS,
    labels,
    milestones,
    issues,
  };
}
