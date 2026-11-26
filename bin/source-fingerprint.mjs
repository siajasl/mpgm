#!/usr/bin/env node
/**
 * A content fingerprint of everything that determines what `tsc -p
 * tsconfig.build.json` emits into `dist/`: the on-disk content of every file
 * it compiles (`src/**\/*.ts`, excluding `*.test.ts`) plus the two config
 * files that say how (T4.3.25).
 *
 * Two earlier keys, and why neither held:
 *
 * - The commit alone. Any commit that moved `HEAD` without changing a
 *   compiled input — docs-only, test-only, an `--allow-empty`, a branch
 *   switch between identical trees — reported stale even though `dist/` is
 *   exactly what that commit would produce. Measured collateral:
 *   `src/implement/scan-secrets.test.ts` and
 *   `src/implement/audit-drift-script.test.ts` spawn scripts that carry the
 *   freshness guard, so an ordinary build-then-test-then-commit cycle left
 *   `npm test` red on the next commit in suites unrelated to it.
 * - The git blobs of those files as of `HEAD` (`git ls-tree`). Closer, but
 *   wrong twice over, both reproduced in review. It answers the wrong
 *   question: `tsc` compiles the working tree, not `HEAD`, so a `dist/`
 *   built from an uncommitted edit — the normal state of a session that is
 *   mid-change — fingerprinted as fresh when it was not. And it made the
 *   answer depend on git being able to answer: when `git rev-parse` or `git
 *   ls-tree` failed for any reason (an unborn `HEAD`, an unreadable `.git`),
 *   the fingerprint was unavailable and the caller skipped the comparison
 *   entirely, so a check that could not run waved the command through —
 *   exactly the fail-open the filing forbids (IMP-2, CONV-4).
 *
 * Hashing the working tree fixes both: it is what the compiler reads, so it
 * is fresh exactly when `dist/` is, and it needs no git at all, so there is
 * no "git would not answer" branch left to fail open in. `git` now appears
 * nowhere in the decision — `bin/dist-freshness.mjs` reads a commit only to
 * make a refusal message readable.
 *
 * Two bounds worth stating rather than implying. The TypeScript compiler's
 * own version also determines `dist/` and is not keyed here: a compiler
 * upgrade is a change to `package.json`/`package-lock.json`, which this does
 * not hash, so an upgrade that is not followed by a build is not caught.
 * And this reads the working tree, so an uncommitted edit to a compiled
 * source does make `dist/` stale until the next build — correctly, because
 * the built output no longer matches what the compiler would now produce.
 *
 * Fails closed (CONV-4): a tree this cannot read does not produce a
 * fingerprint and does not produce silence either — it returns a `reason`
 * its caller must refuse on. The result is `{ fingerprint }` or
 * `{ reason }`, never neither and never both.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Files outside `src/` that still decide what `tsc` emits.
 * `tsconfig.build.json` extends `tsconfig.json`, so both count: a change to
 * either (a `target`, a `rootDir`, an added `exclude`) changes `dist/`
 * without changing a single source file.
 */
const CONFIG_INPUTS = ['tsconfig.json', 'tsconfig.build.json'];

function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Collects `dir`'s compiled `.ts` files, recursively. Throws if unreadable. */
function collectCompiled(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCompiled(full, found);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      found.push(full);
    }
  }
}

/**
 * `{ fingerprint }` for the checkout at `root`, or `{ reason }` naming what
 * could not be read. Path names are hashed alongside content, so a file
 * renamed or deleted changes the fingerprint even when the bytes elsewhere
 * are identical.
 */
export function computeSourceFingerprint(root) {
  const sourceDir = join(root, 'src');
  const files = [];
  try {
    collectCompiled(sourceDir, files);
  } catch (cause) {
    return {
      reason: `cannot read the compiled sources under ${sourceDir} (${describe(cause)})`,
    };
  }
  files.sort();

  const hash = createHash('sha256');
  const inputs = [...CONFIG_INPUTS.map((name) => join(root, name)), ...files];
  for (const path of inputs) {
    let content;
    try {
      content = readFileSync(path);
    } catch (cause) {
      return { reason: `cannot read the build input ${path} (${describe(cause)})` };
    }
    hash.update(relative(root, path).split(sep).join('/'));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return { fingerprint: hash.digest('hex') };
}
