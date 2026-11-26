import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T4.3.25 review (round on ff1b7c8), finding 1: `dist-freshness.test.ts`
 * drives the guard's decision logic through a synthetic `entry.mjs` the
 * suite itself writes, whose only statement is `import
 * './dist-freshness.mjs'` — it loads no `dist/` at all. That leaves the
 * actual wiring unasserted: the 20-odd `import './dist-freshness.mjs'` /
 * `import '../bin/dist-freshness.mjs'` lines placed above a `dist/` import
 * in every real entry point, and the `build` script's `&& node
 * scripts/write-build-info.mjs` step that produces the record the guard
 * reads. Removing the guard import from `bin/mpgm.mjs` made every case in
 * that suite still pass while `mpgm implement` went back to running the
 * code a merge just replaced — exactly the defect T4.3.25 was filed
 * against. This suite asserts the wiring statically instead (precedent:
 * `dependency-audit-trunk-workflow.test.ts` asserts over a workflow file
 * rather than a copy of its logic), so it fails the moment a future script
 * is added unguarded, or an existing guard import is removed, without
 * needing to run that script for real.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** Everything `scripts/write-build-info.mjs` and the guard itself ignore: vitest fixtures. */
const EXCLUDED_DIR_NAMES = new Set(['__fixtures__', 'node_modules']);

/** Every `.mjs` file under `dir`, recursively, skipping vitest fixture directories. */
function listMjsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(name)) {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listMjsFiles(full));
    } else if (name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/** The 1-based line number of the first line matching `pattern`, or `undefined`. */
function firstMatchingLine(content: string, pattern: RegExp): number | undefined {
  const lines = content.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? undefined : index + 1;
}

const DIST_IMPORT = /from\s+['"][^'"]*\/dist\//;
const GUARD_IMPORT = /dist-freshness\.mjs['"]/;

const ENTRY_POINTS = [
  ...listMjsFiles(join(ROOT, 'bin')),
  ...listMjsFiles(join(ROOT, 'scripts')),
];

/**
 * Every `.mjs` file that itself imports from `dist/` — `bin/dist-freshness.mjs`
 * and `bin/source-fingerprint.mjs` do not, so they are excluded the same way
 * `write-build-info.mjs`, `sample-project.mjs` and `mpgm-plan.mjs` are: by
 * having no `dist/` import to guard in the first place. This is what makes
 * the list CI-reproducible, measured against the checkout, not hand-kept.
 */
function distImportingEntryPoints(): string[] {
  return ENTRY_POINTS.filter((path) => DIST_IMPORT.test(readFileSync(path, 'utf8')));
}

describe('every dist/-loading entry point carries the freshness guard (T4.3.25)', () => {
  const files = distImportingEntryPoints();

  it('found at least one dist/-loading entry point to check', () => {
    // Guards the guard: an empty list would make every case below
    // vacuously true (CONV-6), which is exactly what a refactor that moved
    // every dist/ import elsewhere would produce silently.
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((path) => [relative(ROOT, path), path] as const))(
    '%s imports the freshness guard before it imports from dist/',
    (_label, path) => {
      const content = readFileSync(path, 'utf8');
      const guardLine = firstMatchingLine(content, GUARD_IMPORT);
      const distLine = firstMatchingLine(content, DIST_IMPORT);
      const label = relative(ROOT, path);

      // Fails the moment either import is missing, naming which: this is
      // the case that fails against `bin/mpgm.mjs` with its guard import
      // deleted, which is the defect T4.3.25 was filed against and which
      // `dist-freshness.test.ts`'s synthetic entry point never exercised.
      // Thrown rather than asserted so the lines below can rely on both
      // being numbers without a forbidden non-null assertion.
      if (guardLine === undefined) {
        throw new Error(`${label} does not import the dist/ freshness guard at all`);
      }
      if (distLine === undefined) {
        throw new Error(
          `${label} matched the dist/ import pattern but firstMatchingLine found no line`,
        );
      }

      expect(
        guardLine,
        `${label} imports the freshness guard on line ${String(guardLine)}, at or after its ` +
          `dist/ import on line ${String(distLine)} — the guard must run first`,
      ).toBeLessThan(distLine);
    },
  );

  it("package.json's build script runs scripts/write-build-info.mjs", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const build = pkg.scripts?.build;
    expect(build, 'package.json has no "build" script to check').toBeDefined();
    expect(
      build,
      `package.json's "build" script ("${String(build)}") does not run ` +
        'scripts/write-build-info.mjs, so a build would stop recording what dist/ was built from',
    ).toContain('scripts/write-build-info.mjs');
  });
});
