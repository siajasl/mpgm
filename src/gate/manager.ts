import type { Artifact } from '../artifact/store.js';
import type { GateOracle } from '../artifact/store.js';
import type { ArtifactRef } from '../event/catalog.js';
import type { EventLog } from '../event/store.js';
import type { GateCriterion } from '../playbook/definition.js';
import type { Playbook } from '../playbook/graph.js';
import type { KernelState } from '../state/kernel-state.js';

/**
 * Gate manager (DESIGN §4.1, HIL-1/4/5).
 *
 * Gate truth lives in the event log (ADR-3): a phase is open because an
 * approval event was recorded, not because a file or tag says so. Everything
 * here reads or appends events.
 */

export class GateError extends Error {}

export interface CriterionResult {
  readonly id: string;
  readonly kind: GateCriterion['kind'];
  readonly description: string;
  readonly met: boolean;
  readonly detail: string;
}

/**
 * What the operator is shown.
 *
 * HIL-4 forbids a bare "proceed?", so a packet always carries options,
 * trade-offs and a recommendation. When the caller supplies none, they are
 * derived from the criteria — a defaulted recommendation is still a
 * recommendation, and an empty one would be the bare prompt HIL-4 rules out.
 */
export interface ApprovalPacket {
  readonly gateId: string;
  readonly phase: string;
  readonly description: string;
  readonly criteria: readonly CriterionResult[];
  readonly allMet: boolean;
  readonly artifacts: readonly ArtifactRef[];
  readonly options: readonly string[];
  readonly tradeOffs: readonly string[];
  readonly recommendation: string;
  /** True when the gate was closed without an operator, per playbook. */
  readonly autoApproved: boolean;
}

export interface GateEvidence {
  /** Artifact id → the artifact, for artifacts that exist. */
  readonly artifacts: Readonly<Record<string, Artifact>>;
  /**
   * Task id → its validated output.
   *
   * Agent-assertion criteria read a named field of this, rather than treating
   * completion as assent: a task can finish successfully and still be telling
   * you the gate should stay shut.
   */
  readonly outputs: Readonly<Record<string, unknown>>;
}

/** Caller-supplied narrative for the packet (HIL-4). */
export interface PacketNarrative {
  readonly options?: readonly string[];
  readonly tradeOffs?: readonly string[];
  readonly recommendation?: string;
}

function readBoolean(output: unknown, field: string): boolean | undefined {
  const value =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)[field]
      : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

function readString(output: unknown, field: string): string | undefined {
  const value =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)[field]
      : undefined;
  return typeof value === 'string' ? value : undefined;
}

function evaluate(criterion: GateCriterion, evidence: GateEvidence): CriterionResult {
  if (criterion.kind === 'artifact-exists') {
    const artifact = evidence.artifacts[criterion.artifact];
    return {
      id: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      met: artifact !== undefined,
      detail:
        artifact === undefined
          ? `artifact '${criterion.artifact}' has not been produced`
          : `${artifact.id} v${String(artifact.version)} at ${artifact.path}`,
    };
  }

  if (criterion.kind === 'vote-carried') {
    const tallied = evidence.outputs[criterion.panel];
    const carried = readBoolean(tallied, 'carried');
    const summary = readString(tallied, 'summary');
    return {
      id: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      met: carried === true,
      detail:
        carried === undefined
          ? `panel '${criterion.panel}' has not been counted`
          : `${criterion.panel}: ${summary ?? (carried ? 'carried' : 'did not carry')}`,
    };
  }

  const output = evidence.outputs[criterion.fromTask];
  if (output === undefined) {
    return {
      id: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      met: false,
      detail: `task '${criterion.fromTask}' has not reported`,
    };
  }

  const value =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)[criterion.field]
      : undefined;

  if (typeof value !== 'boolean') {
    // An absent or non-boolean field is unmet, not assumed true. A criterion
    // that passes when its evidence is missing is worse than no criterion.
    return {
      id: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      met: false,
      detail: `task '${criterion.fromTask}' reported no boolean '${criterion.field}'`,
    };
  }

  return {
    id: criterion.id,
    kind: criterion.kind,
    description: criterion.description,
    met: value,
    detail: `${criterion.fromTask}.${criterion.field} = ${String(value)}`,
  };
}

function deriveNarrative(
  criteria: readonly CriterionResult[],
  allMet: boolean,
  supplied: PacketNarrative,
): Pick<ApprovalPacket, 'options' | 'tradeOffs' | 'recommendation'> {
  const unmet = criteria.filter((criterion) => !criterion.met);

  return {
    options:
      supplied.options ??
      (allMet
        ? ['Approve and enter the next phase.', 'Reject, with what needs revisiting.']
        : [
            'Reject and address the unmet criteria.',
            'Approve anyway, accepting the gaps as known risk.',
          ]),
    tradeOffs:
      supplied.tradeOffs ??
      (allMet
        ? [
            'Approving fixes this version: later changes require a successor and re-approval.',
          ]
        : unmet.map(
            (criterion) => `Unmet: ${criterion.description} — ${criterion.detail}`,
          )),
    recommendation:
      supplied.recommendation ??
      (allMet
        ? 'Approve: every exit criterion is met.'
        : `Do not approve yet: ${String(unmet.length)} criterion/criteria unmet.`),
  };
}

export interface GateManagerOptions {
  readonly log: EventLog;
  /**
   * Folded state, so the manager can see decisions already taken.
   *
   * Required rather than optional: a guard that silently does not apply when
   * a caller forgets to wire it is worse than no guard, because it is trusted.
   */
  readonly projector: { project(): KernelState };
}

export class GateManager {
  readonly #log: EventLog;
  readonly #projector: { project(): KernelState };

  constructor(options: GateManagerOptions) {
    this.#log = options.log;
    this.#projector = options.projector;
  }

  /**
   * Evaluate the gate and record that it was presented.
   *
   * Auto-approval happens only when the playbook asked for it *and* every
   * criterion is met (HIL-1). The approval is still an event, attributed to
   * `auto`, because an unattributed decision is not an audit trail (HIL-5).
   */
  present(
    runId: string,
    playbook: Playbook,
    evidence: GateEvidence,
    narrative: PacketNarrative = {},
  ): ApprovalPacket {
    const already = this.#projector.project().runs[runId]?.gates[playbook.gate.id];
    if (already?.status === 'approved') {
      // Re-presenting would leave two presentations around one decision, and
      // the audit trail could no longer say which artifacts the operator
      // actually approved. Reopening is a deliberate act (ORC-6), not a side
      // effect of running the phase again.
      throw new GateError(
        `gate '${playbook.gate.id}' is already approved. Reopen the phase first ` +
          `(PhaseReopened, which invalidates the gate) before presenting it again.`,
      );
    }

    const criteria = playbook.gate.criteria.map((criterion) =>
      evaluate(criterion, evidence),
    );
    const allMet = criteria.every((criterion) => criterion.met);

    const artifacts: ArtifactRef[] = Object.values(evidence.artifacts).map(
      (artifact) => ({
        id: artifact.id,
        path: artifact.path,
        commit: null,
        version: artifact.version,
      }),
    );

    this.#log.append({
      runId,
      type: 'GatePresented',
      payload: {
        gateId: playbook.gate.id,
        phase: playbook.phase,
        artifactRefs: artifacts,
      },
    });

    const autoApproved = playbook.gate.autoApprove && allMet;
    if (autoApproved) {
      this.approve(runId, playbook.gate.id, 'auto');
    }

    return {
      gateId: playbook.gate.id,
      phase: playbook.phase,
      description: playbook.gate.description,
      criteria,
      allMet,
      artifacts,
      autoApproved,
      ...deriveNarrative(criteria, allMet, narrative),
    };
  }

  approve(runId: string, gateId: string, by: string): void {
    if (by.trim() === '') {
      // An approval nobody is attributable for is not an audit record (HIL-5).
      throw new GateError('an approval must name who made it');
    }
    this.#log.append({ runId, type: 'GateApproved', payload: { gateId, by } });
  }

  reject(runId: string, gateId: string, by: string, reason: string): void {
    if (by.trim() === '') {
      throw new GateError('a rejection must name who made it');
    }
    this.#log.append({ runId, type: 'GateRejected', payload: { gateId, by, reason } });
  }
}

/** Has this gate been approved, and not since invalidated? */
export function isApproved(state: KernelState, runId: string, gateId: string): boolean {
  return state.runs[runId]?.gates[gateId]?.status === 'approved';
}

/**
 * May work behind this gate proceed?
 *
 * The default is no. A gate that has never been presented blocks exactly as a
 * rejected one does — silence is not consent (HIL-1).
 */
export function canProceed(state: KernelState, runId: string, gateId: string): boolean {
  return isApproved(state, runId, gateId);
}

/**
 * A {@link GateOracle} over folded state, so the artifact store learns which
 * versions are frozen from the log rather than from a separate record.
 */
export function gateOracleFromState(state: KernelState, runId: string): GateOracle {
  const run = state.runs[runId];
  const approved = new Set<string>();

  if (run !== undefined) {
    for (const gate of Object.values(run.gates)) {
      // Only a currently-approved gate freezes anything. A gate that was
      // invalidated by a reopen (ORC-6) releases its artifacts for revision.
      if (gate.status !== 'approved') {
        continue;
      }
      for (const ref of gate.artifactRefs) {
        if (ref.id !== undefined && ref.version !== undefined) {
          approved.add(`${ref.id}@${String(ref.version)}`);
        }
      }
    }
  }

  return {
    isGated(artifactId: string, version: number): boolean {
      return approved.has(`${artifactId}@${String(version)}`);
    },
  };
}
