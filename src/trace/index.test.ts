import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { ArtifactStore, type Artifact } from '../artifact/store.js';
import { MEMORY, openDatabase } from '../database.js';
import { TraceIndex } from './index-store.js';
import { TraceIndexer } from './indexer.js';
import { extractArtifactLinks, extractCommitLinks } from './links.js';

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
    const { links } = extractCommitLinks({
      sha: 'abc123',
      subject: 'Something',
      body: 'Co-Authored-By: Someone <a@b.c>\nSigned-off-by: Someone\n',
    });

    expect(links).toStrictEqual([]);
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
        verified: true,
      });
      // Cited by ADR-1 and nothing else. Designed for is not checked.
      expect(rows[1]).toStrictEqual({
        id: 'NFR-1',
        verifiedBy: [],
        tracedBy: ['ADR-1'],
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
