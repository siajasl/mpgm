import { describe, expect, it } from 'vitest';
import type { Artifact } from '../artifact/store.js';
import { MEMORY } from '../database.js';
import type { EventInput, StoredEvent } from '../event/envelope.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { fileDefect, routeDefect } from '../test/defect.js';
import { computeEscapedDefectRate } from './escaped-defect-rate.js';

/**
 * `computeEscapedDefectRate` (T4.2.2b, OBS-4).
 *
 * Defects are built through the real round trip — `fileDefect`, `routeDefect`
 * (`recordFix`/`retestDefect` are not needed to reach a routed defect, but
 * none of these fixtures hand-write a `Defect` literal) — the same discipline
 * `defect.artifact.test.ts` holds itself to: a hand-built object can hold a
 * shape the lifecycle never produces, and a rate computed off that shape
 * would be proving something about data that cannot occur.
 *
 * `logWith` advances the clock one second per event, so "precedes" is a real
 * ordering the fixtures control by which event they append first, the same
 * pattern `metrics.test.ts` uses for latency.
 */

function logWith(inputs: readonly EventInput[]): StoredEvent[] {
  let seconds = 0;
  const log = EventLog.open(MEMORY, {
    registry: kernelRegistry(),
    clock: () => {
      const ts = new Date(2026_01_01_00_00_00 + seconds * 1000).toISOString();
      seconds += 1;
      return ts;
    },
  });
  try {
    log.appendMany(inputs);
    return log.read();
  } finally {
    log.close();
  }
}

const runStarted = (runId: string): EventInput => ({
  runId,
  type: 'RunStarted',
  payload: { project: 'mpgm', operator: 'operator' },
});

function changeMerged(runId: string, taskId: string): EventInput {
  return {
    runId,
    type: 'ChangeMerged',
    payload: {
      taskId,
      branch: `task/${taskId}`,
      into: 'main',
      commit: 'deadbeef',
      reviewTaskId: `${taskId}-review`,
    },
  };
}

/** A `TaskCompleted` naming `artifact` in its `artifactRefs` — the only way this module dates when a defect was filed. */
function filedBy(runId: string, taskId: string, artifact: Artifact): EventInput {
  return {
    runId,
    type: 'TaskCompleted',
    payload: {
      taskId,
      artifactRefs: [
        { id: artifact.id, path: artifact.path, commit: null, version: artifact.version },
      ],
    },
  };
}

const provenance = (runId: string) => ({
  task: 'retest',
  role: 'tester',
  model: 'claude-sonnet-5',
  runId,
});

function defectArtifact(id: string, foundByRunId: string, data: unknown): Artifact {
  return {
    id,
    version: 1,
    schema: 'defect',
    schemaVersion: 1,
    tracesTo: [],
    producedBy: provenance(foundByRunId),
    supersedes: null,
    egress: undefined,
    data,
    path: `artifacts/defect/${id}.v1.md`,
  };
}

function openDefect(caseId: string) {
  return fileDefect({
    title: 'splitEvenly divides by zero instead of refusing an empty split',
    severity: 'high',
    description: 'An adversarial case caught splitEvenly accepting a zero amount.',
    evidence: {
      kind: 'adversarial',
      caseId,
      detail: 'returned an array instead of refusing',
    },
    tracesTo: ['LOAN-3'],
  });
}

describe('computeEscapedDefectRate — escape vs. fix', () => {
  it('is escaped when the named task merged before the defect was filed', () => {
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug, not a design assumption',
    );
    const artifact = defectArtifact('d1', 'r1', routed);

    const events = logWith([
      runStarted('r1'),
      changeMerged('r1', 'T-old'), // T-old already merged...
      filedBy('r1', 'test-task', artifact), // ...before this defect was filed against it
    ]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.merged).toBe(1);
    expect(rate.escaped).toBe(1);
    expect(rate.rate).toBe(1);
    expect(rate.unrouted).toBe(0);
  });

  it('is not escaped when the named task merges after the defect was filed — that merge is the fix', () => {
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-fix' },
      'routed to a fresh task to hold the fix',
    );
    const artifact = defectArtifact('d2', 'r1', routed);

    const events = logWith([
      runStarted('r1'),
      filedBy('r1', 'test-task', artifact), // filed first...
      changeMerged('r1', 'T-fix'), // ...T-fix merges afterward: the fix landing
    ]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.merged).toBe(1);
    // Real defect data exists (`filed` is 1), so this 0 is a measured "no
    // escapes", not the unmeasured null the next describe block covers.
    expect(rate.filed).toBe(1);
    expect(rate.escaped).toBe(0);
    expect(rate.rate).toBe(0);
  });
});

describe('computeEscapedDefectRate — unrouted defects name no task', () => {
  it('an open defect is reported as unrouted, not counted on either side of the rate', () => {
    const artifact = defectArtifact('d3', 'r1', openDefect('zero-split-refused'));

    const events = logWith([runStarted('r1'), changeMerged('r1', 'T-unrelated')]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.unrouted).toBe(1);
    expect(rate.escaped).toBe(0);
    expect(rate.merged).toBe(1);
  });

  it('a design-routed defect names a phase, not a task, and is unrouted the same way', () => {
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'design', phase: 'design' },
      'a design assumption looks wrong',
    );
    const artifact = defectArtifact('d4', 'r1', routed);

    const events = logWith([runStarted('r1'), changeMerged('r1', 'T-unrelated')]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.unrouted).toBe(1);
    expect(rate.escaped).toBe(0);
  });
});

describe('computeEscapedDefectRate — run attribution differs from who found it', () => {
  it('credits an escape to the run that merged the named task, not the run that filed the defect', () => {
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    // Found (and filed) under a later run than the one that merged T-old.
    const artifact = defectArtifact('d5', 'r-found', routed);

    const events = logWith([
      runStarted('r-old'),
      changeMerged('r-old', 'T-old'),
      runStarted('r-found'),
      filedBy('r-found', 'test-task', artifact),
    ]);

    const oldRun = computeEscapedDefectRate('r-old', events, [artifact]);
    const foundRun = computeEscapedDefectRate('r-found', events, [artifact]);

    // The escape belongs to the run whose merge it escaped.
    expect(oldRun.merged).toBe(1);
    expect(oldRun.escaped).toBe(1);
    expect(oldRun.rate).toBe(1);

    // Not to the run that merely found it — that run merged nothing, so its
    // rate is null (nothing to divide by), not a phantom escape of its own.
    expect(foundRun.merged).toBe(0);
    expect(foundRun.escaped).toBe(0);
    expect(foundRun.rate).toBeNull();
  });
});

describe('computeEscapedDefectRate — no defects filed reads as unmeasured, not 0% (CONV-6)', () => {
  it('a run with merged tasks and zero defect artifacts is null, never 0%', () => {
    // Mirrors this repository's own log: nothing outside a test calls
    // `fileDefect`, so `defects` here is empty exactly the way a real read
    // of `ArtifactStore.list('artifacts/defect')` against this project would
    // be. A rate that read `escaped === 0` alone would print `0%` here —
    // indistinguishable from a run that filed five defects and let none of
    // them escape — which is precisely the confusion this pins down.
    const events = logWith([runStarted('r1'), changeMerged('r1', 'T1')]);

    const rate = computeEscapedDefectRate('r1', events, []);

    expect(rate.merged).toBe(1);
    expect(rate.escaped).toBe(0);
    expect(rate.filed).toBe(0);
    expect(rate.rate).toBeNull();
  });

  it('is null when nothing has merged yet, even with defects on file', () => {
    const artifact = defectArtifact('d6', 'r1', openDefect('zero-split-refused'));
    const events = logWith([runStarted('r1')]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.merged).toBe(0);
    expect(rate.rate).toBeNull();
  });
});
