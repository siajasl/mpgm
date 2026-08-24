import type { z } from 'zod';
import type { planSchema } from '../schemas.js';

/**
 * Replan classification (PLN-4, DESIGN §4.1).
 *
 * PLN-4 draws one line: reordering or splitting tasks *within* a milestone may
 * be applied autonomously and logged; adding or removing milestones,
 * restructuring plan phases, or touching design assumptions must re-enter the
 * Plan gate.
 *
 * Everything not recognised as one of the small cases is gated. The cost of a
 * wrong `gate` is an operator reading a packet; the cost of a wrong
 * `autonomous` is the plan quietly ceasing to be the thing that was approved.
 */

export type Plan = z.infer<typeof planSchema>;

export type ReplanVerdict = 'autonomous' | 'gate';

export type DeltaKind =
  | 'phase-structure'
  | 'milestone-structure'
  | 'milestone-moved'
  | 'milestone-verification'
  | 'milestone-risk'
  | 'risk-structure'
  | 'task-added'
  | 'task-removed'
  | 'task-split'
  | 'task-moved'
  | 'task-reordered'
  | 'task-restated'
  | 'task-retraced'
  | 'completed-task-disturbed';

export interface PlanDelta {
  readonly kind: DeltaKind;
  /** The plan element the change is at. */
  readonly at: string;
  readonly verdict: ReplanVerdict;
  readonly detail: string;
}

/**
 * A split the replanner claims to have made.
 *
 * Declared rather than inferred. A split looks exactly like a removal plus two
 * additions, and the difference between "T1.1.1 was split" and "T1.1.1 was
 * dropped and two other things were added" is intent -- which the kernel
 * cannot read off the diff, but can *check* once it is stated.
 */
export interface DeclaredSplit {
  readonly from: string;
  readonly into: readonly string[];
}

export interface ReplanProposal {
  readonly plan: Plan;
  readonly rationale: string;
  readonly splits?: readonly DeclaredSplit[];
}

export interface ReplanClassification {
  readonly verdict: ReplanVerdict;
  readonly deltas: readonly PlanDelta[];
  /** One line an operator can act on. */
  readonly reason: string;
  /** Completed tasks the proposal would remove or change (PLN-4). */
  readonly disturbsCompleted: readonly string[];
}

interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly completionCriteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly tracesTo: readonly string[];
  readonly milestone: string;
  readonly phase: string;
  /** Position within its milestone. */
  readonly position: number;
}

interface MilestoneView {
  readonly id: string;
  readonly verification: string;
  readonly validatesRisk: string | null;
  readonly phase: string;
}

function tasksOf(plan: Plan): Map<string, TaskView> {
  const map = new Map<string, TaskView>();
  for (const phase of plan.phases) {
    for (const milestone of phase.milestones) {
      milestone.tasks.forEach((task, position) => {
        map.set(task.id, {
          id: task.id,
          title: task.title,
          completionCriteria: task.completionCriteria,
          dependsOn: task.dependsOn,
          tracesTo: task.tracesTo,
          milestone: milestone.id,
          phase: phase.id,
          position,
        });
      });
    }
  }
  return map;
}

function milestonesOf(plan: Plan): Map<string, MilestoneView> {
  const map = new Map<string, MilestoneView>();
  for (const phase of plan.phases) {
    for (const milestone of phase.milestones) {
      map.set(milestone.id, {
        id: milestone.id,
        verification: milestone.verification,
        validatesRisk: milestone.validatesRisk,
        phase: phase.id,
      });
    }
  }
  return map;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/**
 * Is a claimed split real?
 *
 * Every part must land in the milestone the original was in, there must be at
 * least two of them, and between them they must serve everything the original
 * served. A "split" that quietly drops a requirement is a removal wearing a
 * better name. A completed task cannot be split at all: PLN-4 requires
 * replanning to preserve completed work.
 */
function verifySplit(
  split: DeclaredSplit,
  original: TaskView,
  afterTasks: ReadonlyMap<string, TaskView>,
  completed: ReadonlySet<string>,
): boolean {
  if (split.into.length < 2 || completed.has(split.from)) {
    return false;
  }
  const parts = split.into.map((id) => afterTasks.get(id));
  const present = parts.filter((part): part is TaskView => part !== undefined);
  if (present.length !== parts.length) {
    return false;
  }
  if (present.some((part) => part.milestone !== original.milestone)) {
    return false;
  }
  const covered = new Set(present.flatMap((part) => part.tracesTo));
  return original.tracesTo.every((id) => covered.has(id));
}

/**
 * Classify the difference between an approved plan and a proposed one.
 *
 * `completed` is the set of task ids already finished, from folded state.
 * PLN-4 requires replanning to preserve completed work, so anything that would
 * remove or restate one of them is gated however small the diff looks.
 */
export function classifyReplan(
  before: Plan,
  proposal: ReplanProposal,
  completed: ReadonlySet<string> = new Set(),
): ReplanClassification {
  const after = proposal.plan;
  const deltas: PlanDelta[] = [];
  const disturbsCompleted = new Set<string>();

  const beforePhases = before.phases.map((phase) => phase.id);
  const afterPhases = after.phases.map((phase) => phase.id);
  if (!sameSet(beforePhases, afterPhases)) {
    deltas.push({
      kind: 'phase-structure',
      at: '(plan)',
      verdict: 'gate',
      detail: `plan phases changed: ${beforePhases.join(', ')} -> ${afterPhases.join(', ')}`,
    });
  }

  const beforeMilestones = milestonesOf(before);
  const afterMilestones = milestonesOf(after);
  if (!sameSet([...beforeMilestones.keys()], [...afterMilestones.keys()])) {
    deltas.push({
      kind: 'milestone-structure',
      at: '(plan)',
      verdict: 'gate',
      detail: 'milestones were added or removed',
    });
  }

  for (const [id, was] of beforeMilestones) {
    const now = afterMilestones.get(id);
    if (now === undefined) {
      continue;
    }
    if (now.phase !== was.phase) {
      deltas.push({
        kind: 'milestone-moved',
        at: id,
        verdict: 'gate',
        detail: `moved from ${was.phase} to ${now.phase}`,
      });
    }
    if (now.verification !== was.verification) {
      // PLN-3's obligation is what the milestone must demonstrate. Changing it
      // changes what "done" means, which is not a reordering.
      deltas.push({
        kind: 'milestone-verification',
        at: id,
        verdict: 'gate',
        detail: 'what must demonstrably work has changed',
      });
    }
    if (now.validatesRisk !== was.validatesRisk) {
      deltas.push({
        kind: 'milestone-risk',
        at: id,
        verdict: 'gate',
        detail: `the risk it validates changed: ${was.validatesRisk ?? 'none'} -> ${now.validatesRisk ?? 'none'}`,
      });
    }
  }

  const riskKey = (plan: Plan): string =>
    plan.risks
      .map(
        (risk) =>
          `${risk.id}:${risk.assumption}:${[...risk.validatedBy].sort().join('+')}`,
      )
      .sort()
      .join(' / ');
  if (riskKey(before) !== riskKey(after)) {
    // Risks are the design assumptions the plan is built on (PLN-2).
    deltas.push({
      kind: 'risk-structure',
      at: '(plan)',
      verdict: 'gate',
      detail: 'the declared risks or what validates them changed',
    });
  }

  const beforeTasks = tasksOf(before);
  const afterTasks = tasksOf(after);
  const splits = proposal.splits ?? [];
  const splitFrom = new Map(splits.map((split) => [split.from, split]));
  const splitInto = new Set(splits.flatMap((split) => split.into));

  for (const [id, was] of beforeTasks) {
    const now = afterTasks.get(id);

    if (now === undefined) {
      const claimed = splitFrom.get(id);
      const verified =
        claimed !== undefined && verifySplit(claimed, was, afterTasks, completed);

      if (claimed !== undefined && verified) {
        deltas.push({
          kind: 'task-split',
          at: id,
          verdict: 'autonomous',
          detail: `split into ${claimed.into.join(', ')} within ${was.milestone}`,
        });
      } else {
        if (completed.has(id)) {
          disturbsCompleted.add(id);
        }
        deltas.push({
          kind: claimed === undefined ? 'task-removed' : 'task-split',
          at: id,
          verdict: 'gate',
          detail:
            claimed === undefined
              ? 'removed from the plan'
              : `claimed as split into ${claimed.into.join(', ')}, but the claim does not hold`,
        });
      }
      continue;
    }

    if (now.milestone !== was.milestone) {
      deltas.push({
        kind: 'task-moved',
        at: id,
        verdict: 'gate',
        detail: `moved from ${was.milestone} to ${now.milestone}`,
      });
    }

    if (
      now.title !== was.title ||
      !sameSet(now.completionCriteria, was.completionCriteria)
    ) {
      if (completed.has(id)) {
        disturbsCompleted.add(id);
      }
      deltas.push({
        kind: 'task-restated',
        at: id,
        verdict: 'gate',
        detail: 'its title or completion criteria changed',
      });
    }

    if (!sameSet(now.tracesTo, was.tracesTo)) {
      if (completed.has(id)) {
        disturbsCompleted.add(id);
      }
      // What a task serves is a design assumption, not an ordering detail.
      deltas.push({
        kind: 'task-retraced',
        at: id,
        verdict: 'gate',
        detail: 'what it traces to changed',
      });
    }

    if (!sameSet(now.dependsOn, was.dependsOn) || now.position !== was.position) {
      const nowCrosses = now.dependsOn.some(
        (dependency) => afterTasks.get(dependency)?.milestone !== now.milestone,
      );

      if (nowCrosses && !sameSet(now.dependsOn, was.dependsOn)) {
        // A dependency reaching out of the milestone changes the milestone
        // boundary, whatever it looks like from inside one.
        deltas.push({
          kind: 'task-reordered',
          at: id,
          verdict: 'gate',
          detail: 'its dependencies now cross a milestone boundary',
        });
      } else if (completed.has(id) && !sameSet(now.dependsOn, was.dependsOn)) {
        disturbsCompleted.add(id);
        deltas.push({
          kind: 'completed-task-disturbed',
          at: id,
          verdict: 'gate',
          detail: 'a completed task had its dependencies changed',
        });
      } else {
        deltas.push({
          kind: 'task-reordered',
          at: id,
          verdict: 'autonomous',
          detail: `reordered within ${now.milestone}`,
        });
      }
    }
  }

  for (const [id, now] of afterTasks) {
    if (beforeTasks.has(id) || splitInto.has(id)) {
      continue;
    }
    const milestoneExisted = beforeMilestones.has(now.milestone);
    deltas.push({
      kind: 'task-added',
      at: id,
      verdict: milestoneExisted ? 'autonomous' : 'gate',
      detail: milestoneExisted
        ? `added to ${now.milestone}`
        : `added to ${now.milestone}, which is itself new`,
    });
  }

  const gated = deltas.filter((delta) => delta.verdict === 'gate');
  const verdict: ReplanVerdict = gated.length === 0 ? 'autonomous' : 'gate';
  const summary = gated
    .slice(0, 3)
    .map((delta) => `${delta.at} ${delta.detail}`)
    .join('; ');

  return {
    verdict,
    deltas,
    disturbsCompleted: [...disturbsCompleted].sort(),
    reason:
      deltas.length === 0
        ? 'the proposed plan is identical to the approved one'
        : verdict === 'autonomous'
          ? `${String(deltas.length)} change(s), all within existing milestones (PLN-4)`
          : `${String(gated.length)} of ${String(deltas.length)} change(s) need the Plan gate: ` +
            summary +
            (gated.length > 3 ? '; ...' : ''),
  };
}
