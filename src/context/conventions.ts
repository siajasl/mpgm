import type { KbDocument } from './knowledge-base.js';

/**
 * Project conventions from the knowledge base (IMP-4, CTX-1, DESIGN §4.3).
 *
 * IMP-4 asks for two things that look like one: implementation conforms to the
 * conventions, and deviations are *flagged rather than silently introduced*.
 * The first is a matter of putting them in front of the agent. The second
 * needs conventions to be nameable — an author cannot declare a deviation from
 * a bullet point, and a reviewer cannot report one either.
 *
 * So a conventions document numbers its rules, and both sides of the review
 * speak in those ids. What the kernel then does is arithmetic: a convention
 * the reviewer found broken and the author never mentioned was introduced
 * silently, which is the thing IMP-4 forbids.
 */

export interface Convention {
  /** e.g. `CONV-3`. */
  readonly id: string;
  readonly text: string;
  /** The knowledge-base document it came from. */
  readonly source: string;
}

/**
 * Frontmatter that marks a document as the project's conventions.
 *
 * Opt-in, because the alternative is guessing: a glossary entry written as a
 * bullet would otherwise become a rule the reviewer holds people to.
 */
export const CONVENTIONS_KIND = 'conventions';

/** `- **CONV-1** One logical change per commit.` */
// `(\S.*)` rather than `(.+)`: `.` matches a space, so with `\s+` in front
// the two overlap and a heavily indented line backtracks quadratically
// (CodeQL js/polynomial-redos).
const CONVENTION_ITEM = /^[-*][ \t]+\*\*([A-Z][A-Z0-9]*-\d+)\*\*[ \t]+(\S.*)$/;

export function isConventionsDocument(document: KbDocument): boolean {
  return document.kind === CONVENTIONS_KIND;
}

/**
 * Read the numbered conventions out of the knowledge base.
 *
 * A rule spanning several lines keeps its continuation: markdown list items
 * wrap, and dropping everything after the first line would silently truncate
 * half the rules in any document written to a sensible width.
 */
export function parseConventions(documents: readonly KbDocument[]): Convention[] {
  const conventions: Convention[] = [];

  for (const document of documents) {
    if (!isConventionsDocument(document)) {
      continue;
    }
    let current: { id: string; lines: string[] } | undefined;
    const flush = (): void => {
      if (current !== undefined) {
        conventions.push({
          id: current.id,
          text: current.lines.join(' ').replace(/\s+/g, ' ').trim(),
          source: document.path,
        });
      }
      current = undefined;
    };

    for (const line of document.content.split('\n')) {
      const match = CONVENTION_ITEM.exec(line.trim());
      if (match?.[1] !== undefined && match[2] !== undefined) {
        flush();
        current = { id: match[1], lines: [match[2]] };
      } else if (current !== undefined && /^\s+\S/.test(line)) {
        current.lines.push(line.trim());
      } else {
        flush();
      }
    }
    flush();
  }

  return conventions;
}

/** Duplicate ids across documents, which would make a deviation ambiguous. */
export function duplicateConventionIds(conventions: readonly Convention[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const convention of conventions) {
    if (seen.has(convention.id)) {
      duplicated.add(convention.id);
    }
    seen.add(convention.id);
  }
  return [...duplicated].sort();
}

/**
 * Conventions the reviewer found broken that the author never declared.
 *
 * Comparison is by id and nothing else. Matching on prose would mean deciding
 * whether two descriptions of the same rule are the same rule, which is
 * exactly the judgement call that must not be made silently here.
 */
export function undeclaredDeviations(
  found: readonly string[],
  declared: readonly string[],
): string[] {
  const stated = new Set(declared);
  return [...new Set(found)].filter((id) => !stated.has(id)).sort();
}

/**
 * Convention ids used where a requirement id belongs.
 *
 * A convention is a rule about *how* work is done; a trace says *what* a piece
 * of work serves (ART-2, DSG-4). Citing one in `tracesTo` puts an id in the
 * trace graph that no artifact declares, so it shows up as a dangling
 * reference forever — and it hides the real problem, which is that the element
 * has no requirement behind it.
 *
 * This exists because the context tells every task that conventions are
 * binding and nameable, and `tracesTo` is the only id-shaped field most
 * artifacts have. Telling agents not to do it is not enough on its own: the
 * field is right there, and it is the obvious place to put an id.
 */
export function conventionTraceIssues(
  output: unknown,
  conventions: readonly string[],
): string[] {
  const known = new Set(conventions);
  const issues: string[] = [];

  const report = (field: string, id: string, owner: string): void => {
    issues.push(
      `${owner}: '${id}' is a project convention, not a requirement, and cannot appear in ` +
        `\`${field}\`. A trace says what the element serves; if the element departs from ` +
        `${id}, say so in its own text instead.`,
    );
  };

  const walk = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry, owner);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }

    const record = value as Record<string, unknown>;
    const declared = record.id;
    const here = typeof declared === 'string' && declared !== '' ? declared : owner;

    for (const field of ['tracesTo', 'verifies'] as const) {
      const cited = record[field];
      if (!Array.isArray(cited)) {
        continue;
      }
      for (const id of cited) {
        if (typeof id === 'string' && known.has(id)) {
          report(field, id, here);
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'tracesTo' && key !== 'verifies') {
        walk(child, here);
      }
    }
  };

  walk(output, 'output');
  return issues;
}
