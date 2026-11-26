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
 * set it): mutating this repository's own `HEAD` mid test-run would corrupt
 * the checkout every other test and this suite's own build/test ordering
 * depends on.
 *
 * `scripts/write-build-info.mjs` is exercised for real too, rather than hand
 * -written into the fixture, so what `npm run build` actually produces is
 * what this test calls fresh.
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
  return dir;
}

function commitSource(repo: string, content: string): string {
  writeFileSync(join(repo, 'source.txt'), content);
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

/** Runs the real `bin/mpgm.mjs` with no verb, with the freshness check pointed at `repo`. */
function runEntryPoint(repo: string): { code: number; stderr: string } {
  try {
    execFileSync('node', [MPGM], {
      encoding: 'utf8',
      env: { ...process.env, MPGM_PROJECT_ROOT: repo },
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

  it('proceeds once dist/ was built from the commit the checkout is actually on', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo);

    const result = runEntryPoint(repo);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});
