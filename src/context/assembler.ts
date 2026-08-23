import type { Artifact } from '../artifact/store.js';
import type { TaskTemplate } from '../playbook/definition.js';
import { classOf, permitted, type EgressClass, type EgressPolicy } from './egress.js';
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

export interface AssembleRequest {
  readonly task: TaskTemplate;
  readonly upstream: readonly Artifact[];
  readonly kb: readonly KbDocument[];
  readonly policy: EgressPolicy;
}

export interface AssembledContext {
  /** The text handed to the session. */
  readonly prompt: string;
  readonly includedArtifacts: readonly string[];
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
    includedKb: kb.map((document) => document.path),
    withheld,
  };
}
