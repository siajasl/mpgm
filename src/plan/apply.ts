import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import type { EventLog } from '../event/store.js';
import type { KernelState } from '../state/kernel-state.js';
import {
  classifyReplan,
  type ReplanClassification,
  type ReplanProposal,
} from './replan.js';

/**
 * Applying a replan (PLN-4).
 *
 * Autonomous revisions are written as a successor artifact version and logged.
 * Gated ones are not applied at all: re-entering the Plan gate is something
 * the operator does when they accept the proposal, not something a proposal
 * causes by being made. Invalidating an approved plan gate the moment an agent
 * suggests a restructure would let a rejected suggestion cost the project its
 * approval.
 */

export interface ApplyReplanOptions {
  readonly log: EventLog;
  readonly artifacts: ArtifactStore;
  readonly runId: string;
  /** The approved plan artifact the proposal revises. */
  readonly current: Artifact;
  /** Declared base path of the plan artifact, e.g. `artifacts/plan/plan.md`. */
  readonly basePath: string;
  readonly proposal: ReplanProposal;
  readonly producedBy: Provenance;
  /** Task ids already finished, so completed work is preserved. */
  readonly completed?: ReadonlySet<string>;
}

export interface ReplanOutcome {
  readonly classification: ReplanClassification;
  /** The successor version, when the revision was applied. */
  readonly applied: Artifact | null;
  /** What the operator has to do next, when it was not. */
  readonly directive: string;
}

/** Completed task ids for a run, from folded state. */
export function completedTasks(state: KernelState, runId: string): ReadonlySet<string> {
  const tasks = state.runs[runId]?.tasks ?? {};
  return new Set(
    Object.values(tasks)
      .filter((task) => task.status === 'completed')
      .map((task) => task.taskId),
  );
}

export function applyReplan(options: ApplyReplanOptions): ReplanOutcome {
  const { current, proposal } = options;
  const before = current.data as ReplanProposal['plan'];
  const classification = classifyReplan(before, proposal, options.completed);

  if (classification.verdict === 'gate') {
    return {
      classification,
      applied: null,
      directive:
        `This revision needs the Plan gate (PLN-4). Reopen the plan phase ` +
        `(\`mpgm reopen plan\`) if you accept it; the plan on record is unchanged ` +
        `until you do.`,
    };
  }

  const applied = options.artifacts.write({
    id: current.id,
    basePath: options.basePath,
    schema: current.schema,
    data: proposal.plan,
    producedBy: options.producedBy,
    tracesTo: current.tracesTo,
  });

  options.log.append({
    runId: options.runId,
    type: 'PlanRevised',
    payload: {
      fromVersion: current.version,
      toVersion: applied.version,
      rationale: proposal.rationale,
      deltas: classification.deltas.map((delta) => ({
        kind: delta.kind,
        at: delta.at,
      })),
    },
  });

  return {
    classification,
    applied,
    directive: `Applied as version ${String(applied.version)} and logged.`,
  };
}
