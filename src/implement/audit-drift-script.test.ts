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
 * A repo with `main` at one commit (with `refs/remotes/origin/main` set to
 * point at it, modelling the real `origin/main` a `fetch-depth: 0` checkout
 * would have — `scripts/audit-drift.mjs`'s `TRUNK_REF` is hardcoded to this
 * literal ref, so a fixture that never creates it would make every
 * containment check fail to resolve) and, by default, a `feature` branch
 * checked out on top of it (optionally diverging with its own lockfile
 * commit). `checkoutFeature: false` leaves `HEAD` on `main` itself — the
 * `push: branches: [main]` shape, where `origin/main` *is* `HEAD`.
 *
 * `lockOnFeatureBranchFirst` reorders the two feature commits so the
 * lockfile bump lands *before* the unrelated one — the shape a bypass
 * attempt needs: `AUDIT_BASE_REF=HEAD~1` naming the lockfile-bump commit
 * itself as the fork point only matters if there is an unrelated commit
 * after it for `HEAD~1` to resolve to.
 *
 * `advanceTrunkAfterBranch` adds a further commit to `main` — and moves
 * `origin/main` to it — *after* `feature` has already diverged, modelling
 * the trunk advancing on unrelated work while this branch's PR is open.
 */
function newRepo(options: {
  readonly lockOnFeatureBranch?: string;
  readonly lockOnFeatureBranchFirst?: boolean;
  readonly checkoutFeature?: boolean;
  readonly advanceTrunkAfterBranch?: boolean;
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
  run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  if (options.checkoutFeature === false) {
    return dir;
  }
  run(['checkout', '-b', 'feature']);
  const commitLockBump = (): void => {
    writeFileSync(join(dir, 'package-lock.json'), options.lockOnFeatureBranch ?? '');
    run(['add', '--all']);
    run(['commit', '-m', 'bump a dependency']);
  };
  const commitUnrelated = (): void => {
    // A real `pull_request` run checks out a merge commit layered on top of
    // both tips by default, so a feature branch's HEAD is never literally
    // `main`'s own commit even when it has not touched the manifest — this
    // commit (never the manifest) keeps the fixture that honest, rather than
    // leaving `feature` sitting on exactly the commit `main` resolves to.
    writeFileSync(join(dir, 'NOTES.md'), 'unrelated feature work\n');
    run(['add', '--all']);
    run(['commit', '-m', 'unrelated feature work']);
  };
  if (
    options.lockOnFeatureBranch !== undefined &&
    options.lockOnFeatureBranchFirst === true
  ) {
    commitLockBump();
    commitUnrelated();
  } else {
    commitUnrelated();
    if (options.lockOnFeatureBranch !== undefined) {
      commitLockBump();
    }
  }
  if (options.advanceTrunkAfterBranch === true) {
    run(['checkout', 'main']);
    writeFileSync(
      join(dir, 'TRUNK-ADVANCE.md'),
      'the trunk moved on, unrelated to feature\n',
    );
    run(['add', '--all']);
    run(['commit', '-m', 'trunk advances after feature was cut']);
    run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    run(['checkout', 'feature']);
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
  // with HEAD on `main` itself and no override at all — the literal shape of
  // that run: `TRUNK_REF` ('origin/main') resolves to `HEAD`. Fails against
  // the code before this fix, which printed "drift (not blocking)" and
  // exited 0.
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
      AUDIT_MIN_SEVERITY: 'critical',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: trunk,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-ceiling-ceiling');
  });

  // [blocker] T4.3.16 review round 2, scripts/audit-drift.mjs:116: a plain
  // "is the fork point an ancestor of HEAD" check (round 1's fix) is
  // trivially satisfied by any commit on this branch's own history, not
  // only a real trunk commit. Reproduced here exactly as review found it: a
  // feature branch whose first commit bumps the lockfile to a vulnerable
  // version and whose second, later commit is unrelated, with
  // `AUDIT_BASE_REF=HEAD~1` naming that first commit as the fork point.
  // `HEAD~1` is a proper ancestor of `HEAD` and distinct from it, so round
  // 1's guard passes it — but it is not reachable from the real trunk
  // (`origin/main`), which is exactly what the containment check added this
  // round refuses. Fails against the code before this fix, which printed
  // "drift (not blocking)" and exited 0, because the fork point it picked
  // already carried the same advisory, making it look like the trunk's.
  it("grants no exemption when AUDIT_BASE_REF names a commit on this branch's own history, even one that already carries the advisory", () => {
    const repo = newRepo({
      lockOnFeatureBranch: '{"lockfileVersion":3,"bumped":true}\n',
      lockOnFeatureBranchFirst: true,
    });
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const current = join(repo, 'current.json');
    writeFileSync(current, auditJson([{ id: 'GHSA-self-fork-aaaa', pkg: 'left-pad' }]));

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_BASE_REF: 'HEAD~1',
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(1);
    expect(result.output).not.toContain('drift (not blocking)');
    expect(result.output).toContain('blocking');
    expect(result.output).toContain('GHSA-self-fork-aaaa');
  });

  // [major] T4.3.16 review round 2, scripts/audit-drift.mjs:125: the
  // ancestry test was made against live `origin/main`, which this project's
  // own loop advances continuously — once a further, unrelated commit lands
  // on the trunk after this branch was cut, a direct ancestor check of the
  // (now stale) fork point fails and an inherited advisory starts blocking
  // again. Reproduced here by advancing `main`/`origin/main` with a further
  // commit after `feature` has already diverged and carries a shared
  // advisory. Fails against a direct ancestor check of `TRUNK_REF` itself
  // (round 1's shape); `git merge-base` finds the real fork point
  // regardless of how far the trunk has since moved, so this must still
  // pass.
  it('still classifies a shared advisory as drift once the trunk has advanced past the commit this branch was cut from', () => {
    const repo = newRepo({
      advanceTrunkAfterBranch: true,
    });
    const binDir = stubNpm(mkdtempSync(join(tmpdir(), 'mpgm-audit-bin-')));
    tempDirs.push(binDir);
    const shared = auditJson([
      { id: 'GHSA-trnk-adv1-aaaa', pkg: '@modelcontextprotocol/sdk' },
    ]);
    const current = join(repo, 'current.json');
    writeFileSync(current, shared);

    const result = runScript(repo, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AUDIT_STUB_CURRENT: current,
      AUDIT_STUB_TRUNK: current,
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('drift (not blocking)');
    expect(result.output).toContain('GHSA-trnk-adv1-aaaa');
    expect(result.output).toContain('this branch is not its author');
  });
});
