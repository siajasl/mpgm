import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/audit-drift.mjs`, the `scan` job's dependency-audit entry point
 * (SAF-5, T4.3.16), end to end against a throwaway git repository — the same
 * approach `scan-secrets.test.ts` uses for the other `scan` script, and for
 * the same reason: this runs as a subprocess against `dist/`, not as a unit
 * under test, so the only honest test drives it as CI does.
 *
 * `npm audit` itself is stubbed out (a fake `npm` placed first on `PATH`)
 * rather than exercised for real: a real advisory list changes over time as
 * packages get patched, which would make this test's pass/fail depend on
 * which day it ran rather than on the logic it is meant to check — exactly
 * the kind of flake a merge gate cannot afford silently.
 */

const SCRIPT = resolve(import.meta.dirname, '../../scripts/audit-drift.mjs');
const tempDirs: string[] = [];

/** A fake `npm` that answers `audit --json` from a fixed file and ignores everything else. */
function stubNpm(dir: string): string {
  const bin = join(dir, 'npm');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "import { readFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "const isTrunk = args.includes('--package-lock-only');",
      "const key = isTrunk ? 'AUDIT_STUB_TRUNK' : 'AUDIT_STUB_CURRENT';",
      'const path = process.env[key];',
      'if (path === undefined) { process.exit(0); }',
      "process.stdout.write(readFileSync(path, 'utf8'));",
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return dir;
}

function auditJson(advisories: { id: string; pkg: string; severity?: string }[]): string {
  const vulnerabilities: Record<string, unknown> = {};
  for (const { id, pkg, severity = 'high' } of advisories) {
    vulnerabilities[pkg] = {
      name: pkg,
      severity,
      via: [
        {
          source: 1,
          name: pkg,
          title: `${id} affects ${pkg}`,
          url: `https://github.com/advisories/${id}`,
          severity,
          range: '*',
        },
      ],
    };
  }
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities });
}

/** A repo with `main` at one commit and a feature branch optionally diverging from it. */
function newRepo(options: { readonly lockOnFeatureBranch?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-audit-'));
  tempDirs.push(dir);
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir });
  };
  run(['init', '--initial-branch=main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  run(['add', '--all']);
  run(['commit', '-m', 'trunk']);
  run(['checkout', '-b', 'feature']);
  if (options.lockOnFeatureBranch !== undefined) {
    writeFileSync(join(dir, 'package-lock.json'), options.lockOnFeatureBranch);
    run(['add', '--all']);
    run(['commit', '-m', 'bump a dependency']);
  }
  return dir;
}

function runScript(
  cwd: string,
  env: Record<string, string>,
): { code: number; output: string } {
  try {
    return {
      code: 0,
      output: execFileSync('node', [SCRIPT], { cwd, encoding: 'utf8', env }),
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

describe('audit-drift.mjs', () => {
  // T4.3.16 completion criterion, first case, driven through the actual
  // entry point the `scan` job runs: a branch whose diff touches no
  // manifest, with the trunk already carrying the exact same high-severity
  // advisory, must not be refused as that advisory's author. Fails against
  // plain `npm audit --audit-level=high` (today's step), which would exit 1
  // here regardless of who the advisory belongs to.
  it('does not block a branch for an advisory the trunk already carries, when the branch touched no manifest', () => {
    const repo = newRepo({});
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const shared = auditJson([
      { id: 'GHSA-6qxp-vccf-f47h', pkg: '@modelcontextprotocol/sdk' },
    ]);
    const current = join(repo, 'current.json');
    writeFileSync(current, shared);

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('drift (not blocking)');
    expect(result.output).toContain('GHSA-6qxp-vccf-f47h');
    expect(result.output).toContain('this branch is not its author');
  });

  // Second case: a branch that adds a dependency carrying a high-severity
  // advisory the trunk does not have is refused. Fails against the
  // unmodified code for the opposite reason — nothing there distinguishes
  // this from drift either, so a passing test proves nothing unless it can
  // also fail this way.
  it('blocks a branch that introduces a dependency carrying a high-severity advisory', () => {
    const repo = newRepo({
      lockOnFeatureBranch: '{"lockfileVersion":3,"bumped":true}\n',
    });
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const current = join(repo, 'current.json');
    writeFileSync(current, auditJson([{ id: 'GHSA-aaaa-bbbb-cccc', pkg: 'left-pad' }]));
    // Never read for this case — the branch touched the manifest, so the
    // script must not even need a trunk comparison to refuse it.
    const trunk = join(repo, 'unused.json');
    writeFileSync(trunk, auditJson([]));

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: trunk,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-aaaa-bbbb-cccc');
    expect(result.output).toContain('no drift exemption applies');
  });

  it('grants no exemption for a shared advisory once the branch has touched the manifest', () => {
    const repo = newRepo({
      lockOnFeatureBranch: '{"lockfileVersion":3,"bumped":true}\n',
    });
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const shared = auditJson([
      { id: 'GHSA-6qxp-vccf-f47h', pkg: '@modelcontextprotocol/sdk' },
    ]);
    const current = join(repo, 'current.json');
    writeFileSync(current, shared);

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-6qxp-vccf-f47h');
  });

  it('passes cleanly when the audit finds nothing', () => {
    const repo = newRepo({});
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const clean = join(repo, 'current.json');
    writeFileSync(clean, auditJson([]));

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_STUB_CURRENT: clean,
      AUDIT_STUB_TRUNK: clean,
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('no advisories at or above the floor');
  });
});
