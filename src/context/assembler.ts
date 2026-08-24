import type { Artifact } from '../artifact/store.js';
import { classOf, permitted, type EgressClass, type EgressPolicy } from './egress.js';
import type { PriorDecision } from './decisions.js';
import type { KbDocument } from './knowledge-base.js';

/**
 * Builds a task's context (CTX-1, CTX-2, DESIGN §4.3).
 *
 * Context is assembled from the task spec, the upstream artifacts it depends
 * on, and a knowledge-base digest — never from another agent's transcript
 * (CTX-2). Artifacts are the interface between phases precisely because a
 * transcript carries an agent's mistakes and detours as well as its
 * conclusions.
 *
 * The egress filter runs last (SAF-6), because it is the final check before
 * content leaves the machine.
 */

export interface WithheldItem {
  readonly path: string;
  readonly egress: EgressClass;
}

/** What the task being assembled for was told to do. */
export interface TaskSpec {
  readonly description: string;
  readonly prompt: string;
}

/**
 * A result from an earlier step of the same phase that produced no artifact —
 * a fan-out worker, a panel judge, a panel tally (ORC-4).
 *
 * This is not a transcript (CTX-2): it is the step's validated structured
 * output, the same thing an artifact would have been built from had the step
 * declared one. Members of a pattern node deliberately produce no artifacts,
 * so without this a collector would be asked to collect nothing.
 *
 * Results carry no egress label of their own, because nothing labelled one.
 * They are derived from material the filter already passed on the way in.
 */
export interface UpstreamResult {
  readonly taskId: string;
  readonly description: string;
  readonly data: unknown;
}

export interface AssembleRequest {
  readonly task: TaskSpec;
  readonly upstream: readonly Artifact[];
  /** Upstream step results not carried by an artifact. */
  readonly results?: readonly UpstreamResult[];
  /**
   * Prior decisions this task could contradict (CTX-3).
   *
   * Already filtered for relevance by the caller: handing an agent every
   * decision ever taken is the same as handing it none.
   */
  readonly decisions?: readonly PriorDecision[];
  readonly kb: readonly KbDocument[];
  readonly policy: EgressPolicy;
}

export interface AssembledContext {
  /** The text handed to the session. */
  readonly prompt: string;
  readonly includedArtifacts: readonly string[];
  readonly includedResults: readonly string[];
  readonly includedDecisions: readonly string[];
  readonly includedKb: readonly string[];
  /**
   * What the policy withheld. Reported here in full for the operator and the
   * event log; the prompt itself gets only a count, so the model learns that
   * something was withheld without learning what.
   */
  readonly withheld: readonly WithheldItem[];
}

function renderArtifact(artifact: Artifact): string {
  return [
    `### ${artifact.id} (v${String(artifact.version)}, schema ${artifact.schema})`,
    '',
    '```json',
    JSON.stringify(artifact.data, null, 2),
    '```',
  ].join('\n');
}

function renderResult(result: UpstreamResult): string {
  return [
    `### ${result.taskId}`,
    '',
    result.description.trim(),
    '',
    '```json',
    JSON.stringify(result.data, null, 2),
    '```',
  ].join('\n');
}

function renderDecision(decision: PriorDecision): string {
  return [
    `### ${decision.id} — ${decision.title}`,
    '',
    decision.decision.trim(),
    '',
    `Consequences accepted: ${decision.consequences.join('; ')}`,
    `Decided about: ${decision.tracesTo.join(', ')} (recorded in ${decision.source})`,
  ].join('\n');
}

export function assembleContext(request: AssembleRequest): AssembledContext {
  const { task, policy } = request;
  const withheld: WithheldItem[] = [];

  const artifacts = request.upstream.filter((artifact) => {
    if (permitted(artifact.egress, policy)) {
      return true;
    }
    withheld.push({ path: artifact.path, egress: classOf(artifact.egress, policy) });
    return false;
  });

  const kb = request.kb.filter((document) => {
    if (permitted(document.egress, policy)) {
      return true;
    }
    withheld.push({ path: document.path, egress: classOf(document.egress, policy) });
    return false;
  });

  const sections: string[] = [
    '## Task',
    '',
    task.description.trim(),
    '',
    task.prompt.trim(),
  ];

  if (artifacts.length > 0) {
    sections.push('', '## Upstream artifacts', '');
    sections.push(artifacts.map(renderArtifact).join('\n\n'));
  }

  const results = request.results ?? [];
  if (results.length > 0) {
    sections.push('', '## Upstream results', '');
    sections.push(results.map(renderResult).join('\n\n'));
  }

  const decisions = request.decisions ?? [];
  if (decisions.length > 0) {
    // Stated as binding, and as contestable. An agent that quietly works
    // around a decision produces work the project cannot reconcile; one that
    // says the decision no longer holds produces a finding somebody can act on.
    sections.push(
      '',
      '## Prior decisions',
      '',
      'These decisions were already taken about material this task touches.',
      'Work within them. If your work requires contradicting one, say so',
      'explicitly and say why — do not route around it silently.',
      '',
      decisions.map(renderDecision).join('\n\n'),
    );
  }

  if (kb.length > 0) {
    sections.push('', '## Knowledge base', '');
    sections.push(
      kb.map((document) => `### ${document.title}\n\n${document.content}`).join('\n\n'),
    );
  }

  if (withheld.length > 0) {
    // Say that something was withheld, never what. Silence would let an agent
    // confabulate around the gap without knowing there was one.
    sections.push(
      '',
      '## Withheld',
      '',
      `${String(withheld.length)} item(s) were withheld by the project's data-egress policy.`,
    );
  }

  return {
    prompt: `${sections.join('\n').trimEnd()}\n`,
    includedArtifacts: artifacts.map((artifact) => artifact.id),
    includedResults: results.map((result) => result.taskId),
    includedDecisions: decisions.map((decision) => decision.id),
    includedKb: kb.map((document) => document.path),
    withheld,
  };
}
