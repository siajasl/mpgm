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
      // Mirrors real `npm audit --json`, which exits non-zero the moment it
      // finds anything (or fails to run at all) while still printing its
      // JSON report to stdout — `AUDIT_STUB_EXIT` lets a test simulate that
      // without needing a real advisory list on either side.
      "process.exit(Number(process.env.AUDIT_STUB_EXIT ?? '0'));",
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

/**
 * A repo with `main` at one commit and, by default, a `feature` branch
 * checked out on top of it (optionally diverging with its own lockfile
 * commit). `checkoutFeature: false` leaves `HEAD` on `main` itself — the
 * `push: branches: [main]` shape, where `origin/main` *is* `HEAD`.
 */
function newRepo(options: {
  readonly lockOnFeatureBranch?: string;
  readonly checkoutFeature?: boolean;
}): string {
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
  if (options.checkoutFeature === false) {
    return dir;
  }
  run(['checkout', '-b', 'feature']);
  // A real `pull_request` run checks out a merge commit layered on top of
  // both tips by default, so a feature branch's HEAD is never literally
  // `main`'s own commit even when it has not touched the manifest — this
  // commit (never the manifest) keeps the fixture that honest, rather than
  // leaving `feature` sitting on exactly the commit `main` resolves to.
  writeFileSync(join(dir, 'NOTES.md'), 'unrelated feature work\n');
  run(['add', '--all']);
  run(['commit', '-m', 'unrelated feature work']);
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

  // [blocker] finding verified against real npm 11.19.1 with this repo's own
  // package-lock.json: a registry/proxy/auth failure makes `npm audit --json`
  // print `{"message": ..., "error": {...}}` and exit non-zero — no
  // `vulnerabilities` key at all. Plain `npm audit --audit-level=high` goes
  // red on that (it cannot tell "nothing found" from "could not look"), so
  // this script must too. Fails against the code before this fix: the stub
  // exits non-zero exactly like real npm does on this failure, `npmAuditJson`
  // treats that non-zero exit's non-empty stdout as a valid report (the
  // branch that already handles npm's normal "found something" non-zero
  // exit), and the absent `vulnerabilities` key parsed as zero advisories —
  // a clean pass having audited nothing.
  it('fails closed when the audit itself could not be run, rather than reporting a clean pass', () => {
    const repo = newRepo({});
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const errorReport = join(repo, 'current.json');
    writeFileSync(
      errorReport,
      JSON.stringify({
        message:
          'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed',
        error: { code: 'ENOTFOUND' },
      }),
    );

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_STUB_CURRENT: errorReport,
      AUDIT_STUB_EXIT: '1',
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("did not carry a 'vulnerabilities' list");
  });

  // [major] T4.3.16 review, scripts/audit-drift.mjs:127: when the base ref
  // resolves to the same commit as HEAD — every `push: branches: [main]` run
  // of ci.yml — the trunk audited itself and every advisory classified as
  // drift, exiting 0 with a high-severity advisory unblocked. Reproduced here
  // with HEAD on `main` and `AUDIT_BASE_REF=main` (the literal shape of that
  // run: `origin/main` resolves to `HEAD`). Fails against the code before
  // this fix, which printed "drift (not blocking)" and exited 0.
  it('blocks on the trunk itself when the base ref resolves to HEAD, rather than auditing the trunk against itself', () => {
    const repo = newRepo({ checkoutFeature: false });
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const current = join(repo, 'current.json');
    writeFileSync(
      current,
      auditJson([{ id: 'GHSA-trunk-trunk-trunk', pkg: 'left-pad' }]),
    );

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('resolves to HEAD itself');
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-trunk-trunk-trunk');
  });

  // [major] T4.3.16 review, scripts/audit-drift.mjs:51: AUDIT_BASE_REF is read
  // from process.env, and the only thing that sets a step's environment is
  // ci.yml's own env: — part of the branch's own diff. AUDIT_BASE_REF=HEAD
  // audits a branch against itself (every advisory then looks like the
  // trunk's own), a complete bypass via a one-line workflow edit. Fails
  // against the code before this fix, which granted the exemption.
  it('grants no exemption when AUDIT_BASE_REF points at HEAD, even though the branch touched no manifest', () => {
    const repo = newRepo({});
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const current = join(repo, 'current.json');
    writeFileSync(
      current,
      auditJson([{ id: 'GHSA-bypass-bypass-bypass', pkg: 'left-pad' }]),
    );

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'HEAD',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('resolves to HEAD itself');
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-bypass-bypass-bypass');
  });

  // [minor] T4.3.16 review, audit-drift-script.test.ts:118: the script's
  // central fail-closed branch — the catch around manifestChanged/
  // trunkAdvisories that grants no exemption when the trunk cannot be read —
  // had no test. A base ref that does not resolve at all (a typo'd
  // AUDIT_BASE_REF, or a shallow checkout missing `origin/main`) must refuse
  // the exemption and list the advisory as blocking rather than silently
  // falling through.
  it('fails closed with the advisory listed as blocking when the base ref cannot be read at all', () => {
    const repo = newRepo({});
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const current = join(repo, 'current.json');
    writeFileSync(current, auditJson([{ id: 'GHSA-unreadable-trunk', pkg: 'left-pad' }]));

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'this-ref-does-not-exist',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('no drift exemption for this run');
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-unreadable-trunk');
  });

  // [major] T4.3.16 review, src/implement/audit-drift.ts:48: AUDIT_MIN_SEVERITY
  // is read from process.env (set by ci.yml, part of the branch's own diff);
  // raising it past `high` made every real advisory rank beneath it, so the
  // job reported a clean audit having examined nothing. A floor raised to
  // 'critical' must still catch a high-severity advisory this branch
  // introduced. Fails against the code before this fix, which passed
  // AUDIT_MIN_SEVERITY straight through and exited 0.
  it('does not let AUDIT_MIN_SEVERITY raised past high drop a high-severity advisory this branch introduced', () => {
    const repo = newRepo({
      lockOnFeatureBranch: '{"lockfileVersion":3,"bumped":true}\n',
    });
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const current = join(repo, 'current.json');
    writeFileSync(current, auditJson([{ id: 'GHSA-ceiling-ceiling', pkg: 'left-pad' }]));
    const trunk = join(repo, 'unused.json');
    writeFileSync(trunk, auditJson([]));

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'main',
      AUDIT_MIN_SEVERITY: 'critical',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: trunk,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-ceiling-ceiling');
  });
});
