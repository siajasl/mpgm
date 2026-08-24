import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { egressClassSchema, type EgressClass } from './egress.js';

/**
 * The in-repo knowledge base (`kb/`) — conventions, glossary, decision log
 * (CTX-1, CTX-4). Plain markdown so both agents and the operator can read it.
 */

// Loose: knowledge-base frontmatter is authored by hand and may carry fields
// the harness has no opinion about. Only title and egress are interpreted.
const kbFrontmatterSchema = z.looseObject({
  title: z.string().min(1).optional(),
  egress: egressClassSchema.optional(),
  /**
   * What the document is, when the harness treats one kind differently from
   * the rest. `conventions` is the only value that means anything today
   * (IMP-4); everything else is a document like any other.
   */
  kind: z.string().min(1).optional(),
});

export interface KbDocument {
  /** Repo-relative path, used as a stable identifier. */
  readonly path: string;
  readonly title: string;
  readonly egress: EgressClass | undefined;
  /** Declared kind, if the document claims one. */
  readonly kind: string | undefined;
  readonly content: string;
}

export function parseKbDocument(path: string, contents: string): KbDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  const body = match === null ? contents : contents.slice(match[0].length);
  const frontmatter =
    match === null ? {} : kbFrontmatterSchema.parse(parseYaml(match[1] ?? '') ?? {});

  return {
    path,
    title: frontmatter.title ?? path,
    egress: frontmatter.egress,
    kind: frontmatter.kind,
    content: body.trim(),
  };
}

/** Load every markdown document under `directory`, recursively. */
export function loadKnowledgeBase(directory: string): KbDocument[] {
  const root = resolve(directory);
  const documents: KbDocument[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        documents.push(parseKbDocument(relative(root, full), readFileSync(full, 'utf8')));
      }
    }
  };

  walk(root);
  return documents;
}
