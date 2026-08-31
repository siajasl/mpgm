import { describe, expect, it } from 'vitest';
import type { Artifact } from '../artifact/store.js';
import { MEMORY, openDatabase } from '../database.js';
import { projectArtifactSchemas } from '../schemas.js';
import { TraceIndex } from '../trace/index-store.js';
import { extractArtifactLinks } from '../trace/links.js';
import { fileDefect, recordFix, retestDefect, routeDefect } from './defect.js';

/**
 * The Defect artifact as the rest of the codebase actually sees it —
 * validated by the artifact registry (`src/schemas.ts`) and read by the
 * generic trace-link walk (`src/trace/links.ts`) — rather than only as the
 * plain object `defect.ts`'s own functions return. `defect.test.ts` exercises
 * the round trip; this exercises what the round trip's result does once it is
 * the kind of thing `mpgm trace` and the Test gate's coverage report actually
 * read.
 */

const provenance = {
  task: 'retest',
  role: 'tester',
  model: 'claude-sonnet-5',
  runId: 'run-1',
};

function defectArtifact(data: unknown): Artifact {
  return {
    id: 'defect-1',
    version: 1,
    schema: 'defect',
    schemaVersion: 1,
    tracesTo: [],
    producedBy: provenance,
    supersedes: null,
    egress: undefined,
    data,
    path: 'artifacts/defect/defect-1.v1.md',
  };
}

describe('a Defect as an artifact (TST-5, ART-2)', () => {
  it('validates against the artifact registry the same way any other family does', () => {
    const defect = fileDefect({
      title: 'splitEvenly divides by zero instead of refusing an empty split',
      severity: 'high',
      description: 'An adversarial case caught splitEvenly accepting a zero amount.',
      evidence: {
        kind: 'adversarial',
        caseId: 'zero-split-refused',
        detail: 'splitEvenly(0, 3) returned an array instead of refusing',
      },
      tracesTo: ['LOAN-3'],
    });

    expect(projectArtifactSchemas().validate('defect', defect)).toEqual(defect);
  });

  it('cites the requirements it traces to, and declares no verifies link, at any status', () => {
    const filed = fileDefect({
      title: 'splitEvenly divides by zero instead of refusing an empty split',
      severity: 'high',
      description: 'An adversarial case caught splitEvenly accepting a zero amount.',
      evidence: {
        kind: 'adversarial',
        caseId: 'zero-split-refused',
        detail: 'splitEvenly(0, 3) returned an array instead of refusing',
      },
      tracesTo: ['LOAN-3'],
    });
    const routed = routeDefect(
      filed,
      { to: 'implement', taskId: 'T3.1.9' },
      'implementation bug, not a design assumption',
    );
    const fixPending = recordFix(routed, {
      ref: 'def456',
      summary: 'actually refuse a zero amount this time',
    });
    const verified = retestDefect(fixPending, {
      passed: true,
      detail: 'splitEvenly(0, 3) now throws',
    });

    const { links } = extractArtifactLinks(
      defectArtifact(verified),
      'artifacts/defect/defect-1.v1.md',
    );

    expect(links).toStrictEqual([
      {
        src: 'defect-1@1',
        dst: 'LOAN-3',
        relation: 'traces-to',
        source: 'artifacts/defect/defect-1.v1.md',
      },
    ]);
  });

  it('does not, by itself, mark the requirement it traced to as verified (TST-2)', () => {
    const filed = fileDefect({
      title: 'splitEvenly divides by zero instead of refusing an empty split',
      severity: 'high',
      description: 'An adversarial case caught splitEvenly accepting a zero amount.',
      evidence: {
        kind: 'adversarial',
        caseId: 'zero-split-refused',
        detail: 'splitEvenly(0, 3) returned an array instead of refusing',
      },
      tracesTo: ['LOAN-3'],
    });
    const routed = routeDefect(filed, { to: 'implement', taskId: 'T3.1.9' }, 'why');
    const fixPending = recordFix(routed, { ref: 'def456', summary: 'the fix' });
    const verified = retestDefect(fixPending, { passed: true, detail: 'holds' });

    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      index.indexArtifactAs(defectArtifact(verified), 'artifacts/defect/defect-1.v1.md');

      // LOAN-3 has no test verifying it — only a defect that traced to it and
      // was later closed. Reporting it verified on that strength alone is the
      // hole TST-6/T3.2.3 closed for quarantined tests, for defects.
      const [row] = index.coverage(['LOAN-3']);
      expect(row).toStrictEqual({
        id: 'LOAN-3',
        verifiedBy: [],
        tracedBy: ['defect-1@1'],
        verified: false,
      });
    } finally {
      db.close();
    }
  });
});
