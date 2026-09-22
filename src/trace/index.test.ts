import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { ArtifactStore, type Artifact } from '../artifact/store.js';
import { MEMORY, openDatabase } from '../database.js';
import { projectArtifactSchemas } from '../schemas.js';
import { TraceIndex } from './index-store.js';
import { TraceIndexer } from './indexer.js';
import { extractArtifactLinks, extractCommitLinks } from './links.js';

/** `src/trace/` -> repo root, to walk mpgm's own history and artifacts (T4.2.16). */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const tempDirs: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-trace-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const schemas = new ArtifactSchemaRegistry([
  defineArtifactSchema('scope', z.looseObject({})),
  defineArtifactSchema('design', z.looseObject({})),
]);

const provenance = {
  task: 'derive',
  role: 'analyst',
  model: 'claude-sonnet-5',
  runId: 'run-1',
};

const SCOPE = {
  requirements: [
    { id: 'LOAN-1', statement: 'Record a loan.', tracesTo: ['goal: track loans'] },
    { id: 'NFR-1', statement: 'Lose nothing.', tracesTo: ['goal: track loans'] },
  ],
};

const DESIGN = {
  summary: 'The chosen design.',
  components: [{ name: 'loan-service', tracesTo: ['LOAN-1'] }],
  adrs: [
    {
      id: 'ADR-1',
      title: 'Use SQLite',
      tracesTo: ['NFR-1', 'LOAN-9'],
    },
  ],
};

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'design',
    version: 1,
    schema: 'design',
    schemaVersion: 1,
    tracesTo: [],
    producedBy: provenance,
    supersedes: null,
    egress: undefined,
    data: DESIGN,
    path: '/abs/artifacts/design/design.v1.md',
    ...overrides,
  };
}

describe('extracting links from an artifact', () => {
  it('attributes a citation to the nearest enclosing declared element', () => {
    const { links } = extractArtifactLinks(artifact(), 'artifacts/design/design.v1.md');

    // ADR-1 declares itself, so its citations are ADR-1's rather than the
    // whole artifact's — that is the granularity gate invalidation needs.
    expect(links).toContainEqual({
      src: 'ADR-1',
      dst: 'NFR-1',
      relation: 'traces-to',
      source: 'artifacts/design/design.v1.md',
    });
    // A component declares no id, so its citation belongs to the artifact.
    expect(links).toContainEqual({
      src: 'design@1',
      dst: 'LOAN-1',
      relation: 'traces-to',
      source: 'artifacts/design/design.v1.md',
    });
  });

  it('records what the artifact declares', () => {
    const { nodes, links } = extractArtifactLinks(artifact());

    expect(nodes.map((node) => node.id)).toStrictEqual(['design@1', 'ADR-1']);
    expect(nodes[1]?.label).toBe('Use SQLite');
    expect(links).toContainEqual(
      expect.objectContaining({ src: 'design@1', dst: 'ADR-1', relation: 'declares' }),
    );
  });

  it('links a successor to the version it replaces', () => {
    const { links } = extractArtifactLinks(artifact({ version: 2, supersedes: 1 }));

    expect(links).toContainEqual(
      expect.objectContaining({
        src: 'design@2',
        dst: 'design@1',
        relation: 'supersedes',
      }),
    );
  });

  it('carries frontmatter citations as well as ones inside the data', () => {
    const { links } = extractArtifactLinks(artifact({ tracesTo: ['SCP-1'] }));

    expect(links).toContainEqual(
      expect.objectContaining({ src: 'design@1', dst: 'SCP-1', relation: 'traces-to' }),
    );
  });
});

describe('extracting links from a commit', () => {
  it('reads the trailers it recognises', () => {
    const { nodes, links } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Add the loan service',
      body: 'Some prose about LOAN-1.\n\nTraces-To: LOAN-1, NFR-1\nVerifies: LOAN-1\n',
    });

    expect(nodes[0]).toMatchObject({ id: 'abc123', kind: 'commit' });
    expect(links.map((link) => link.dst)).toStrictEqual(['LOAN-1', 'NFR-1', 'LOAN-1']);
  });

  it('separates verification from citation (TST-2)', () => {
    const { links } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Add the ledger',
      body: 'Implements: LOAN-1\nVerifies: LOAN-1, NFR-1\n',
    });

    // A commit that *implements* a requirement is not evidence that anything
    // checks it, which is the distinction a coverage report exists to make.
    expect(links).toStrictEqual([
      { src: 'abc123', dst: 'LOAN-1', relation: 'traces-to', source: 'abc123' },
      { src: 'abc123', dst: 'LOAN-1', relation: 'verifies', source: 'abc123' },
      { src: 'abc123', dst: 'NFR-1', relation: 'verifies', source: 'abc123' },
    ]);
  });

  it('ignores an id merely mentioned in prose', () => {
    // A body that names LOAN-1 in a sentence has not declared a link, and
    // treating it as one puts entries in the graph no author can see they
    // wrote.
    const { links } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Mention LOAN-1',
      body: 'This is about LOAN-1 but declares nothing.\n',
    });

    expect(links).toStrictEqual([]);
  });

  it('ignores trailers that are not trace trailers', () => {
    const { links, reports } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Something',
      body: 'Co-Authored-By: Someone <a@b.c>\nSigned-off-by: Someone\n',
    });

    expect(links).toStrictEqual([]);
    // Neither value is id-shaped, so a commit carrying only these trailers
    // produces no report either — there is nothing here worth a human
    // noticing.
    expect(reports.unrecognised).toStrictEqual([]);
    expect(reports.unindexed).toStrictEqual([]);
  });

  it('reads Traces: as a traces-to link — the P1 bootstrap spelling', () => {
    // The P1 bootstrap commits spelled their claims `Traces:`, which is not
    // one of the keys the index used to read. T4.2.5 closes that gap.
    const { links } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Add phase playbook format and loader',
      body: 'Traces: DESIGN §2, EXT-3.\n',
    });

    expect(links).toContainEqual({
      src: 'abc123',
      dst: 'EXT-3',
      relation: 'traces-to',
      source: 'abc123',
    });
  });

  it('never lets Traces: count as verifying — Verifies is the only key TST-2 counts', () => {
    const { links } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Add the ledger',
      body: 'Traces: LOAN-1\n',
    });

    expect(links).toStrictEqual([
      { src: 'abc123', dst: 'LOAN-1', relation: 'traces-to', source: 'abc123' },
    ]);
  });

  it('reports a trailer value that is not id-shaped, and indexes no link for it', () => {
    // This history carries values exactly like these, alongside real ids, in
    // the same trailer line.
    const { links, reports } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Add M1.3 verification demo and derived gate tags',
      body: 'Traces: PLAN M1.3 verification, ADR-3, ORC-3, HIL-1, HIL-4.\n',
    });

    expect(links.map((link) => link.dst)).toStrictEqual([
      'ADR-3',
      'ORC-3',
      'HIL-1',
      'HIL-4',
    ]);
    expect(reports.unindexed).toStrictEqual([
      { key: 'Traces', value: 'PLAN M1.3 verification', sha: 'abc123' },
    ]);
  });

  it('resolves a value that is id-shaped only after trailing punctuation is stripped', () => {
    // The last citation on a `Traces:` line ends the sentence, so it carries
    // a full stop that is not part of the id.
    const { links, reports } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Add versioned artifact store with gate immutability',
      body: 'Traces: ADR-3, ART-1, ART-3.\n',
    });

    expect(links).toContainEqual({
      src: 'abc123',
      dst: 'ART-3',
      relation: 'traces-to',
      source: 'abc123',
    });
    // Resolved to the same id as a citation without the punctuation, not to
    // a second node beside it.
    expect(links.filter((link) => link.dst.startsWith('ART-3'))).toHaveLength(1);
    expect(reports.unindexed).toStrictEqual([]);
  });

  it('reads a lettered plan-task split as id-shaped, not as prose', () => {
    // This history really does cite `Closes-Task: T3.1.2a` — a plan task's
    // lettered split. Id-shape now decides whether a trailer value is
    // indexed at all, so the pattern missing this would silently drop a
    // citation the graph used to carry regardless of shape.
    const { links, reports } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Something',
      body: 'Closes-Task: T3.1.2a\n',
    });

    expect(links).toStrictEqual([
      { src: 'abc123', dst: 'T3.1.2a', relation: 'traces-to', source: 'abc123' },
    ]);
    expect(reports.unindexed).toStrictEqual([]);
  });

  it('reports an unrecognised trailer whose value is id-shaped, by key and commit', () => {
    const { links, reports } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Something',
      body: 'Refs: LOAN-1\n',
    });

    // Never read as a claim — the next spelling somebody invents is not
    // silently added to the graph.
    expect(links).toStrictEqual([]);
    expect(reports.unrecognised).toStrictEqual([{ key: 'Refs', sha: 'abc123' }]);
  });

  it('does not read a wrapped sentence that starts a line with a trailer key (T4.2.11)', () => {
    // Two commits in this history wrap a sentence so that a line break lands
    // right after "verifies:" — the prose reads "a verified defect wrote
    // verifies: tracesTo, which extractArtifactLinks turned into verifies
    // trace links", and the middle line of that paragraph is
    // `verifies: tracesTo, which extractArtifactLinks turned into verifies`.
    // Scanning every line regardless of its paragraph reads that as a
    // `Verifies:` claim with two comma-separated values — `tracesTo` and
    // `which extractArtifactLinks turned into verifies` — even though
    // neither is id-shaped enough to become a link, the key that got through
    // is the only one TST-2 coverage counts.
    const { links, reports } = extractCommitLinks({
      sha: 'abc123',
      subject: "Stop a closed defect from posing as a requirement's test coverage",
      body: [
        'Review of the T3.2.4 change found that a verified defect wrote',
        'verifies: tracesTo, which extractArtifactLinks turned into',
        'verifies trace links and TraceIndexStore.coverage() then read',
        'that as this requirement being verified.',
        '',
        'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
        '',
      ].join('\n'),
    });

    expect(links).toStrictEqual([]);
    // Nothing worth reporting either: the paragraph is prose, not a trailer
    // that happens to carry a value the id-shape filter refuses.
    expect(reports.unindexed).toStrictEqual([]);
    expect(reports.unrecognised).toStrictEqual([]);
  });

  it('still reads Verifies: when its paragraph is trailers, nothing else', () => {
    // The other half of the T4.2.11 rule: a paragraph that is entirely
    // `Key: value` shaped is read, same as before. Without this half, a
    // parser that reads no trailers at all would also pass the previous
    // test (CONV-6).
    const { links } = extractCommitLinks({
      sha: 'def456',
      subject: 'Add the ledger',
      body: [
        'Some prose explaining the change, on its own paragraph.',
        '',
        'Verifies: LOAN-1',
        'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
        '',
      ].join('\n'),
    });

    expect(links).toStrictEqual([
      { src: 'def456', dst: 'LOAN-1', relation: 'verifies', source: 'def456' },
    ]);
  });
});

function indexed(): { db: ReturnType<typeof openDatabase>; index: TraceIndex } {
  const db = openDatabase(MEMORY);
  return { db, index: TraceIndex.attach(db) };
}

describe('the index', () => {
  it('answers both directions of a trace (ART-2)', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');

      expect(index.tracesFrom('ADR-1').map((link) => link.dst)).toStrictEqual([
        'LOAN-9',
        'NFR-1',
      ]);
      expect(index.tracesTo('LOAN-1').map((link) => link.src)).toStrictEqual([
        'design@1',
      ]);
      expect(index.declarationsOf('ADR-1')[0]?.label).toBe('Use SQLite');
    } finally {
      db.close();
    }
  });

  it('a punctuation-trimmed citation lands on the declared node, not a second one', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');
      index.indexCommit({
        sha: 'commit-1',
        subject: 'Cite ADR-1 at the end of a sentence',
        body: 'Traces: ADR-1.\n',
      });

      // The commit cites `ADR-1.`, with the sentence's full stop; it must
      // resolve to the same node ADR-1 that the design artifact declared,
      // not to a second one spelled with the period still attached.
      expect(
        index
          .tracesFrom('commit-1')
          .map((link) => ({ dst: link.dst, relation: link.relation })),
      ).toStrictEqual([{ dst: 'ADR-1', relation: 'traces-to' }]);
      expect(index.tracesTo('ADR-1').map((link) => link.src)).toContain('commit-1');
      expect(index.declarationsOf('ADR-1.')).toStrictEqual([]);
      expect(index.declarationsOf('ADR-1')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('walks the graph to everything a change would reach (ORC-6)', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(
        artifact({ id: 'scope', schema: 'scope', data: SCOPE }),
        'artifacts/scope/requirements.v1.md',
      );
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');

      // NFR-1 is cited by ADR-1, which the design artifact declares — so a
      // change to NFR-1 reaches the design, not just the ADR.
      expect(index.downstreamOf('NFR-1')).toStrictEqual(['ADR-1', 'design@1', 'scope@1']);
      expect(index.downstreamOf('LOAN-1')).toStrictEqual(['design@1', 'scope@1']);
    } finally {
      db.close();
    }
  });

  it('drops a link that the artifact no longer declares', () => {
    const { db, index } = indexed();
    try {
      const source = 'artifacts/design/design.v1.md';
      index.indexArtifactAs(artifact(), source);
      expect(index.tracesTo('LOAN-1')).toHaveLength(1);

      // The same source, re-read, with the citation gone. An upsert would
      // leave the stale link in place forever, and nothing about the index
      // would look wrong.
      index.indexArtifactAs(artifact({ data: { components: [] } }), source);

      expect(index.tracesTo('LOAN-1')).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('reports citations of things that do not exist, and only those', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(
        artifact({ id: 'scope', schema: 'scope', data: SCOPE }),
        'artifacts/scope/requirements.v1.md',
      );
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');

      const dangling = index.danglingReferences();

      // LOAN-9 does not exist. "goal: track loans" is prose and was never
      // going to resolve; reporting it would bury the finding that matters.
      expect(dangling.map((entry) => entry.dst)).toStrictEqual(['LOAN-9']);
      expect(dangling[0]?.src).toBe('ADR-1');
    } finally {
      db.close();
    }
  });

  /**
   * T4.2.16: a convention id cited via `Traces:`/`tracesTo` is excluded from
   * `danglingReferences` on purpose, not because it resolved — nothing ever
   * declares a `CONV-` id (DESIGN.md §4.3, IMP-4/ART-2/DSG-4's rule, enforced
   * by `conventionTraceIssues`, is that a convention is never a trace
   * target) — and `excludedReferences` says so rather than
   * making the citation disappear. Reproduces the real citation this history
   * carries: commit `7b09783` trailers `Traces: NFR-6, CONV-6.`, an id-shaped
   * requirement citation next to an id-shaped convention citation in the same
   * trailer.
   */
  it('excludes a convention citation from dangling rather than resolving or hiding it', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(
        artifact({ id: 'scope', schema: 'scope', data: SCOPE }),
        'artifacts/scope/requirements.v1.md',
      );
      index.indexCommit({
        sha: '7b09783',
        subject: 'Make the tag undo non-destructive',
        body: 'Traces: NFR-6, CONV-6.\n',
      });

      // NFR-1 exists, CONV-6 does not — but CONV-6 is not "dangling" the way
      // a missing NFR-6 declaration would be: NFR-6 is a real requirement id
      // this fixture happens not to declare, and CONV-6 is a convention id no
      // artifact was ever going to declare. Both fail to resolve; only one
      // is a gap in the index.
      const dangling = index.danglingReferences();
      expect(dangling.map((entry) => entry.dst)).toStrictEqual(['NFR-6']);

      const excluded = index.excludedReferences();
      expect(excluded).toHaveLength(1);
      expect(excluded[0]?.dst).toBe('CONV-6');
      expect(excluded[0]?.src).toBe('7b09783');
      expect(excluded[0]?.reason).toMatch(/never a trace target/);
    } finally {
      db.close();
    }
  });
});

describe('dangling citations from one artifact', () => {
  it('covers what the artifact and its elements cite, and nothing else', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(
        artifact({ id: 'scope', schema: 'scope', data: SCOPE }),
        'artifacts/scope/requirements.v1.md',
      );
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');

      // ADR-1 is declared by design@1, so its dangling citation of LOAN-9 is
      // the design's problem — which is what a gate criterion on the design
      // has to be able to see.
      expect(index.danglingFrom('design@1').map((entry) => entry.dst)).toStrictEqual([
        'LOAN-9',
      ]);
      // The scope artifact cites only prose, which was never going to resolve.
      expect(index.danglingFrom('scope@1')).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('is keyed on nodes, so it does not care how the source was spelled', () => {
    const { db, index } = indexed();
    try {
      // Indexed under absolute paths rather than repo-relative ones.
      index.indexArtifact(
        artifact({
          id: 'scope',
          schema: 'scope',
          data: SCOPE,
          path: '/abs/artifacts/scope/requirements.v1.md',
        }),
      );
      index.indexArtifact(artifact());

      expect(index.danglingFrom('design@1').map((entry) => entry.dst)).toStrictEqual([
        'LOAN-9',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('coverage (TST-2)', () => {
  it('counts only what claims to verify, and says what merely cites', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(
        artifact({ id: 'scope', schema: 'scope', data: SCOPE }),
        'artifacts/scope/requirements.v1.md',
      );
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');
      index.indexCommit({
        sha: 'commit-1',
        subject: 'Add the ledger',
        body: 'Verifies: LOAN-1\n',
      });

      const rows = index.coverage(['LOAN-1', 'NFR-1']);

      expect(rows[0]).toStrictEqual({
        id: 'LOAN-1',
        verifiedBy: ['commit-1'],
        tracedBy: ['design@1'],
        retractions: [],
        verified: true,
      });
      // Cited by ADR-1 and nothing else. Designed for is not checked.
      expect(rows[1]).toStrictEqual({
        id: 'NFR-1',
        verifiedBy: [],
        tracedBy: ['ADR-1'],
        retractions: [],
        verified: false,
      });
    } finally {
      db.close();
    }
  });

  it('lists the elements artifacts declare, with what declared them', () => {
    const { db, index } = indexed();
    try {
      index.indexArtifactAs(
        artifact({ id: 'scope', schema: 'scope', data: SCOPE }),
        'artifacts/scope/requirements.v1.md',
      );
      index.indexArtifactAs(artifact(), 'artifacts/design/design.v1.md');

      expect(index.declaredElements().map((entry) => entry.id)).toStrictEqual([
        'ADR-1',
        'LOAN-1',
        'NFR-1',
      ]);
      expect(index.declaredElements()[0]?.source).toBe('artifacts/design/design.v1.md');
    } finally {
      db.close();
    }
  });
});

describe('a Traces: trailer against a repository the test builds (T4.2.5)', () => {
  // Against this repository's own history the defect this closes is
  // invisible: CI checks it out at depth one, so a test walking commits here
  // would find none dropped and pass whether or not `Traces:` was read. Every
  // assertion below is against a repository the test creates for itself.
  it('moves a requirement from untraced to traced once Traces: is read', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);

      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: {
          requirements: [{ id: 'LOAN-1', statement: 'Record a loan.', tracesTo: [] }],
        },
        producedBy: provenance,
      });
      commit('Add the requirement set');

      let report = new TraceIndexer({ repo: root, index, artifacts: store }).update();
      // Nothing cites LOAN-1 yet — the T3.2.1 report would have shown it
      // untraced, same as before this task.
      expect(index.coverage(['LOAN-1'])[0]).toStrictEqual({
        id: 'LOAN-1',
        verifiedBy: [],
        tracedBy: [],
        retractions: [],
        verified: false,
      });

      commit('Add the loan service\n\nTraces: LOAN-1, DESIGN §4.1.\n');
      report = new TraceIndexer({ repo: root, index, artifacts: store }).update();

      const row = index.coverage(['LOAN-1'])[0];
      // Traced now — the commit's `Traces:` claim reached it — but still not
      // verified: nothing here raised a coverage figure, because Verifies
      // remains the only key TST-2 counts.
      expect(row?.tracedBy).toHaveLength(1);
      expect(row?.verified).toBe(false);
      // `DESIGN §4.1` is not id-shaped — reported, not turned into a link.
      expect(report.unindexedTrailerValues).toHaveLength(1);
      expect(report.unindexedTrailerValues[0]).toMatchObject({
        key: 'Traces',
        value: 'DESIGN §4.1.',
      });
      expect(report.unindexedTrailerValues[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      db.close();
    }
  });

  it('reports an invented trailer spelling seen in this history, and stays silent on the ones that are not claims', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);

      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: {
          requirements: [{ id: 'LOAN-1', statement: 'Record a loan.', tracesTo: [] }],
        },
        producedBy: provenance,
      });
      commit('Add the requirement set');
      commit('Merge branch\n\nRefs: LOAN-1\n');
      commit('Add a fix\n\nCo-Authored-By: Someone <a@b.c>\nSigned-off-by: Someone\n');

      const report = new TraceIndexer({ repo: root, index, artifacts: store }).rebuild();

      expect(report.unrecognisedTrailers).toHaveLength(1);
      expect(report.unrecognisedTrailers[0]).toMatchObject({ key: 'Refs' });
      // The Co-Authored-By/Signed-off-by-only commit produced no report at
      // all — its values never looked like ids, so it was never a candidate.
      expect(report.unindexedTrailerValues).toStrictEqual([]);
    } finally {
      db.close();
    }
  });
});

/** A project with artifacts and commits, to compare rebuild against update. */
function repository(): {
  root: string;
  store: ArtifactStore;
  commit: (m: string) => void;
} {
  const root = newRoot();
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'trace@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'trace test'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.mpgm/\n');

  const store = new ArtifactStore({ root, schemas });
  const commit = (message: string): void => {
    execFileSync('git', ['add', '--all'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', message], {
      cwd: root,
    });
  };

  return { root, store, commit };
}

describe('rebuild and incremental update agree', () => {
  it('produces the same index either way — the T2.2.1 criterion', () => {
    const { root, store, commit } = repository();
    const incremental = openDatabase(MEMORY);
    const full = openDatabase(MEMORY);

    try {
      const incrementalIndex = TraceIndex.attach(incremental);
      const fullIndex = TraceIndex.attach(full);

      store.write({
        id: 'requirement-set',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set\n\nTraces-To: LOAN-1\n');

      // Bring the incremental index up to the first commit, then move the
      // repository on twice more without touching it in between.
      new TraceIndexer({
        repo: root,
        index: incrementalIndex,
        artifacts: store,
      }).update();

      store.write({
        id: 'design',
        basePath: 'artifacts/design/design.md',
        schema: 'design',
        data: DESIGN,
        producedBy: { ...provenance, task: 'record-design' },
      });
      commit('Add the design\n\nTraces-To: NFR-1, LOAN-1\n');

      store.write({
        id: 'design',
        basePath: 'artifacts/design/design.md',
        schema: 'design',
        data: { ...DESIGN, adrs: [{ id: 'ADR-1', title: 'Use SQLite', tracesTo: [] }] },
        producedBy: { ...provenance, task: 'record-design' },
      });
      commit('Revise the design\n\nTraces-To: NFR-1\n');

      const updated = new TraceIndexer({
        repo: root,
        index: incrementalIndex,
        artifacts: store,
      }).update();
      const rebuilt = new TraceIndexer({
        repo: root,
        index: fullIndex,
        artifacts: store,
      }).rebuild();

      expect(updated.indexedAt).toBe(rebuilt.indexedAt);
      expect(incrementalIndex.snapshot()).toStrictEqual(fullIndex.snapshot());
      // And it really did less work than the rebuild it matched.
      expect(updated.commits).toBe(2);
      expect(rebuilt.commits).toBe(3);
    } finally {
      incremental.close();
      full.close();
    }
  });

  it('forgets an artifact that was deleted between commits', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      const indexer = new TraceIndexer({ repo: root, index, artifacts: store });

      store.write({
        id: 'design',
        basePath: 'artifacts/design/design.md',
        schema: 'design',
        data: DESIGN,
        producedBy: provenance,
      });
      commit('Add the design');
      indexer.update();
      expect(index.tracesTo('LOAN-1')).toHaveLength(1);

      rmSync(join(root, 'artifacts', 'design', 'design.v1.md'));
      commit('Remove the design');
      indexer.update();

      expect(index.tracesTo('LOAN-1')).toStrictEqual([]);
      expect(index.declarationsOf('ADR-1')).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('falls back to a rebuild when the recorded commit is gone', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'design',
        basePath: 'artifacts/design/design.md',
        schema: 'design',
        data: DESIGN,
        producedBy: provenance,
      });
      commit('Add the design');

      // A commit git no longer knows — a rewritten history. A partial update
      // against it would leave an index that looks current and is not.
      index.indexedAt = '0000000000000000000000000000000000000000';
      const report = new TraceIndexer({ repo: root, index, artifacts: store }).update();

      expect(report.artifacts).toBe(1);
      expect(index.tracesTo('LOAN-1')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

/**
 * T4.2.16: measured against this checkout's own history, not a fixture the
 * test builds.
 *
 * Every other real-history claim in this file (T4.2.5, T4.2.11) is
 * deliberately tested against a repository the test constructs instead,
 * because CI's default checkout is depth one and a test reading commits here
 * would find nothing to read regardless of whether the defect it exists to
 * catch is still live — passing either way is exactly the CONV-6 failure
 * this task exists to refuse (see the block comment above `describe('a
 * Traces: trailer against a repository the test builds (T4.2.5)')`). T4.2.16
 * accepts that trade the other way: mpgm trace --dangling naming eight
 * citations is a measurement over this repository's own log, not over a
 * fixture, and a fix proven only against a fixture would leave that
 * measurement unchanged. The CI workflow's `test` job checkout is widened to
 * full history (`fetch-depth: 0`, `.github/workflows/ci.yml`) in the same
 * change, so this assertion is load-bearing there rather than trivially true
 * on a single shallow commit.
 *
 * Read-only against the checkout: the index lives in an in-memory database
 * (`MEMORY`), and `ArtifactStore`/`readCommits` only read `context.root` —
 * nothing here writes `.mpgm/state.db` into this working tree the way the
 * `mpgm` binary itself would.
 */
describe("this repository's own history (T4.2.16)", () => {
  it('names no dangling citation other than the convention citation it declares deliberate', () => {
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      const artifacts = new ArtifactStore({
        root: projectRoot,
        schemas: projectArtifactSchemas(),
      });
      new TraceIndexer({ repo: projectRoot, index, artifacts }).rebuild();

      // The measured floor this task exists to close: ADR-4, ADR-5, ADR-6
      // and CONV-6 all resolved to nothing against this same history before
      // the design artifact existed and before CONV- citations were reported
      // as a deliberate exclusion rather than counted.
      expect(index.danglingReferences()).toStrictEqual([]);

      // The one citation this change declares deliberately unresolvable, and
      // no other — a test asserting only `danglingReferences` is empty would
      // still pass if excluding *every* citation, however unrelated, were
      // the mechanism (CONV-6).
      const excluded = index.excludedReferences();
      expect(excluded).toHaveLength(1);
      expect(excluded[0]?.dst).toBe('CONV-6');
      expect(excluded[0]?.src).toBe('7b09783647eb1ae76d63a5329f125759ce538292');
      expect(excluded[0]?.reason).toMatch(/never a trace target/);

      // ADR-1 through ADR-7 all resolve, not merely the three this history
      // happens to cite today — DESIGN.md's own ids carried across
      // unchanged, per the design artifact's own summary.
      for (const id of ['ADR-1', 'ADR-2', 'ADR-3', 'ADR-4', 'ADR-5', 'ADR-6', 'ADR-7']) {
        expect(index.declarationsOf(id).length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  /**
   * The coverage figure says what it rests on (T4.3.11).
   *
   * Asserted against this repository rather than a fixture, which is the
   * whole point: the defect was measured here — 3 commits in 337 carrying
   * `Verifies:` while 1,300-odd tests passed, so `2/84` counted how often
   * somebody wrote one word — and a synthetic repository seeded with one
   * verifying commit passes whatever the real history holds. That is the
   * test this defect already survived.
   *
   * What is asserted is the gap, not a number: the number moves every time
   * a task writes a trailer, and pinning it would make this a test about
   * today's history rather than about the figure's honesty.
   */
  it('reports the basis the coverage figure rests on', () => {
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      const artifacts = new ArtifactStore({
        root: projectRoot,
        schemas: projectArtifactSchemas(),
      });
      new TraceIndexer({ repo: projectRoot, index, artifacts }).rebuild();

      const basis = index.coverageBasis();
      // Real history, not a fixture: no seeded repository in this suite is
      // anywhere near this size, so a test that quietly started reading one
      // would fail here rather than pass quietly.
      expect(basis.commits).toBeGreaterThan(100);

      // The gap the figure has to declare. Most commits claim nothing the
      // index reads; most of those that do claim to *serve* rather than to
      // *check*, and `Verifies:` is the only key coverage counts.
      expect(basis.withTraceClaim).toBeLessThan(basis.commits);
      expect(basis.withVerifies).toBeLessThan(basis.withTraceClaim);

      // And the figure is exactly as wide as those claims — which is the
      // sentence the report now carries: it counts claims, not checks.
      const scopeSources = new Set(
        artifacts
          .list('artifacts')
          .filter((entry) => entry.artifact.schema === 'scope')
          .map((entry) => entry.relativePath),
      );
      const requirements = index
        .declaredElements()
        .filter((element) => scopeSources.has(element.source))
        .map((element) => element.id);
      const rows = index.coverage(requirements);
      expect(rows.length).toBeGreaterThan(50);
      expect(rows.filter((row) => row.verified).length).toBeLessThanOrEqual(
        basis.withVerifies,
      );
    } finally {
      db.close();
    }
  });
});

/**
 * Withdrawing a verification claim (T4.3.12).
 *
 * The defect these close: `Verifies:` links are keyed by the commit that
 * wrote them, `coverage` marks a requirement verified on `verifiedBy.length >
 * 0`, and nothing read a later commit as taking a claim back — so a claim its
 * own author had publicly retracted went on counting. This repository has
 * three such rows (`627e6cd`'s TST-1/TST-2, `264d947`'s NFR-3/PLN-4), each
 * retracted in a later commit body that the index could not see.
 *
 * Driven against a real repository rather than hand-built `CommitRecord`s
 * because the matching is by sha prefix: a retraction names the claim the way
 * a person reads it (`627e6cd`) and the link carries the full forty
 * characters, and a fixture that invented both would never exercise that.
 */
describe('a retracted Verifies: claim (T4.3.12)', () => {
  const shaOf = (root: string): string =>
    execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();

  it('stops counting as coverage, and says who withdrew it and why', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      commit('Check the loan ledger\n\nVerifies: LOAN-1\n');
      const claim = shaOf(root);

      new TraceIndexer({ repo: root, index, artifacts: store }).rebuild();
      // Verified while the claim stands — the state every row in this
      // repository's coverage report is in today.
      expect(index.coverage(['LOAN-1'])[0]?.verified).toBe(true);

      commit(
        `Retract the LOAN-1 claim: the test asserts nothing\n\nRetracts-Verifies: ${claim}:LOAN-1\n`,
      );
      new TraceIndexer({ repo: root, index, artifacts: store }).rebuild();

      const row = index.coverage(['LOAN-1'])[0];
      expect(row?.verified).toBe(false);
      expect(row?.verifiedBy).toStrictEqual([]);
      // Named, not merely subtracted. A figure that moved downward with no
      // account of who moved it is the laundering this field exists to
      // prevent (HIL-5).
      expect(row?.retractions).toHaveLength(1);
      expect(row?.retractions[0]).toMatchObject({
        claimSource: claim,
        id: 'LOAN-1',
        author: 'trace test <trace@example.com>',
        why: 'Retract the LOAN-1 claim: the test asserts nothing',
      });
    } finally {
      db.close();
    }
  });

  it('withdraws one of a commit’s several claims and leaves the rest', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      // The `627e6cd` shape: three claims on one commit, two of them untrue.
      commit('Check two things\n\nVerifies: LOAN-1, NFR-1\n');
      const claim = shaOf(root);
      commit(`Retract only LOAN-1\n\nRetracts-Verifies: ${claim}:LOAN-1\n`);

      new TraceIndexer({ repo: root, index, artifacts: store }).rebuild();

      const [loan, nfr] = index.coverage(['LOAN-1', 'NFR-1']);
      expect(loan?.verified).toBe(false);
      // The claim that was true is untouched. A retraction naming only the
      // requirement, or only the commit, would have taken this with it.
      expect(nfr?.verified).toBe(true);
      expect(nfr?.retractions).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it('reports a withdrawal that matches no claim rather than dropping it', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      const unrelated = shaOf(root);
      commit(`Withdraw a claim nobody made\n\nRetracts-Verifies: ${unrelated}:LOAN-1\n`);

      new TraceIndexer({ repo: root, index, artifacts: store }).rebuild();

      const row = index.coverage(['LOAN-1'])[0];
      // Unverified either way, so the interesting assertion is the second:
      // somebody wrote this and the report says so. Silently discarding it
      // is the disappearance the reporting exists to prevent.
      expect(row?.verified).toBe(false);
      expect(row?.retractions).toHaveLength(1);
      expect(row?.retractions[0]?.claimSource).toBe(unrelated);
    } finally {
      db.close();
    }
  });

  it('survives an incremental update identically to a full rebuild', () => {
    const { root, store, commit } = repository();
    const incremental = openDatabase(MEMORY);
    const full = openDatabase(MEMORY);
    try {
      const incrementalIndex = TraceIndex.attach(incremental);
      const fullIndex = TraceIndex.attach(full);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      commit('Check the loan ledger\n\nVerifies: LOAN-1\n');
      const claim = shaOf(root);

      // The incremental index sees the claim before the withdrawal exists,
      // which is the ordering a real repository is always in.
      new TraceIndexer({
        repo: root,
        index: incrementalIndex,
        artifacts: store,
      }).update();
      commit(`Retract it\n\nRetracts-Verifies: ${claim}:LOAN-1\n`);
      new TraceIndexer({
        repo: root,
        index: incrementalIndex,
        artifacts: store,
      }).update();
      new TraceIndexer({ repo: root, index: fullIndex, artifacts: store }).rebuild();

      expect(incrementalIndex.coverage(['LOAN-1'])).toStrictEqual(
        fullIndex.coverage(['LOAN-1']),
      );
      expect(incrementalIndex.coverage(['LOAN-1'])[0]?.verified).toBe(false);
    } finally {
      incremental.close();
      full.close();
    }
  });
});

/**
 * An unread trace claim survives a second look (T4.3.6).
 *
 * M4.2's verification asks for a run over this repository's own history that
 * names every commit whose trace claim could not be read. It held on a cold
 * index and nowhere else: `mpgm trace --dangling` printed seventeen NOTE
 * lines against a rebuild and none against the warm index beside it, because
 * the lines came from `TraceIndexer.update()`'s per-call return and an index
 * already at HEAD re-reads no commit. Neither report was wrong about the
 * history; only one had been asked to read it.
 *
 * Persisted rather than recomputed: recomputing would walk the whole history
 * on a command that is otherwise incremental, while a row keyed by its source
 * commit inherits the forget path `update()` already reports as `forgotten`,
 * which is what CLAUDE.md already requires of this index and what makes an
 * incremental update equal a full rebuild.
 */
describe('an unread trace claim is named on every invocation (T4.3.6)', () => {
  it('names the same claims on a second pass that read no new commit', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      // Both shapes: a recognised key whose value is not id-shaped, and an
      // unrecognised key carrying one.
      commit('Serve the design\n\nTraces: DESIGN §4.7\n');
      commit('Refer to a requirement\n\nRefs: LOAN-1\n');

      const first = new TraceIndexer({ repo: root, index, artifacts: store }).update();
      expect(first.unindexedTrailerValues).toHaveLength(1);
      expect(first.unrecognisedTrailers).toHaveLength(1);

      // Nothing has moved. The per-call report is empty and correct — it
      // answers what this pass read — and the durable one is not.
      const second = new TraceIndexer({ repo: root, index, artifacts: store }).update();
      expect(second.unindexedTrailerValues).toStrictEqual([]);
      expect(second.unrecognisedTrailers).toStrictEqual([]);

      const claims = index.unreadClaims();
      expect(claims.unindexed).toHaveLength(1);
      expect(claims.unindexed[0]).toMatchObject({
        key: 'Traces',
        value: 'DESIGN §4.7',
      });
      expect(claims.unrecognised).toHaveLength(1);
      expect(claims.unrecognised[0]).toMatchObject({ key: 'Refs' });
    } finally {
      db.close();
    }
  });

  it('holds the same claims after an incremental update as after a rebuild', () => {
    const { root, store, commit } = repository();
    const incremental = openDatabase(MEMORY);
    const full = openDatabase(MEMORY);
    try {
      const incrementalIndex = TraceIndex.attach(incremental);
      const fullIndex = TraceIndex.attach(full);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      commit('Serve the design\n\nTraces: DESIGN §4.7\n');

      new TraceIndexer({
        repo: root,
        index: incrementalIndex,
        artifacts: store,
      }).update();
      commit('Serve another section\n\nTraces: PLAN M1.1 verification\n');
      new TraceIndexer({
        repo: root,
        index: incrementalIndex,
        artifacts: store,
      }).update();
      new TraceIndexer({ repo: root, index: fullIndex, artifacts: store }).rebuild();

      expect(incrementalIndex.unreadClaims()).toStrictEqual(fullIndex.unreadClaims());
      expect(incrementalIndex.unreadClaims().unindexed).toHaveLength(2);
    } finally {
      incremental.close();
      full.close();
    }
  });

  it('does not let a reported claim raise a coverage figure', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      // Reported *because* it was not indexed (T4.2.5). Making the report
      // durable must not quietly make the claim count.
      commit('Claim a section\n\nVerifies: DESIGN §4.7\n');

      new TraceIndexer({ repo: root, index, artifacts: store }).update();

      expect(index.unreadClaims().unindexed).toHaveLength(1);
      expect(index.coverage(['LOAN-1'])[0]?.verified).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rebuilds rather than trusting an index an older reader wrote', () => {
    const { root, store, commit } = repository();
    const db = openDatabase(MEMORY);
    try {
      const index = TraceIndex.attach(db);
      store.write({
        id: 'scope',
        basePath: 'artifacts/scope/requirements.md',
        schema: 'scope',
        data: SCOPE,
        producedBy: provenance,
      });
      commit('Add the requirement set');
      commit('Serve the design\n\nTraces: DESIGN §4.7\n');
      new TraceIndexer({ repo: root, index, artifacts: store }).update();

      // Exactly the state an index written before this task is in: current
      // at HEAD, and holding nothing in a table its reader did not know. An
      // update that trusted `indexedAt` alone would re-read no commit and
      // report an empty table as the history's own answer.
      db.exec(
        "DELETE FROM trace_unread_claims; DELETE FROM trace_meta WHERE key = 'schemaVersion'",
      );
      expect(index.unreadClaims().unindexed).toStrictEqual([]);

      const report = new TraceIndexer({ repo: root, index, artifacts: store }).update();

      expect(report.commits).toBeGreaterThan(0);
      expect(index.unreadClaims().unindexed).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
