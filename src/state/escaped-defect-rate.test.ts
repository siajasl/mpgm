import { describe, expect, it } from 'vitest';
import type { Artifact } from '../artifact/store.js';
import { MEMORY } from '../database.js';
import type { EventInput, StoredEvent } from '../event/envelope.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { fileDefect, recordFix, retestDefect, routeDefect } from '../test/defect.js';
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

const provenance = (runId: string, task = 'retest') => ({
  task,
  role: 'tester',
  model: 'claude-sonnet-5',
  runId,
});

function defectArtifact(
  id: string,
  foundByRunId: string,
  data: unknown,
  version = 1,
): Artifact {
  return {
    id,
    version,
    schema: 'defect',
    schemaVersion: 1,
    tracesTo: [],
    producedBy: provenance(foundByRunId),
    supersedes: version > 1 ? version - 1 : null,
    egress: undefined,
    data,
    path: `artifacts/defect/${id}.v${String(version)}.md`,
  };
}

/**
 * Like {@link defectArtifact}, but with `producedBy.task` set to whichever
 * task actually wrote this version — the field the filing fallback reads
 * (T4.2.7). `defectArtifact` hardcodes `'retest'` for every version, which is
 * fine where the fallback never fires; the fallback tests below need each
 * lifecycle transition's own task distinguishable from the others.
 */
function defectArtifactBy(
  id: string,
  foundByRunId: string,
  data: unknown,
  version: number,
  task: string,
): Artifact {
  return {
    ...defectArtifact(id, foundByRunId, data, version),
    producedBy: provenance(foundByRunId, task),
  };
}

/** A `TaskCompleted` with no `artifactRefs` — the shape `SessionRunner` wrote
 * for every task on the task path before T4.2.7, and still writes for a
 * caller that declares no artifact. */
function completedWithNoRefs(runId: string, taskId: string): EventInput {
  return { runId, type: 'TaskCompleted', payload: { taskId, artifactRefs: [] } };
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

describe('computeEscapedDefectRate — one defect, however many versions its lifecycle wrote', () => {
  it('counts a defect once, not once per version, when it has only been routed', () => {
    // Reproduces the review finding directly: v1 (open) and v2 (routed) of
    // the same artifact id, both handed in the way `ArtifactStore.list`
    // hands in every version it finds on disk.
    const open = openDefect('zero-split-refused');
    const v1 = defectArtifact('d7', 'r1', open, 1);
    const routed = routeDefect(
      open,
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    const v2 = defectArtifact('d7', 'r1', routed, 2);

    const events = logWith([runStarted('r1'), changeMerged('r1', 'T-unrelated')]);

    const rate = computeEscapedDefectRate('r1', events, [v1, v2]);

    expect(rate.filed).toBe(1);
    expect(rate.unrouted).toBe(0);
  });

  it('counts one escape, not three, when file/route/fix/verify each wrote a version', () => {
    // The reviewer's own repro: drive one defect through the whole round
    // trip and hand in every version `ArtifactStore.list` would return. The
    // filing `TaskCompleted` names v1 — the version `fileDefect` actually
    // wrote — because that is the only shape the lifecycle produces; naming
    // a later version would be dating the filing from some other
    // transition's completion instead.
    const v1Data = openDefect('zero-split-refused');
    const v2Data = routeDefect(
      v1Data,
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    const v3Data = recordFix(v2Data, { ref: 'deadbeef', summary: 'refuse a zero split' });
    const v4Data = retestDefect(v3Data, {
      passed: true,
      detail: 're-ran the adversarial case',
    });

    const v1 = defectArtifact('d8', 'r1', v1Data, 1);
    const v2 = defectArtifact('d8', 'r1', v2Data, 2);
    const v3 = defectArtifact('d8', 'r1', v3Data, 3);
    const v4 = defectArtifact('d8', 'r1', v4Data, 4);

    const events = logWith([
      runStarted('r1'),
      changeMerged('r1', 'T-old'), // T-old already merged...
      filedBy('r1', 'test-task', v1), // ...before the defect was filed (v1, the filing version)
    ]);

    const rate = computeEscapedDefectRate('r1', events, [v1, v2, v3, v4]);

    expect(rate.filed).toBe(1);
    expect(rate.escaped).toBe(1);
    expect(rate.rate).toBe(1);
    expect(rate.unrouted).toBe(0);
  });

  it('is not escaped when a routed defect is filed before the fix task merges, even though the fix task later completes naming a later version', () => {
    // The blocker this pins down: a fix-pending defect whose *filing*
    // TaskCompleted (naming v1) predates the fix task's merge, but whose
    // fix task later completes naming v3 (recordFix's version) — reading
    // the filing date off whichever TaskCompleted names the *current*
    // (highest) version would find that later completion instead of the
    // filing, put it after the merge, and count the fix landing as an
    // escape.
    const v1Data = openDefect('zero-split-refused');
    const v2Data = routeDefect(
      v1Data,
      { to: 'implement', taskId: 'T-fix' },
      'routed to a fresh task to hold the fix',
    );
    const v3Data = recordFix(v2Data, { ref: 'deadbeef', summary: 'refuse a zero split' });

    const v1 = defectArtifact('d11', 'r1', v1Data, 1);
    const v2 = defectArtifact('d11', 'r1', v2Data, 2);
    const v3 = defectArtifact('d11', 'r1', v3Data, 3);

    const events = logWith([
      runStarted('r1'),
      filedBy('r1', 'test-task', v1), // filed first (v1)...
      changeMerged('r1', 'T-fix'), // ...T-fix merges next: the fix landing...
      filedBy('r1', 'T-fix', v3), // ...and only later does T-fix's own completion name v3
    ]);

    const rate = computeEscapedDefectRate('r1', events, [v1, v2, v3]);

    expect(rate.filed).toBe(1);
    expect(rate.escaped).toBe(0);
    expect(rate.rate).toBe(0);
  });

  it('does not count an artifact under the defect path whose schema is not defect', () => {
    const stray: Artifact = {
      id: 'not-a-defect',
      version: 1,
      schema: 'brief',
      schemaVersion: 1,
      tracesTo: [],
      producedBy: provenance('r1'),
      supersedes: null,
      egress: undefined,
      data: { anything: 'at all' },
      path: 'artifacts/defect/not-a-defect.v1.md',
    };

    const events = logWith([runStarted('r1'), changeMerged('r1', 'T1')]);

    const rate = computeEscapedDefectRate('r1', events, [stray]);

    // One artifact was handed in, but none of it is a Defect: `filed` stays
    // 0 and `rate` reads as unmeasured, not a clean `0%` (CONV-6).
    expect(rate.filed).toBe(0);
    expect(rate.rate).toBeNull();
  });
});

describe('computeEscapedDefectRate — a routed defect that cannot be dated', () => {
  it('reports a routed defect whose named task merged but which no TaskCompleted names as undated, not silently dropped', () => {
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    const artifact = defectArtifact('d9', 'r1', routed);

    // T-old merges, but nothing ever names this artifact in a TaskCompleted
    // — the only dating this module has (module doc).
    const events = logWith([runStarted('r1'), changeMerged('r1', 'T-old')]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.undated).toBe(1);
    expect(rate.escaped).toBe(0);
    expect(rate.unrouted).toBe(0);
  });

  it('attributes the undated defect to the run that merged the named task, not the run that found it', () => {
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    const artifact = defectArtifact('d10', 'r-found', routed);

    const events = logWith([
      runStarted('r-old'),
      changeMerged('r-old', 'T-old'),
      runStarted('r-found'),
      // Nothing ever files a TaskCompleted naming this artifact.
    ]);

    const oldRun = computeEscapedDefectRate('r-old', events, [artifact]);
    const foundRun = computeEscapedDefectRate('r-found', events, [artifact]);

    expect(oldRun.undated).toBe(1);
    expect(foundRun.undated).toBe(0);
  });
});

describe('computeEscapedDefectRate — filing fallback when artifactRefs is empty (T4.2.7)', () => {
  it('dates filing from the lowest-version record — the version fileDefect wrote — not the latest', () => {
    // Handed in at all four lifecycle versions, each written by a distinct
    // task, and every TaskCompleted carries no artifactRefs — the shape
    // `SessionRunner` wrote for every task on the task path before T4.2.7.
    // Only the fallback (`producedBy.task` on the *lowest* version) can date
    // this at all.
    const v1Data = openDefect('zero-split-refused');
    const v2Data = routeDefect(
      v1Data,
      { to: 'implement', taskId: 'T-fix' },
      'routed to a fresh task to hold the fix',
    );
    const v3Data = recordFix(v2Data, { ref: 'deadbeef', summary: 'refuse a zero split' });
    const v4Data = retestDefect(v3Data, {
      passed: true,
      detail: 're-ran the adversarial case',
    });

    const v1 = defectArtifactBy('d12', 'r1', v1Data, 1, 'file-task');
    const v2 = defectArtifactBy('d12', 'r1', v2Data, 2, 'route-task');
    const v3 = defectArtifactBy('d12', 'r1', v3Data, 3, 'fix-task');
    const v4 = defectArtifactBy('d12', 'r1', v4Data, 4, 'retest-task');

    const events = logWith([
      runStarted('r1'),
      completedWithNoRefs('r1', 'file-task'), // filing task completes first...
      changeMerged('r1', 'T-fix'), // ...T-fix merges next: the fix landing...
      completedWithNoRefs('r1', 'route-task'),
      completedWithNoRefs('r1', 'fix-task'),
      completedWithNoRefs('r1', 'retest-task'), // ...and retest completes last, long after the merge
    ]);

    const rate = computeEscapedDefectRate('r1', events, [v1, v2, v3, v4]);

    expect(rate.filed).toBe(1);
    // Dated correctly (off `file-task`, before the merge), this reads as the
    // fix landing, not an escape. Dated off the *latest* version's task
    // (`retest-task`, whose completion falls long after the merge) it would
    // flip to `escaped: 1` — precisely the regression this pins down.
    expect(rate.escaped).toBe(0);
    expect(rate.rate).toBe(0);
    // Not "cannot be dated" either: the fallback did find something.
    expect(rate.undated).toBe(0);
  });

  it('still reads escaped when the fallback dates the filing after the named task had already merged', () => {
    const v1Data = openDefect('zero-split-refused');
    const v2Data = routeDefect(
      v1Data,
      { to: 'implement', taskId: 'T-old' },
      'implementation bug, not a design assumption',
    );
    const v3Data = recordFix(v2Data, { ref: 'deadbeef', summary: 'refuse a zero split' });
    const v4Data = retestDefect(v3Data, {
      passed: true,
      detail: 're-ran the adversarial case',
    });

    const v1 = defectArtifactBy('d13', 'r1', v1Data, 1, 'file-task');
    const v2 = defectArtifactBy('d13', 'r1', v2Data, 2, 'route-task');
    const v3 = defectArtifactBy('d13', 'r1', v3Data, 3, 'fix-task');
    const v4 = defectArtifactBy('d13', 'r1', v4Data, 4, 'retest-task');

    const events = logWith([
      runStarted('r1'),
      changeMerged('r1', 'T-old'), // T-old already merged...
      completedWithNoRefs('r1', 'file-task'), // ...before this defect was filed against it
      completedWithNoRefs('r1', 'route-task'),
      completedWithNoRefs('r1', 'fix-task'),
      completedWithNoRefs('r1', 'retest-task'),
    ]);

    const rate = computeEscapedDefectRate('r1', events, [v1, v2, v3, v4]);

    expect(rate.filed).toBe(1);
    expect(rate.escaped).toBe(1);
    expect(rate.rate).toBe(1);
    expect(rate.undated).toBe(0);
  });

  it('does not date the fallback from a same-named step completing under a different run (review finding)', () => {
    // Reproduces the review finding directly: `producedBy.task` is a phase
    // *step* id (`test-file`), which repeats across every run that invokes
    // the phase. Run r1 completes `test-file` first — an unrelated,
    // wrong-run completion of the same step id — long before the run that
    // actually wrote this artifact even starts. Matching on `taskId` alone
    // would find r1's completion (first in the log) and date the filing off
    // it, well before r2's own merge, and misread a real escape as a fix.
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    const artifact = defectArtifactBy('d14', 'r2', routed, 1, 'test-file');

    const events = logWith([
      runStarted('r1'),
      completedWithNoRefs('r1', 'test-file'), // unrelated: a different run's own step
      runStarted('r2'),
      changeMerged('r2', 'T-old'), // T-old already merged in r2...
      completedWithNoRefs('r2', 'test-file'), // ...before r2's own filing completes
    ]);

    const rate = computeEscapedDefectRate('r2', events, [artifact]);

    expect(rate.filed).toBe(1);
    // The true reading: r2's merge preceded r2's own filing, so this
    // escaped. Dated off r1's wrong-run completion instead, the buggy
    // fallback reads `escaped: 0` here.
    expect(rate.escaped).toBe(1);
    expect(rate.rate).toBe(1);
    expect(rate.undated).toBe(0);
  });

  it('reports undated, not an arbitrary pick, when the filing task completed more than once in its own run', () => {
    // The step id completed twice within the *same* run — run-scoping alone
    // cannot tell which of the two completions wrote this version, so rather
    // than guess by read order the fallback finds none, and the defect
    // reports as undated instead of being dated off whichever completion
    // happened to come first.
    const routed = routeDefect(
      openDefect('zero-split-refused'),
      { to: 'implement', taskId: 'T-old' },
      'implementation bug',
    );
    const artifact = defectArtifactBy('d15', 'r1', routed, 1, 'test-file');

    const events = logWith([
      runStarted('r1'),
      changeMerged('r1', 'T-old'),
      completedWithNoRefs('r1', 'test-file'), // the step id completes...
      completedWithNoRefs('r1', 'test-file'), // ...twice, in the same run
    ]);

    const rate = computeEscapedDefectRate('r1', events, [artifact]);

    expect(rate.filed).toBe(1);
    expect(rate.undated).toBe(1);
    expect(rate.escaped).toBe(0);
  });
});
