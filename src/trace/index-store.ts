import type { DatabaseSync } from 'node:sqlite';
import type { Artifact } from '../artifact/store.js';
import { TRACE_DDL } from './ddl.js';
import {
  extractArtifactLinks,
  extractCommitLinks,
  looksLikeConventionId,
  looksLikeId,
  type CommitLinks,
  type CommitRecord,
  type ExtractedLinks,
  type Retraction,
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

/** One requirement's coverage (TST-2). */
export interface CoverageRow {
  readonly id: string;
  /** Nodes claiming to verify it — tests, or commits whose trailer says so. */
  readonly verifiedBy: readonly string[];
  /** Nodes that merely cite it. */
  readonly tracedBy: readonly string[];
  /**
   * Claims about this requirement withdrawn by a later commit (T4.3.12).
   *
   * Reported whether or not the withdrawal matched a claim: a
   * `Retracts-Verifies:` naming a commit that never claimed this id has still
   * been written by somebody, and dropping it from the report would be the
   * silent-disappearance this field exists to prevent. Each row says who
   * withdrew the claim and why, so a figure that moved downward can be
   * judged rather than merely trusted (HIL-5).
   */
  readonly retractions: readonly Retraction[];
  readonly verified: boolean;
}

/** A citation of something no artifact declares. */
export interface DanglingReference {
  readonly src: string;
  readonly dst: string;
  readonly source: string;
}

/**
 * A citation excluded from the dangling count on purpose, with why.
 *
 * Distinct from {@link DanglingReference}: an excluded reference is not a
 * broken link waiting on a node the index will eventually gain, it is a
 * citation of a kind the graph was never meant to resolve — reported so the
 * exclusion is visible rather than making the citation disappear the way
 * `looksLikeId` already makes prose disappear.
 */
export interface ExcludedReference extends DanglingReference {
  readonly reason: string;
}

/**
 * Why a convention citation is excluded rather than counted as dangling.
 *
 * Kept as a value the caller can compare against in a test, not just prose
 * folded into a template string at the call site.
 */
export const CONVENTION_CITATION_REASON =
  'a convention id is never a trace target (DESIGN.md §4.3, IMP-4/ART-2/DSG-4; ' +
  'enforced by conventionTraceIssues, src/context/conventions.ts): a ' +
  'convention is a rule about how work is done, not something an element ' +
  'serves, so no artifact will ever declare one and this citation is not ' +
  'waiting on one to appear.';

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
    this.#db.prepare('DELETE FROM trace_retractions WHERE source = ?').run(source);
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

  /**
   * Returns the commit's trailer reports (unindexed values, unrecognised
   * keys) alongside indexing it, so a caller walking many commits can collect
   * them without re-parsing each one to find out what did not go in.
   */
  indexCommit(commit: CommitRecord): CommitLinks['reports'] {
    const extracted = extractCommitLinks(commit);
    // `#replace` forgets this source first, so the retractions this commit
    // wrote are re-read here rather than accumulated — the same rule the
    // links follow, and what makes re-reading one commit produce the table a
    // full rebuild would.
    this.#replace(commit.sha, extracted);
    const retraction = this.#db.prepare(
      `INSERT OR REPLACE INTO trace_retractions
         (claim_source, id, author, why, source) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const entry of extracted.retractions) {
      retraction.run(entry.claimSource, entry.id, entry.author, entry.why, commit.sha);
    }
    return extracted.reports;
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
      'DELETE FROM trace_nodes; DELETE FROM trace_links; ' +
        'DELETE FROM trace_retractions; DELETE FROM trace_meta;',
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
   * Citations that resolve to nothing, other than the ones excluded on
   * purpose — see {@link excludedReferences}.
   *
   * Filtered to strings that look like ids, because a `tracesTo` entry may
   * legitimately be prose — "goal: lend books" was never going to resolve, and
   * reporting it as dangling would bury the citation of `LOAN-9`, a
   * requirement that does not exist. A convention id (`CONV-6`) looks like an
   * id and is filtered out for a different reason: nothing will ever declare
   * one (T4.2.16), so it is reported by {@link excludedReferences} instead of
   * counted here — counting it would give this report a floor no amount of
   * filing a missing artifact could bring to zero.
   */
  danglingReferences(): readonly DanglingReference[] {
    return this.#unresolvedReferences().filter(
      (row) => looksLikeId(row.dst) && !looksLikeConventionId(row.dst),
    );
  }

  /**
   * Citations excluded from {@link danglingReferences} on purpose, with why.
   *
   * A convention id cited via `tracesTo`/`Traces:` is the one case today
   * (T4.2.16): the project's own rule, stated in DESIGN.md §4.3 (IMP-4,
   * ART-2, DSG-4) and enforced by `conventionTraceIssues`
   * (`src/context/conventions.ts`), is that a convention id is never a
   * trace target, so no artifact will declare `CONV-6` and this
   * citation is not a gap in the index to close, it is a citation the
   * trailer vocabulary was never meant to carry. Reported rather than
   * silently dropped, so the exclusion is a decision a reader can see and
   * check, not an absence they have to notice on their own.
   */
  excludedReferences(): readonly ExcludedReference[] {
    return this.#unresolvedReferences()
      .filter((row) => looksLikeConventionId(row.dst))
      .map((row) => ({ ...row, reason: CONVENTION_CITATION_REASON }));
  }

  /** Citations naming a node the index does not have, whatever they look like. */
  #unresolvedReferences(): readonly DanglingReference[] {
    return this.#db
      .prepare(
        `SELECT l.src AS src, l.dst AS dst, l.source AS source
           FROM trace_links l
          WHERE l.relation IN ('traces-to', 'verifies')
            AND NOT EXISTS (SELECT 1 FROM trace_nodes n WHERE n.id = l.dst)
          ORDER BY l.dst, l.src, l.source`,
      )
      .all() as unknown as DanglingReference[];
  }

  /** Elements some artifact declares, with what declared them. */
  declaredElements(): readonly Declaration[] {
    return this.#db
      .prepare(
        `SELECT id, kind, label, source FROM trace_nodes
          WHERE kind = 'element' ORDER BY id, source`,
      )
      .all() as unknown as Declaration[];
  }

  /** What demonstrates that this holds (TST-2). */
  verifiedBy(id: string): readonly string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT src FROM trace_links
          WHERE dst = ? AND relation = 'verifies' ORDER BY src`,
      )
      .all(id) as unknown as { src: string }[];
    const withdrawn = this.retractionsOf(id);
    // Matched by prefix because a retraction names the claim the way a person
    // reads a commit — `627e6cd` — while the link carries the full sha. The
    // pattern requires seven hex characters, git's own abbreviation floor, so
    // this cannot collapse two commits an author meant to keep apart.
    return rows
      .map((row) => row.src)
      .filter((src) => !withdrawn.some((entry) => src.startsWith(entry.claimSource)));
  }

  /**
   * Withdrawals recorded against this requirement (T4.3.12).
   *
   * Every one, including a withdrawal naming a commit that never claimed the
   * id — see {@link CoverageRow.retractions} for why an unmatched one is
   * still reported rather than dropped.
   */
  retractionsOf(id: string): readonly Retraction[] {
    const rows = this.#db
      .prepare(
        `SELECT claim_source, id, author, why, source FROM trace_retractions
          WHERE id = ? ORDER BY source, claim_source`,
      )
      .all(id) as unknown as {
      claim_source: string;
      id: string;
      author: string;
      why: string;
      source: string;
    }[];
    return rows.map((row) => ({
      claimSource: row.claim_source,
      id: row.id,
      by: row.source,
      author: row.author,
      why: row.why,
    }));
  }

  /**
   * Requirement-level coverage (TST-2).
   *
   * `verifiedBy` is deliberately narrow: something has to claim to *verify*
   * the requirement. `tracedBy` is everything else that cites it, reported
   * separately because a design element referring to a requirement is
   * evidence that it was designed for, not that it was checked — and the
   * difference is the whole point of a coverage report.
   */
  coverage(ids: readonly string[]): readonly CoverageRow[] {
    return ids.map((id) => {
      const verifiedBy = this.verifiedBy(id);
      return {
        id,
        verifiedBy,
        tracedBy: this.tracesTo(id)
          .filter((link) => link.relation === 'traces-to')
          .map((link) => link.src)
          .filter((src, index, all) => all.indexOf(src) === index),
        retractions: this.retractionsOf(id),
        verified: verifiedBy.length > 0,
      };
    });
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
