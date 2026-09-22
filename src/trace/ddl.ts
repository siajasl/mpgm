/**
 * Derived traceability index (ADR-4).
 *
 * Every row here is rebuildable from artifact frontmatter and commit trailers,
 * which is why there are no append-only triggers and no migration story: if
 * this ever disagrees with the files, the files win and the index is dropped.
 *
 * Rows are keyed partly by `source` — the artifact path or commit sha a link
 * was read from — so re-reading one source can replace exactly its own rows
 * and nothing else. That is what makes an incremental update produce the same
 * table as a full rebuild rather than merely a similar one.
 */
export const TRACE_DDL = `
CREATE TABLE IF NOT EXISTS trace_nodes (
  id      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  label   TEXT NOT NULL,
  source  TEXT NOT NULL,
  PRIMARY KEY (id, source)
) STRICT;

CREATE TABLE IF NOT EXISTS trace_links (
  src       TEXT NOT NULL,
  dst       TEXT NOT NULL,
  relation  TEXT NOT NULL,
  source    TEXT NOT NULL,
  PRIMARY KEY (src, dst, relation, source)
) STRICT;

-- A \`Verifies:\` claim withdrawn by a later commit (T4.3.12). Keyed by the
-- commit that *made* the claim and the id withdrawn, so one of a commit's
-- several claims can go without taking the others; \`source\` is the commit
-- that wrote the withdrawal, which is what re-reading that commit replaces.
CREATE TABLE IF NOT EXISTS trace_retractions (
  claim_source  TEXT NOT NULL,
  id            TEXT NOT NULL,
  author        TEXT NOT NULL,
  why           TEXT NOT NULL,
  source        TEXT NOT NULL,
  PRIMARY KEY (claim_source, id, source)
) STRICT;

CREATE TABLE IF NOT EXISTS trace_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS trace_links_dst ON trace_links (dst);
CREATE INDEX IF NOT EXISTS trace_links_src ON trace_links (src);
CREATE INDEX IF NOT EXISTS trace_nodes_source ON trace_nodes (source);
CREATE INDEX IF NOT EXISTS trace_links_source ON trace_links (source);
CREATE INDEX IF NOT EXISTS trace_retractions_id ON trace_retractions (id);
CREATE INDEX IF NOT EXISTS trace_retractions_source ON trace_retractions (source);
`;
