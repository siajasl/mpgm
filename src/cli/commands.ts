import { join } from 'node:path';
import type { AgentSessionProvider } from '../agent/session.js';
import { SessionRunner } from '../agent/runner.js';
import type { OutputSchemaRegistry } from '../agent/output-registry.js';
import { ArtifactStore } from '../artifact/store.js';
import type { ArtifactSchemaRegistry } from '../artifact/schema-registry.js';
import { DEFAULT_EGRESS_POLICY, type EgressPolicy } from '../context/egress.js';
import { loadKnowledgeBase, type KbDocument } from '../context/knowledge-base.js';
import { openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { elicit, type OperatorIo } from '../elicit/session.js';
import { GateManager, gateOracleFromState } from '../gate/manager.js';
import { runPhase } from '../phase/runner.js';
import { PlaybookRegistry } from '../playbook/loader.js';
import { RoleRegistry } from '../role/loader.js';
import { Projector } from '../state/projector.js';
import { fold } from '../state/reduce.js';
import { SnapshotStore } from '../state/snapshot-store.js';

/**
 * Operator console verbs (DESIGN §4.4, HIL-3).
 *
 * Every verb is a function of a context, so the same code path the operator
 * drives is the one the end-to-end script drives. A CLI that could only be
 * exercised by a human would be a CLI nobody tests.
 */

export interface CliContext {
  /** Project root; the log lives at `<root>/.mpgm/state.db`. */
  readonly root: string;
  readonly provider: AgentSessionProvider;
  readonly io: OperatorIo;
  readonly outputSchemas: OutputSchemaRegistry;
  readonly artifactSchemas: ArtifactSchemaRegistry;
  readonly policy?: EgressPolicy;
  /** Defaults to `<root>/kb`, when it exists. */
  readonly kb?: readonly KbDocument[];
  readonly write: (line: string) => void;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly detail: string;
}

function open(context: CliContext) {
  const db = openDatabase(join(context.root, '.mpgm', 'state.db'));
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  return { db, log, projector };
}

function knowledgeBase(context: CliContext): readonly KbDocument[] {
  if (context.kb !== undefined) {
    return context.kb;
  }
  try {
    return loadKnowledgeBase(join(context.root, 'kb'));
  } catch {
    return [];
  }
}

/** `mpgm run <phase>` — execute a phase and present its gate. */
export async function run(
  context: CliContext,
  runId: string,
  phase: string,
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: 'operator' },
      });
    }

    const playbook = PlaybookRegistry.fromDirectory(join(context.root, 'phases')).get(
      phase,
    );
    const roles = RoleRegistry.fromDirectory(join(context.root, 'roles'));
    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
      gates: gateOracleFromState(projector.project(), runId),
    });

    const result = await runPhase({
      runId,
      playbook,
      roles,
      artifacts,
      sessions: new SessionRunner({
        log,
        provider: context.provider,
        schemas: context.outputSchemas,
        policyRoot: context.root,
      }),
      gates: new GateManager({ log }),
      log,
      projector,
      kb: knowledgeBase(context),
      policy: context.policy ?? DEFAULT_EGRESS_POLICY,
    });

    if (result.outcome.status === 'stopped') {
      context.write(`run ${runId} is ${result.outcome.control}; nothing dispatched`);
      return { ok: false, detail: result.outcome.control };
    }

    if (result.outcome.status === 'blocked') {
      context.write(`task ${result.outcome.taskId} blocked: ${result.outcome.reason}`);
      return { ok: false, detail: result.outcome.reason };
    }

    const packet = result.outcome.packet;
    context.write(`\nGate: ${packet.gateId} (${packet.phase})`);
    context.write(packet.description.trim());
    context.write('\nCriteria');
    for (const criterion of packet.criteria) {
      context.write(
        `  ${criterion.met ? 'met ' : 'UNMET'}  ${criterion.id}: ${criterion.detail}`,
      );
    }
    context.write('\nOptions');
    for (const option of packet.options) {
      context.write(`  - ${option}`);
    }
    context.write('\nTrade-offs');
    for (const tradeOff of packet.tradeOffs) {
      context.write(`  - ${tradeOff}`);
    }
    context.write(`\nRecommendation: ${packet.recommendation}`);
    context.write(
      packet.autoApproved
        ? '\nAuto-approved per playbook.'
        : `\nApprove with: mpgm approve ${packet.gateId} --by <you>`,
    );

    return { ok: true, detail: packet.gateId };
  } finally {
    db.close();
  }
}

/** `mpgm status` — folded run state (OBS-3). */
export function status(context: CliContext, runId?: string): CommandResult {
  const { db, projector } = open(context);
  try {
    const state = projector.project();
    const runs = runId === undefined ? Object.values(state.runs) : [state.runs[runId]];

    if (runs.length === 0 || runs[0] === undefined) {
      context.write('no runs');
      return { ok: true, detail: 'no runs' };
    }

    for (const current of runs) {
      if (current === undefined) {
        continue;
      }
      context.write(
        `run ${current.runId} [${current.control}] phase=${current.currentPhase ?? '-'}`,
      );
      context.write(
        `  spend $${current.usage.costUsd.toFixed(4)}  ` +
          `tokens ${String(current.usage.inputTokens + current.usage.outputTokens)}  ` +
          `interventions ${String(current.interventions)}`,
      );
      for (const task of Object.values(current.tasks)) {
        context.write(
          `  task ${task.taskId} ${task.status} (${task.role} on ${task.model})`,
        );
      }
      for (const gate of Object.values(current.gates)) {
        context.write(
          `  gate ${gate.gateId} ${gate.status}${gate.decidedBy === null ? '' : ` by ${gate.decidedBy}`}`,
        );
      }
    }

    return { ok: true, detail: `seq ${String(state.lastSeq)}` };
  } finally {
    db.close();
  }
}

/** `mpgm pause|resume|kill|redirect` — operator control, recorded (HIL-3, HIL-5). */
export function intervene(
  context: CliContext,
  runId: string,
  action: 'pause' | 'resume' | 'kill' | 'redirect',
  detail = '',
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      context.write(`no such run: ${runId}`);
      return { ok: false, detail: 'unknown run' };
    }

    log.append({ runId, type: 'OperatorIntervened', payload: { action, detail } });
    const control = projector.project().runs[runId]?.control ?? 'running';
    context.write(`run ${runId} is now ${control}`);
    return { ok: true, detail: control };
  } finally {
    db.close();
  }
}

/** `mpgm approve <gate>` — record a gate decision (HIL-5). */
export function approve(
  context: CliContext,
  runId: string,
  gateId: string,
  by: string,
  reject = false,
  reason = '',
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const gates = new GateManager({ log });
    if (reject) {
      gates.reject(runId, gateId, by, reason);
    } else {
      gates.approve(runId, gateId, by);
    }
    const status = projector.project().runs[runId]?.gates[gateId]?.status ?? 'unknown';
    context.write(`gate ${gateId} ${status} by ${by}`);
    return { ok: true, detail: status };
  } finally {
    db.close();
  }
}

/** `mpgm chat <phase>` — operator elicitation (DEF-1). */
export async function chat(
  context: CliContext,
  runId: string,
  phase: string,
  brief = '',
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: 'operator' },
      });
    }

    const roles = RoleRegistry.fromDirectory(join(context.root, 'roles'));
    const elicitor = roles.get('elicitor');

    // Dispatch before completion: the elicitation is a task like any other,
    // and recording it is what makes its spend attributable and the run
    // reconstructable from the log alone.
    log.append({
      runId,
      type: 'TaskDispatched',
      payload: { taskId: 'elicit', role: elicitor.name, model: elicitor.model },
    });

    const result = await elicit({
      provider: context.provider,
      role: elicitor,
      io: context.io,
      brief,
    });

    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
      gates: gateOracleFromState(projector.project(), runId),
    });
    const artifact = artifacts.write({
      id: `${phase}-elicitation`,
      basePath: `artifacts/${phase}/elicitation.md`,
      schema: 'elicitation',
      data: { conclusions: result.conclusions, transcript: result.transcript },
      producedBy: {
        task: 'elicit',
        role: 'elicitor',
        model: elicitor.model,
        runId,
      },
    });

    log.append({
      runId,
      type: 'TaskCompleted',
      payload: {
        taskId: 'elicit',
        artifactRefs: [
          {
            id: artifact.id,
            path: artifact.path,
            commit: null,
            version: artifact.version,
          },
        ],
      },
    });

    context.write(
      `elicitation complete after ${String(result.turns)} turns → ${artifact.path}`,
    );
    return { ok: true, detail: artifact.path };
  } finally {
    db.close();
  }
}

/**
 * `mpgm replay` — re-derive state from the log alone (ORC-3).
 *
 * Folds from seq 1 with snapshots ignored, and reports whether the result
 * matches the projector's. A divergence means state was reached by some path
 * other than the log, which is the one thing event sourcing is supposed to
 * make impossible.
 */
export function replay(context: CliContext, runId?: string): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const events = log.read();
    const replayed = fold(events);
    const projected = projector.rebuild();
    const matches = JSON.stringify(replayed) === JSON.stringify(projected);

    context.write(`replayed ${String(events.length)} events`);
    for (const event of events) {
      if (runId !== undefined && event.runId !== runId) {
        continue;
      }
      context.write(`  ${String(event.seq).padStart(4)}  ${event.ts}  ${event.type}`);
    }
    context.write(
      matches
        ? 'replay reproduces the run exactly'
        : 'REPLAY DIVERGED from the projected state',
    );

    return { ok: matches, detail: matches ? 'identical' : 'diverged' };
  } finally {
    db.close();
  }
}
