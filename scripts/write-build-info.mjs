#!/usr/bin/env node
/**
 * Records what `npm run build` just compiled `dist/` from (T4.3.25): the
 * source fingerprint (`bin/source-fingerprint.mjs`) that
 * `bin/dist-freshness.mjs` compares against, and the commit, for a readable
 * diagnostic only.
 *
 * Run as the last step of `build` (`package.json`), after `tsc` — `&&`, not
 * a separate npm lifecycle hook, so a failed `tsc` never reaches this and
 * leaves whatever record the previous successful build left in place,
 * correctly reporting stale once the checkout moves again.
 *
 * `bin/dist-freshness.mjs` is this record's only reader; see that module's
 * doc comment for why a stale or missing record refuses rather than being
 * silently tolerated or rebuilt out from under the running process, and for
 * why the comparison is keyed on what `tsc` reads rather than on a commit.
 *
 * The commit is written when git can say what it is and omitted when it
 * cannot (an unborn `HEAD`, no `.git` at all). Nothing is decided from it,
 * here or in the reader, so its absence costs a few words in one message
 * and never an exemption. A fingerprint that cannot be computed is a
 * different matter: it would leave the reader with a record it must treat
 * as stale, so this fails the build instead and says which input it could
 * not read (CONV-3).
 *
 * `MPGM_PROJECT_ROOT` overrides the checkout this writes against, for the
 * same reason as `bin/dist-freshness.mjs`'s own override — a test builds a
 * throwaway fixture repository's record without touching this one.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceFingerprint } from '../bin/source-fingerprint.mjs';

const root =
  process.env.MPGM_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

let commit;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  commit = undefined;
}

const fingerprint = computeSourceFingerprint(root);
if (fingerprint.fingerprint === undefined) {
  process.stderr.write(
    `Cannot record what dist/ was built from: ${fingerprint.reason}.\n` +
      `bin/dist-freshness.mjs would treat the resulting record as stale, so the build fails ` +
      `here instead (T4.3.25).\n`,
  );
  process.exit(1);
}

writeFileSync(
  join(root, 'dist', 'build-info.json'),
  `${JSON.stringify(
    {
      commit,
      sourceFingerprint: fingerprint.fingerprint,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
