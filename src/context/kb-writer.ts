import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Provenance } from '../artifact/store.js';
import { egressClassSchema, type EgressClass } from './egress.js';

/**
 * Updating the knowledge base from a task (CTX-4).
 *
 * The knowledge base is plain markdown that agents and the operator both read,
 * so it has to stay incrementally updatable as the project moves. Tasks do not
 * write it directly: roles stay read-only and the kernel writes what a task's
 * validated output declared, exactly as it does for artifacts. A role with
 * write access to `kb/` would be a role that can rewrite the conventions it is
 * being held to.
 */

export class KnowledgeBaseError extends Error {}

export const kbUpdateSchema = z.object({
  /** Repo-relative path under `kb/`, e.g. `conventions/testing.md`. */
  path: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  /**
   * Why this belongs in the knowledge base. Not decoration: an entry nobody
   * can see the reason for is one nobody will dare delete (CTX-3).
   */
  rationale: z.string().min(1),
  /**
   * Data-egress class (SAF-6). A curator that knows the entry quotes
   * restricted material says so; silence means
   * {@link DEFAULT_KB_EGRESS}, which is written into the document rather
   * than left for a reader to assume.
   */
  egress: egressClassSchema.optional(),
});

/**
 * Class stamped on a knowledge-base document whose author named none.
 *
 * The alternative is leaving it unlabelled, which a fail-closed policy
 * withholds — so the curator's own output would be invisible to every task
 * after it, and CTX-4's point is that what one task learned reaches the next.
 */
export const DEFAULT_KB_EGRESS: EgressClass = 'internal';

export type KbUpdate = z.infer<typeof kbUpdateSchema>;

/** The field a task declaring `updatesKb` must return. */
export const kbUpdatesSchema = z.object({
  kbUpdates: z.array(kbUpdateSchema),
});

/**
 * Read the knowledge-base updates out of a task's validated output.
 *
 * Absent or malformed means none. A task that declared it updates the
 * knowledge base and then returned nothing has said nothing needed changing,
 * which is a legitimate outcome.
 */
export function kbUpdatesOf(output: unknown): KbUpdate[] {
  const parsed = kbUpdatesSchema.safeParse(output);
  return parsed.success ? parsed.data.kbUpdates : [];
}

export interface KbWriteRequest {
  /** Project root; the knowledge base lives at `<root>/kb`. */
  readonly root: string;
  readonly update: KbUpdate;
  readonly producedBy: Provenance;
  readonly directory?: string;
}

/**
 * Write one knowledge-base document, returning its repo-relative path.
 *
 * The path is resolved and checked before anything is written: a `path` of
 * `../roles/analyst.md` would otherwise let a task rewrite its own role, which
 * is the one thing the read-only toolset exists to prevent.
 */
export function writeKbDocument(request: KbWriteRequest): string {
  const root = resolve(request.root);
  const base = join(root, request.directory ?? 'kb');
  const { update } = request;

  if (isAbsolute(update.path)) {
    throw new KnowledgeBaseError(
      `knowledge-base path '${update.path}' is absolute; paths are relative to kb/`,
    );
  }
  if (!update.path.endsWith('.md')) {
    throw new KnowledgeBaseError(
      `knowledge-base path '${update.path}' is not a markdown file`,
    );
  }

  const target = resolve(base, update.path);
  const inside = relative(base, target);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new KnowledgeBaseError(
      `knowledge-base path '${update.path}' resolves outside kb/`,
    );
  }

  const frontmatter = stringifyYaml({
    title: update.title,
    egress: update.egress ?? DEFAULT_KB_EGRESS,
    updatedBy: request.producedBy,
    rationale: update.rationale,
  }).trimEnd();

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `---\n${frontmatter}\n---\n\n${update.content.trim()}\n`, 'utf8');

  return relative(root, target);
}
