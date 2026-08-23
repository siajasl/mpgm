import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { ArtifactStore, GatedArtifactError, type Artifact } from '../artifact/store.js';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { loadPlaybookFile } from '../playbook/loader.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import {
  canProceed,
  GateError,
  GateManager,
  gateOracleFromState,
  isApproved,
  type GateEvidence,
} from './manager.js';

const phasesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'phases');
const playbook = loadPlaybookFile(join(phasesDir, 'definition.yaml'));

const schemas = new ArtifactSchemaRegistry([
  defineArtifactSchema('definition', z.object({ problem: z.string().min(1) })),
  defineArtifactSchema('findings', z.object({ open: z.number() })),
]);

const provenance = {
  task: 'draft-brief',
  role: 'analyst',
  model: 'claude-sonnet-5',
  runId: 'run-1',
};

const tempDirs: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-gate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function harness() {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  const gates = new GateManager({ log });

  log.append({
    runId: 'run-1',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });

  return { db, log, projector, gates };
}

function evidenceFor(
  root: string,
  opts: { findings?: boolean; resolved?: boolean } = {},
) {
  const store = new ArtifactStore({ root, schemas });
  const brief = store.write({
    id: 'definition-brief',
    basePath: 'artifacts/definition/brief.md',
    schema: 'definition',
    data: { problem: 'Loans get lost.' },
    producedBy: provenance,
  });

  const artifacts: Record<string, Artifact> = { 'definition-brief': brief };
  if (opts.findings !== false) {
    artifacts['ambiguity-findings'] = store.write({
      id: 'ambiguity-findings',
      basePath: 'artifacts/definition/ambiguities.md',
      schema: 'findings',
      data: { open: 0 },
      producedBy: { ...provenance, task: 'challenge-brief', role: 'reviewer' },
    });
  }

  return {
    store,
    evidence: {
      artifacts,
      assertions: {
        'challenge-brief': {
          met: opts.resolved !== false,
          detail:
            opts.resolved === false ? '2 findings still open' : 'all findings resolved',
        },
      },
    } satisfies GateEvidence,
  };
}

describe('the gate blocks until approved', () => {
  it('does not permit progress before it has even been presented', () => {
    const { db, projector } = harness();
    try {
      // Silence is not consent (HIL-1).
      expect(canProceed(projector.project(), 'run-1', 'definition-gate')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('still blocks after presentation, with every criterion met', () => {
    const { db, projector, gates } = harness();
    try {
      const packet = gates.present('run-1', playbook, evidenceFor(newRoot()).evidence);

      expect(packet.allMet).toBe(true);
      expect(packet.autoApproved).toBe(false);
      // Meeting the criteria is not approval; a person still decides.
      expect(canProceed(projector.project(), 'run-1', 'definition-gate')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('opens once approved, and the decision is in the log (HIL-5)', () => {
    const { db, log, projector, gates } = harness();
    try {
      gates.present('run-1', playbook, evidenceFor(newRoot()).evidence);
      gates.approve('run-1', 'definition-gate', 'macg');

      expect(canProceed(projector.project(), 'run-1', 'definition-gate')).toBe(true);
      expect(isApproved(projector.project(), 'run-1', 'definition-gate')).toBe(true);

      const decision = log.read().find((event) => event.type === 'GateApproved');
      expect((decision?.payload as { by: string }).by).toBe('macg');
      expect(projector.project().runs['run-1']?.gates['definition-gate']?.decidedBy).toBe(
        'macg',
      );
    } finally {
      db.close();
    }
  });

  it('stays shut when rejected, and records why', () => {
    const { db, projector, gates } = harness();
    try {
      gates.present('run-1', playbook, evidenceFor(newRoot()).evidence);
      gates.reject(
        'run-1',
        'definition-gate',
        'macg',
        'success metrics are unmeasurable',
      );

      expect(canProceed(projector.project(), 'run-1', 'definition-gate')).toBe(false);
      const gate = projector.project().runs['run-1']?.gates['definition-gate'];
      expect(gate?.status).toBe('rejected');
      expect(gate?.reason).toBe('success metrics are unmeasurable');
    } finally {
      db.close();
    }
  });

  it('refuses an unattributed decision', () => {
    const { db, gates } = harness();
    try {
      gates.present('run-1', playbook, evidenceFor(newRoot()).evidence);

      expect(() => {
        gates.approve('run-1', 'definition-gate', '  ');
      }).toThrow(GateError);
      expect(() => {
        gates.reject('run-1', 'definition-gate', '', 'no');
      }).toThrow(/must name who made it/);
    } finally {
      db.close();
    }
  });
});

describe('the approval packet (HIL-4)', () => {
  it('never presents a bare proceed', () => {
    const { db, gates } = harness();
    try {
      const packet = gates.present('run-1', playbook, evidenceFor(newRoot()).evidence);

      expect(packet.options.length).toBeGreaterThan(0);
      expect(packet.tradeOffs.length).toBeGreaterThan(0);
      expect(packet.recommendation).not.toBe('');
      expect(packet.recommendation).toMatch(/Approve: every exit criterion is met/);
    } finally {
      db.close();
    }
  });

  it('reports each criterion and why it is unmet', () => {
    const { db, gates } = harness();
    try {
      const { evidence } = evidenceFor(newRoot(), { findings: false, resolved: false });
      const packet = gates.present('run-1', playbook, evidence);

      expect(packet.allMet).toBe(false);
      const byId = Object.fromEntries(packet.criteria.map((c) => [c.id, c]));
      expect(byId['brief-present']?.met).toBe(true);
      expect(byId['findings-present']?.met).toBe(false);
      expect(byId['findings-present']?.detail).toMatch(/has not been produced/);
      expect(byId['ambiguities-resolved']?.detail).toBe('2 findings still open');
      expect(packet.recommendation).toMatch(/Do not approve yet: 2/);
    } finally {
      db.close();
    }
  });

  it('uses a supplied narrative when the phase produced one', () => {
    const { db, gates } = harness();
    try {
      const packet = gates.present('run-1', playbook, evidenceFor(newRoot()).evidence, {
        options: ['Ship it'],
        tradeOffs: ['Scope may widen later'],
        recommendation: 'Approve, with the glossary gap noted.',
      });

      expect(packet.options).toStrictEqual(['Ship it']);
      expect(packet.recommendation).toBe('Approve, with the glossary gap noted.');
    } finally {
      db.close();
    }
  });
});

describe('auto-approval (HIL-1)', () => {
  const autoPlaybook = { ...playbook, gate: { ...playbook.gate, autoApprove: true } };

  it('closes the gate only when the playbook asked and every criterion is met', () => {
    const { db, projector, gates } = harness();
    try {
      const packet = gates.present(
        'run-1',
        autoPlaybook,
        evidenceFor(newRoot()).evidence,
      );

      expect(packet.autoApproved).toBe(true);
      expect(canProceed(projector.project(), 'run-1', 'definition-gate')).toBe(true);
      // Still attributed: an unattributed decision is not an audit trail.
      expect(projector.project().runs['run-1']?.gates['definition-gate']?.decidedBy).toBe(
        'auto',
      );
    } finally {
      db.close();
    }
  });

  it('does not auto-approve when a criterion is unmet', () => {
    const { db, projector, gates } = harness();
    try {
      const { evidence } = evidenceFor(newRoot(), { resolved: false });
      const packet = gates.present('run-1', autoPlaybook, evidence);

      expect(packet.autoApproved).toBe(false);
      expect(canProceed(projector.project(), 'run-1', 'definition-gate')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('approval freezes the artifact (ART-1)', () => {
  it('makes the artifact store refuse to edit the approved version', () => {
    const { db, projector, gates } = harness();
    try {
      const root = newRoot();
      const { evidence } = evidenceFor(root);
      gates.present('run-1', playbook, evidence);
      gates.approve('run-1', 'definition-gate', 'macg');

      // The store learns what is frozen from the log, not a separate record.
      const store = new ArtifactStore({
        root,
        schemas,
        gates: gateOracleFromState(projector.project(), 'run-1'),
      });

      expect(() =>
        store.overwrite(
          {
            id: 'definition-brief',
            basePath: 'artifacts/definition/brief.md',
            schema: 'definition',
            data: { problem: 'Rewritten after approval.' },
            producedBy: provenance,
          },
          1,
        ),
      ).toThrow(GatedArtifactError);

      // A successor is still allowed.
      expect(
        store.write({
          id: 'definition-brief',
          basePath: 'artifacts/definition/brief.md',
          schema: 'definition',
          data: { problem: 'Revised.' },
          producedBy: provenance,
        }).version,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it('freezes only the approved artifact, not everything at that version', () => {
    const { db, projector, gates } = harness();
    try {
      const brief = evidenceFor(newRoot()).evidence.artifacts['definition-brief'];
      if (brief === undefined) {
        throw new Error('expected the brief to have been written');
      }
      gates.present('run-1', playbook, {
        artifacts: { 'definition-brief': brief },
        assertions: {},
      });
      gates.approve('run-1', 'definition-gate', 'macg');

      const oracle = gateOracleFromState(projector.project(), 'run-1');

      expect(oracle.isGated('definition-brief', 1)).toBe(true);
      // A different artifact that also happens to be at v1 is untouched.
      expect(oracle.isGated('ambiguity-findings', 1)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('releases artifacts when the gate is no longer approved', () => {
    const { db, log, projector, gates } = harness();
    try {
      gates.present('run-1', playbook, evidenceFor(newRoot()).evidence);
      gates.approve('run-1', 'definition-gate', 'macg');
      // ORC-6: a reopen invalidates the approval, and revision becomes possible.
      log.append({
        runId: 'run-1',
        type: 'GateInvalidated',
        payload: { gateId: 'definition-gate', cause: 'scope reopened' },
      });

      expect(
        gateOracleFromState(projector.project(), 'run-1').isGated('definition-brief', 1),
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
