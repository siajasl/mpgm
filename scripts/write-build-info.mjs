#!/usr/bin/env node
/**
 * Records the commit `npm run build` just compiled `dist/` from (T4.3.25).
 *
 * Run as the last step of `build` (`package.json`), after `tsc` — `&&`, not
 * a separate npm lifecycle hook, so a failed `tsc` never reaches this and
 * leaves whatever record the previous successful build left in place,
 * correctly naming an earlier commit than `HEAD` once the checkout moves
 * again.
 *
 * `bin/dist-freshness.mjs` is this record's only reader; see that module's
 * doc comment for why a stale or missing record refuses rather than being
 * silently tolerated or rebuilt out from under the running process.
 *
 * `MPGM_PROJECT_ROOT` overrides the checkout this writes against, for the
 * same reason and with the same "no legitimate caller sets it" status as
 * `bin/dist-freshness.mjs`'s own override — a test builds a throwaway
 * fixture repository's record without touching this one.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root =
  process.env.MPGM_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

let commit;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
} catch {
  // Not a git checkout at all (e.g. a published tarball extracted without a
  // `.git` directory) — `bin/dist-freshness.mjs` treats that same case as
  // nothing to compare against rather than as stale, so there is nothing
  // this needs to record either.
  process.exit(0);
}

writeFileSync(
  join(root, 'dist', 'build-info.json'),
  `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
