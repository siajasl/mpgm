import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact } from '../artifact/store.js';
import { assembleContext } from './assembler.js';
import { collectDecisions, decisionsIn, relevantDecisions } from './decisions.js';
import { DEFAULT_EGRESS_POLICY } from './egress.js';
import { kbUpdatesOf, KnowledgeBaseError, writeKbDocument } from './kb-writer.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-kb-'));
  tempDirs.push(dir);
  return dir;
}

const provenance = {
  task: 'record-conventions',
  role: 'kb-curator',
  model: 'claude-sonnet-5',
  runId: 'run-1',
};

const design: Artifact = {
  id: 'design',
  version: 1,
  schema: 'design',
  schemaVersion: 1,
  tracesTo: [],
  producedBy: { ...provenance, task: 'record-design', role: 'design-architect' },
  supersedes: null,
  egress: undefined,
  data: {
    components: [{ name: 'member-view', tracesTo: ['LOAN-6'] }],
    adrs: [
      {
        id: 'ADR-3',
        title: 'Leave the member view unauthenticated',
        decision: 'Serve it unauthenticated, bounded by the intranet.',
        consequences: ['Anyone on the intranet can read any member loan list.'],
        tracesTo: ['LOAN-6'],
      },
      {
        id: 'ADR-1',
        title: 'Embed SQLite',
        decision: 'Use SQLite in WAL mode inside the service process.',
        consequences: ['One writer at a time.'],
        tracesTo: ['NFR-1'],
      },
    ],
  },
  path: 'artifacts/design/design.v1.md',
};

describe('finding prior decisions (CTX-3)', () => {
  it('recognises a decision by its shape, not by its schema', () => {
    // A project recording decisions somewhere other than the Design artifact
    // still gets them surfaced.
    const found = decisionsIn(design);

    expect(found.map((entry) => entry.id)).toStrictEqual(['ADR-3', 'ADR-1']);
    expect(found[0]).toMatchObject({
      title: 'Leave the member view unauthenticated',
      tracesTo: ['LOAN-6'],
      sourceArtifact: 'design',
    });
  });

  it('ignores an object that has an id but decides nothing', () => {
    const notADecision: Artifact = {
      ...design,
      data: { requirements: [{ id: 'LOAN-1', statement: 'Record a loan.' }] },
    };

    expect(decisionsIn(notADecision)).toStrictEqual([]);
  });
});

describe('choosing which decisions to surface (CTX-3)', () => {
  const decisions = collectDecisions([design]);

  it('surfaces only decisions the task could contradict', () => {
    const relevant = relevantDecisions({
      decisions,
      touching: new Set(['LOAN-6']),
    });

    // ADR-1 is about NFR-1, which this task does not touch. Handing an agent
    // every decision ever taken is the same as handing it none.
    expect(relevant.map((entry) => entry.id)).toStrictEqual(['ADR-3']);
  });

  it('does not read an artifact its own decisions back to it', () => {
    const relevant = relevantDecisions({
      decisions,
      touching: new Set(['LOAN-6', 'NFR-1']),
      alreadyPresent: new Set(['design']),
    });

    expect(relevant).toStrictEqual([]);
  });

  it('surfaces nothing when nothing overlaps', () => {
    expect(relevantDecisions({ decisions, touching: new Set(['LOAN-2']) })).toStrictEqual(
      [],
    );
  });
});

describe('a surfaced decision in the assembled context', () => {
  const task = { description: 'Revise the member view.', prompt: 'Make it better.' };

  it('states the decision, its consequences, and that it is contestable', () => {
    const context = assembleContext({
      task,
      upstream: [],
      decisions: relevantDecisions({
        decisions: collectDecisions([design]),
        touching: new Set(['LOAN-6']),
      }),
      kb: [],
      policy: DEFAULT_EGRESS_POLICY,
    });

    expect(context.includedDecisions).toStrictEqual(['ADR-3']);
    expect(context.prompt).toContain('## Prior decisions');
    expect(context.prompt).toContain('Leave the member view unauthenticated');
    expect(context.prompt).toContain('Anyone on the intranet can read');
    // An agent that quietly works around a decision produces work the project
    // cannot reconcile; one that says it no longer holds produces a finding.
    expect(context.prompt).toContain('do not route around it silently');
  });

  it('says nothing at all when there is nothing to say', () => {
    const context = assembleContext({
      task,
      upstream: [],
      kb: [],
      policy: DEFAULT_EGRESS_POLICY,
    });

    expect(context.prompt).not.toContain('Prior decisions');
    expect(context.includedDecisions).toStrictEqual([]);
  });
});

describe('writing the knowledge base (CTX-4)', () => {
  const update = {
    path: 'conventions/testing.md',
    title: 'Testing conventions',
    content: 'Property tests for anything with an invariant.',
    rationale: 'The design relies on the ledger invariant holding.',
  };

  it('writes a document with its provenance and rationale', () => {
    const root = newRoot();
    const path = writeKbDocument({ root, update, producedBy: provenance });

    expect(path).toBe(join('kb', 'conventions', 'testing.md'));
    const written = readFileSync(join(root, path), 'utf8');
    expect(written).toContain('title: Testing conventions');
    expect(written).toContain('role: kb-curator');
    // An entry whose reason nobody can see is one nobody will dare delete.
    expect(written).toContain('rationale: The design relies on');
    expect(written).toContain('Property tests for anything with an invariant.');
  });

  it('labels a document whose author named no class', () => {
    const root = newRoot();
    // Left unlabelled it would be withheld from every task after this one,
    // and the curator's work would be invisible to exactly the readers CTX-4
    // exists to serve.
    const path = writeKbDocument({ root, update, producedBy: provenance });

    expect(readFileSync(join(root, path), 'utf8')).toContain('egress: internal');
  });

  it('keeps the class the author did name', () => {
    const root = newRoot();
    const path = writeKbDocument({
      root,
      update: { ...update, egress: 'restricted' },
      producedBy: provenance,
    });

    expect(readFileSync(join(root, path), 'utf8')).toContain('egress: restricted');
  });

  it('refuses a path that would escape the knowledge base', () => {
    const root = newRoot();

    // Otherwise a task could rewrite its own role, which is the one thing the
    // read-only toolset exists to prevent.
    for (const path of ['../roles/analyst.md', 'a/../../roles/analyst.md']) {
      expect(() =>
        writeKbDocument({ root, update: { ...update, path }, producedBy: provenance }),
      ).toThrow(KnowledgeBaseError);
    }
    expect(() =>
      writeKbDocument({
        root,
        update: { ...update, path: '/etc/passwd' },
        producedBy: provenance,
      }),
    ).toThrow(/absolute/);
  });

  it('refuses anything that is not markdown', () => {
    expect(() =>
      writeKbDocument({
        root: newRoot(),
        update: { ...update, path: 'conventions/testing.sh' },
        producedBy: provenance,
      }),
    ).toThrow(/not a markdown file/);
  });

  it('reads updates out of a task output, and treats none as none', () => {
    expect(kbUpdatesOf({ summary: 's', kbUpdates: [update] })).toStrictEqual([update]);
    // A task that looked and found nothing worth recording has said something
    // useful.
    expect(kbUpdatesOf({ summary: 's', kbUpdates: [] })).toStrictEqual([]);
    expect(kbUpdatesOf({ summary: 's' })).toStrictEqual([]);
    expect(kbUpdatesOf(null)).toStrictEqual([]);
  });
});
