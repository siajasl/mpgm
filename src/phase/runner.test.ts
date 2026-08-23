import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OutputSchemaRegistry } from '../agent/output-registry.js';
import { SessionRunner } from '../agent/runner.js';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
} from '../agent/session.js';
import { scriptedSuccess } from '../agent/scripted-provider.js';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { ArtifactStore } from '../artifact/store.js';
import { DEFAULT_EGRESS_POLICY } from '../context/egress.js';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { GateManager } from '../gate/manager.js';
import { parsePlaybook } from '../playbook/loader.js';
import { parseRole } from '../role/loader.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { RoleRegistry } from '../role/loader.js';
import { runPhase } from './runner.js';

const tempDirs: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-phase-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function role(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} for phase tests`,
    'model: claude-sonnet-5',
    'tools: { allow: [Read] }',
    'budgets: { tokens: 100000, costUsd: 5, steps: 10, wallClockSeconds: 600 }',
    'output: { schema: note }',
    '---',
    `You are the ${name}.`,
  ].join('\n');
}

const roles = new RoleRegistry(
  ['analyst', 'researcher', 'judge', 'reviewer'].map((name) =>
    parseRole(`${name}.md`, role(name)),
  ),
);

/**
 * A provider that answers by prompt content and reports what the scheduler
 * actually did. Concurrency is measured here, outside the code under test.
 */
class ProbeProvider implements AgentSessionProvider {
  readonly seen: string[] = [];
  #inFlight = 0;
  peak = 0;

  constructor(
    private readonly reply: (prompt: string) => unknown,
    private readonly delayMs = 1,
  ) {}

  async run(request: SessionRequest): Promise<SessionResult> {
    this.seen.push(request.prompt);
    this.#inFlight += 1;
    this.peak = Math.max(this.peak, this.#inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.#inFlight -= 1;
    return scriptedSuccess(this.reply(request.prompt));
  }
}

const noteSchema = z.object({ note: z.string() });
const voteSchema = z.object({ note: z.string(), pick: z.string().optional() });

function harness(provider: AgentSessionProvider) {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  const artifacts = new ArtifactStore({
    root: newRoot(),
    schemas: new ArtifactSchemaRegistry([
      defineArtifactSchema('note', noteSchema),
      defineArtifactSchema('vote', z.looseObject({ carried: z.boolean() })),
    ]),
  });
  const sessions = new SessionRunner({
    log,
    provider,
    schemas: new OutputSchemaRegistry({ note: voteSchema }),
  });

  log.append({
    runId: 'run-1',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });

  return {
    db,
    log,
    projector,
    common: {
      runId: 'run-1',
      roles,
      artifacts,
      sessions,
      gates: new GateManager({ log, projector }),
      log,
      projector,
      kb: [],
      policy: DEFAULT_EGRESS_POLICY,
    },
  };
}

const FAN_OUT = `
phase: scope
description: a phase with a fan-out
artifacts:
  survey:
    schema: note
    path: artifacts/survey.md
    description: the survey
tasks:
  - kind: fan-out
    id: explore
    description: explore the problem
    workers:
      role: researcher
      prompt: MARK-WORKER explore it
      count: 4
    collect:
      role: analyst
      prompt: MARK-COLLECT reconcile them
      produces: survey
gate:
  id: scope-gate
  description: the survey exists
  criteria:
    - id: c
      kind: artifact-exists
      description: survey exists
      artifact: survey
`;

describe('runPhase over a fan-out', () => {
  it('runs the workers concurrently, within the configured cap', async () => {
    const provider = new ProbeProvider(() => ({ note: 'ok' }), 5);
    const { db, common } = harness(provider);
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', FAN_OUT),
        concurrency: 2,
      });

      expect(result.outcome.status).toBe('gate-presented');
      expect(provider.seen).toHaveLength(5);
      // Four workers, cap of two: the cap held and was actually used.
      expect(provider.peak).toBe(2);
    } finally {
      db.close();
    }
  });

  it('gives the collector every worker result, and none of their transcripts', async () => {
    let finding = 0;
    const provider = new ProbeProvider((prompt) => {
      if (prompt.includes('MARK-COLLECT')) {
        return { note: 'reconciled' };
      }
      finding += 1;
      return { note: `finding ${String(finding)}` };
    });
    const { db, common } = harness(provider);
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', FAN_OUT),
        concurrency: 4,
      });

      const collectPrompt = provider.seen.find((prompt) =>
        prompt.includes('MARK-COLLECT'),
      );
      expect(collectPrompt).toContain('## Upstream results');
      for (const index of [1, 2, 3, 4]) {
        expect(collectPrompt).toContain(`explore-worker-${String(index)}`);
      }
      // The collector's own output is what becomes the artifact.
      expect(result.produced.survey?.data).toStrictEqual({ note: 'reconciled' });
    } finally {
      db.close();
    }
  });

  it('blocks the phase when a worker blocks, without dispatching the collector', async () => {
    const provider = new ProbeProvider((prompt) =>
      prompt.includes('member 2 of 4') ? { note: 42 } : { note: 'ok' },
    );
    const { db, common } = harness(provider);
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', FAN_OUT),
        concurrency: 1,
      });

      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.taskId).toBe(
        'explore-worker-2',
      );
      expect(provider.seen.some((prompt) => prompt.includes('MARK-COLLECT'))).toBe(false);
      expect(result.produced.survey).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

const PANEL = `
phase: scope
description: a phase with a panel
artifacts:
  decision:
    schema: vote
    path: artifacts/decision.md
    description: the decision
tasks:
  - kind: panel
    id: select
    description: pick an approach
    judges:
      role: judge
      prompt: MARK-JUDGE judge the candidates
      count: 3
    ballot:
      type: choice
      field: pick
      options: [event-sourced, crud]
    vote: plurality
    produces: decision
gate:
  id: scope-gate
  description: the panel decided
  criteria:
    - id: decided
      kind: vote-carried
      description: the panel reached a decision
      panel: select
`;

describe('runPhase over a panel', () => {
  it('counts the ballots itself, logs the count, and lets the gate read it', async () => {
    let cast = 0;
    const provider = new ProbeProvider(() => {
      cast += 1;
      return { note: 'judged', pick: cast === 3 ? 'crud' : 'event-sourced' };
    });
    const { db, log, projector, common } = harness(provider);
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', PANEL),
      });

      // Three judges dispatched; the tally made no fourth model call.
      expect(provider.seen).toHaveLength(3);

      const tallied = log.read({ type: 'VoteTallied' });
      expect(tallied).toHaveLength(1);
      expect(tallied[0]?.payload).toMatchObject({
        taskId: 'select-tally',
        node: 'select',
        rule: 'plurality',
        carried: true,
      });

      // Folded state carries it too, so `status` can show it without replaying
      // the judges' sessions.
      expect(projector.project().runs['run-1']?.votes['select-tally']).toMatchObject({
        carried: true,
        node: 'select',
      });

      expect(result.outcome.status).toBe('gate-presented');
      const packet = result.outcome.status === 'gate-presented' && result.outcome.packet;
      expect(packet && packet.criteria[0]).toMatchObject({ id: 'decided', met: true });
      expect(packet && packet.criteria[0]?.detail).toContain('event-sourced');
    } finally {
      db.close();
    }
  });

  it('leaves the criterion unmet when the panel ties', async () => {
    const picks = ['event-sourced', 'crud', 'neither-of-them'];
    let cast = 0;
    const provider = new ProbeProvider(() => {
      const pick = picks[cast] ?? 'crud';
      cast += 1;
      return { note: 'judged', pick };
    });
    const { db, common } = harness(provider);
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', PANEL),
      });

      // One vote each and one spoiled ballot: no winner, and the gate says so
      // rather than picking whichever option was listed first.
      const packet = result.outcome.status === 'gate-presented' && result.outcome.packet;
      expect(packet && packet.criteria[0]?.met).toBe(false);
      expect(packet && packet.allMet).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('runPhase under operator control', () => {
  it('stops dispatching when the operator pauses mid-phase', async () => {
    const operator: { intervene?: () => void } = {};
    const provider = new ProbeProvider(() => {
      operator.intervene?.();
      return { note: 'ok' };
    });
    const { db, log, common } = harness(provider);
    operator.intervene = () => {
      log.append({
        runId: 'run-1',
        type: 'OperatorIntervened',
        payload: { action: 'pause', detail: 'operator stepped in' },
      });
    };

    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', FAN_OUT),
        concurrency: 1,
      });

      expect(result.outcome).toStrictEqual({ status: 'stopped', control: 'paused' });
      // One worker ran; the pause was seen before the second was dispatched
      // rather than at the end of the phase (HIL-3).
      expect(provider.seen).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('reports a kill as a kill, not as a pause', async () => {
    const operator: { intervene?: () => void } = {};
    const provider = new ProbeProvider(() => {
      operator.intervene?.();
      return { note: 'ok' };
    });
    const { db, log, common } = harness(provider);
    operator.intervene = () => {
      log.append({
        runId: 'run-1',
        type: 'OperatorIntervened',
        payload: { action: 'kill', detail: 'stop everything' },
      });
    };

    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', FAN_OUT),
        concurrency: 1,
      });

      expect(result.outcome).toStrictEqual({ status: 'stopped', control: 'killed' });
    } finally {
      db.close();
    }
  });
});

const PIPELINE = `
phase: scope
description: a phase with a pipeline
artifacts:
  final:
    schema: note
    path: artifacts/final.md
    description: the final note
tasks:
  - kind: pipeline
    id: refine
    description: refine the note
    stages:
      - id: draft
        role: analyst
        description: draft it
        prompt: MARK-DRAFT draft the note
      - id: polish
        role: reviewer
        description: polish it
        prompt: MARK-POLISH polish the note
        produces: final
gate:
  id: scope-gate
  description: the note exists
  criteria:
    - id: c
      kind: artifact-exists
      description: the note exists
      artifact: final
`;

describe('runPhase over a pipeline', () => {
  it('feeds each stage the previous stage result', async () => {
    const provider = new ProbeProvider((prompt) =>
      prompt.includes('MARK-DRAFT') ? { note: 'rough draft' } : { note: 'polished' },
    );
    const { db, common } = harness(provider);
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', PIPELINE),
        concurrency: 4,
      });

      const polish = provider.seen.find((prompt) => prompt.includes('MARK-POLISH'));
      expect(polish).toContain('refine-draft');
      expect(polish).toContain('rough draft');
      // Stages are sequential however much room the cap allows.
      expect(provider.peak).toBe(1);
      expect(result.produced.final?.data).toStrictEqual({ note: 'polished' });
    } finally {
      db.close();
    }
  });
});
