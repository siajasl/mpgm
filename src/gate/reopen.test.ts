import { describe, expect, it } from 'vitest';
import type { Artifact } from '../artifact/store.js';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { TraceIndex } from '../trace/index-store.js';
import { gateOracleFromState, isApproved } from './manager.js';
import { planReopen, reopenPhase } from './reopen.js';

/**
 * The ORC-6 scenario matrix.
 *
 * A three-phase run with real trace links between its artifacts. The
 * interesting column is `retained`: a cascade that invalidated everything
 * would satisfy the first half of ORC-6 and make gates worthless.
 */

const provenance = {
  task: 't',
  role: 'r',
  model: 'claude-sonnet-5',
  runId: 'run-1',
};

function artifact(
  id: string,
  schema: string,
  data: unknown,
  tracesTo: readonly string[] = [],
): Artifact {
  return {
    id,
    version: 1,
    schema,
    schemaVersion: 1,
    tracesTo,
    producedBy: provenance,
    supersedes: null,
    egress: undefined,
    data,
    path: `artifacts/${schema}/${id}.v1.md`,
  };
}

const DEFINITION = artifact('definition-brief', 'definition', {
  problem: 'Loans get lost.',
});

const SCOPE = artifact('requirement-set', 'scope', {
  requirements: [
    { id: 'LOAN-1', statement: 'Record a loan.', tracesTo: ['goal: track loans'] },
    { id: 'LOAN-2', statement: 'Return a book.', tracesTo: ['goal: track loans'] },
    { id: 'NFR-1', statement: 'Lose nothing.', tracesTo: ['goal: track loans'] },
  ],
});

// Cites LOAN-1 and NFR-1. Says nothing about LOAN-2 — that is the case the
// "unaffected artifacts retain approval" half of ORC-6 exists for.
const DESIGN = artifact('design', 'design', {
  components: [{ name: 'loan-service', tracesTo: ['LOAN-1'] }],
  adrs: [{ id: 'ADR-1', title: 'Use SQLite', tracesTo: ['NFR-1'] }],
});

interface Harness {
  db: ReturnType<typeof openDatabase>;
  log: EventLog;
  projector: Projector;
  index: TraceIndex;
}

function harness(
  approve: readonly string[] = ['definition', 'scope', 'design'],
): Harness {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  const index = TraceIndex.attach(db);

  for (const entry of [DEFINITION, SCOPE, DESIGN]) {
    index.indexArtifactAs(entry, entry.path);
  }

  log.append({
    runId: 'run-1',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });

  const phases: Record<string, { gate: string; artifacts: Artifact[] }> = {
    definition: { gate: 'definition-gate', artifacts: [DEFINITION] },
    scope: { gate: 'scope-gate', artifacts: [SCOPE] },
    design: { gate: 'design-gate', artifacts: [DESIGN] },
  };

  for (const [phase, { gate, artifacts }] of Object.entries(phases)) {
    log.append({
      runId: 'run-1',
      type: 'GatePresented',
      payload: {
        gateId: gate,
        phase,
        artifactRefs: artifacts.map((entry) => ({
          id: entry.id,
          path: entry.path,
          commit: null,
          version: entry.version,
        })),
      },
    });
    if (approve.includes(phase)) {
      log.append({
        runId: 'run-1',
        type: 'GateApproved',
        payload: { gateId: gate, by: 'operator' },
      });
    }
  }

  return { db, log, projector, index };
}

const ids = (verdicts: readonly { gateId: string }[]): string[] =>
  verdicts.map((verdict) => verdict.gateId);

describe('the reopen cascade (ORC-6)', () => {
  const cases = [
    {
      name: 'a requirement the design cites invalidates the design',
      phase: 'scope',
      changed: ['LOAN-1'],
      invalidated: ['design-gate', 'scope-gate'],
      retained: ['definition-gate'],
    },
    {
      name: 'a requirement nothing cites leaves the design approved',
      phase: 'scope',
      changed: ['LOAN-2'],
      invalidated: ['scope-gate'],
      retained: ['definition-gate', 'design-gate'],
    },
    {
      name: 'a requirement cited through an ADR still reaches the design',
      phase: 'scope',
      changed: ['NFR-1'],
      invalidated: ['design-gate', 'scope-gate'],
      retained: ['definition-gate'],
    },
    {
      name: 'reopening the last phase touches nothing upstream',
      phase: 'design',
      changed: undefined,
      invalidated: ['design-gate'],
      retained: ['definition-gate', 'scope-gate'],
    },
    {
      name: 'an unstated change is treated as everything that phase approved',
      phase: 'scope',
      changed: undefined,
      invalidated: ['scope-gate'],
      retained: ['definition-gate', 'design-gate'],
    },
  ] as const;

  for (const scenario of cases) {
    it(scenario.name, () => {
      const { db, projector, index } = harness();
      try {
        const plan = planReopen(projector.project(), index, {
          runId: 'run-1',
          phase: scenario.phase,
          reason: 'test',
          ...(scenario.changed === undefined ? {} : { changed: scenario.changed }),
        });

        expect(ids(plan.invalidated)).toStrictEqual([...scenario.invalidated]);
        expect(ids(plan.retained)).toStrictEqual([...scenario.retained]);
      } finally {
        db.close();
      }
    });
  }

  it('says why each gate was invalidated or left alone', () => {
    const { db, projector, index } = harness();
    try {
      const plan = planReopen(projector.project(), index, {
        runId: 'run-1',
        phase: 'scope',
        reason: 'LOAN-1 changed',
        changed: ['LOAN-1'],
      });

      expect(
        plan.invalidated.find((gate) => gate.gateId === 'design-gate')?.because,
      ).toBe('design@1 traces to the changed content');
      expect(plan.invalidated.find((gate) => gate.gateId === 'scope-gate')?.because).toBe(
        "phase 'scope' was reopened",
      );
      expect(plan.retained[0]?.because).toMatch(/nothing it approved traces/);
    } finally {
      db.close();
    }
  });

  it('ignores gates that were never approved', () => {
    const { db, projector, index } = harness(['scope']);
    try {
      const plan = planReopen(projector.project(), index, {
        runId: 'run-1',
        phase: 'scope',
        reason: 'test',
        changed: ['LOAN-1'],
      });

      // The design gate was presented but not approved: there is no approval
      // to invalidate, and it is not "retained" either.
      expect(ids(plan.invalidated)).toStrictEqual(['scope-gate']);
      expect(ids(plan.retained)).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses a phase this run has no gate for', () => {
    const { db, projector, index } = harness();
    try {
      expect(() =>
        planReopen(projector.project(), index, {
          runId: 'run-1',
          phase: 'implement',
          reason: 'test',
        }),
      ).toThrow(/no gate for phase 'implement'.*definition, design, scope/s);
    } finally {
      db.close();
    }
  });
});

describe('recording a reopen', () => {
  it('changes what is approved, and only what the cascade said', () => {
    const { db, log, projector, index } = harness();
    try {
      reopenPhase({
        log,
        projector,
        index,
        request: {
          runId: 'run-1',
          phase: 'scope',
          reason: 'LOAN-1 changed after operator review',
          changed: ['LOAN-1'],
        },
      });

      const state = projector.project();
      expect(isApproved(state, 'run-1', 'scope-gate')).toBe(false);
      expect(isApproved(state, 'run-1', 'design-gate')).toBe(false);
      // The half of ORC-6 that is easy to lose.
      expect(isApproved(state, 'run-1', 'definition-gate')).toBe(true);

      const oracle = gateOracleFromState(state, 'run-1');
      expect(oracle.isGated('definition-brief', 1)).toBe(true);
      // Released for revision, which is the point of reopening.
      expect(oracle.isGated('requirement-set', 1)).toBe(false);
      expect(oracle.isGated('design', 1)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('records the reopen and one invalidation each, in one batch', () => {
    const { db, log, projector, index } = harness();
    try {
      reopenPhase({
        log,
        projector,
        index,
        request: {
          runId: 'run-1',
          phase: 'scope',
          reason: 'LOAN-1 changed',
          changed: ['LOAN-1'],
        },
      });

      const written = log.read({ fromSeq: 8 }).map((event) => event.type);
      expect(written).toStrictEqual([
        'PhaseReopened',
        'GateInvalidated',
        'GateInvalidated',
      ]);

      const causes = log
        .read({ type: 'GateInvalidated' })
        .map((event) => (event.payload as { cause: string }).cause);
      expect(causes[0]).toContain('LOAN-1 changed');
      expect(causes[0]).toContain('traces to the changed content');
    } finally {
      db.close();
    }
  });

  it('refuses a reopen that does not say why', () => {
    const { db, log, projector, index } = harness();
    try {
      expect(() =>
        reopenPhase({
          log,
          projector,
          index,
          request: { runId: 'run-1', phase: 'scope', reason: '   ' },
        }),
      ).toThrow(/must say why/);
      // And wrote nothing: an unexplained reopen in an append-only log is
      // permanent.
      expect(log.read({ type: 'PhaseReopened' })).toStrictEqual([]);
    } finally {
      db.close();
    }
  });
});
