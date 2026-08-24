import type { Artifact } from '../artifact/store.js';

/**
 * Surfacing prior decisions (CTX-3).
 *
 * CTX-3 asks for decisions with rationale to be persisted and surfaced to
 * agents whose tasks *may conflict* with them. The persistence is already
 * there — ADRs live in the Design artifact (DSG-1) — so what is missing is the
 * surfacing, and specifically the "may conflict" part: handing every agent
 * every decision ever taken is the same as handing it none, because it stops
 * reading them.
 *
 * Relevance is computed from what a decision and a task both trace to. A
 * decision that traces to nothing the task touches is not withheld because it
 * is unimportant; it is withheld because there is no way for the task to
 * contradict it.
 */

export interface PriorDecision {
  readonly id: string;
  readonly title: string;
  readonly decision: string;
  readonly consequences: readonly string[];
  /** Requirement or design ids the decision was made about. */
  readonly tracesTo: readonly string[];
  /** Artifact the decision was recorded in. */
  readonly source: string;
  /** Artifact id, so a task is not told about its own artifact's decisions. */
  readonly sourceArtifact: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

/**
 * Find the decisions recorded in an artifact.
 *
 * A decision is an object carrying an id, a `decision` and its `consequences` —
 * the ADR shape (DSG-1). Recognised structurally rather than by schema name so
 * that a project recording decisions somewhere other than the Design artifact
 * still gets them surfaced.
 */
export function decisionsIn(artifact: Artifact): PriorDecision[] {
  const found: PriorDecision[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    const id = value.id;
    const decision = value.decision;
    const consequences = stringsOf(value.consequences);
    if (
      typeof id === 'string' &&
      id !== '' &&
      typeof decision === 'string' &&
      decision !== '' &&
      consequences.length > 0
    ) {
      found.push({
        id,
        title: typeof value.title === 'string' ? value.title : id,
        decision,
        consequences,
        tracesTo: stringsOf(value.tracesTo),
        source: artifact.path,
        sourceArtifact: artifact.id,
      });
    }

    for (const child of Object.values(value)) {
      walk(child);
    }
  };

  walk(artifact.data);
  return found;
}

/** Every decision recorded across a set of artifacts. */
export function collectDecisions(artifacts: readonly Artifact[]): PriorDecision[] {
  return artifacts.flatMap((artifact) => decisionsIn(artifact));
}

export interface RelevanceRequest {
  readonly decisions: readonly PriorDecision[];
  /** Ids the task's own material touches. */
  readonly touching: ReadonlySet<string>;
  /**
   * Artifact ids already in the task's context.
   *
   * A task reading the Design artifact does not need its own ADRs read back
   * to it, and the space is better spent on the ones it cannot see.
   */
  readonly alreadyPresent?: ReadonlySet<string>;
}

/** Decisions this task could contradict, in id order. */
export function relevantDecisions(request: RelevanceRequest): PriorDecision[] {
  const present = request.alreadyPresent ?? new Set<string>();

  return request.decisions
    .filter(
      (decision) =>
        !present.has(decision.sourceArtifact) &&
        decision.tracesTo.some((id) => request.touching.has(id)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}
