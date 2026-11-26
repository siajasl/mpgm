import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * T4.3.25 — nothing used to connect what `dist/` was built from to what a
 * checkout now holds, so a merge that changed the loop ran the loop it had
 * just replaced, silently.
 *
 * Two ways in, because the guard has two roots and they must not differ:
 *
 * - `runEntryPoint` drives the real `bin/mpgm.mjs` — not a copy, not a stub
 *   — with `MPGM_PROJECT_ROOT` pointed at a throwaway fixture, because
 *   mutating this repository's own sources mid test-run would corrupt the
 *   checkout every other suite and this project's build/test ordering
 *   depend on.
 * - `asDefaultRoot` copies the two guard modules into a fixture's own
 *   `bin/` and runs an entry point there with `MPGM_PROJECT_ROOT` *unset*,
 *   so the root is the one the module derives from its own location — the
 *   path a real `node ./bin/mpgm.mjs` takes. Review reproduced a fail-open
 *   that existed only on that path (git failing to answer was treated as
 *   nothing to compare), so asserting it via the override alone would not
 *   have caught it, and the cases below assert it there directly.
 *
 * `scripts/write-build-info.mjs` is exercised for real rather than
 * hand-written into the fixture, so what `npm run build` actually produces
 * is what this suite calls fresh. Fixtures mirror this project's layout —
 * compiled sources under `src/**\/*.ts`, `tsconfig.json` and
 * `tsconfig.build.json` at the root — because those are the inputs
 * `bin/source-fingerprint.mjs` hashes; a `*.test.ts`, or a file outside
 * `src/`, is invisible to it the same way it is to `tsconfig.build.json`.
 */

const BIN = resolve(import.meta.dirname, '../../bin');
const MPGM = join(BIN, 'mpgm.mjs');
const WRITE_BUILD_INFO = resolve(
  import.meta.dirname,
  '../../scripts/write-build-info.mjs',
);

const tempDirs: string[] = [];

/** A fixture laid out like this project: `src/`, `dist/`, both tsconfigs. */
function newFixture(prefix = 'mpgm-dist-fresh-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: {} })}\n`,
  );
  writeFileSync(
    join(dir, 'tsconfig.build.json'),
    `${JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.ts'] })}\n`,
  );
  return dir;
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // Isolated from whoever runs the suite: a global `commit.gpgsign` makes
  // these fixture commits depend on the host's signing key being usable,
  // and the same isolation is already how `declared-history.test.ts` and
  // `commands.test.ts` keep their fixtures host-independent.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function newRepo(): string {
  const dir = newFixture();
  initRepo(dir);
  return dir;
}

/** Writes a file `tsc` would compile — moves the fingerprint. */
function writeSource(repo: string, content: string): void {
  writeFileSync(join(repo, 'src', 'source.ts'), `export const v = '${content}';\n`);
}

/** Writes and commits a compiled source, the shape of a merge landing. */
function commitSource(repo: string, content: string): void {
  writeSource(repo, content);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', content], { cwd: repo });
}

/**
 * Commits a file `tsc` never reads (outside `src/`) — moves `HEAD` without
 * moving the fingerprint, the shape of a docs-only or test-only commit.
 */
function commitNonSource(repo: string, content: string): void {
  writeFileSync(join(repo, 'NOTES.md'), content);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', content], { cwd: repo });
}

/** Runs the real `scripts/write-build-info.mjs` against `root`, as `npm run build` does. */
function writeBuildInfo(root: string): void {
  execFileSync('node', [WRITE_BUILD_INFO], {
    env: { ...process.env, MPGM_PROJECT_ROOT: root },
  });
}

function runNode(
  script: string,
  env: NodeJS.ProcessEnv,
): { code: number; stderr: string } {
  try {
    execFileSync('node', [script], { encoding: 'utf8', env });
    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { code: failure.status ?? 1, stderr: failure.stderr ?? '' };
  }
}

/** The real `bin/mpgm.mjs`, with the freshness check pointed at `root`. */
function runEntryPoint(root: string): { code: number; stderr: string } {
  return runNode(MPGM, { ...process.env, MPGM_PROJECT_ROOT: root });
}

/**
 * Installs the real guard modules into `root/bin` and returns a runner that
 * invokes an entry point there with no override, so the guard resolves
 * `root` from its own location exactly as `bin/mpgm.mjs` does in a real
 * checkout.
 */
function asDefaultRoot(root: string): () => { code: number; stderr: string } {
  mkdirSync(join(root, 'bin'), { recursive: true });
  for (const name of ['dist-freshness.mjs', 'source-fingerprint.mjs']) {
    copyFileSync(join(BIN, name), join(root, 'bin', name));
  }
  const entry = join(root, 'bin', 'entry.mjs');
  writeFileSync(
    entry,
    `import './dist-freshness.mjs';\nprocess.stdout.write('ran\\n');\n`,
  );
  const env = { ...process.env };
  delete env.MPGM_PROJECT_ROOT;
  return () => runNode(entry, env);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dist/ freshness (T4.3.25)', () => {
  it('refuses, naming the fix, once a merge moves the checkout past what dist/ was built from', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo); // dist/ is built from v1.

    // The checkout moves on without a rebuild — exactly what `mergeChange`
    // (`src/implement/merge.ts`) does: it advances the trunk and never
    // touches `dist/`.
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

    // Against the unmodified entry point this first assertion is what
    // fails: nothing refuses, so the case cannot pass against code with no
    // staleness concept (CONV-6). Only after that does a passing run below
    // mean anything.
    expect(runEntryPoint(repo).code).not.toBe(0);

    writeBuildInfo(repo); // The rebuild `npm run build` would have done.
    const fresh = runEntryPoint(repo);

    expect(fresh.code).toBe(0);
    expect(fresh.stderr).toBe('');
  });

  it('refuses on an uncommitted edit to a compiled source, which is what tsc would now read', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo);

    // Never committed: the normal state of a session mid-change. Keying on
    // HEAD's blobs called this fresh, though `dist/` no longer matches what
    // the compiler would produce.
    writeSource(repo, 'edited-in-place');

    const result = runEntryPoint(repo);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
  });

  it('refuses on a change to the compiler configuration, which also decides what dist/ holds', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo);

    // No source file changed; `tsc` would still emit something different.
    writeFileSync(
      join(repo, 'tsconfig.build.json'),
      `${JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.ts'], compilerOptions: { target: 'es2017' } })}\n`,
    );

    const result = runEntryPoint(repo);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
  });

  it('does not go stale on a commit that touches nothing dist/ was compiled from', () => {
    const repo = newRepo();
    commitSource(repo, 'v1');
    writeBuildInfo(repo);

    // Anchor: the guard is live here, so the pass below is a decision and
    // not the absence of one (CONV-6) — the unmodified entry point, which
    // always exits 0, fails this line.
    commitSource(repo, 'v2');
    expect(runEntryPoint(repo).code).not.toBe(0);
    writeBuildInfo(repo);

    // A docs-only / test-only commit: HEAD moves, nothing `tsc` reads does.
    commitNonSource(repo, 'unrelated notes');

    const result = runEntryPoint(repo);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('refuses when MPGM_PROJECT_ROOT points at a directory with no git history, rather than skipping the check', () => {
    const dir = newFixture('mpgm-dist-fresh-nogit-');
    writeSource(dir, 'v1');
    // A record that names some other build — if the override could disable
    // the check, this would make no difference either way. It must not.
    writeFileSync(
      join(dir, 'dist', 'build-info.json'),
      `${JSON.stringify({ commit: 'deadbeef', sourceFingerprint: 'whatever' })}\n`,
    );

    const result = runEntryPoint(dir);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
  });

  it('refuses at the default root when git will not answer: an unborn HEAD and a stale dist/', () => {
    // The fail-open review reproduced: `git rev-parse HEAD` fails in a
    // freshly initialised repository, and that failure used to skip the
    // comparison and exit 0 with a stale record sitting right there.
    const dir = newFixture('mpgm-dist-fresh-unborn-');
    initRepo(dir); // A git repository that cannot answer: no commits yet.
    const run = asDefaultRoot(dir);
    writeSource(dir, 'v1');
    writeBuildInfo(dir);
    writeSource(dir, 'v2'); // dist/ now predates the sources.

    const stale = run();
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('npm run build');

    // And git still plays no part when the answer is yes: a rebuild makes
    // this run, unborn HEAD and all.
    writeBuildInfo(dir);
    expect(run().code).toBe(0);
  });

  it('refuses at the default root when .git is unreadable and dist/ is stale', () => {
    const dir = newFixture('mpgm-dist-fresh-brokengit-');
    const run = asDefaultRoot(dir);
    writeSource(dir, 'v1');
    writeBuildInfo(dir);
    writeSource(dir, 'v2');
    // A `.git` that git itself rejects — the second case review reproduced
    // as exit 0 at the default root.
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/elsewhere\n');

    const result = run();

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
  });

  it('refuses at the default root when the compiled sources cannot be read at all', () => {
    // Not "nothing to compare": a tree the guard cannot read is stale, so
    // the record that is sitting there does not get believed (CONV-4).
    const dir = newFixture('mpgm-dist-fresh-nosrc-');
    const run = asDefaultRoot(dir);
    writeSource(dir, 'v1');
    writeBuildInfo(dir);
    rmSync(join(dir, 'src'), { recursive: true, force: true });

    const result = run();

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
    expect(result.stderr).toContain('cannot read');
  });
});
