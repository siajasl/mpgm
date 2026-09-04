import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import { releaseOutcomeSchema, type ReleaseOutcome } from './verify.js';

/**
 * Where DEP-5's "record the outcome" actually lands (DESIGN §4.5, §9.12).
 *
 * A release outcome is a versioned artifact like any other (ADR-3): one
 * `artifacts/deploy/<env>.md` file per environment, a new version per
 * verification run, written through the same {@link ArtifactStore} every
 * phase's output goes through — never a bespoke store of its own. That is
 * what makes "recorded" mean something durable: T4.1.3 landed this as a
 * path-agnostic JSONL appender whose only caller wrote under `.mpgm/`, and
 * ADR-2 gitignores that tree, so the outcome existed for the length of the
 * run and nothing held it once the process exited. Versioned markdown with
 * frontmatter, in git, survives the run that produced it — a deploy gate
 * reading the last outcome reads a committed file, not a transient one only
 * the machine that produced it ever saw.
 *
 * A release outcome is never gated (ART-1's sense): it is a fact about what
 * a verification run found, not a document an operator approves before it
 * can be acted on. `write()` always creates the next version, so a caller
 * never has to reason about gating here — every recorded outcome simply
 * gets its own immutable file.
 */

const RELEASE_OUTCOME_SCHEMA = 'release-outcome';

/** `env` → the base path its outcome artifact is versioned under. */
export function outcomeBasePath(env: string): string {
  return `artifacts/deploy/${env}.md`;
}

export interface RecordOutcomeOptions {
  readonly env: string;
  readonly outcome: ReleaseOutcome;
  readonly producedBy: Provenance;
  /** Requirement/design ids this outcome serves (ART-2). Defaults to DEP-5. */
  readonly tracesTo?: readonly string[];
}

/**
 * Writes one outcome as the next version of `env`'s outcome artifact.
 *
 * Validation happens twice on the way in only in the sense that
 * {@link ArtifactStore.write} itself validates against the registered
 * `release-outcome` schema (the same {@link releaseOutcomeSchema}) before
 * anything reaches disk (ART-3) — a malformed outcome fails loudly at the
 * point that would have written it, never landing silently to be discovered
 * only when something later tries to read it back (CONV-4).
 */
export function recordOutcome(
  store: ArtifactStore,
  options: RecordOutcomeOptions,
): Artifact {
  return store.write({
    id: `release-outcome-${options.env}`,
    basePath: outcomeBasePath(options.env),
    schema: RELEASE_OUTCOME_SCHEMA,
    data: options.outcome,
    producedBy: options.producedBy,
    tracesTo: options.tracesTo ?? ['DEP-5'],
  });
}

/**
 * Every outcome recorded for `env`, oldest first. An environment with no
 * outcome artifact yet reads as no outcomes, not an error — the same
 * "nothing recorded yet" a fresh environment legitimately starts from.
 *
 * Reads versions `1..latest` explicitly rather than delegating to
 * {@link ArtifactStore.list}, whose directory-entry ordering is
 * lexicographic (`v10` sorts before `v2`) — wrong for a log that must read
 * back oldest-first past nine runs.
 */
export function readOutcomes(store: ArtifactStore, env: string): ReleaseOutcome[] {
  const basePath = outcomeBasePath(env);
  const latest = store.latestVersion(basePath);
  const outcomes: ReleaseOutcome[] = [];
  for (let version = 1; version <= latest; version += 1) {
    outcomes.push(releaseOutcomeSchema.parse(store.read(basePath, version).data));
  }
  return outcomes;
}
