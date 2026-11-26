#!/usr/bin/env node
/**
 * Refuses to let `dist/` load when `dist/` was not built from what this
 * checkout's compiled sources now look like (T4.3.25, MNT-4).
 *
 * Side-effect only: every entry point that loads `dist/` — `bin/mpgm.mjs`
 * and every `scripts/*.mjs`/`scripts/demo/*.mjs` that imports from
 * `../dist/...` — imports this module *first*, before its own `dist`
 * import.
 *
 * What this ordering does and does not buy (T4.3.25 rework, finding 1): a
 * missing *named* export is resolved at ESM link time, before any module in
 * the graph — including this one — evaluates, so a stale `dist/index.js`
 * whose export shape changed still raises `SyntaxError: ... does not
 * provide an export named '...'` with this module's own check never
 * reached, import order notwithstanding. That is exactly the one incident
 * this task measures (see below): the operator would still see only the
 * bare `SyntaxError`. This module's value is the sharper, silent case the
 * filing calls out — a merge that changes behaviour *without* changing
 * exports, where a stale `dist/index.js` links and runs happily and the old
 * behaviour would otherwise never say so.
 *
 * Measured, not supposed (T4.3.25's filing): on 2026-11-23, five days after
 * T4.3.20 merged as 8338e58, `npm run probe:sdk` died with `SyntaxError: The
 * requested module '../../dist/index.js' does not provide an export named
 * 'defaultProbeExclusions'`, because `dist/` predated the merge and
 * `mpgm implement T4.3.22` was about to run from that same `dist/`.
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
 *   than rebuilds. Chosen. It costs one `git rev-parse HEAD`, one
 *   `git ls-tree`, and one small file read per invocation — real but
 *   negligible next to a session, and nowhere near the cost of a rebuild on
 *   every invocation, which is why this does not rebuild unconditionally
 *   itself either. It also catches a checkout someone moved by hand (a
 *   manual `git checkout`), not only a merge the loop made, because it looks
 *   at what the checkout holds now, not at how it got there.
 *
 * Keyed on compiled inputs, not on the commit (T4.3.25 rework, finding 3):
 * the first version of this module compared `HEAD` directly, which meant any
 * commit that changed `HEAD` without changing anything `tsc` compiles — a
 * docs-only commit, a test-only commit, an `--allow-empty` — was reported
 * stale even though `dist/` is exactly what that commit would produce.
 * Measured collateral: `src/implement/scan-secrets.test.ts` and
 * `src/implement/audit-drift-script.test.ts` spawn scripts this guard now
 * sits in front of, so an ordinary build-then-test-then-commit cycle left
 * `npm test` red on the very next commit, in suites unrelated to whatever
 * that commit touched. `bin/source-fingerprint.mjs` fixes that: it hashes
 * the content of `src/**\/*.ts` (excluding `*.test.ts`, matching
 * `tsconfig.build.json`) as of `HEAD`, and only a change to one of those
 * files changes the fingerprint.
 *
 * Fails closed (CONV-4): a build record that is missing, unreadable, or
 * names no fingerprint is treated as stale, not fresh — absence is not
 * success — and refuses the same way a real mismatch does rather than
 * waving the command through because the check itself could not run.
 *
 * The one case this does *not* refuse is the default (module-derived) root
 * having no git history to read at all (`git rev-parse HEAD` itself fails,
 * e.g. a package extracted from a tarball with no `.git`): there, "what was
 * `dist/` built from" is not a question this checkout can even pose, so
 * there is nothing to compare against and nothing to refuse — the same case
 * `scripts/write-build-info.mjs` already treats as nothing to record.
 *
 * `MPGM_PROJECT_ROOT` does *not* get that same allowance (T4.3.25 rework,
 * finding 2): a stale build record plus an override pointed at a directory
 * with no git history used to exit 0 silently, because `currentCommit()`
 * failed and the whole comparison was skipped — a one-environment-variable
 * way to defeat a guard the filing requires to fail closed. When the
 * override is explicitly set, a failure to read git history now refuses
 * instead: an override must not be able to grant an exemption the default
 * path does not have. This is now the same shape `scripts/audit-drift.mjs`'s
 * `AUDIT_BASE_REF` uses, and for the same reason — a test points this module
 * at a throwaway fixture repository instead of mutating this project's own
 * checkout to exercise staleness, without that pointer being able to weaken
 * what it's testing.
 *
 * Every refusal names the fix (CONV-3): run `npm run build`, which (since
 * T4.3.25) also regenerates this record via `scripts/write-build-info.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceFingerprint } from './source-fingerprint.mjs';

const overrideSet = process.env.MPGM_PROJECT_ROOT !== undefined;
const root =
  process.env.MPGM_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUILD_INFO_PATH = join(root, 'dist', 'build-info.json');

/**
 * `{ commit, fingerprint }` as of `HEAD` in `root`, or `undefined` when
 * `root` has no readable git history at all.
 */
function currentState() {
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
  return { commit, fingerprint: computeSourceFingerprint(root) };
}

/**
 * The fingerprint `dist/build-info.json` says `dist/` was built from, or a
 * reason it cannot say — missing, unreadable, malformed, or silent on the
 * one field that matters. Every one of those is stale (CONV-4); only a
 * real, matching fingerprint is fresh.
 */
function recordedBuildInfo() {
  let raw;
  try {
    raw = readFileSync(BUILD_INFO_PATH, 'utf8');
  } catch (cause) {
    return {
      commit: undefined,
      fingerprint: undefined,
      reason: `no build record at ${BUILD_INFO_PATH} (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      commit: undefined,
      fingerprint: undefined,
      reason: `the build record at ${BUILD_INFO_PATH} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  if (typeof parsed.sourceFingerprint !== 'string' || parsed.sourceFingerprint === '') {
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : undefined,
      fingerprint: undefined,
      reason: `the build record at ${BUILD_INFO_PATH} does not name a source fingerprint`,
    };
  }
  return {
    commit: typeof parsed.commit === 'string' ? parsed.commit : undefined,
    fingerprint: parsed.sourceFingerprint,
    reason: undefined,
  };
}

function refuse(reason) {
  process.stderr.write(
    `dist/ is stale: ${reason}.\n` +
      `Run 'npm run build' before running this command (T4.3.25).\n`,
  );
  process.exit(1);
}

const current = currentState();
if (current === undefined) {
  if (overrideSet) {
    refuse(
      `MPGM_PROJECT_ROOT=${root} has no readable git history to check dist/ against — ` +
        `an override must not grant an exemption the default checkout does not have`,
    );
  }
  // Default root, no git history at all: nothing to compare, nothing to refuse.
} else {
  const record = recordedBuildInfo();
  if (record.fingerprint === undefined) {
    refuse(`${record.reason} — a missing or unreadable record is stale, not fresh`);
  } else if (record.fingerprint !== current.fingerprint) {
    refuse(
      `it was built from ${record.commit ?? 'an unrecorded commit'}, but this checkout's compiled ` +
        `sources now differ (HEAD ${current.commit}) — something (very likely a merge) moved the ` +
        `checkout without rebuilding`,
    );
  }
}
