#!/usr/bin/env node
/**
 * A content fingerprint of every file `tsconfig.build.json` actually
 * compiles (`src/**\/*.ts`, excluding `*.test.ts`) as of `HEAD` in a given
 * checkout root (T4.3.25 rework).
 *
 * `bin/dist-freshness.mjs` keyed staleness on the commit alone in its first
 * version. That over-refused: any commit that changes HEAD without changing
 * a compiled input — a docs-only commit, a test-only commit, an
 * `--allow-empty`, a branch switch between identical trees — still moved
 * `HEAD`, so it was reported stale even though `dist/` is exactly what that
 * commit would produce. Measured collateral: `src/implement/
 * scan-secrets.test.ts` and `src/implement/audit-drift-script.test.ts` spawn
 * scripts that carry the freshness guard, so after an ordinary
 * build-then-test-then-commit cycle those suites went red on the next
 * commit even though nothing they exercise had changed, because the guard
 * itself was reporting stale.
 *
 * Fingerprinting the compiled inputs instead of the commit fixes that: two
 * trees with the same compiled files produce the same fingerprint
 * regardless of what else changed between them.
 *
 * Built from `git ls-tree`'s blob hashes rather than by reading file bytes
 * directly — git already content-addresses every blob, and reading via
 * `ls-tree` means this never has to care whether the working tree and the
 * index agree, only what `HEAD` actually committed.
 *
 * Returns `undefined` when `root` has no readable git history at all (e.g.
 * a package extracted from a tarball with no `.git`) — the same "nothing to
 * compare" case callers already have to handle for `git rev-parse HEAD`
 * itself.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function computeSourceFingerprint(root) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', 'src'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }

  const lines = listing
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => {
      const path = line.split('\t')[1] ?? '';
      return path.endsWith('.ts') && !path.endsWith('.test.ts');
    })
    .sort();

  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}
