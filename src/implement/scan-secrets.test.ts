import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The `scan` merge check (SAF-5) runs as a subprocess against `dist/`, so
 * these tests need a build — the same reason the crash fixtures do.
 */

const SCANNER = resolve(import.meta.dirname, '../../scripts/scan-secrets.mjs');
const tempDirs: string[] = [];

function newRepo(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-scan-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  execFileSync('git', ['add', '--all'], { cwd: dir });
  return dir;
}

function scan(cwd: string): { code: number; output: string } {
  try {
    return {
      code: 0,
      output: execFileSync('node', [SCANNER], { cwd, encoding: 'utf8' }),
    };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; stdout?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('secret scan', () => {
  it('fails on a committed credential', () => {
    // A fabricated GitHub token, shaped to match the redaction rule.
    const planted = `ghp_${'a'.repeat(36)}`;
    const repo = newRepo({ 'config.ts': `export const token = '${planted}';\n` });

    const result = scan(repo);

    expect(result.code).toBe(1);
    expect(result.output).toContain('config.ts:1');
    expect(result.output).toContain('github-token');
  });

  it('passes a repository with nothing to find', () => {
    const repo = newRepo({ 'index.ts': 'export const answer = 42;\n' });

    expect(scan(repo).code).toBe(0);
  });

  it('exempts only the line that says so', () => {
    const planted = `ghp_${'b'.repeat(36)}`;
    const repo = newRepo({
      'fixture.ts': `const example = '${planted}'; // mpgm-secret-scan: allow\nconst real = '${planted}';\n`,
    });

    const result = scan(repo);

    expect(result.code).toBe(1);
    expect(result.output).toContain('fixture.ts:2');
    expect(result.output).not.toContain('fixture.ts:1');
  });

  it('ignores files git does not track', () => {
    const planted = `ghp_${'c'.repeat(36)}`;
    const repo = newRepo({ 'index.ts': 'export const answer = 42;\n' });
    writeFileSync(join(repo, 'untracked.ts'), `const key = '${planted}';\n`);

    // Untracked files are not in the repository, so they are not what this
    // check is about — the merge gate asks what a merge would bring in.
    expect(scan(repo).code).toBe(0);
  });
});
