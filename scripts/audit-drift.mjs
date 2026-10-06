#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authoredReasons,
  classifyAudit,
  driftReasons,
  parseNpmAuditAdvisories,
} from '../dist/implement/audit-drift.js';

/**
 * The `scan` job's dependency audit (SAF-5, T4.3.16).
 *
 * Plain `npm audit --audit-level=high` reads one way whether a high-severity
 * advisory is this branch's own finding or one the trunk already carries
 * through no doing of this branch's diff — `checks.ts`'s `^scan\b` mapping
 * then reports one refusal either way. That cost two real sessions real
 * money (T4.3.14's hono/ip-address/proxy-addr/qs/source-map-js round, and the
 * GHSA-6qxp-vccf-f47h round against `@modelcontextprotocol/sdk`) fixing
 * dependency drift neither task had asked for.
 *
 * What this does differently: it still runs the full audit against the
 * whole tree (SAF-5 is not weakened — nothing here lowers the floor or
 * narrows what gets scanned), but it classifies each advisory before
 * deciding whether it blocks (`classifyAudit`, `audit-drift.ts`):
 *
 * - if this branch's own diff touches `package.json` or
 *   `package-lock.json` (relative to the trunk, computed below), it gets no
 *   exemption at all — every advisory found blocks, same as today;
 * - otherwise, an advisory also present on the trunk right now is drift, not
 *   this branch's to answer for, and does not block it. One only this
 *   branch's audit reports still blocks.
 *
 * "The trunk right now" is read fresh from `origin/main` at the moment this
 * runs — never from a file committed in this branch's own tree — which is
 * what stops a branch widening its own exemption: there is no baseline file
 * here for a diff to edit. The only way to add an entry to the trunk side of
 * the comparison is to actually be the state of `origin/main`, and nothing
 * in a pull request's diff can write to that.
 *
 * A branch let through on drift is not the end of it (SAF-5 still has to be
 * satisfied somewhere): `.github/workflows/dependency-audit-trunk.yml` runs
 * the same audit against the trunk alone, on a schedule, with no exemption
 * to grant — there is no other branch to blame it on there — so the finding
 * this script let through is exactly the one that job is watching for.
 */

const MIN_SEVERITY = process.env.AUDIT_MIN_SEVERITY ?? 'high';
const BASE_REF = process.env.AUDIT_BASE_REF ?? 'origin/main';

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

/** `npm audit --json`'s stdout, however the command itself exited. */
function npmAuditJson(cwd, extraArgs = []) {
  try {
    return execFileSync('npm', ['audit', '--json', ...extraArgs], {
      cwd,
      encoding: 'utf8',
    });
  } catch (error) {
    // `npm audit` exits non-zero the moment it finds anything — that is not
    // a failure of the command, and its JSON report is still on stdout.
    const stdout = error.stdout;
    if (typeof stdout === 'string' && stdout.trim() !== '') {
      return stdout;
    }
    throw error;
  }
}

/**
 * Whether this branch's own diff touches either manifest, relative to
 * `baseRef` — computed with `git diff A...B`, i.e. against the merge base of
 * `HEAD` and `baseRef`, which is exactly the diff a pull request shows: the
 * branch's own changes, nothing `baseRef` picked up afterwards from some
 * other merge. `baseRef` itself is still read fresh (see module doc) — only
 * the *comparison point* for this one check is the merge base, not the
 * trunk's live tip, so that a trunk that has moved on *unrelated* work since
 * this branch was cut does not get blamed on this branch.
 */
function manifestChanged(baseRef) {
  const diff = git([
    'diff',
    '--name-only',
    `${baseRef}...HEAD`,
    '--',
    'package.json',
    'package-lock.json',
  ]);
  return diff !== '';
}

/**
 * The trunk's own advisories, read fresh from `baseRef`'s current tip.
 *
 * Materializes `baseRef`'s `package.json` and `package-lock.json` into a
 * throwaway directory and audits *that* — `--package-lock-only` so npm does
 * not expect a `node_modules` to exist there, which it never will. Nothing
 * this branch controls feeds this: the two files come from `git show
 * baseRef:<path>`, not from anything in this checkout's working tree.
 */
function trunkAdvisories(baseRef) {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-audit-trunk-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) {
      writeFileSync(join(dir, file), git(['show', `${baseRef}:${file}`]));
    }
    const raw = npmAuditJson(dir, ['--package-lock-only']);
    return parseNpmAuditAdvisories(raw, { minSeverity: MIN_SEVERITY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const current = parseNpmAuditAdvisories(npmAuditJson(process.cwd()), {
    minSeverity: MIN_SEVERITY,
  });

  let changed;
  let trunk = [];
  try {
    changed = manifestChanged(BASE_REF);
    if (!changed) {
      trunk = trunkAdvisories(BASE_REF);
    }
  } catch (error) {
    // Fail closed (CONV-4): anything that stops this from reading the trunk
    // — `baseRef` does not resolve, `git show` cannot find a file there, the
    // trunk's own audit cannot be run — is treated the same as "this branch
    // touched the manifest": no exemption, every advisory this branch's own
    // audit reports blocks, exactly today's behaviour. Guessing an exemption
    // on a trunk this could not actually read is how a real finding would
    // merge past this check.
    console.error(
      `could not compare against '${BASE_REF}': ${error.message}\n` +
        `Granting no drift exemption for this run — every advisory below blocks.`,
    );
    changed = true;
  }

  const classification = classifyAudit({ manifestChanged: changed, current, trunk });

  console.log(
    `dependency audit (floor: ${MIN_SEVERITY}): ${classification.summary}` +
      (changed ? ' — branch touches the manifest, no drift exemption applies' : ''),
  );
  for (const reason of driftReasons(classification)) {
    console.log(`  drift (not blocking): ${reason}`);
  }
  for (const reason of authoredReasons(classification)) {
    console.error(`  blocking: ${reason}`);
  }

  if (classification.drift.length > 0) {
    // "Prices" the drift rather than letting it vanish the moment this job
    // goes green: the scheduled `dependency-audit-trunk` workflow runs the
    // same audit against the trunk alone, with no exemption to grant, so
    // every advisory named above as drift is exactly what that job is
    // watching for next time it runs — the thing this script lets through is
    // not nothing, it is handed to a different, trunk-only check.
    console.log(
      `\n${String(classification.drift.length)} drift advisory(ies) let through unblocked. ` +
        `Not this branch's business, but still SAF-5's: the scheduled ` +
        `'Dependency audit (trunk)' workflow (.github/workflows/` +
        `dependency-audit-trunk.yml) checks the trunk alone for these, with no ` +
        `exemption available there, and is what closes them.`,
    );
  }

  if (classification.blocked) {
    process.exit(1);
  }
}

main();
