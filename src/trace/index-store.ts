import type { DatabaseSync } from 'node:sqlite';
import type { Artifact } from '../artifact/store.js';
import { TRACE_DDL } from './ddl.js';
import {
  extractArtifactLinks,
  extractCommitLinks,
  looksLikeId,
  type CommitRecord,
  type ExtractedLinks,
  type TraceLink,
  type TraceNode,
} from './links.js';

/**
 * The derived trace index (ADR-4, ART-2).
 *
 * Queries the frontmatter cannot answer: which artifacts cite this
 * requirement, what does this design element trace to, which citations resolve
 * to nothing. Gate invalidation (ORC-6) and coverage (TST-2) are both walks
 * over this graph.
 */

export interface Declaration extends TraceNode {
  /** The artifact path or commit that declared it. */
  readonly source: string;
}

/** A citation of something no artifact declares. */
export interface DanglingReference {
  readonly src: string;
  readonly dst: string;
  readonly source: string;
}

export class TraceIndex {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static attach(db: DatabaseSync): TraceIndex {
    db.exec(TRACE_DDL);
    return new TraceIndex(db);
  }

  /** The commit the index was last brought up to, or null if never. */
  get indexedAt(): string | null {
    const row = this.#db
      .prepare('SELECT value FROM trace_meta WHERE key = ?')
      .get('indexedAt') as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  set indexedAt(commit: string | null) {
    if (commit === null) {
      this.#db.prepare('DELETE FROM trace_meta WHERE key = ?').run('indexedAt');
      return;
    }
    this.#db
      .prepare('INSERT OR REPLACE INTO trace_meta (key, value) VALUES (?, ?)')
      .run('indexedAt', commit);
  }

  /**
   * Replace everything read from `source` with `extracted`.
   *
   * Delete-then-insert rather than upsert: a link removed from an artifact has
   * to disappear from the index, and an upsert would leave it there forever —
   * which is the failure mode that makes a derived index untrustworthy, since
   * nothing about it looks wrong.
   */
  #replace(source: string, extracted: ExtractedLinks): void {
    this.forget(source);
    const node = this.#db.prepare(
      'INSERT OR REPLACE INTO trace_nodes (id, kind, label, source) VALUES (?, ?, ?, ?)',
    );
    for (const entry of extracted.nodes) {
      node.run(entry.id, entry.kind, entry.label, source);
    }
    const link = this.#db.prepare(
      'INSERT OR REPLACE INTO trace_links (src, dst, relation, source) VALUES (?, ?, ?, ?)',
    );
    for (const entry of extracted.links) {
      link.run(entry.src, entry.dst, entry.relation, source);
    }
  }

  /** Drop everything read from a source — an artifact version that is gone. */
  forget(source: string): void {
    this.#db.prepare('DELETE FROM trace_nodes WHERE source = ?').run(source);
    this.#db.prepare('DELETE FROM trace_links WHERE source = ?').run(source);
  }

  indexArtifact(artifact: Artifact): void {
    this.#replace(artifact.path, extractArtifactLinks(artifact));
  }

  /**
   * Index an artifact under a repo-relative source path.
   *
   * Preferred over {@link indexArtifact} anywhere the index might be rebuilt
   * elsewhere: an absolute path makes the rows machine-specific, so two
   * rebuilds of the same repository would differ in a field nobody queries
   * and everything compares.
   */
  indexArtifactAs(artifact: Artifact, relativePath: string): void {
    this.#replace(relativePath, extractArtifactLinks(artifact, relativePath));
  }

  indexCommit(commit: CommitRecord): void {
    this.#replace(commit.sha, extractCommitLinks(commit));
  }

  /** Every source currently represented in the index. */
  get sources(): readonly string[] {
    const rows = this.#db
      .prepare(
        'SELECT source FROM trace_nodes UNION SELECT source FROM trace_links ORDER BY source',
      )
      .all() as unknown as { source: string }[];
    return rows.map((row) => row.source);
  }

  /** Throw the index away. It is derived; nothing is lost. */
  clear(): void {
    this.#db.exec(
      'DELETE FROM trace_nodes; DELETE FROM trace_links; DELETE FROM trace_meta;',
    );
  }

  /** Where an id was declared. More than one row means two artifacts claim it. */
  declarationsOf(id: string): readonly Declaration[] {
    const rows = this.#db
      .prepare(
        'SELECT id, kind, label, source FROM trace_nodes WHERE id = ? ORDER BY source',
      )
      .all(id) as unknown as Declaration[];
    return rows;
  }

  /** What this node cites. */
  tracesFrom(id: string): readonly TraceLink[] {
    return this.#db
      .prepare(
        `SELECT src, dst, relation, source FROM trace_links
         WHERE src = ? ORDER BY relation, dst, source`,
      )
      .all(id) as unknown as TraceLink[];
  }

  /** What cites this node — the direction gate invalidation walks (ORC-6). */
  tracesTo(id: string): readonly TraceLink[] {
    return this.#db
      .prepare(
        `SELECT src, dst, relation, source FROM trace_links
         WHERE dst = ? ORDER BY relation, src, source`,
      )
      .all(id) as unknown as TraceLink[];
  }

  /**
   * Everything that cites `id`, directly or through other nodes.
   *
   * `declares` edges are followed backwards too, so a change to a requirement
   * reaches the artifacts citing it *and* the artifact that declared it — a
   * design citing ADR-1 is affected by a change to the design that declared
   * ADR-1, and stopping at the element would miss that.
   */
  downstreamOf(id: string): readonly string[] {
    const seen = new Set<string>();
    const queue = [id];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      for (const link of this.tracesTo(current)) {
        if (!seen.has(link.src)) {
          seen.add(link.src);
          queue.push(link.src);
        }
      }
    }

    seen.delete(id);
    return [...seen].sort();
  }

  /**
   * Citations that resolve to nothing.
   *
   * Filtered to strings that look like ids, because a `tracesTo` entry may
   * legitimately be prose — "goal: lend books" was never going to resolve, and
   * reporting it as dangling would bury the citation of `LOAN-9`, a
   * requirement that does not exist.
   */
  danglingReferences(): readonly DanglingReference[] {
    const rows = this.#db
      .prepare(
        `SELECT l.src AS src, l.dst AS dst, l.source AS source
           FROM trace_links l
          WHERE l.relation = 'traces-to'
            AND NOT EXISTS (SELECT 1 FROM trace_nodes n WHERE n.id = l.dst)
          ORDER BY l.dst, l.src, l.source`,
      )
      .all() as unknown as DanglingReference[];
    return rows.filter((row) => looksLikeId(row.dst));
  }

  /**
   * Dangling citations made by one artifact, or by an element it declares.
   *
   * Keyed on node ids rather than on the source path, so a caller does not
   * have to know how the artifact was spelled when it was indexed — the same
   * artifact indexed absolutely and relatively answers identically.
   */
  danglingFrom(artifactNode: string): readonly DanglingReference[] {
    const rows = this.#db
      .prepare(
        `WITH owned(id) AS (
           SELECT ?
           UNION
           SELECT dst FROM trace_links WHERE src = ? AND relation = 'declares'
         )
         SELECT l.src AS src, l.dst AS dst, l.source AS source
           FROM trace_links l
           JOIN owned o ON l.src = o.id
          WHERE l.relation = 'traces-to'
            AND NOT EXISTS (SELECT 1 FROM trace_nodes n WHERE n.id = l.dst)
          ORDER BY l.dst, l.src, l.source`,
      )
      .all(artifactNode, artifactNode) as unknown as DanglingReference[];
    return rows.filter((row) => looksLikeId(row.dst));
  }

  /** Every row, ordered — for comparing a rebuild against an update. */
  snapshot(): {
    nodes: readonly Declaration[];
    links: readonly TraceLink[];
  } {
    return {
      nodes: this.#db
        .prepare('SELECT id, kind, label, source FROM trace_nodes ORDER BY id, source')
        .all() as unknown as Declaration[],
      links: this.#db
        .prepare(
          `SELECT src, dst, relation, source FROM trace_links
           ORDER BY src, dst, relation, source`,
        )
        .all() as unknown as TraceLink[],
    };
  }
}
