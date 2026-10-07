#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authoredReasons,
  classifyAudit,
  clampSeverityCeiling,
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
 * here for a diff to edit.
 *
 * `AUDIT_MIN_SEVERITY` below *is* settable by `.github/workflows/ci.yml`'s
 * `env:`, and that file is part of the branch's own diff. Raising it past
 * `high` (`AUDIT_MIN_SEVERITY=critical`) would drop a high-severity advisory
 * before classification ever sees it; `clampSeverityCeiling` never lets the
 * floor rise past `high`, whatever `AUDIT_MIN_SEVERITY` asks for, so there is
 * nothing for that one to widen.
 *
 * `AUDIT_BASE_REF` is a different shape of risk, and review needed two
 * rounds to pin it down. `TRUNK_REF` below — `origin/main` — is a *constant*,
 * never read from the environment: no diff on this branch can move what
 * commit `origin/main` resolves to on the real remote, however
 * `ci.yml` is edited, which is exactly why it is safe to hardcode. What
 * `AUDIT_BASE_REF` feeds is only the *candidate* `resolveBase` hands to `git
 * merge-base` — so the test suite can point it at a throwaway repo's own
 * trunk branch, since a `mkdtemp` fixture has no real `origin` remote to
 * fetch. That candidate grants no exemption by itself: `resolveBase`
 * additionally requires the fork point it computes to be contained in
 * `TRUNK_REF`'s own history — reachable from `origin/main`, not merely from
 * `HEAD`. The first round fixed only "is the fork point a proper ancestor of
 * `HEAD`", which `AUDIT_BASE_REF=HEAD~1` (any earlier commit on this same
 * branch) still satisfied trivially, because every commit on this branch is
 * one; review reproduced that as a full bypass. Requiring containment in
 * `TRUNK_REF` instead closes it, because a branch's own commit is never
 * reachable from the trunk it branched off — and deriving the fork point
 * with `merge-base` rather than a direct ancestor check of `TRUNK_REF`
 * itself is what keeps this working once the trunk has advanced past the
 * commit this branch was actually cut from (second round's other major
 * finding).
 *
 * A branch let through on drift is not the end of it (SAF-5 still has to be
 * satisfied somewhere): `.github/workflows/dependency-audit-trunk.yml` runs
 * the same audit against the trunk alone, on a schedule, with no exemption
 * to grant — there is no other branch to blame it on there — so the finding
 * this script let through is exactly the one that job is watching for.
 */

// clampSeverityCeiling both validates (throws on a floor npm audit's own
// scale does not recognise, CONV-3/CONV-4) and caps the floor so a workflow
// cannot raise it past `high` — see the module doc above.
const MIN_SEVERITY = clampSeverityCeiling(process.env.AUDIT_MIN_SEVERITY ?? 'high');

// The one ref this script treats as ground truth for "the trunk" — a
// constant, never read from `process.env`, because the only thing able to
// set an environment variable here is `.github/workflows/ci.yml`, itself
// part of the branch under review's own diff. See the module doc above.
const TRUNK_REF = 'origin/main';

// The candidate `resolveBase` hands to `git merge-base` below. Unlike
// `TRUNK_REF`, this one *is* overridable, because it grants no exemption by
// itself — `resolveBase` still requires whatever it resolves to be
// contained in `TRUNK_REF`'s own history. The override exists only so the
// test suite can point it at a throwaway repo's own trunk branch; no
// legitimate workflow sets `AUDIT_BASE_REF` at all.
const MERGE_BASE_CANDIDATE = process.env.AUDIT_BASE_REF ?? TRUNK_REF;

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

/**
 * Whether `commitSha` is reachable from `ref`'s history — an ancestor of it,
 * or the same commit (git's own `--is-ancestor` already treats the two
 * refs resolving to the same commit as true, which is exactly what is
 * wanted here: an ordinary PR cut right at the trunk's current tip has a
 * fork point that *is* that tip, not merely an ancestor of it).
 */
function isContainedIn(commitSha, ref) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commitSha, ref], {
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    // `--is-ancestor` exits 1 for a plain "no" — not a failure of the
    // command. Anything else (e.g. a ref `merge-base` cannot even look up)
    // is a real error and must propagate, so the caller's fail-closed catch
    // treats it the same as any other unreadable-trunk condition.
    if (error.status === 1) {
      return false;
    }
    throw error;
  }
}

/**
 * Resolves the fork point between `candidateRef` and `HEAD`, and decides
 * whether comparing against it can grant any exemption at all (T4.3.16
 * review, two rounds).
 *
 * The fork point is derived with `git merge-base`, not a direct
 * `rev-parse` of `candidateRef` followed by an ancestor check against
 * `HEAD`: `merge-base` always finds the real common ancestor of the two,
 * however far `TRUNK_REF` has advanced since this branch was cut, rather
 * than throwing the moment a stale ref fails a direct ancestor check
 * (second round's major finding — the trunk moves constantly in this
 * project's own loop, and an inherited advisory must not start blocking
 * again merely because something unrelated landed on `main` first).
 *
 * Two cases refuse eligibility even though every git call here succeeds
 * (CONV-4):
 *
 * - the fork point is `HEAD` itself. Every `push: branches: [main]` run of
 *   `ci.yml` is exactly this (`origin/main` *is* `HEAD` there), and so is
 *   `AUDIT_BASE_REF=HEAD`: auditing a commit against itself makes every
 *   advisory look like "the trunk's", which is not a comparison, it is the
 *   trunk auditing itself. There is no other branch to blame a finding on,
 *   so this run gets no exemption.
 * - the fork point is not contained in `TRUNK_REF`'s own history. First
 *   round's blocker: `AUDIT_BASE_REF` pointing at an earlier commit on this
 *   same branch (`HEAD~1`, say) passed a plain "is the fork point an
 *   ancestor of `HEAD`" check trivially, because every commit on this
 *   branch already is one — the check that mattered was never against
 *   `HEAD`, it was against the trunk this branch is actually being
 *   compared to, which `AUDIT_BASE_REF` cannot move.
 */
function resolveBase(candidateRef, headSha) {
  const baseSha = git(['merge-base', candidateRef, headSha]);
  if (baseSha === headSha) {
    throw new Error(
      `'${candidateRef}' resolves to HEAD itself (${headSha}) — there is ` +
        `no other branch to blame a finding on, so this run is the trunk, not a ` +
        `branch reviewed against it`,
    );
  }
  if (!isContainedIn(baseSha, TRUNK_REF)) {
    throw new Error(
      `the fork point with '${candidateRef}' (${baseSha}) is not contained in ` +
        `'${TRUNK_REF}'s own history — not a real trunk commit this branch can be ` +
        `compared against, so there is nothing to compare`,
    );
  }
  return baseSha;
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
 * `baseSha` — computed with `git diff A...B`, i.e. against the merge base of
 * `HEAD` and `baseSha`, which is exactly the diff a pull request shows: the
 * branch's own changes, nothing `baseSha` picked up afterwards from some
 * other merge. Only the *comparison point* for this one check is the merge
 * base, not the trunk's live tip, so that a trunk that has moved on
 * *unrelated* work since this branch was cut does not get blamed on this
 * branch. `baseSha` is already resolved and ancestry-checked by
 * `resolveBase` before this is called.
 */
function manifestChanged(baseSha) {
  const diff = git([
    'diff',
    '--name-only',
    `${baseSha}...HEAD`,
    '--',
    'package.json',
    'package-lock.json',
  ]);
  return diff !== '';
}

/**
 * The trunk's own advisories, read fresh from `baseSha`.
 *
 * Materializes `baseSha`'s `package.json` and `package-lock.json` into a
 * throwaway directory and audits *that* — `--package-lock-only` so npm does
 * not expect a `node_modules` to exist there, which it never will. Nothing
 * this branch controls feeds this: the two files come from `git show
 * baseSha:<path>`, not from anything in this checkout's working tree.
 */
function trunkAdvisories(baseSha) {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-audit-trunk-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) {
      writeFileSync(join(dir, file), git(['show', `${baseSha}:${file}`]));
    }
    const raw = npmAuditJson(dir, ['--package-lock-only']);
    return parseNpmAuditAdvisories(raw, { minSeverity: MIN_SEVERITY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Makes an exemption this run granted countable after the run, not only
 * visible in a passing job's stdout (review finding: "a count printed into a
 * passing job's log is not recoverable later").
 *
 * `$GITHUB_STEP_SUMMARY` is a file path Actions provides per step and renders
 * as markdown on the run's summary page; it is unset outside Actions (e.g.
 * the script's own tests), when this is a silent no-op. This does not record
 * the exemption on the task's own event log — that is the loop's job, when it
 * reads a passing `scan` check — but it is enough that the next session
 * reading this run can tell a branch that was handed drift from one that
 * never had any, without re-running the audit.
 */
function recordDriftSummary(drift) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === '') {
    return;
  }
  const lines = [
    '',
    '### Dependency drift let through unblocked (T4.3.16)',
    '',
    "Already on the trunk, not this branch's to answer for. Still SAF-5's: the " +
      "scheduled 'Dependency audit (trunk)' workflow is what closes these.",
    '',
    ...drift.map((a) => `- \`${a.id}\` (${a.package}, ${a.severity})`),
    '',
  ];
  try {
    appendFileSync(summaryPath, lines.join('\n'));
  } catch (error) {
    // Best-effort: losing the durable record must not turn a real pass into
    // a crash, but say so rather than failing silently.
    console.error(
      `could not write drift summary to GITHUB_STEP_SUMMARY: ${error.message}`,
    );
  }
}

function main() {
  const current = parseNpmAuditAdvisories(npmAuditJson(process.cwd()), {
    minSeverity: MIN_SEVERITY,
  });

  let changed;
  let trunk = [];
  try {
    const headSha = git(['rev-parse', 'HEAD']);
    const baseSha = resolveBase(MERGE_BASE_CANDIDATE, headSha);
    changed = manifestChanged(baseSha);
    if (changed) {
      console.error(
        'no drift exemption for this run: branch touches package.json or ' +
          'package-lock.json relative to the trunk — editing the manifest is ' +
          'exactly the diff that can introduce a finding, so no exemption applies.',
      );
    } else {
      trunk = trunkAdvisories(baseSha);
    }
  } catch (error) {
    // Fail closed (CONV-4): anything that stops this run from being eligible
    // for an exemption at all — the fork point resolves to `HEAD` itself or
    // is not contained in `TRUNK_REF`'s own history (`resolveBase`), the
    // candidate ref does not resolve, `git show` cannot find a file there,
    // or the trunk's own audit cannot be run — is treated the same as "this
    // branch touched the manifest": no exemption, every advisory this
    // branch's own audit reports blocks, exactly today's behaviour. Guessing
    // an exemption here is how a real finding would merge past this check.
    console.error(
      `no drift exemption for this run: ${error.message}\n` +
        `Granting none — every advisory below blocks.`,
    );
    changed = true;
  }

  const classification = classifyAudit({ manifestChanged: changed, current, trunk });

  console.log(
    `dependency audit (floor: ${MIN_SEVERITY}): ${classification.summary}` +
      (changed ? ' — no drift exemption applies' : ''),
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
    recordDriftSummary(classification.drift);
  }

  if (classification.blocked) {
    process.exit(1);
  }
}

main();
