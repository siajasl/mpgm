#!/usr/bin/env node
/**
 * Refuses to let `dist/` load when `dist/` was not built from what this
 * checkout's compiled sources now hold (T4.3.25, MNT-4).
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
 *   than rebuilds. Chosen. It costs reading and hashing the files `tsc`
 *   compiles (~1.4MB, measured at roughly 10ms) and one small file read per
 *   invocation — real but negligible next to a session, and nowhere near
 *   the cost of a rebuild on every invocation, which is why this does not
 *   rebuild unconditionally itself either. It also catches a checkout
 *   someone moved by hand (a manual `git checkout`, a `git pull`), not only
 *   a merge the loop made, because it looks at what the checkout holds now,
 *   not at how it got there.
 *
 * Keyed on what the compiler reads, and on nothing that can decline to
 * answer (T4.3.25 rework rounds 1 and 2). The first version compared
 * `HEAD`; the second compared the git blobs of the compiled sources as of
 * `HEAD`. Both asked git, and git can fail — an unborn `HEAD`, an
 * unreadable `.git` — and when it did, the comparison was skipped and the
 * command ran from a stale `dist/` reporting nothing. Reproduced in review
 * at the default root, twice. `bin/source-fingerprint.mjs` now hashes the
 * on-disk content of `src/**\/*.ts` (excluding `*.test.ts`, matching
 * `tsconfig.build.json`) together with `tsconfig.json` and
 * `tsconfig.build.json`, which is what `tsc` actually reads. So there is no
 * git in the decision and no exemption anywhere in it: not for the default
 * root, not for `MPGM_PROJECT_ROOT`, not for a directory with no git
 * history. A tree this cannot read is stale, and a stale tree refuses.
 *
 * Fails closed (CONV-4, IMP-2): a build record that is missing, unreadable,
 * malformed or silent on the fingerprint is stale, not fresh; a source tree
 * that cannot be read is stale, not fresh; absence is not success. There is
 * one code path and `MPGM_PROJECT_ROOT` only moves which root it runs
 * against, so a test can point this at a throwaway fixture repository —
 * rather than mutating this project's own checkout to exercise staleness —
 * without the pointer being able to change what the guard decides. That is
 * why the fixture tests and the default-root tests in
 * `src/implement/dist-freshness.test.ts` exercise the same code.
 *
 * Known cost, stated rather than discovered: because this reads the working
 * tree, editing a compiled source without rebuilding makes `dist/` stale
 * immediately, so the suites that spawn guarded scripts
 * (`scan-secrets.test.ts`, `audit-drift-script.test.ts`) will fail while an
 * edit is unbuilt — `vitest --watch` mid-edit, not `npm run check`, where
 * `build` precedes `test`. Those failures surface the refusal on the
 * spawned process's stderr; the fix is the one every refusal names.
 *
 * Every refusal names the fix (CONV-3): run `npm run build`, which (since
 * T4.3.25) also regenerates this record via `scripts/write-build-info.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceFingerprint } from './source-fingerprint.mjs';

const root =
  process.env.MPGM_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUILD_INFO_PATH = join(root, 'dist', 'build-info.json');

function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `HEAD`'s short commit, for a readable message only. Nothing is decided
 * from this, which is why it may safely be unknown: a checkout with no
 * usable git history still gets the same refusal, just worded without a
 * commit in it.
 */
function headForDiagnostics() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
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
      reason: `no build record at ${BUILD_INFO_PATH} (${describe(cause)})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      commit: undefined,
      fingerprint: undefined,
      reason: `the build record at ${BUILD_INFO_PATH} is not valid JSON (${describe(cause)})`,
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

const current = computeSourceFingerprint(root);
if (current.fingerprint === undefined) {
  refuse(
    `${current.reason} — a check that cannot read what dist/ would be built from must refuse, ` +
      `not wave the command through`,
  );
} else {
  const record = recordedBuildInfo();
  if (record.fingerprint === undefined) {
    refuse(`${record.reason} — a missing or unreadable record is stale, not fresh`);
  } else if (record.fingerprint !== current.fingerprint) {
    const head = headForDiagnostics();
    refuse(
      `it was built from ${record.commit ?? 'an unrecorded commit'}, but this checkout's compiled ` +
        `sources now differ${head === undefined ? '' : ` (HEAD ${head})`} — something (a merge, ` +
        `a pull, or an edit) changed them without rebuilding`,
    );
  }
}
