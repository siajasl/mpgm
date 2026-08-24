import { z } from 'zod';
import type { ContractSpec } from '../contract/capability.js';
import type {
  DesiredIssue,
  DesiredLabel,
  DesiredMilestone,
  DesiredProjection,
  TaskColumn,
} from './projection.js';

/**
 * Reconciling the GitHub projection (PMG-3, PMG-4, DESIGN section 4.8).
 *
 * The kernel computes the difference between what the board should hold and
 * what it does, and hands the provider a list of operations. Two consequences
 * worth having:
 *
 * - **Bootstrap and reconcile are the same function.** A greenfield repository
 *   is just an empty observation, so the PMG-4 requirement that re-running
 *   converges instead of duplicating is structural rather than something the
 *   provider has to be careful about.
 * - **The diff is testable without GitHub.** What the projector decides can be
 *   asserted directly; what a provider does with it is the provider problem.
 */

export interface ObservedIssue {
  /** The task id read back from the body marker. */
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly milestone: string;
  readonly column: TaskColumn;
  readonly state: 'open' | 'closed';
}

export interface ObservedProjection {
  readonly labels: readonly DesiredLabel[];
  readonly milestones: readonly DesiredMilestone[];
  readonly issues: readonly ObservedIssue[];
  /** Columns the board already has. */
  readonly columns?: readonly TaskColumn[];
  readonly boardTitle?: string;
}

export const EMPTY_PROJECTION: ObservedProjection = {
  labels: [],
  milestones: [],
  issues: [],
  columns: [],
};

export type PmOperation =
  | {
      readonly kind: 'create-board';
      readonly title: string;
      readonly columns: readonly TaskColumn[];
    }
  | { readonly kind: 'create-label'; readonly label: DesiredLabel }
  | { readonly kind: 'update-label'; readonly label: DesiredLabel }
  | { readonly kind: 'create-milestone'; readonly milestone: DesiredMilestone }
  | { readonly kind: 'update-milestone'; readonly milestone: DesiredMilestone }
  | { readonly kind: 'create-issue'; readonly issue: DesiredIssue }
  | {
      readonly kind: 'update-issue';
      readonly key: string;
      readonly number: number;
      readonly issue: DesiredIssue;
    }
  | {
      readonly kind: 'move-issue';
      readonly key: string;
      readonly number: number;
      readonly from: TaskColumn;
      readonly to: TaskColumn;
      readonly state: 'open' | 'closed';
    }
  | {
      readonly kind: 'link-pull-request';
      readonly key: string;
      readonly number: number;
      readonly pullRequest: number;
    };

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
}

/**
 * What must change for the board to match the plan.
 *
 * Nothing is ever deleted. An issue on the board that the plan no longer
 * mentions is left alone: it may be a task somebody split, an issue a person
 * opened, or a plan revision still in review, and a projector that closes
 * other people issues because they are not in its model is a projector nobody
 * will leave running (PMG-3).
 */
export function reconcile(
  desired: DesiredProjection,
  observed: ObservedProjection = EMPTY_PROJECTION,
): PmOperation[] {
  const operations: PmOperation[] = [];

  if (
    observed.boardTitle !== desired.boardTitle ||
    (observed.columns ?? []).length === 0
  ) {
    operations.push({
      kind: 'create-board',
      title: desired.boardTitle,
      columns: desired.columns,
    });
  }

  const labels = new Map(observed.labels.map((entry) => [entry.name, entry]));
  for (const label of desired.labels) {
    const existing = labels.get(label.name);
    if (existing === undefined) {
      operations.push({ kind: 'create-label', label });
    } else if (
      existing.color !== label.color ||
      existing.description !== label.description
    ) {
      operations.push({ kind: 'update-label', label });
    }
  }

  const milestones = new Map(observed.milestones.map((entry) => [entry.title, entry]));
  for (const milestone of desired.milestones) {
    const existing = milestones.get(milestone.title);
    if (existing === undefined) {
      operations.push({ kind: 'create-milestone', milestone });
    } else if (existing.description !== milestone.description) {
      operations.push({ kind: 'update-milestone', milestone });
    }
  }

  const issues = new Map(observed.issues.map((entry) => [entry.key, entry]));
  for (const issue of desired.issues) {
    const existing = issues.get(issue.key);
    if (existing === undefined) {
      operations.push({ kind: 'create-issue', issue });
      continue;
    }
    if (
      existing.title !== issue.title ||
      existing.body !== issue.body ||
      existing.milestone !== issue.milestone ||
      !sameStrings(existing.labels, issue.labels)
    ) {
      operations.push({
        kind: 'update-issue',
        key: issue.key,
        number: existing.number,
        issue,
      });
    }
    // A move is separate from an update because it is what the board is for: a
    // task changing column is the thing somebody is watching (PMG-2), and
    // folding it into a body edit makes it invisible in the operation list.
    if (existing.column !== issue.column || existing.state !== issue.state) {
      operations.push({
        kind: 'move-issue',
        key: issue.key,
        number: existing.number,
        from: existing.column,
        to: issue.column,
        state: issue.state,
      });
    }
  }

  return operations;
}

/**
 * Apply operations to an observation.
 *
 * Not for production: a provider does that against GitHub. This is what makes
 * convergence testable, by reconciling, applying, and reconciling again — the
 * second result must be empty.
 */
export function applyOperations(
  observed: ObservedProjection,
  operations: readonly PmOperation[],
  numbers: () => number,
): ObservedProjection {
  let labels = [...observed.labels];
  let milestones = [...observed.milestones];
  let issues = [...observed.issues];
  let columns = observed.columns ?? [];
  let boardTitle = observed.boardTitle;

  for (const operation of operations) {
    switch (operation.kind) {
      case 'create-board':
        boardTitle = operation.title;
        columns = operation.columns;
        break;
      case 'create-label':
        labels = [...labels, operation.label];
        break;
      case 'update-label':
        labels = labels.map((entry) =>
          entry.name === operation.label.name ? operation.label : entry,
        );
        break;
      case 'create-milestone':
        milestones = [...milestones, operation.milestone];
        break;
      case 'update-milestone':
        milestones = milestones.map((entry) =>
          entry.title === operation.milestone.title ? operation.milestone : entry,
        );
        break;
      case 'create-issue':
        issues = [...issues, { ...operation.issue, number: numbers() }];
        break;
      case 'update-issue':
        issues = issues.map((entry) =>
          entry.key === operation.key
            ? {
                ...operation.issue,
                number: entry.number,
                column: entry.column,
                state: entry.state,
              }
            : entry,
        );
        break;
      case 'move-issue':
        issues = issues.map((entry) =>
          entry.key === operation.key
            ? { ...entry, column: operation.to, state: operation.state }
            : entry,
        );
        break;
      case 'link-pull-request':
        break;
    }
  }

  return {
    labels,
    milestones,
    issues,
    columns,
    ...(boardTitle === undefined ? {} : { boardTitle }),
  };
}

const columnSchema = z.enum([
  'backlog',
  'ready',
  'in-progress',
  'in-review',
  'blocked',
  'done',
]);

const labelSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  description: z.string(),
});

const milestoneSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
});

const observedIssueSchema = z.object({
  key: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string().min(1)),
  milestone: z.string(),
  column: columnSchema,
  state: z.enum(['open', 'closed']),
});

export const pmObserveInput = z.object({ repo: z.string().min(1) });

export const pmObserveOutput = z.object({
  labels: z.array(labelSchema),
  milestones: z.array(milestoneSchema),
  issues: z.array(observedIssueSchema),
  columns: z.array(columnSchema).default([]),
  boardTitle: z.string().default(''),
});

export const pmApplyInput = z.object({
  repo: z.string().min(1),
  operations: z.array(z.record(z.string(), z.unknown())).min(1),
});

export const pmApplyOutput = z.object({
  applied: z.number().int().nonnegative(),
  /** Issue numbers by task id, for operations that created them. */
  issues: z.record(z.string(), z.number().int().positive()).default({}),
});

/**
 * The `pm.github` capability (PMG-1 to PMG-4).
 *
 * Two operations, not seven: the kernel reads the board once and computes the
 * whole difference itself, so a provider needs to know how to look and how to
 * act, and nothing about plans, milestones or task state.
 */
export const pmGithubContract: ContractSpec = {
  name: 'pm.github',
  summary: 'Read and update the GitHub projection of the plan (PMG-1 to PMG-4).',
  operations: [
    {
      name: 'observe',
      summary: 'The board, labels, milestones and mpgm-owned issues as they stand.',
      input: pmObserveInput,
      output: pmObserveOutput,
      effects: 'read-only',
    },
    {
      name: 'apply',
      summary: 'Perform a reconcile plan.',
      input: pmApplyInput,
      output: pmApplyOutput,
      // Every operation is keyed by something stable — a label name, a
      // milestone title, a task marker — so replaying the batch after a crash
      // converges rather than duplicating (DESIGN section 6).
      effects: 'idempotent',
    },
  ],
};
