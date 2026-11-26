#!/usr/bin/env node
/**
 * Refuses to let `dist/` load when `dist/` was not built from the commit
 * this checkout now holds (T4.3.25, MNT-4).
 *
 * Side-effect only: every entry point that loads `dist/` — `bin/mpgm.mjs`
 * and every `scripts/*.mjs`/`scripts/demo/*.mjs` that imports from
 * `../dist/...` — imports this module *first*, before its own `dist`
 * import. Sibling static imports with no dependency between them evaluate in
 * the order they are written, so this module's top-level code runs and can
 * `process.exit` before the entry point's own `dist` import is ever reached
 * — which matters exactly when `dist/index.js` itself is the thing that
 * changed shape, as it was the one time this was measured (see below): by
 * the time a stale `dist/index.js` would throw trying to resolve an export
 * nothing still provides, this module has already said why and exited,
 * rather than letting that `SyntaxError` be the only signal.
 *
 * Measured, not supposed (T4.3.25's filing): on 2026-11-23, five days after
 * T4.3.20 merged as 8338e58, `npm run probe:sdk` died with `SyntaxError: The
 * requested module '../../dist/index.js' does not provide an export named
 * 'defaultProbeExclusions'`, because `dist/` predated the merge and
 * `mpgm implement T4.3.22` was about to run from that same `dist/`. That
 * case was loud only because an export had been added; a merge that changes
 * behaviour without changing exports runs the old behaviour silently.
 *
 * Three ways this could have gone (T4.3.25's filing weighs all three):
 *
 * - Have `mergeChange` (`src/implement/merge.ts`) rebuild after every
 *   merge. Keeps the operator out of it, but couples merge to build: a build
 *   that fails after the merge has already landed needs an answer — the
 *   trunk is now ahead of `dist/` and there is no "undo the merge" this
 *   function would reach for — and rebuilding *underneath* the very process
 *   that is currently running from the `dist/` being replaced needs one
 *   too. Priced here as the more expensive option for the harness to carry
 *   and not chosen.
 * - Run every entry point from source, so there is no build to go stale.
 *   Collides with what CLAUDE.md already records: Node strips TypeScript
 *   types but will not resolve a `.js` specifier to a `.ts` file, which is
 *   why the crash/worktree/secret-scan fixtures run against `dist/` at all
 *   (`vitest.config.ts`, CI's `build`-precedes-`test` ordering). Reversing
 *   that would mean teaching every one of those fixtures, and this project's
 *   whole module-resolution story, something else — a much larger change
 *   than a staleness check, and not this task's to make. Not chosen.
 * - This module: a cheap, fail-closed read-and-compare that refuses rather
 *   than rebuilds. Chosen. It costs one `git rev-parse HEAD` and one small
 *   file read per invocation — real but negligible next to a session, and
 *   nowhere near the cost of a rebuild on every invocation, which is why
 *   this does not rebuild unconditionally itself either. It also catches a
 *   checkout someone moved by hand (a manual `git checkout`), not only a
 *   merge the loop made, because it looks at what the checkout holds now,
 *   not at how it got there.
 *
 * Fails closed (CONV-4): a build record that is missing, unreadable or
 * names no commit is treated as stale, not fresh — absence is not success —
 * and refuses the same way a real mismatch does rather than waving the
 * command through because the check itself could not run. The one case
 * this does *not* refuse is a checkout with no git history to read at all
 * (`git rev-parse HEAD` itself fails, e.g. a package extracted from a
 * tarball with no `.git`): there, "what commit is this `dist/` built from"
 * is not a question this checkout can even pose, so there is nothing to
 * compare against and nothing to refuse.
 *
 * Every refusal names the fix (CONV-3): run `npm run build`, which (since
 * T4.3.25) also regenerates this record via `scripts/write-build-info.mjs`.
 *
 * `MPGM_PROJECT_ROOT` overrides where this module looks for the checkout
 * and the build record. No legitimate invocation sets it — the default,
 * the directory this module's own file sits one level below, is always
 * right for every shipped entry point, because `bin/` and `dist/` are
 * siblings in every checkout this harness runs from. It exists only so a
 * test can point this module at a throwaway fixture repository instead of
 * mutating this project's own checkout to exercise staleness, the same
 * shape `scripts/audit-drift.mjs`'s `AUDIT_BASE_REF` already uses for the
 * same reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root =
  process.env.MPGM_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUILD_INFO_PATH = join(root, 'dist', 'build-info.json');

/** `git rev-parse HEAD` in `root`, or `undefined` when `root` is not a git checkout at all. */
function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The commit `dist/build-info.json` says `dist/` was built from, or a reason
 * it cannot say — missing, unreadable, malformed, or silent on the one field
 * that matters. Every one of those is stale (CONV-4); only a real, matching
 * commit is fresh.
 */
function recordedCommit() {
  let raw;
  try {
    raw = readFileSync(BUILD_INFO_PATH, 'utf8');
  } catch (cause) {
    return {
      commit: undefined,
      reason: `no build record at ${BUILD_INFO_PATH} (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      commit: undefined,
      reason: `the build record at ${BUILD_INFO_PATH} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  if (typeof parsed.commit !== 'string' || parsed.commit === '') {
    return {
      commit: undefined,
      reason: `the build record at ${BUILD_INFO_PATH} does not name a commit`,
    };
  }
  return { commit: parsed.commit, reason: undefined };
}

function refuse(reason) {
  process.stderr.write(
    `dist/ is stale: ${reason}.\n` +
      `Run 'npm run build' before running this command (T4.3.25).\n`,
  );
  process.exit(1);
}

const head = currentCommit();
if (head !== undefined) {
  const record = recordedCommit();
  if (record.commit === undefined) {
    refuse(`${record.reason} — a missing or unreadable record is stale, not fresh`);
  } else if (record.commit !== head) {
    refuse(
      `it was built from ${record.commit}, but this checkout is now at ${head} — ` +
        `something (very likely a merge) moved the checkout without rebuilding`,
    );
  }
}
