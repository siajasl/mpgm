/**
 * Telling a dependency finding this branch introduced apart from one it
 * merely inherited (SAF-5, IMP-2, T4.3.16).
 *
 * `npm audit` answers one question — does the resolved tree carry a known
 * advisory at or above a severity — and today's `scan` job (`.github/
 * workflows/ci.yml`) reads that answer as a single pass/fail with no floor on
 * advisory age and no comparison against anything else. An advisory
 * published the week after a branch was cut, against a package the branch
 * never touched, reads exactly like one the branch's own diff introduced: the
 * gate (`checks.ts`'s `^scan\b` mapping) sees one refusal either way. That is
 * what cost two real sessions real money and time (T4.3.14's hono/ip-
 * address/proxy-addr/qs/source-map-js round, and the GHSA-6qxp-vccf-f47h
 * round against `@modelcontextprotocol/sdk`) fixing drift neither branch's
 * task had asked for.
 *
 * This module does not weaken SAF-5. A high-severity advisory still has to be
 * fixed, by something — see `scripts/audit-drift.mjs` and the scheduled
 * workflow it is paired with. What this separates is *who the finding is
 * about*: an advisory against a package this branch's own diff added or
 * moved is this branch's; one the trunk already carries, unrelated to
 * anything this branch touched, is the project's. {@link classifyAudit} is
 * the pure decision; nothing here runs `npm audit` or touches git — that is
 * the script's job, so the decision itself can be unit-tested without a
 * registry on the other end of it.
 */

/** `npm audit`'s own severity scale, low to high. */
export const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity as Severity);
  // An unrecognised severity string ranks above every known one, not below
  // (CONV-4): this value only ever feeds a floor comparison in
  // `meetsSeverity`, and the one direction that could quietly cost SAF-5 a
  // real finding is treating an advisory `npm audit` labelled with something
  // this code does not recognise as *beneath* the floor, so it gets dropped
  // from `current` or `trunk` and never considered at all. Ranking it highest
  // means it always meets the floor and always blocks, whatever the floor is
  // — the same "ambiguous input stops the merge" rule CONV-4 asks for, not a
  // guess at how serious it actually is.
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** Whether `severity` is at or above `minSeverity` on `npm audit`'s scale. */
export function meetsSeverity(severity: string, minSeverity: string): boolean {
  return severityRank(severity) >= severityRank(minSeverity);
}

/**
 * Throws when `minSeverity` is not one of {@link SEVERITY_ORDER}, rather than
 * letting it reach {@link meetsSeverity} unexamined.
 *
 * The "unrecognised ranks highest" rule above is right for an *advisory's*
 * severity (an unfamiliar label must not let a real finding slip beneath the
 * floor), but it is exactly backwards for the floor itself: `meetsSeverity`
 * compares every advisory's rank against `severityRank(minSeverity)`, so an
 * unrecognised floor — `AUDIT_MIN_SEVERITY=High` (capital H) reproduces this —
 * ranks *above every real severity there is*, and nothing meets it. That is a
 * clean audit having filtered out every advisory unseen, the precise fail-open
 * CONV-4 forbids, and it is indistinguishable from an audit that genuinely
 * found nothing. Validating the floor where it enters this module closes that
 * regardless of which caller supplied it (the `scan` job's `AUDIT_MIN_SEVERITY`
 * or a direct call here).
 */
function assertKnownSeverity(minSeverity: string): asserts minSeverity is Severity {
  if (!SEVERITY_ORDER.includes(minSeverity as Severity)) {
    // CONV-3: names the bad value and the scale it was checked against, so
    // the cause is fixable without reading this file.
    throw new Error(
      `minSeverity '${minSeverity}' is not one of npm audit's own severities ` +
        `(${SEVERITY_ORDER.join(', ')}). Treating it as if it ranked above ` +
        `every real severity (so nothing met the floor) would report a clean ` +
        `audit having examined nothing — fix the caller instead (this is ` +
        `'AUDIT_MIN_SEVERITY' if it came from the 'scan' job's dependency audit).`,
    );
  }
}

/**
 * The floor `scripts/audit-drift.mjs` should actually use, given what
 * `AUDIT_MIN_SEVERITY` asked for.
 *
 * `AUDIT_MIN_SEVERITY` is read from `process.env`, and the only thing that
 * sets a step's environment is `.github/workflows/ci.yml` — part of the
 * branch's own diff. Lowering the floor only ever finds *more* advisories, so
 * there is nothing there for a branch to widen. Raising it above `high` is
 * the opposite: `AUDIT_MIN_SEVERITY=critical` would make `meetsSeverity` drop
 * every high-severity advisory from both `current` and `trunk` before
 * `classifyAudit` ever sees them, in either direction — an advisory this
 * branch itself introduced would disappear entirely rather than merely being
 * misclassified. That is `--audit-level=high` itself being narrowed by a
 * one-line workflow edit, which CONV-4 forbids regardless of the drift
 * question; this clamps the ceiling so a request to raise it past `high` is
 * silently capped there instead, while an invalid value still raises via
 * {@link assertKnownSeverity} — a typo must stop the job, not widen it.
 */
export function clampSeverityCeiling(
  minSeverity: string,
  ceiling: Severity = 'high',
): Severity {
  assertKnownSeverity(minSeverity);
  return severityRank(minSeverity) > severityRank(ceiling) ? ceiling : minSeverity;
}

/** One advisory against one package, as read out of `npm audit --json`. */
export interface Advisory {
  /** GHSA id where the report carries one, else the registry's own numeric id. */
  readonly id: string;
  readonly package: string;
  readonly severity: string;
  readonly title: string;
}

interface NpmAuditViaEntry {
  readonly source?: number;
  readonly title?: string;
  readonly url?: string;
  readonly severity?: string;
}

interface NpmAuditVulnerability {
  readonly severity?: string;
  readonly via?: readonly (string | NpmAuditViaEntry)[];
}

interface NpmAuditReport {
  readonly vulnerabilities?: Readonly<Record<string, NpmAuditVulnerability>>;
  /** Present instead of `vulnerabilities` when the audit itself could not run. */
  readonly message?: string;
  readonly error?: unknown;
}

const GHSA_PATTERN = /GHSA-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}/;

/**
 * Flatten `npm audit --json`'s report into one {@link Advisory} per
 * (package, advisory) pair at or above `minSeverity` (default `high`, the
 * same floor `--audit-level=high` already enforced — this does not lower it).
 *
 * `via` entries that are plain strings name the dependency that pulled an
 * advisory in, not an advisory of their own; the entry for *that* dependency
 * carries the real one, so plain strings are skipped here rather than turned
 * into a phantom finding with no id.
 */
export function parseNpmAuditAdvisories(
  raw: string,
  options: { readonly minSeverity?: string } = {},
): Advisory[] {
  const minSeverity = options.minSeverity ?? 'high';
  assertKnownSeverity(minSeverity);
  let report: NpmAuditReport;
  try {
    report = JSON.parse(raw) as NpmAuditReport;
  } catch (cause) {
    // CONV-3: enough to fix the cause without reading this file — the raw
    // output is right there, truncated so a huge audit report does not drown
    // the message that matters.
    throw new Error(
      `could not parse 'npm audit --json' output as JSON: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `First 200 characters of what was given: ${raw.slice(0, 200)}`,
      { cause },
    );
  }

  // CONV-4: a report that did not actually run the audit — `npm audit
  // --json` prints `{"message": "...", "error": {...}}` and exits non-zero
  // when the registry is unreachable, a proxy/auth step fails, or an
  // offline runner has no network at all — must not read as "no
  // advisories". A clean audit always carries `vulnerabilities`, even as an
  // empty object; its absence means the audit itself did not happen, so
  // this fails closed the same way an unparseable payload already does
  // above, rather than letting the scan job go green having examined
  // nothing (the one outcome T4.3.16 forbids).
  if (report.vulnerabilities === undefined) {
    // CONV-3: enough to fix the cause without reading this file.
    const npmMessage =
      report.message !== undefined ? `npm's own message: ${report.message}. ` : '';
    throw new Error(
      `'npm audit --json' output did not carry a 'vulnerabilities' list, which ` +
        `means the audit itself did not run (registry unreachable, a proxy or ` +
        `auth failure, or an offline runner) rather than that nothing was found. ` +
        npmMessage +
        `First 200 characters of what was given: ${raw.slice(0, 200)}`,
    );
  }

  const advisories: Advisory[] = [];
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === 'string') {
        continue;
      }
      const severity = via.severity ?? vuln.severity ?? 'low';
      if (!meetsSeverity(severity, minSeverity)) {
        continue;
      }
      const ghsa = via.url === undefined ? undefined : GHSA_PATTERN.exec(via.url)?.[0];
      const id =
        ghsa ?? (via.source !== undefined ? String(via.source) : via.title) ?? pkg;
      advisories.push({ id, package: pkg, severity, title: via.title ?? id });
    }
  }
  return advisories;
}

/** What {@link classifyAudit} decided about one set of advisories. */
export interface AuditClassification {
  /** True when at least one advisory is this branch's to own. */
  readonly blocked: boolean;
  /** Advisories this branch is the author of — block the merge. */
  readonly authored: readonly Advisory[];
  /** Advisories the trunk already carries, unrelated to this branch — do not block it. */
  readonly drift: readonly Advisory[];
  readonly summary: string;
}

export interface ClassifyAuditInput {
  /**
   * Whether this branch's own diff touches `package.json` or
   * `package-lock.json`, against the trunk it is about to merge into.
   *
   * True here switches off the exemption entirely, not just for the
   * package the diff names (CONV-4, fail closed): editing the manifest is
   * exactly the diff that can introduce a dependency finding, so once it has
   * happened nothing on this audit gets to claim it is merely inheriting the
   * trunk's problem. There is no partial exemption to widen.
   */
  readonly manifestChanged: boolean;
  /** What `npm audit` reports against this branch's resolved tree. */
  readonly current: readonly Advisory[];
  /**
   * What `npm audit` reports against the trunk's resolved tree, read fresh
   * at comparison time (`scripts/audit-drift.mjs`), never from a file this
   * branch's own diff could have edited.
   *
   * The commit this is read from is the fork point between `HEAD` and
   * `origin/main` — a hardcoded constant in that script, `TRUNK_REF`, not
   * read from `process.env` — found with `git merge-base` and then checked
   * to be contained in `origin/main`'s own history. That containment check
   * is what actually stops a branch widening its own exemption: review
   * (T4.3.16) found that a plain "is it an ancestor of `HEAD`" check is not
   * enough, because every commit on this branch already is one, so an
   * `AUDIT_BASE_REF` pointing at an earlier commit on the same branch passed
   * it trivially. A branch's own commit, by contrast, is never reachable
   * from the trunk it branched off, so it can never satisfy containment —
   * that is the property nothing in a pull request's diff can forge.
   */
  readonly trunk: readonly Advisory[];
}

function advisoryKey(advisory: Advisory): string {
  return `${advisory.id} ${advisory.package}`;
}

/**
 * Decide which advisories this branch owns and which are the trunk's
 * already, hence not this branch's to be blocked by.
 *
 * Pure: given the same two advisory sets and the same manifest-changed flag,
 * this always returns the same classification, so the decision can be tested
 * without a registry, a git checkout, or `npm audit` anywhere nearby.
 */
export function classifyAudit(input: ClassifyAuditInput): AuditClassification {
  const trunkKeys = new Set(input.trunk.map(advisoryKey));
  const authored: Advisory[] = [];
  const drift: Advisory[] = [];
  for (const advisory of input.current) {
    if (!input.manifestChanged && trunkKeys.has(advisoryKey(advisory))) {
      drift.push(advisory);
    } else {
      authored.push(advisory);
    }
  }
  return {
    blocked: authored.length > 0,
    authored,
    drift,
    summary: summarize(authored, drift),
  };
}

function summarize(authored: readonly Advisory[], drift: readonly Advisory[]): string {
  if (authored.length === 0 && drift.length === 0) {
    return 'no advisories at or above the floor';
  }
  const parts: string[] = [];
  if (authored.length > 0) {
    parts.push(
      `${String(authored.length)} advisor${authored.length === 1 ? 'y' : 'ies'} this branch is the author of (blocking)`,
    );
  }
  if (drift.length > 0) {
    parts.push(
      `${String(drift.length)} drift advisor${drift.length === 1 ? 'y' : 'ies'} already on the trunk (not blocking)`,
    );
  }
  return parts.join('; ');
}

/** One line per blocking advisory, naming it and the package it is against. */
export function authoredReasons(classification: AuditClassification): string[] {
  return classification.authored.map(
    (a) => `${a.id} (${a.package}, ${a.severity}): ${a.title}`,
  );
}

/**
 * One line per drift advisory — named, and explicit that this branch is not
 * its author, which is the whole point of the distinction (T4.3.16): read
 * back later without this module, the line still says why nothing blocked.
 */
export function driftReasons(classification: AuditClassification): string[] {
  return classification.drift.map(
    (a) =>
      `${a.id} (${a.package}, ${a.severity}) is already on the trunk — this branch is not its author`,
  );
}
