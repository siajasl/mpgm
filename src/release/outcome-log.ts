import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import { releaseOutcomeSchema, type ReleaseOutcome } from './verify.js';

/**
 * `env`, kebab-case only. `outcomeBasePath` interpolates it directly into a
 * filesystem path — the same shape `roles/<name>.md` and `phases/<name>.yaml`
 * names already require (`role/definition.ts`, `playbook/definition.ts`) —
 * because a free-form string reaching a path unconstrained is one
 * `../../escaped` away from writing outside `artifacts/` altogether, and
 * fails closed rather than silently permitting it (CONV-4).
 */
const ENV_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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

/**
 * `env` → the base path its outcome artifact is versioned under.
 *
 * Throws before interpolating anything that is not a path-safe environment
 * name (CONV-4, fail closed) — the single point every caller of this module
 * (`recordOutcome`, `readOutcomes`, and anything reading an outcome path
 * directly) goes through on the way to a filesystem path, so a guard here
 * covers all of them rather than each having to remember its own.
 */
export function outcomeBasePath(env: string): string {
  if (!ENV_NAME_PATTERN.test(env)) {
    throw new Error(
      `release outcome env '${env}' is not a valid environment name — must match ` +
        `${ENV_NAME_PATTERN.source} (lowercase kebab-case). This name is interpolated ` +
        `directly into a path under artifacts/deploy/, and anything else risks writing ` +
        `(or reading) outside that directory instead of merely naming a bad environment.`,
    );
  }
  return `artifacts/deploy/${env}.md`;
}

export interface RecordOutcomeOptions {
  readonly outcome: ReleaseOutcome;
  readonly producedBy: Provenance;
  /** Requirement/design ids this outcome serves (ART-2). Defaults to DEP-5. */
  readonly tracesTo?: readonly string[];
}

/**
 * Writes one outcome as the next version of its own `outcome.env`'s outcome
 * artifact.
 *
 * There is deliberately no separate `env` option to file this under: an
 * earlier version of this function took one, independent of
 * `outcome.env`, which let a caller record a `prod` outcome under `test`'s
 * artifact — a `recordOutcome(store, { env: 'test', outcome: { ...o, env:
 * 'prod' } })` landed at `artifacts/deploy/test.md` and `readOutcomes(store,
 * 'test')` read it back as `test`'s own history, exactly the "deploy gate
 * deciding blind" DESIGN §9.12 exists to prevent. Deriving the path from
 * `outcome.env` alone makes that mismatch unrepresentable rather than
 * something a caller has to remember to check (CONV-5): there is only ever
 * one `env` in play, so there is nothing left for two to disagree about.
 *
 * Validation happens twice on the way in only in the sense that
 * {@link ArtifactStore.write} itself validates against the registered
 * `release-outcome` schema (the same {@link releaseOutcomeSchema}) before
 * anything reaches disk (ART-3) — a malformed outcome fails loudly at the
 * point that would have written it, never landing silently to be discovered
 * only when something later tries to read it back (CONV-4). `outcomeBasePath`
 * itself rejects an `env` that is not path-safe before that, since a schema
 * failure inside `write()` would come too late to stop the path from having
 * already been built from it.
 */
export function recordOutcome(
  store: ArtifactStore,
  options: RecordOutcomeOptions,
): Artifact {
  const env = options.outcome.env;
  return store.write({
    id: `release-outcome-${env}`,
    basePath: outcomeBasePath(env),
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
