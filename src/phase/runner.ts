import type { SessionRunner } from '../agent/runner.js';
import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import { assembleContext } from '../context/assembler.js';
import type { EgressPolicy } from '../context/egress.js';
import type { KbDocument } from '../context/knowledge-base.js';
import type { EventLog } from '../event/store.js';
import type { ApprovalPacket, GateEvidence, GateManager } from '../gate/manager.js';
import type { Playbook, TaskTemplate } from '../playbook/definition.js';
import type { RoleRegistry } from '../role/loader.js';
import type { Projector } from '../state/projector.js';
import { runControl } from '../state/reduce.js';

/**
 * Executes one phase from its playbook (DESIGN §4.1).
 *
 * Tasks run in dependency order; each is given context assembled from the
 * artifacts its dependencies produced, never from their sessions. When a task
 * declares an artifact, its validated output is written as one. The phase ends
 * by presenting the gate — it never approves it.
 */

export interface PhaseRunOptions {
  readonly runId: string;
  readonly playbook: Playbook;
  readonly roles: RoleRegistry;
  readonly artifacts: ArtifactStore;
  readonly sessions: SessionRunner;
  readonly gates: GateManager;
  readonly log: EventLog;
  readonly projector: Projector;
  readonly kb: readonly KbDocument[];
  readonly policy: EgressPolicy;
}

export type PhaseOutcome =
  | { readonly status: 'gate-presented'; readonly packet: ApprovalPacket }
  | { readonly status: 'blocked'; readonly taskId: string; readonly reason: string }
  | { readonly status: 'stopped'; readonly control: 'paused' | 'killed' };

export interface PhaseResult {
  readonly outcome: PhaseOutcome;
  readonly produced: Readonly<Record<string, Artifact>>;
}

function upstreamOf(
  task: TaskTemplate,
  playbook: Playbook,
  available: Readonly<Record<string, Artifact>>,
): Artifact[] {
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();

  const add = (artifactId: string | undefined): void => {
    if (artifactId === undefined || seen.has(artifactId)) {
      return;
    }
    seen.add(artifactId);
    const artifact = available[artifactId];
    if (artifact !== undefined) {
      artifacts.push(artifact);
    }
  };

  for (const dependency of task.dependsOn) {
    add(playbook.tasks.find((candidate) => candidate.id === dependency)?.produces);
  }
  // Inputs the phase did not produce — an earlier phase's artifact, or an
  // operator dialogue held outside any playbook.
  for (const consumed of task.consumes) {
    add(consumed);
  }

  return artifacts;
}

export async function runPhase(options: PhaseRunOptions): Promise<PhaseResult> {
  const { runId, playbook, log } = options;

  // Checked before the phase is recorded as entered. A refused attempt that
  // still logged PhaseEntered would leave the log claiming a phase was entered
  // twice when the first attempt never dispatched anything.
  const initial = runControl(options.projector.project(), runId);
  if (initial !== 'running') {
    return { outcome: { status: 'stopped', control: initial }, produced: {} };
  }

  log.append({ runId, type: 'PhaseEntered', payload: { phase: playbook.phase } });

  const produced: Record<string, Artifact> = {};
  const outputs: Record<string, unknown> = {};

  // Load the artifacts this phase reads but does not write. A required input
  // that is absent blocks the phase: running anyway is how a phase produces a
  // confident artifact about material it never saw.
  const available: Record<string, Artifact> = {};
  for (const [inputId, template] of Object.entries(playbook.inputs)) {
    try {
      available[inputId] = options.artifacts.read(template.path);
    } catch (cause) {
      if (!template.optional) {
        return {
          outcome: {
            status: 'blocked',
            taskId: '(inputs)',
            reason:
              `required input '${inputId}' is missing at '${template.path}': ` +
              (cause instanceof Error ? cause.message : String(cause)),
          },
          produced,
        };
      }
    }
  }

  for (const taskId of playbook.order) {
    // Checked before every dispatch, not once at the start: an operator who
    // pauses mid-phase expects the current task to be the last one (HIL-3).
    const control = runControl(options.projector.project(), runId);
    if (control !== 'running') {
      return { outcome: { status: 'stopped', control }, produced };
    }

    const task = playbook.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw new Error(`playbook order names unknown task '${taskId}'`);
    }

    const role = options.roles.get(task.role);
    const context = assembleContext({
      task,
      upstream: upstreamOf(task, playbook, { ...available, ...produced }),
      kb: options.kb,
      policy: options.policy,
    });

    const outcome = await options.sessions.runTask({
      runId,
      taskId: task.id,
      role,
      prompt: context.prompt,
    });

    if (outcome.status !== 'completed') {
      return {
        outcome: { status: 'blocked', taskId: task.id, reason: outcome.reason },
        produced,
      };
    }

    // The task's own output is evidence for the gate — what it concluded,
    // not merely that it ran.
    outputs[task.id] = outcome.output;

    if (task.produces !== undefined) {
      const template = playbook.artifacts[task.produces];
      if (template === undefined) {
        throw new Error(
          `task '${task.id}' produces undeclared artifact '${task.produces}'`,
        );
      }
      const provenance: Provenance = {
        task: task.id,
        role: role.name,
        model: role.model,
        runId,
      };
      produced[task.produces] = options.artifacts.write({
        id: task.produces,
        basePath: template.path,
        schema: template.schema,
        data: outcome.output,
        producedBy: provenance,
      });
    }
  }

  const evidence: GateEvidence = { artifacts: produced, outputs };
  return {
    outcome: {
      status: 'gate-presented',
      packet: options.gates.present(runId, playbook, evidence),
    },
    produced,
  };
}
