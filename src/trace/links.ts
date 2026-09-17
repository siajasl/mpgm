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
  /**
   * The source demonstrates that the target holds — a test, or a change whose
   * commit says so. Kept apart from `traces-to` because TST-2 asks which
   * requirements are *verified*, and a design element citing a requirement is
   * not evidence that anything checks it.
   */
  | 'verifies'
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
 * What an id looks like.
 *
 * For an artifact's own citations, this is used only for reporting: a node is
 * a node because some artifact declared it, not because it matched a regex,
 * so `danglingReferences` uses this only to tell `LOAN-9` — a citation of a
 * requirement that does not exist — apart from `goal: lend books`, which is
 * prose and was never going to resolve.
 *
 * A commit trailer has no declared element to check a citation against, so
 * there `extractCommitLinks` uses this pattern to decide whether a trailer
 * value becomes a link at all (T4.2.5) — which is why a plan task's lettered
 * split, `T3.1.2a`, has to match here: `Closes-Task: T3.1.2a` is a real
 * citation of a real id, and the pattern missing it would silently drop a
 * link that the graph used to carry.
 */
export const TRACE_ID_PATTERN =
  /^(?:[A-Z][A-Z0-9]{0,7}-[0-9]+|T[0-9]+(?:\.[0-9]+)+[a-z]?)$/;

export function looksLikeId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value);
}

/**
 * A convention id (`CONV-6`), shaped exactly like the numbered rules in
 * `kb/conventions.md`.
 *
 * DESIGN.md §4.3 (IMP-4, ART-2, DSG-4) states the rule this exists to
 * apply, enforced by `conventionTraceIssues`
 * (`src/context/conventions.ts`): "a convention id is never a trace
 * target" — a
 * convention is a rule about how work is done, not something an element
 * serves, so a `tracesTo`/`Traces:` citation of one puts an id in the graph
 * that nothing was ever going to declare. `danglingReferences` uses this to
 * tell that citation apart from a genuine dangling reference: `CONV-6` cited
 * by a commit trailer (`7b09783`) is not a broken link waiting on a node
 * nobody has written yet, it is a citation of a kind the graph was never
 * meant to resolve, and is reported as a stated, deliberate exclusion
 * instead of counted toward the dangling total.
 */
export const CONVENTION_ID_PATTERN = /^CONV-[0-9]+$/;

export function looksLikeConventionId(value: string): boolean {
  return CONVENTION_ID_PATTERN.test(value);
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
    for (const verified of stringsOf(value.verifies)) {
      links.push({ src: here, dst: verified, relation: 'verifies', source });
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== 'tracesTo' && key !== 'verifies') {
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
 * A trailer value the index would not turn into a graph edge: not id-shaped
 * even once trailing punctuation is stripped. Reported rather than indexed —
 * a `Traces:` line that says `DESIGN section 4.1` has declared something,
 * just not something the graph can name a node after.
 */
export interface UnindexedTrailerValue {
  readonly key: string;
  readonly value: string;
  readonly sha: string;
}

/**
 * A trailer key this module does not read, seen carrying an id-shaped value.
 * Reported so that the next spelling somebody invents for a trace claim is
 * visible rather than silently discarded — a key like `Co-Authored-By` whose
 * values never look like ids is not reported, since it was never a candidate.
 */
export interface UnrecognisedTrailer {
  readonly key: string;
  readonly sha: string;
}

export interface CommitLinks extends ExtractedLinks {
  readonly reports: {
    readonly unindexed: readonly UnindexedTrailerValue[];
    readonly unrecognised: readonly UnrecognisedTrailer[];
  };
}

/**
 * Trailers this reads, lowercased. `Traces:` is what the P1 bootstrap commits
 * spelled their claims with; `Traces-To:` is the same relation under the name
 * later commits settled on; `Implements` and `Closes-Task` are conveniences
 * that mean the same thing with a narrower intent, so that a commit can say
 * what it implements without inventing a vocabulary per repo. This is the
 * vocabulary; see also CLAUDE.md, which is where a commit author looks for it
 * before writing a trailer, not just here where it is read.
 */
const TRAILER_RELATIONS: Readonly<Record<string, TraceRelation>> = {
  traces: 'traces-to',
  'traces-to': 'traces-to',
  implements: 'traces-to',
  'closes-task': 'traces-to',
  // TST-2 coverage counts this one and not the others: a commit that
  // *implements* a requirement is not evidence that anything checks it.
  verifies: 'verifies',
};

/**
 * Trailing punctuation a sentence puts after a citation but that is never
 * part of the id itself — `Traces: ADR-3, DESIGN §4.1.` ends the line with a
 * full stop that belongs to the sentence, not to `§4.1`. Stripped before the
 * id shape is tested, so the trailing-period case resolves to the same node
 * as a citation without one, rather than a second one beside it.
 *
 * A trailer value is text from a commit a scanned repository did not write —
 * CodeQL flags `/[.,;:]+$/` here as `js/polynomial-redos` because V8's
 * backtracking engine re-checks the `$` anchor once per matched character on
 * a non-matching tail (`"." .repeat(n) + "x"` measures quadratic, not
 * linear), so a crafted trailer of many trailing punctuation characters
 * would cost the indexer quadratic time. Walking from the end by hand keeps
 * the same trimming with no backtracking to exploit.
 */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':']);

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

// `(\S.*)` rather than `(.+)`: `.` matches a tab, so with `[ \t]*` in front of
// it the two alternatives overlap and a line like `A:\t\t\t…` backtracks
// quadratically (CodeQL js/polynomial-redos).
const TRAILER_LINE_PATTERN = /^([A-Za-z][A-Za-z-]*):[ \t]*(\S.*)$/;

/**
 * Split a commit body into paragraphs — runs of non-blank lines separated by
 * one or more blank lines, each trimmed. A trailer block is a paragraph on
 * its own (T4.2.11): git trailers sit in the last paragraph of a message, set
 * apart from prose by the blank line above it, and this is the only signal a
 * plain-text body carries for "this line means what it says" versus "this
 * line is part of a sentence that happens to start with a word ending in a
 * colon".
 */
function paragraphsOf(body: string): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    paragraphs.push(current);
  }
  return paragraphs;
}

/**
 * Read the links a commit declares in its trailers.
 *
 * `Traces-To: LOAN-1, NFR-2` — comma-separated, one or more trailer lines.
 * Anything that is not a trailer is ignored: a commit body mentioning LOAN-1
 * in prose has not declared a link, and treating it as one would put entries
 * in the graph that no author could see they had written.
 *
 * A `Key: value` shaped line only counts if every other line in its paragraph
 * is shaped the same way (T4.2.11). Scanning every line regardless of context
 * misreads a wrapped sentence that happens to start a line with a trailer
 * key — this history carries "verifies: tracesTo, which
 * extractArtifactLinks turned into verifies" mid-paragraph in two commits,
 * which a plain per-line scan reads as a `Verifies:` claim. Git's own
 * trailer parsing (`git log --format=%(trailers)`) is not the fix: it reads
 * only the last paragraph of a message, and on this repository it finds a
 * trailer in none of the commits that spell their claim `Traces:` in a
 * paragraph of its own above `Co-Authored-By:` — delegating to it would
 * discard every claim T4.2.5 just made readable. Requiring the *whole*
 * paragraph to be trailer-shaped is the rule that was measured against this
 * history before being written: it keeps every recognised-key trailer line
 * that sits in a paragraph shaped entirely like trailers, and drops only the
 * two that sit inside prose.
 *
 * A value that does not look like an id after trailing punctuation is
 * stripped is reported rather than turned into a link — the graph gains no
 * node from it either way, since a link's destination is never itself a node,
 * but indexing it would leave an unresolvable string sitting in the graph
 * that nothing declared. Reporting it separately is what lets `DESIGN §4.1`
 * and `ADR-3` sit in the same trailer without the first being mistaken for a
 * dangling reference to a node that could exist.
 *
 * A trailer key this module does not recognise is reported the same way,
 * but only when it carries a value that looks like an id — `Co-Authored-By`
 * and `Signed-off-by` never do, so a commit carrying only those trailers
 * reports nothing.
 */
export function extractCommitLinks(commit: CommitRecord): CommitLinks {
  const node: TraceNode = {
    id: commit.sha,
    kind: 'commit',
    label: commit.subject,
  };
  const links: TraceLink[] = [];
  const unindexed: UnindexedTrailerValue[] = [];
  const unrecognised: UnrecognisedTrailer[] = [];
  const unrecognisedKeysSeen = new Set<string>();

  for (const paragraph of paragraphsOf(commit.body)) {
    const matches = paragraph.map((line) => TRAILER_LINE_PATTERN.exec(line));
    // A paragraph counts as trailers only if every line in it is `Key:
    // value` shaped — one prose line among trailer-shaped ones means the
    // whole paragraph is prose, not that the other lines are trailers.
    if (matches.some((match) => match === null)) {
      continue;
    }

    for (const match of matches) {
      const rawKey = match?.[1];
      const values = match?.[2];
      if (rawKey === undefined || values === undefined) {
        continue;
      }
      const key = rawKey.toLowerCase();
      const relation = TRAILER_RELATIONS[key];

      for (const raw of values.split(',').map((entry) => entry.trim())) {
        if (raw === '') {
          continue;
        }
        const stripped = stripTrailingPunctuation(raw);
        const idShaped = looksLikeId(stripped);

        if (relation === undefined) {
          if (idShaped && !unrecognisedKeysSeen.has(key)) {
            unrecognisedKeysSeen.add(key);
            unrecognised.push({ key: rawKey, sha: commit.sha });
          }
          continue;
        }

        if (idShaped) {
          links.push({ src: commit.sha, dst: stripped, relation, source: commit.sha });
        } else {
          unindexed.push({ key: rawKey, value: raw, sha: commit.sha });
        }
      }
    }
  }

  return { nodes: [node], links, reports: { unindexed, unrecognised } };
}
