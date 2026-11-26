import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * T4.3.25 — nothing used to connect the commit `dist/` was built from to the
 * commit a checkout now holds, so a merge that changed the loop ran the loop
 * it had just replaced, silently.
 *
 * `bin/mpgm.mjs` is a real entry point that loads `dist/` (the thing every
 * `scripts/*.mjs`/`scripts/demo/*.mjs` does too, and `bin/dist-freshness.mjs`
 * is what all of them now import first). It is driven here — not a copy, not
 * a stub — against a throwaway git repository rather than against this
 * checkout's own history, via `MPGM_PROJECT_ROOT` (`bin/dist-freshness.mjs`'s
 * own doc comment explains why that override exists and why nothing else may
 * weaken what it guards): mutating this repository's own `HEAD` mid test-run
 * would corrupt the checkout every other test and this suite's own
 * build/test ordering depends on.
 *
 * `scripts/write-build-info.mjs` is exercised for real too, rather than hand
 * -written into the fixture, so what `npm run build` actually produces is
 * what this test calls fresh. The fixture repository mirrors this project's
 * own layout — compiled sources live under `src/**\/*.ts` — because
 * `bin/source-fingerprint.mjs` only looks there; a file outside `src/`, or a
 * `*.test.ts` inside it, is invisible to the fingerprint the same way it is
 * invisible to `tsconfig.build.json`.
 */

const MPGM = resolve(import.meta.dirname, '../../bin/mpgm.mjs');
const WRITE_BUILD_INFO = resolve(
  import.meta.dirname,
  '../../scripts/write-build-info.mjs',
);

const tempDirs: string[] = [];

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-dist-fresh-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

/** Commits a change to a file `tsc` would compile — moves the fingerprint. */
function commitSource(repo: string, content: string): string {
  writeFileSync(join(repo, 'src', 'source.ts'), content);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', content], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

/**
 * Commits a change to a file `tsc` never reads (outside `src/`) — moves
 * `HEAD` without moving the fingerprint, the shape of a docs-only or
 * test-only commit in the real checkout.
 */
function commitNonSource(repo: string, content: string): string {
  writeFileSync(join(repo, 'NOTES.md'), content);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', content], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

/** Runs the real `scripts/write-build-info.mjs` against `repo`, as `npm run build` would. */
function writeBuildInfo(repo: string): void {
  execFileSync('node', [WRITE_BUILD_INFO], {
    env: { ...process.env, MPGM_PROJECT_ROOT: repo },
  });
}

/** Runs the real `bin/mpgm.mjs` with no verb, with the freshness check pointed at `root`. */
function runEntryPoint(root: string): { code: number; stderr: string } {
  try {
    execFileSync('node', [MPGM], {
      encoding: 'utf8',
      env: { ...process.env, MPGM_PROJECT_ROOT: root },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { code: failure.status ?? 1, stderr: failure.stderr ?? '' };
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dist/ freshness (T4.3.25)', () => {
  it('refuses, naming the fix, once the checkout moves past the commit dist/ was built from', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo); // dist/ is built from v1's commit.

    // The checkout moves on without a rebuild — exactly what `mergeChange`
    // (`src/implement/merge.ts`) does today: it advances the trunk and
    // never touches `dist/`.
    commitSource(repo, 'v2');

    const result = runEntryPoint(repo);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
    expect(result.stderr).toContain('stale');
  });

  it('treats a missing build record as stale, not fresh', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    // No `writeBuildInfo` call at all — `dist/build-info.json` never existed.

    const result = runEntryPoint(repo);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
    expect(result.stderr).toContain('no build record');
  });

  it('refuses before a rebuild and proceeds once dist/ has actually been rebuilt', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo);
    commitSource(repo, 'v2');

    // Against today's unmodified bin/mpgm.mjs this first assertion is what
    // fails: nothing refuses, so this case cannot pass against the
    // unmodified entry point (CONV-6) — only after the rebuild below does a
    // passing run mean anything.
    const stale = runEntryPoint(repo);
    expect(stale.code).not.toBe(0);

    writeBuildInfo(repo); // The rebuild `npm run build` would have done.
    const fresh = runEntryPoint(repo);

    expect(fresh.code).toBe(0);
    expect(fresh.stderr).toBe('');
  });

  it('does not go stale on a commit that touches nothing dist/ was compiled from', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo);

    // A docs-only / test-only commit: HEAD moves, nothing `tsc` reads does.
    commitNonSource(repo, 'unrelated notes');

    const result = runEntryPoint(repo);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('refuses when MPGM_PROJECT_ROOT points at a directory with no git history, rather than skipping the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpgm-dist-fresh-nogit-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    // A build record is present — if the override could disable the check,
    // this would make no difference either way. It must not.
    writeFileSync(
      join(dir, 'dist', 'build-info.json'),
      `${JSON.stringify({ commit: 'deadbeef', sourceFingerprint: 'whatever', builtAt: new Date().toISOString() })}\n`,
    );

    const result = runEntryPoint(dir);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
    expect(result.stderr).toContain('MPGM_PROJECT_ROOT');
  });
});
