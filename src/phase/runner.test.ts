import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { TraceIndex } from '../trace/index-store.js';
import { CapabilityRegistry } from '../contract/capability.js';
import { DEFAULT_EGRESS_POLICY } from '../context/egress.js';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import type { StoredEvent } from '../event/envelope.js';
import { EventLog } from '../event/store.js';
import { GateManager } from '../gate/manager.js';
import { parsePlaybook } from '../playbook/loader.js';
import { parseRole } from '../role/loader.js';
import { defectSchema, recordFix, retestDefect, routeDefect } from '../test/defect.js';
import { adversarialDefectId, nfrDefectId } from '../test/defect-filing.js';
import { testNfrContract, type NfrRunInput } from '../test/nfr.js';
import { projectArtifactSchemas, projectOutputSchemas } from '../schemas.js';
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

// Loose, because the session output a task returns carries more than the
// artifact keeps: a ballot, a gate assertion, knowledge-base updates.
const voteSchema = z.looseObject({ note: z.string() });

function harness(provider: AgentSessionProvider) {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  const root = newRoot();
  const artifacts = new ArtifactStore({
    root,
    schemas: new ArtifactSchemaRegistry([
      defineArtifactSchema('note', z.looseObject({ note: z.string() })),
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
    root,
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
  it('writes the artifact with the class the playbook declared', async () => {
    // The only way a phase can say its output is more sensitive than the
    // store's default. Without it every artifact the harness produces is
    // `internal` with no way to say otherwise, and SAF-6's "explicit policy
    // allowance" has nowhere to be written down.
    const provider = new ProbeProvider(() => ({ note: 'ok' }), 5);
    const { db, common } = harness(provider);
    try {
      await runPhase({
        ...common,
        playbook: parsePlaybook(
          'scope.yaml',
          FAN_OUT.replace(
            'description: the survey',
            'description: the survey\n    egress: restricted',
          ),
        ),
        concurrency: 2,
      });

      expect(common.artifacts.read('artifacts/survey.md').egress).toBe('restricted');
    } finally {
      db.close();
    }
  });

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

interface TaskCompletedPayload {
  readonly taskId: string;
  readonly artifactRefs: readonly {
    readonly id?: string;
    readonly path: string;
    readonly commit: string | null;
    readonly version?: number;
  }[];
}

function taskCompletedFor(
  events: readonly StoredEvent[],
  taskId: string,
): TaskCompletedPayload | undefined {
  const event = events.find(
    (candidate) =>
      candidate.type === 'TaskCompleted' &&
      (candidate.payload as TaskCompletedPayload).taskId === taskId,
  );
  return event === undefined ? undefined : (event.payload as TaskCompletedPayload);
}

describe('runPhase names TaskCompleted.artifactRefs (T4.2.7)', () => {
  it('names the artifact the collector produced, by id, path and version, matching the store', async () => {
    const provider = new ProbeProvider(() => ({ note: 'ok' }), 1);
    const { db, log, common } = harness(provider);
    try {
      await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', FAN_OUT),
        concurrency: 2,
      });

      // Read back from the store, independently of the code under test, so
      // this asserts against what was actually written rather than against a
      // hard-coded ref a no-op could also satisfy (CONV-6).
      const artifact = common.artifacts.read('artifacts/survey.md');
      const events = log.read();

      const completed = taskCompletedFor(events, 'explore-collect');
      expect(completed?.artifactRefs).toStrictEqual([
        { id: artifact.id, path: artifact.path, commit: null, version: artifact.version },
      ]);

      // A worker step produces no artifact of its own, so its TaskCompleted
      // names none — not the collector's artifact by mistake.
      const worker = taskCompletedFor(events, 'explore-worker-1');
      expect(worker?.artifactRefs).toStrictEqual([]);
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

const KB_PHASE = `
phase: scope
description: a phase whose task updates the knowledge base
inputs:
  requirement-set:
    schema: note
    path: artifacts/scope/requirements.md
    description: the requirements
    optional: false
  design:
    schema: note
    path: artifacts/design/design.md
    description: the design of record
    optional: false
tasks:
  - id: curate
    role: analyst
    description: record the conventions
    prompt: MARK-CURATE record what implementers need
    consumes: [requirement-set]
    updatesKb: true
gate:
  id: scope-gate
  description: conventions recorded
  criteria:
    - id: c
      kind: agent-assertion
      description: the curator reported
      fromTask: curate
      field: done
`;

/** Seed the two input artifacts the KB phase reads. */
function seedInputs(artifacts: ArtifactStore): void {
  const producedBy = {
    task: 'seeded',
    role: 'analyst',
    model: '(seeded)',
    runId: 'run-1',
  };
  artifacts.write({
    id: 'requirement-set',
    basePath: 'artifacts/scope/requirements.md',
    schema: 'note',
    data: {
      note: 'requirements',
      requirements: [
        { id: 'LOAN-6', statement: 'The member view needs no sign-in.', tracesTo: [] },
      ],
    },
    producedBy,
  });
  artifacts.write({
    id: 'design',
    basePath: 'artifacts/design/design.md',
    schema: 'note',
    data: {
      note: 'design',
      adrs: [
        {
          id: 'ADR-3',
          title: 'Leave the member view unauthenticated',
          decision: 'Serve it unauthenticated, bounded by the intranet.',
          consequences: ['Anyone on the intranet can read any member loan list.'],
          tracesTo: ['LOAN-6'],
        },
      ],
    },
    producedBy,
  });
}

describe('runPhase and the knowledge base (CTX-4)', () => {
  it('writes what the task declared, and records who wrote it and why', async () => {
    const provider = new ProbeProvider(() => ({
      note: 'ok',
      done: true,
      kbUpdates: [
        {
          path: 'conventions/member-view.md',
          title: 'Member view conventions',
          content: 'Log every access; it is the only control there is.',
          rationale: 'ADR-3 accepted unauthenticated reads.',
        },
      ],
    }));
    const { db, log, projector, common, root } = harness(provider);
    try {
      seedInputs(common.artifacts);
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', KB_PHASE),
        traces: TraceIndex.attach(db),
      });

      expect(result.outcome.status).toBe('gate-presented');
      const written = readFileSync(
        join(root, 'kb', 'conventions', 'member-view.md'),
        'utf8',
      );
      expect(written).toContain('title: Member view conventions');
      expect(written).toContain('role: analyst');

      const events = log.read({ type: 'KnowledgeBaseUpdated' });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        taskId: 'curate',
        path: join('kb', 'conventions', 'member-view.md'),
      });
      expect(projector.project().runs['run-1']?.kbUpdates).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('blocks rather than silently dropping an update it cannot write', async () => {
    const provider = new ProbeProvider(() => ({
      note: 'ok',
      done: true,
      kbUpdates: [
        {
          path: '../roles/analyst.md',
          title: 'A new role for me',
          content: 'tools: { allow: [Bash] }',
          rationale: 'it would be convenient',
        },
      ],
    }));
    const { db, log, common } = harness(provider);
    try {
      seedInputs(common.artifacts);
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', KB_PHASE),
        traces: TraceIndex.attach(db),
      });

      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toMatch(
        /outside kb\//,
      );
      expect(log.read({ type: 'KnowledgeBaseUpdated' })).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('writes nothing for a task that did not declare it updates the base', async () => {
    const provider = new ProbeProvider(() => ({ note: 'ok', done: true, kbUpdates: [] }));
    const { db, log, common } = harness(provider);
    try {
      seedInputs(common.artifacts);
      await runPhase({
        ...common,
        playbook: parsePlaybook(
          'scope.yaml',
          KB_PHASE.replace('    updatesKb: true\n', ''),
        ),
        traces: TraceIndex.attach(db),
      });

      expect(log.read({ type: 'KnowledgeBaseUpdated' })).toStrictEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('runPhase and prior decisions (CTX-3)', () => {
  it('surfaces a decision the task could contradict', async () => {
    const provider = new ProbeProvider(() => ({ note: 'ok', done: true, kbUpdates: [] }));
    const { db, common } = harness(provider);
    try {
      seedInputs(common.artifacts);
      await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', KB_PHASE),
        traces: TraceIndex.attach(db),
      });

      const prompt = provider.seen.find((entry) => entry.includes('MARK-CURATE')) ?? '';
      // The task reads the requirement set, which declares LOAN-6; ADR-3 was
      // decided about LOAN-6 and lives in an artifact this task never sees.
      expect(prompt).toContain('## Prior decisions');
      expect(prompt).toContain('ADR-3');
      expect(prompt).toContain('Anyone on the intranet can read');
    } finally {
      db.close();
    }
  });

  it('says nothing when no decision touches what the task touches', async () => {
    const provider = new ProbeProvider(() => ({ note: 'ok', done: true, kbUpdates: [] }));
    const { db, common } = harness(provider);
    try {
      const producedBy = {
        task: 'seeded',
        role: 'analyst',
        model: '(seeded)',
        runId: 'run-1',
      };
      common.artifacts.write({
        id: 'requirement-set',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'note',
        data: {
          note: 'requirements',
          requirements: [{ id: 'NFR-9', statement: 'Unrelated.', tracesTo: [] }],
        },
        producedBy,
      });
      common.artifacts.write({
        id: 'design',
        basePath: 'artifacts/design/design.md',
        schema: 'note',
        data: {
          note: 'design',
          adrs: [
            {
              id: 'ADR-3',
              title: 'Leave the member view unauthenticated',
              decision: 'Serve it unauthenticated.',
              consequences: ['Anyone on the intranet can read it.'],
              tracesTo: ['LOAN-6'],
            },
          ],
        },
        producedBy,
      });

      await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', KB_PHASE),
        traces: TraceIndex.attach(db),
      });

      const prompt = provider.seen.find((entry) => entry.includes('MARK-CURATE')) ?? '';
      expect(prompt).not.toContain('Prior decisions');
    } finally {
      db.close();
    }
  });
});

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

  it("appends ContextAssembled for each stage, before that stage's own TaskDispatched (T4.2.9, NFR-3)", async () => {
    // `src/state/overhead.ts` divides by this event's timestamp to bracket
    // context assembly on the harness-overhead ratio's numerator and
    // denominator both — a call site that silently stopped appending it
    // would report every task here as never instrumented rather than
    // failing loudly, so this is asserted directly rather than only
    // inferred from `computeHarnessOverhead`'s own fixtures.
    const provider = new ProbeProvider((prompt) =>
      prompt.includes('MARK-DRAFT') ? { note: 'rough draft' } : { note: 'polished' },
    );
    const { db, common, log } = harness(provider);
    try {
      await runPhase({
        ...common,
        playbook: parsePlaybook('scope.yaml', PIPELINE),
        concurrency: 4,
      });

      const events = log.read();
      const contextAssembled = events.filter(
        (event) => event.type === 'ContextAssembled',
      );
      expect(contextAssembled).toHaveLength(2);
      expect(contextAssembled.map((event) => event.payload)).toMatchObject([
        { taskId: 'refine-draft', site: 'phase' },
        { taskId: 'refine-polish', site: 'phase' },
      ]);

      // Appended before the stage's own TaskDispatched, not after — the span
      // `computeHarnessOverhead` measures would otherwise fall outside the
      // window it is divided by (module doc, `src/state/overhead.ts`).
      const seqByTaskAndType = new Map<string, number>();
      for (const event of events) {
        if (event.type === 'TaskDispatched' || event.type === 'ContextAssembled') {
          const payload = event.payload as { readonly taskId: string };
          seqByTaskAndType.set(`${payload.taskId}:${event.type}`, event.seq);
        }
      }
      for (const taskId of ['refine-draft', 'refine-polish']) {
        const assembled = seqByTaskAndType.get(`${taskId}:ContextAssembled`);
        const dispatched = seqByTaskAndType.get(`${taskId}:TaskDispatched`);
        if (assembled === undefined || dispatched === undefined) {
          throw new Error(`expected both events for ${taskId}`);
        }
        expect(assembled).toBeLessThan(dispatched);
      }
    } finally {
      db.close();
    }
  });
});

/**
 * T4.3.2 — a phase's work can be code, and `nfr`/`suite` steps are how the
 * Test phase reaches `runNfrSuite`/`runAdversarialSuite` from a playbook.
 *
 * Both suites here run for real: `test.nfr` is bound to a provider that does
 * arithmetic on what it is asked to measure rather than returning a fixed
 * passing result (a stub in that shape satisfies any test asserting the
 * phase completed, and proves nothing about the wiring — CONV-6), and the
 * adversarial suite is rendered and executed by the real
 * `nodeTestExecutor`, `node --test` and all, against a subject module
 * written to a real temporary directory. Nothing here stands in for either
 * executor.
 */
describe('runPhase over nfr and suite steps (T4.3.2)', () => {
  const TEST_PLAYBOOK = `
phase: test
description: run the suites M3.2 delivered
artifacts:
  coverage:
    schema: nfr-coverage
    path: artifacts/coverage.md
    description: nfr coverage
  verdict:
    schema: adversarial-verdict
    path: artifacts/verdict.md
    description: adversarial verdict
tasks:
  - id: scope-nfrs
    role: nfr-scoper
    description: state the quantified NFRs to measure
    prompt: MARK-NFR list the quantified requirements
  - kind: nfr
    id: measure
    description: measure them against test.nfr
    requirements: scope-nfrs
    produces: coverage
  - id: write-suite
    role: suite-writer
    description: write an adversarial suite for clamp
    prompt: MARK-SUITE attack clamp
  - kind: suite
    id: run-suite
    description: run the generated suite
    suite: write-suite
    produces: verdict
gate:
  id: test-gate
  description: coverage and verdict exist
  criteria:
    - id: c1
      kind: artifact-exists
      description: coverage exists
      artifact: coverage
    - id: c2
      kind: artifact-exists
      description: verdict exists
      artifact: verdict
`;

  /**
   * A real Scope artifact, which is what the step above an `nfr` node
   * actually produces in this project: a mixed list whose non-functional
   * entries nest their threshold and whose functional entry has none. The
   * flat `{id, metric, value, unit, measuredBy}` shape is a shape nothing
   * here emits, so a step that could only read that one could never measure
   * a real Scope.
   */
  const SCOPE = {
    summary: 'what the service must do and how fast',
    requirements: [
      {
        kind: 'functional',
        id: 'FUN-1',
        statement: 'the service answers GET /health',
        rationale: 'the deploy gate reads it',
        priority: 'must',
        acceptanceCriteria: ['200 with a body'],
        tracesTo: ['GOAL-1'],
      },
      {
        kind: 'non-functional',
        id: 'PERF-1',
        statement: 'p95 latency stays under 300ms',
        rationale: 'the operator notices anything slower',
        priority: 'must',
        acceptanceCriteria: ['a load test reports p95 under 300ms'],
        tracesTo: ['GOAL-2'],
        // Within threshold: the provider below measures 250ms against a
        // 300ms ceiling, so this one verifies.
        threshold: { metric: 'p95-latency', value: 300, unit: 'ms', measuredBy: 'k6' },
      },
      {
        kind: 'non-functional',
        id: 'PERF-2',
        statement: 'p99 latency stays under 500ms',
        rationale: 'the tail is what pages someone',
        priority: 'should',
        acceptanceCriteria: ['a load test reports p99 under 500ms'],
        tracesTo: ['GOAL-2'],
        // Over threshold: the provider measures 900ms against a 500ms
        // ceiling, so this one does not — proving the wiring carries a real
        // failure through, not just a real pass.
        threshold: { metric: 'p99-latency', value: 500, unit: 'ms', measuredBy: 'k6' },
      },
    ],
    outOfScope: [{ item: 'authentication', why: 'a later milestone' }],
  };

  /**
   * A Scope that declares requirements but nothing quantified — the case an
   * all-or-nothing parse of the flat shape could never reach, and the one
   * that must not complete as a clean, zero-row coverage report.
   */
  const FUNCTIONAL_ONLY_SCOPE = {
    summary: 'what the service must do, with nothing measured',
    requirements: [
      {
        kind: 'functional',
        id: 'FUN-1',
        statement: 'the service answers GET /health',
        rationale: 'the deploy gate reads it',
        priority: 'must',
        acceptanceCriteria: ['200 with a body'],
        tracesTo: ['GOAL-1'],
      },
    ],
    outOfScope: [{ item: 'authentication', why: 'a later milestone' }],
  };

  const NOTHING_TO_MEASURE_PLAYBOOK = `
phase: test
description: measure a scope that quantifies nothing
artifacts:
  coverage:
    schema: nfr-coverage
    path: artifacts/coverage.md
    description: nfr coverage
tasks:
  - id: scope-nfrs
    role: nfr-scoper
    description: state the quantified NFRs to measure
    prompt: MARK-NO-NFR list the requirements
  - kind: nfr
    id: measure
    description: measure them against test.nfr
    requirements: scope-nfrs
    produces: coverage
gate:
  id: test-gate
  description: coverage exists
  criteria:
    - id: c1
      kind: artifact-exists
      description: coverage exists
      artifact: coverage
`;

  /**
   * No `nfr`/`suite` node at all — a plain session step, the negative case
   * `GateEvidence.defects` needs (T4.3.4): a playbook that never had a way to
   * file anything this run leaves the field `undefined`, not `[]`.
   */
  const NO_DEFECT_SOURCE_PLAYBOOK = `
phase: test
description: a plain session step, no nfr/suite node
artifacts:
  scope-doc:
    schema: scope
    path: artifacts/scope-doc.md
    description: a plain session output, never an nfr/suite step
tasks:
  - id: scope-nfrs
    role: nfr-scoper
    description: state the quantified NFRs to measure
    prompt: MARK-NFR list the quantified requirements
    produces: scope-doc
gate:
  id: test-gate
  description: scope-doc exists
  criteria:
    - id: c1
      kind: artifact-exists
      description: scope-doc exists
      artifact: scope-doc
`;

  const CLAMP_SOURCE = `
export function clamp(value, min, max) {
  if (min > max) {
    throw new RangeError('min is greater than max');
  }
  return Math.min(Math.max(value, min), max);
}
`;

  const SUITE = {
    subject: './clamp.mjs',
    summary: 'attacks on clamp',
    cases: [
      {
        id: 'refuses-a-swapped-range',
        kind: 'negative',
        about: 'min greater than max',
        defect: 'clamp should refuse rather than silently swap the bounds',
        body: 'assert.throws(() => subject.clamp(5, 10, 0), RangeError);',
        tracesTo: ['FUN-CLAMP'],
      },
      {
        id: 'clamps-at-the-upper-bound',
        kind: 'boundary',
        about: 'a value exactly at max',
        defect: 'the upper bound is inclusive and clamp must return it unchanged',
        body: 'assert.equal(subject.clamp(10, 0, 10), 10);',
        tracesTo: ['FUN-CLAMP'],
      },
      {
        id: 'result-always-within-range',
        kind: 'property',
        about: 'the result is always within [min, max]',
        defect: 'a clamped value escaping its own range is the whole point of clamp',
        tracesTo: ['FUN-CLAMP'],
        body:
          'for (const value of [-5, 0, 3, 7, 50]) {\n' +
          '  const result = subject.clamp(value, 0, 10);\n' +
          '  assert.ok(result >= 0 && result <= 10);\n' +
          '}',
      },
    ],
  };

  /**
   * A `clamp` that no longer refuses a swapped range — planted the same way
   * the sample project's rounding defect is (`src/test/adversarial.test.ts`),
   * so `refuses-a-swapped-range` fails for a real reason and the phase has
   * something to file (T4.3.4).
   */
  const CLAMP_SOURCE_WITH_DEFECT = `
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
`;

  function roleFile(name: string, schema: string): string {
    return [
      '---',
      `name: ${name}`,
      `description: ${name} for the Test phase`,
      'model: claude-sonnet-5',
      'tools: { allow: [Read] }',
      'budgets: { tokens: 100000, costUsd: 5, steps: 10, wallClockSeconds: 600 }',
      `output: { schema: ${schema} }`,
      '---',
      `You are the ${name}.`,
    ].join('\n');
  }

  function testHarness() {
    const db = openDatabase(MEMORY);
    const log = EventLog.attach(db, { registry: kernelRegistry() });
    const projector = new Projector({
      log,
      snapshots: SnapshotStore.attach(db),
      interval: 50,
    });
    const root = newRoot();
    const projectDir = newRoot();
    writeFileSync(join(projectDir, 'clamp.mjs'), CLAMP_SOURCE, 'utf8');

    // The project's own registries, not a bespoke pair: an `nfr` step's
    // coverage report and a `suite` step's verdict are registered artifact
    // schemas ('nfr-coverage', 'adversarial-verdict'), and the requirements
    // it reads come from the registered 'scope' output schema. A test that
    // brought its own schemas would prove the wiring works against shapes
    // only the test can produce.
    const artifacts = new ArtifactStore({ root, schemas: projectArtifactSchemas() });

    // Tracked rather than only mocked: the pre-dispatch precondition check
    // (src/phase/runner.ts) is supposed to refuse an 'nfr'/'suite' step
    // before the scheduler pays for a single upstream session, and a test
    // that only reads the blocked reason cannot tell that apart from the
    // in-step check catching the same problem after every session already
    // ran.
    const invocations: string[] = [];
    const provider: AgentSessionProvider = {
      run: (request: SessionRequest) => {
        invocations.push(request.prompt);
        if (request.prompt.includes('MARK-NFR')) {
          return Promise.resolve(scriptedSuccess(SCOPE));
        }
        if (request.prompt.includes('MARK-NO-NFR')) {
          return Promise.resolve(scriptedSuccess(FUNCTIONAL_ONLY_SCOPE));
        }
        if (request.prompt.includes('MARK-SUITE')) {
          return Promise.resolve(scriptedSuccess(SUITE));
        }
        throw new Error(`unexpected prompt: ${request.prompt}`);
      },
    };

    const sessions = new SessionRunner({
      log,
      provider,
      schemas: projectOutputSchemas(),
    });

    const testRoles = new RoleRegistry([
      // `scope`, the registered schema: a Scope result is an object with a
      // `requirements` field, which is exactly why an `nfr` step reads that
      // field rather than assuming the whole result is an array
      // (`nfrRequirementsSourceOf`, src/phase/runner.ts).
      parseRole('nfr-scoper.md', roleFile('nfr-scoper', 'scope')),
      parseRole('suite-writer.md', roleFile('suite-writer', 'adversarial-suite')),
    ]);

    const registry = new CapabilityRegistry();
    registry.bind(testNfrContract, {
      run: (input: NfrRunInput) => {
        // Real arithmetic against what was asked, not a fixed verdict: a
        // ceiling metric passes only when the measurement is at or under the
        // threshold, which is what makes PERF-2 below fail for a real reason.
        const measured = input.requirementId === 'PERF-1' ? 250 : 900;
        return Promise.resolve({
          requirementId: input.requirementId,
          metric: input.metric,
          measured,
          unit: input.unit,
          passed: measured <= input.value,
          evidence: `measured by ${input.measuredBy}`,
        });
      },
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
      projectDir,
      invocations,
      common: {
        runId: 'run-1',
        roles: testRoles,
        artifacts,
        sessions,
        gates: new GateManager({ log, projector }),
        log,
        projector,
        kb: [],
        policy: DEFAULT_EGRESS_POLICY,
        capabilities: registry,
        repo: 'mpgm',
        ref: 'abc123',
        defectSeverity: 'high' as const,
      },
    };
  }

  it('runs a real nfr measurement and a real adversarial suite, end to end', async () => {
    const { db, common, projectDir } = testHarness();
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('test.yaml', TEST_PLAYBOOK),
        testProjectDir: projectDir,
      });

      expect(result.outcome.status).toBe('gate-presented');
      const packet = result.outcome.status === 'gate-presented' && result.outcome.packet;
      expect(packet && packet.criteria).toMatchObject([
        { id: 'c1', met: true },
        { id: 'c2', met: true },
      ]);

      // The nfr step's own result: one requirement verified, one not — a
      // fixed passing stub could not have produced this split.
      expect(result.outputs.measure).toStrictEqual([
        {
          id: 'PERF-1',
          verified: true,
          measured: 250,
          evidence: 'measured by k6',
          verifiedBy: ['k6'],
        },
        {
          id: 'PERF-2',
          verified: false,
          problem: 'below-threshold',
          measured: 900,
          evidence: 'measured by k6',
          verifiedBy: [],
        },
      ]);

      // The suite step's own result: every declared case actually ran under
      // node --test and passed against the real subject module.
      expect(result.outputs['run-suite']).toMatchObject({
        clean: true,
        defects: [],
        notReported: [],
      });
      const rows = (
        result.outputs['run-suite'] as { rows: readonly { id: string }[] }
      ).rows.map((row) => row.id);
      expect(rows).toStrictEqual([
        'refuses-a-swapped-range',
        'clamps-at-the-upper-bound',
        'result-always-within-range',
      ]);
    } finally {
      db.close();
    }
  }, 20_000);

  it('blocks a suite step rather than defaulting to a project directory (decision, not a default)', async () => {
    const { db, common, invocations } = testHarness();
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('test.yaml', TEST_PLAYBOOK),
        // testProjectDir deliberately omitted.
      });

      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toMatch(
        /decision, not a/,
      );
      // Caught before dispatch, not after the scope/suite-writing sessions
      // already ran and were paid for: the provider was never invoked.
      expect(invocations).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('blocks an nfr step that measured nothing rather than writing a clean report of no rows (CONV-4)', async () => {
    const { db, common } = testHarness();
    try {
      const result = await runPhase({
        ...common,
        playbook: parsePlaybook('test.yaml', NOTHING_TO_MEASURE_PLAYBOOK),
      });

      // Not "completed with an empty coverage report, gate criterion met":
      // a phase whose NFR enumeration came back with nothing quantified has
      // measured nothing, and nothing measured is not everything verified.
      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toMatch(
        /found nothing to measure in 'scope-nfrs': 1 requirement\(s\), none of them quantified/,
      );
      expect(result.produced.coverage).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('blocks an nfr step rather than reading an unbound capability as nothing to measure (CONV-4)', async () => {
    const { db, common, projectDir, invocations } = testHarness();
    const { capabilities: _unused, ...withoutCapabilities } = common;
    try {
      const result = await runPhase({
        ...withoutCapabilities,
        playbook: parsePlaybook('test.yaml', TEST_PLAYBOOK),
        testProjectDir: projectDir,
      });

      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toMatch(
        /needs the 'test\.nfr' capability bound/,
      );
      // Caught before dispatch: an unbound capability blocks the whole phase
      // before the scope-enumeration session that would otherwise run first.
      expect(invocations).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('blocks an nfr step missing repo/ref before dispatch, without running its upstream session', async () => {
    const { db, common, projectDir, invocations } = testHarness();
    const { repo: _repo, ref: _ref, ...withoutRepoRef } = common;
    try {
      const result = await runPhase({
        ...withoutRepoRef,
        playbook: parsePlaybook('test.yaml', TEST_PLAYBOOK),
        testProjectDir: projectDir,
      });

      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toMatch(
        /has no 'repo'\/'ref' to measure against/,
      );
      expect(invocations).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('blocks an nfr/suite step missing defectSeverity before dispatch (decision, not a default)', async () => {
    const { db, common, projectDir, invocations } = testHarness();
    const { defectSeverity: _defectSeverity, ...withoutSeverity } = common;
    try {
      const result = await runPhase({
        ...withoutSeverity,
        playbook: parsePlaybook('test.yaml', TEST_PLAYBOOK),
        testProjectDir: projectDir,
      });

      expect(result.outcome.status).toBe('blocked');
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toMatch(
        /needs one supplied rather than assumed/,
      );
      expect(result.outcome.status === 'blocked' && result.outcome.reason).toContain(
        '--defect-severity',
      );
      // Caught before dispatch, the same as the other run-option checks
      // above: no upstream session ran to pay for it.
      expect(invocations).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it(
    'files a Defect for a failed case and a below-threshold NFR, outside produces, ' +
      'and the round trip from there reads back off disk (T4.3.4)',
    async () => {
      const { db, common, projectDir } = testHarness();
      const { artifacts, gates } = common;
      // Spied rather than inferred from the packet: `ApprovalPacket` does not
      // expose the `GateEvidence` it was built from, so the only way to check
      // what the gate manager actually received is to intercept the call.
      const presentSpy = vi.spyOn(gates, 'present');
      // The planted defect: `clamp` no longer refuses a swapped range, so
      // `refuses-a-swapped-range` fails against the real subject the way
      // `split.mjs`'s planted rounding defect does in `adversarial.test.ts`.
      writeFileSync(join(projectDir, 'clamp.mjs'), CLAMP_SOURCE_WITH_DEFECT, 'utf8');

      try {
        const result = await runPhase({
          ...common,
          playbook: parsePlaybook('test.yaml', TEST_PLAYBOOK),
          testProjectDir: projectDir,
        });

        expect(result.outcome.status).toBe('gate-presented');

        // Filed outside `step.produces`: neither id is a declared artifact of
        // this playbook (`coverage`/`verdict` are), and `result.produced`
        // — exactly what `step.produces` writes — carries neither.
        expect(
          result.produced['defect-adversarial-refuses-a-swapped-range'],
        ).toBeUndefined();
        expect(result.produced['defect-nfr-PERF-2']).toBeUndefined();

        // Written to disk under artifacts/defect/, at v1 each — the path
        // `mpgm status --rates` reads a filed defect back from.
        const adversarialPath = join(
          artifacts.root,
          'artifacts',
          'defect',
          `${adversarialDefectId('refuses-a-swapped-range')}.v1.md`,
        );
        const nfrPath = join(
          artifacts.root,
          'artifacts',
          'defect',
          `${nfrDefectId('PERF-2')}.v1.md`,
        );
        expect(existsSync(adversarialPath)).toBe(true);
        expect(existsSync(nfrPath)).toBe(true);

        // Read back off disk — not the in-memory value this test just built —
        // through the same store `runPhase` wrote it with.
        const adversarialArtifact = artifacts.read(
          `artifacts/defect/${adversarialDefectId('refuses-a-swapped-range')}.md`,
        );
        const adversarialDefect = defectSchema.parse(adversarialArtifact.data);
        expect(adversarialDefect.status).toBe('open');
        expect(adversarialDefect.severity).toBe('high');
        expect(adversarialDefect.title).toContain('refuses-a-swapped-range');
        expect(adversarialDefect.tracesTo).toStrictEqual(['FUN-CLAMP']);
        expect(adversarialDefect.evidence.detail).not.toBe('');
        expect(adversarialDefect.evidence.caseId).toBe('refuses-a-swapped-range');

        const nfrArtifact = artifacts.read(
          `artifacts/defect/${nfrDefectId('PERF-2')}.md`,
        );
        const nfrDefect = defectSchema.parse(nfrArtifact.data);
        expect(nfrDefect.status).toBe('open');
        expect(nfrDefect.severity).toBe('high');
        expect(nfrDefect.tracesTo).toStrictEqual(['PERF-2']);
        // The mock provider supplied evidence text, so the fallback never
        // fires here — see `defect-filing.test.ts` for the empty-evidence
        // case.
        expect(nfrDefect.evidence.detail).toBe('measured by k6');

        // `no-open-defects` is not a criterion of TEST_PLAYBOOK's own gate
        // (only `c1`/`c2`, both `artifact-exists`) — so the only way to see
        // that the T4.3.4 gap `phases/test.yaml`'s own gate description named
        // is actually closed is to check what `present` was handed directly:
        // an explicit `defects` array (not `undefined`) naming both filings.
        expect(presentSpy).toHaveBeenCalledTimes(1);
        const evidence = presentSpy.mock.calls[0]?.[2];
        expect(evidence?.defects).toBeDefined();
        expect(
          evidence?.defects?.map((defect) => defect.evidence.caseId).sort(),
        ).toStrictEqual(['PERF-2', 'refuses-a-swapped-range'].sort());

        // The round trip from here is a caller's judgement call (ORC-1), not
        // this module's — driven directly here the way an operator or a
        // future triage role would drive it, over the artifact this run
        // already filed, through the real store. `basePath` is the same
        // root-relative path `fileAndWriteDefect` wrote v1 under — never
        // `adversarialArtifact.path`, which `ArtifactStore.read` already
        // resolved to an absolute path.
        const basePath = `artifacts/defect/${adversarialDefectId('refuses-a-swapped-range')}.md`;
        let defect = adversarialDefect;
        artifacts.write({
          id: adversarialArtifact.id,
          basePath,
          schema: 'defect',
          data: (defect = routeDefect(
            defect,
            { to: 'implement', taskId: 'T-fix-clamp' },
            'a real implementation bug, not a design assumption',
          )),
          producedBy: adversarialArtifact.producedBy,
          tracesTo: defect.tracesTo,
        });
        artifacts.write({
          id: adversarialArtifact.id,
          basePath,
          schema: 'defect',
          data: (defect = recordFix(defect, {
            ref: 'abc1234',
            summary: 'clamp refuses min > max again',
          })),
          producedBy: adversarialArtifact.producedBy,
          tracesTo: defect.tracesTo,
        });
        artifacts.write({
          id: adversarialArtifact.id,
          basePath,
          schema: 'defect',
          data: (defect = retestDefect(defect, {
            passed: true,
            detail: 'refuses-a-swapped-range now passes against the fix',
          })),
          producedBy: adversarialArtifact.producedBy,
          tracesTo: defect.tracesTo,
        });

        // Every version read back off disk, not carried over in memory —
        // the store's own history, not this test's.
        expect(defectSchema.parse(artifacts.read(basePath, 1).data).status).toBe('open');
        expect(defectSchema.parse(artifacts.read(basePath, 2).data).status).toBe(
          'routed',
        );
        expect(defectSchema.parse(artifacts.read(basePath, 3).data).status).toBe(
          'fix-pending',
        );
        const verified = defectSchema.parse(artifacts.read(basePath, 4).data);
        expect(verified.status).toBe('verified');
        expect(verified.tracesTo).toStrictEqual(['FUN-CLAMP']);
      } finally {
        db.close();
      }
    },
    20_000,
  );

  it(
    'leaves GateEvidence.defects undefined for a playbook with no nfr/suite node ' +
      '(T4.3.4)',
    async () => {
      const { db, common } = testHarness();
      const { gates } = common;
      const presentSpy = vi.spyOn(gates, 'present');

      try {
        const result = await runPhase({
          ...common,
          playbook: parsePlaybook('test.yaml', NO_DEFECT_SOURCE_PLAYBOOK),
        });

        expect(result.outcome.status).toBe('gate-presented');
        expect(presentSpy).toHaveBeenCalledTimes(1);
        const evidence = presentSpy.mock.calls[0]?.[2];
        // Not `[]`: `[]` means a source was consulted and found nothing,
        // `undefined` means no source was wired at all — this playbook never
        // declared an `nfr`/`suite` node, so it is the latter
        // (`GateEvidence.defects`'s own doc, `src/gate/manager.ts`).
        expect(evidence?.defects).toBeUndefined();
      } finally {
        db.close();
      }
    },
  );
});
