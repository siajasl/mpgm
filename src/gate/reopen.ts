import type { ArtifactRef } from '../event/catalog.js';
import type { EventLog } from '../event/store.js';
import type { KernelState } from '../state/kernel-state.js';
import { artifactNodeId } from '../trace/links.js';
import type { TraceIndex } from '../trace/index-store.js';
import { GateError } from './manager.js';

/**
 * Reopening a gated phase, and the invalidation cascade it causes (ORC-6).
 *
 * The requirement has two halves and the second is the harder one: approvals
 * of downstream artifacts that trace to the changed content are invalidated,
 * *and unaffected downstream artifacts retain approval*. A cascade that
 * invalidated everything would satisfy the first half and make gates
 * worthless — every reopen would re-gate the whole project, so nobody would
 * reopen anything.
 *
 * What is affected is read from the trace index (ADR-4), which is derived from
 * what the artifacts themselves declare. The kernel does not guess.
 */

export interface ReopenRequest {
  readonly runId: string;
  readonly phase: string;
  readonly reason: string;
  /**
   * Ids whose content changed — requirement ids, ADR ids, artifact node ids.
   *
   * Omitted means the whole of what the reopened phase's gate approved, which
   * is the safe reading: an operator who cannot say what changed has said that
   * anything might have.
   */
  readonly changed?: readonly string[];
}

/** An approved gate, and what the cascade decided about it. */
export interface GateVerdict {
  readonly gateId: string;
  readonly phase: string;
  /** Artifact node ids (`id@version`) this gate approved. */
  readonly artifacts: readonly string[];
  /**
   * The affected node that reached it, for an invalidated gate; the reason it
   * was left alone, for a retained one. Either way the operator is told why,
   * because a cascade nobody can follow is a cascade nobody will trust.
   */
  readonly because: string;
}

export interface ReopenPlan {
  readonly runId: string;
  readonly phase: string;
  /** What the cascade started from, after defaulting. */
  readonly changed: readonly string[];
  /** Every node the change reaches, including the changed nodes themselves. */
  readonly affected: readonly string[];
  readonly invalidated: readonly GateVerdict[];
  readonly retained: readonly GateVerdict[];
}

function nodeIdsOf(refs: readonly ArtifactRef[]): string[] {
  return refs
    .filter((ref) => ref.id !== undefined && ref.version !== undefined)
    .map((ref) => artifactNodeId(ref.id ?? '', ref.version ?? 0));
}

/**
 * Work out what a reopen would invalidate, without recording anything.
 *
 * Exposed separately so an operator can be shown the consequence before
 * causing it: invalidating a Design gate can cost the whole phase to redo,
 * and that is not a thing to discover after the event is in an append-only
 * log.
 */
export function planReopen(
  state: KernelState,
  index: TraceIndex,
  request: ReopenRequest,
): ReopenPlan {
  const run = state.runs[request.runId];
  if (run === undefined) {
    throw new GateError(`unknown run '${request.runId}'`);
  }

  const gates = Object.values(run.gates);
  const ownGates = gates.filter((gate) => gate.phase === request.phase);
  if (ownGates.length === 0) {
    throw new GateError(
      `run '${request.runId}' has no gate for phase '${request.phase}'. ` +
        `Phases with gates: ${[...new Set(gates.map((gate) => gate.phase))].sort().join(', ') || '(none)'}`,
    );
  }

  const changed =
    request.changed !== undefined && request.changed.length > 0
      ? [...request.changed]
      : [...new Set(ownGates.flatMap((gate) => nodeIdsOf(gate.artifactRefs)))].sort();

  const affected = new Set<string>(changed);
  for (const id of changed) {
    for (const reached of index.downstreamOf(id)) {
      affected.add(reached);
    }
  }

  const invalidated: GateVerdict[] = [];
  const retained: GateVerdict[] = [];

  for (const gate of gates) {
    if (gate.status !== 'approved') {
      continue;
    }
    const artifacts = nodeIdsOf(gate.artifactRefs);
    const hit = artifacts.find((node) => affected.has(node));

    // The reopened phase's own gate goes whatever the graph says. Reopening a
    // phase *is* withdrawing its approval; leaving it standing because no
    // trace happened to reach it would be a reopen that reopened nothing.
    if (gate.phase === request.phase) {
      invalidated.push({
        gateId: gate.gateId,
        phase: gate.phase,
        artifacts,
        because: `phase '${request.phase}' was reopened`,
      });
      continue;
    }

    if (hit === undefined) {
      retained.push({
        gateId: gate.gateId,
        phase: gate.phase,
        artifacts,
        because: 'nothing it approved traces to the changed content',
      });
    } else {
      invalidated.push({
        gateId: gate.gateId,
        phase: gate.phase,
        artifacts,
        because: `${hit} traces to the changed content`,
      });
    }
  }

  const order = (a: GateVerdict, b: GateVerdict): number =>
    a.gateId.localeCompare(b.gateId);

  return {
    runId: request.runId,
    phase: request.phase,
    changed,
    affected: [...affected].sort(),
    invalidated: invalidated.sort(order),
    retained: retained.sort(order),
  };
}

export interface ReopenOptions {
  readonly log: EventLog;
  readonly projector: { project(): KernelState };
  readonly index: TraceIndex;
  readonly request: ReopenRequest;
}

/**
 * Record the reopen and every invalidation it causes.
 *
 * The plan is computed first and the whole batch is appended together, so a
 * log can never hold a `PhaseReopened` whose cascade was half-written: the
 * next fold would then show a phase reopened with gates still approved that
 * the cascade had already decided against.
 */
export function reopenPhase(options: ReopenOptions): ReopenPlan {
  const { log, request } = options;
  const plan = planReopen(options.projector.project(), options.index, request);

  if (request.reason.trim() === '') {
    // Reopening costs whole phases of work; an unexplained one is not a
    // record anyone can act on later (HIL-5).
    throw new GateError('a reopen must say why');
  }

  log.appendMany([
    {
      runId: request.runId,
      type: 'PhaseReopened',
      payload: { phase: request.phase, reason: request.reason },
    },
    ...plan.invalidated.map((gate) => ({
      runId: request.runId,
      type: 'GateInvalidated',
      payload: {
        gateId: gate.gateId,
        cause: `${request.reason} (${gate.because})`,
      },
    })),
  ]);

  return plan;
}
