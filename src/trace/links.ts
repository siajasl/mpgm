import type { Artifact } from '../artifact/store.js';

/**
 * Trace-link extraction (ADR-4, ART-2).
 *
 * Frontmatter and commit trailers are the source of truth; this reads them.
 * The index built from these links is derived and rebuildable, so nothing here
 * may invent a link that is not written down somewhere a human can read.
 */

/**
 * What a node in the graph is.
 *
 * `artifact` nodes are versioned files; `element` nodes are the ids artifacts
 * declare inside themselves (a requirement, an ADR, a plan task); `commit`
 * nodes are changes. ART-2 asks for one graph over all of them.
 */
export type TraceNodeKind = 'artifact' | 'element' | 'commit';

export type TraceRelation =
  /** The source cites the target as something it serves or derives from. */
  | 'traces-to'
  /** The source artifact declares the target element. */
  | 'declares'
  /** The source artifact version replaces the target version. */
  | 'supersedes';

export interface TraceNode {
  readonly id: string;
  readonly kind: TraceNodeKind;
  /** Short human label, for `mpgm trace` output. */
  readonly label: string;
}

export interface TraceLink {
  readonly src: string;
  readonly dst: string;
  readonly relation: TraceRelation;
  /**
   * Where the link was read from — an artifact path or a commit sha. The index
   * is rebuilt by re-reading these, and an incremental update discards
   * everything that came from a source it is about to re-read.
   */
  readonly source: string;
}

export interface ExtractedLinks {
  readonly nodes: readonly TraceNode[];
  readonly links: readonly TraceLink[];
}

/**
 * What an id looks like, used only for reporting.
 *
 * Graph structure never depends on this: an id is a node because some artifact
 * declared it, not because it matched a regex. The pattern exists so that
 * `danglingReferences` can tell `LOAN-9` — a citation of a requirement that
 * does not exist — apart from `goal: lend books`, which is prose and was never
 * going to resolve.
 */
export const TRACE_ID_PATTERN = /^(?:[A-Z][A-Z0-9]{0,7}-[0-9]+|T[0-9]+(?:\.[0-9]+)+)$/;

export function looksLikeId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value);
}

/** The node id for an artifact version. */
export function artifactNodeId(id: string, version: number): string {
  return `${id}@${String(version)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

function labelOf(value: Record<string, unknown>): string {
  for (const key of ['title', 'statement', 'name', 'summary']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate.length > 120 ? `${candidate.slice(0, 117)}...` : candidate;
    }
  }
  return '';
}

/**
 * Read the links an artifact declares.
 *
 * Two kinds, found by walking the validated `data`:
 *
 * - an object carrying a string `id` **declares** that element, and citations
 *   nested under it belong to the element rather than to the whole artifact;
 * - an object carrying `tracesTo` **cites** each entry, from the nearest
 *   enclosing declared element, or from the artifact itself if there is none.
 *
 * The walk is generic because the alternative is a table of paths per schema,
 * which drifts the moment a schema gains a field — and drifts silently, since
 * a missing trace looks exactly like an artifact that declared none.
 */
export function extractArtifactLinks(
  artifact: Artifact,
  /**
   * What to record as the origin of these links. Defaults to the artifact's
   * own path; callers pass a repo-relative one so that an index rebuilt on
   * another machine produces the same rows rather than merely equivalent ones.
   */
  source: string = artifact.path,
): ExtractedLinks {
  const self = artifactNodeId(artifact.id, artifact.version);
  const nodes: TraceNode[] = [
    {
      id: self,
      kind: 'artifact',
      label: `${artifact.id} v${String(artifact.version)} (${artifact.schema})`,
    },
  ];
  const links: TraceLink[] = [];

  for (const cited of artifact.tracesTo) {
    links.push({ src: self, dst: cited, relation: 'traces-to', source });
  }

  if (artifact.supersedes !== null) {
    links.push({
      src: self,
      dst: artifactNodeId(artifact.id, artifact.supersedes),
      relation: 'supersedes',
      source,
    });
  }

  const walk = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry, owner);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    let here = owner;
    const declared = value.id;
    if (typeof declared === 'string' && declared !== '') {
      here = declared;
      nodes.push({ id: declared, kind: 'element', label: labelOf(value) });
      links.push({ src: self, dst: declared, relation: 'declares', source });
    }

    for (const cited of stringsOf(value.tracesTo)) {
      links.push({ src: here, dst: cited, relation: 'traces-to', source });
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== 'tracesTo') {
        walk(child, here);
      }
    }
  };

  walk(artifact.data, self);

  return { nodes, links };
}

export interface CommitRecord {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * Trailers this reads, lowercased. `Traces-To:` is the general one; the others
 * are conveniences that mean the same thing with a narrower intent, so that a
 * commit can say what it implements without inventing a vocabulary per repo.
 */
const TRAILER_KEYS = new Set(['traces-to', 'implements', 'verifies', 'closes-task']);

/**
 * Read the links a commit declares in its trailers.
 *
 * `Traces-To: LOAN-1, NFR-2` — comma-separated, one or more trailer lines.
 * Anything that is not a trailer is ignored: a commit body mentioning LOAN-1
 * in prose has not declared a link, and treating it as one would put entries
 * in the graph that no author could see they had written.
 */
export function extractCommitLinks(commit: CommitRecord): ExtractedLinks {
  const node: TraceNode = {
    id: commit.sha,
    kind: 'commit',
    label: commit.subject,
  };
  const links: TraceLink[] = [];

  for (const line of commit.body.split('\n')) {
    const match = /^([A-Za-z][A-Za-z-]*):[ \t]*(.+)$/.exec(line.trim());
    const key = match?.[1]?.toLowerCase();
    const values = match?.[2];
    if (key === undefined || values === undefined || !TRAILER_KEYS.has(key)) {
      continue;
    }
    for (const cited of values.split(',').map((entry) => entry.trim())) {
      if (cited !== '') {
        links.push({
          src: commit.sha,
          dst: cited,
          relation: 'traces-to',
          source: commit.sha,
        });
      }
    }
  }

  return { nodes: [node], links };
}
