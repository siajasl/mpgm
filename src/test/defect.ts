import { z } from 'zod';
import type { ReopenRequest } from '../gate/reopen.js';

/**
 * Defect artifacts and routing (TST-5, ADR-3, ORC-1).
 *
 * TST-5 draws a line this module exists to enforce structurally rather than
 * by convention: a defect found in the Test phase is **filed as an
 * artifact, traced to requirements, and routed back through Implement (or
 * Design, per ORC-1) — never patched out-of-band**. "Never patched
 * out-of-band" is the operative phrase — a fix that shows up without a
 * defect behind it is exactly the failure mode TST-5 exists to rule out, and
 * the cheapest place to rule it out is the shape of the data (CONV-5): a
 * {@link Defect} cannot become `verified` without first being `routed` and
 * having a `fix` recorded, because the zod union below has no branch that
 * skips either step. What {@link routeDefect}, {@link recordFix} and
 * {@link retestDefect} do is walk that union forward one edge at a time, and
 * refuse (CONV-4) any call that would skip one.
 *
 * Where a defect comes from is deliberately out of this module's business —
 * {@link fileDefect} takes an {@link DefectEvidence}, and the two producers
 * already in this codebase both hand it exactly what it needs: a failed
 * {@link AdversarialCaseResult} (`src/test/adversarial.ts`) carries the
 * tester's own `defect` account of what failing means, and a
 * below-threshold {@link NfrCoverageRow} (`src/test/nfr.ts`) carries a
 * measurement and its evidence. Either reads straight into `evidence`
 * without this module needing to know which kind of suite caught it.
 *
 * `tracesTo` is required and non-empty for the same CONV-5 reason ART-2 makes
 * every design element carry one: a defect that names no requirement gives
 * whichever phase it is routed to nothing to check the fix against, and
 * would sit outside the trace graph TST-2 reads for coverage. It rides the
 * generic artifact-link walk ({@link extractArtifactLinks},
 * `src/trace/links.ts`) unchanged — a `tracesTo` array on an artifact's own
 * `data` is read as citations from the artifact itself, so a Defect artifact
 * needs no special case there. A `verified` defect additionally declares
 * `verifies: tracesTo` (same walk, `verifies` rather than `traces-to`) —
 * once a fix has been retested and held, the defect *is* evidence the
 * requirement holds, the same distinction TST-2 draws between a citation and
 * a check.
 *
 * Routing itself is left to whoever files or triages the defect: judging
 * "does this invalidate a design assumption" is exactly the kind of call
 * ORC-1 hands to a person or an agent, not something this module infers from
 * the evidence. What it does provide is {@link designReopenRequest}, which
 * turns a `design`-routed defect straight into the {@link ReopenRequest}
 * shape `planReopen`/`reopenPhase` (`src/gate/reopen.ts`) already consume —
 * so a Design-routed defect reopens over exactly the ids it named, not a
 * fresh guess at what changed.
 */

/**
 * REQUIREMENTS' Test-phase gate reads "no open critical/high defects" — the
 * two severities that block it. `medium`/`low` are tracked the same way but
 * do not, on their own, hold the gate shut.
 */
export const defectSeverities = ['critical', 'high', 'medium', 'low'] as const;

export type DefectSeverity = (typeof defectSeverities)[number];

/**
 * What caught the defect, in the finder's own words (CONV-3) — a defect
 * report that says only "assertion failed" makes whoever reads it re-derive
 * why the case existed.
 */
export const defectEvidenceSchema = z.object({
  /** The suite or contract that caught it, e.g. `'adversarial'`, `'nfr'`. */
  kind: z.string().min(1),
  /**
   * The case/requirement id within that suite — an adversarial case id, or a
   * quantified NFR's requirement id. What a re-test reruns.
   */
  caseId: z.string().min(1),
  /** What was seen: an assertion message, a measurement, a stack. */
  detail: z.string().min(1),
});

export type DefectEvidence = z.infer<typeof defectEvidenceSchema>;

/**
 * Where TST-5 sends a defect. `implement` names the plan task the fix lands
 * under — an existing task taking rework, or a new one added within its
 * milestone (PLN-4's autonomous case). `design` names the phase to reopen
 * and the ids whose content the defect calls into question — the same
 * `changed` set {@link ReopenRequest} takes, because a Design reopen that
 * cannot say what changed is a Design reopen that invalidates everything
 * (ORC-6).
 */
export const defectRouteSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('implement'), taskId: z.string().min(1) }),
  z.object({
    to: z.literal('design'),
    phase: z.string().min(1),
    changed: z.array(z.string().min(1)).min(1),
  }),
]);

export type DefectRoute = z.infer<typeof defectRouteSchema>;

/**
 * What the round trip produced: a commit sha for an Implement fix, or the
 * artifact node (`id@version`) a Design reopen landed on for a Design one —
 * whichever ref the route in fact took, recorded so a re-test can be
 * attributed to it.
 */
export const defectFixSchema = z.object({
  ref: z.string().min(1),
  summary: z.string().min(1),
});

export type DefectFix = z.infer<typeof defectFixSchema>;

export const defectStatuses = [
  'open',
  'routed',
  'fix-pending',
  'reopened',
  'verified',
] as const;

export type DefectStatus = (typeof defectStatuses)[number];

const defectHistoryEntrySchema = z.object({
  status: z.enum(defectStatuses),
  detail: z.string().min(1),
});

/** One entry in a defect's history — append-only, mirroring the quarantine
 * ledger (`src/test/quarantine.ts`) and the kernel's own event log: a
 * transition is added, never edited, so a defect's account of itself stays
 * legible after the fact rather than only while current. */
export type DefectHistoryEntry = z.infer<typeof defectHistoryEntrySchema>;

const defectCommon = {
  title: z.string().min(1),
  severity: z.enum(defectSeverities),
  description: z.string().min(1),
  evidence: defectEvidenceSchema,
  tracesTo: z.array(z.string().min(1)).min(1),
  /** Fix/re-test round trips this defect has been through — 0 until the
   * first one comes back failing. */
  attempts: z.number().int().nonnegative(),
  history: z.array(defectHistoryEntrySchema).min(1),
};

/**
 * The Defect artifact (TST-5).
 *
 * A discriminated union on `status` rather than one shape with optional
 * `route`/`fix` fields, so that "routed with no route" or "verified with no
 * fix" is not a state the type system lets through (CONV-5) — each is
 * unrepresentable rather than merely unchecked. `verified` additionally
 * carries `verifies`, always equal to `tracesTo` at the moment a re-test held
 * (set by {@link retestDefect}, never supplied directly): a defect
 * conjecturing it verifies a requirement it never traced to would be a claim
 * this module has no evidence for.
 */
export const defectSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open'), ...defectCommon }),
  z.object({ status: z.literal('routed'), ...defectCommon, route: defectRouteSchema }),
  z.object({
    status: z.literal('fix-pending'),
    ...defectCommon,
    route: defectRouteSchema,
    fix: defectFixSchema,
  }),
  z.object({
    status: z.literal('reopened'),
    ...defectCommon,
    route: defectRouteSchema,
    fix: defectFixSchema,
  }),
  z.object({
    status: z.literal('verified'),
    ...defectCommon,
    route: defectRouteSchema,
    fix: defectFixSchema,
    verifies: z.array(z.string().min(1)).min(1),
  }),
]);

export type Defect = z.infer<typeof defectSchema>;

/** Raised when a defect transition is asked to run from a status it does not
 * support (CONV-4) — the fail-closed twin of the schema's CONV-5 guarantee:
 * where the union cannot rule a call out by shape, the function does. */
export class DefectLifecycleError extends Error {
  readonly action: string;
  readonly from: DefectStatus;
  readonly allowed: readonly DefectStatus[];

  constructor(action: string, from: DefectStatus, allowed: readonly DefectStatus[]) {
    super(
      `cannot ${action} a defect whose status is '${from}'. Allowed from: ` +
        `${allowed.join(', ')}. TST-5's round trip moves one step at a time — ` +
        `skipping from '${from}' straight to this step is exactly the ` +
        `out-of-band patch TST-5 refuses.`,
    );
    this.name = 'DefectLifecycleError';
    this.action = action;
    this.from = from;
    this.allowed = allowed;
  }
}

/** Raised when a constructed defect fails its own schema (CONV-3, mirrors
 * `ArtifactSchemaRegistry.validate`). Every transition below builds through
 * this rather than trusting its own object literal, so a mistake inside this
 * module surfaces the same way a malformed agent output would. */
export class DefectDataError extends Error {}

function build(candidate: unknown): Defect {
  const result = defectSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new DefectDataError(`defect data is invalid: ${issues}`);
  }
  return result.data;
}

/** The fields every status carries, read off whichever branch `defect` is. */
function commonFieldsOf(defect: Defect): {
  title: string;
  severity: DefectSeverity;
  description: string;
  evidence: DefectEvidence;
  tracesTo: readonly string[];
} {
  return {
    title: defect.title,
    severity: defect.severity,
    description: defect.description,
    evidence: defect.evidence,
    tracesTo: defect.tracesTo,
  };
}

export interface FileDefectOptions {
  readonly title: string;
  readonly severity: DefectSeverity;
  /** What was seen, in the filer's own words (CONV-3). */
  readonly description: string;
  readonly evidence: DefectEvidence;
  /** Requirement ids this defect calls into question (TST-5, ART-2). */
  readonly tracesTo: readonly string[];
}

/**
 * File a defect (TST-5's first obligation): `open`, unrouted, with a history
 * of one entry recording why it was filed.
 */
export function fileDefect(options: FileDefectOptions): Defect {
  return build({
    status: 'open',
    title: options.title,
    severity: options.severity,
    description: options.description,
    evidence: options.evidence,
    tracesTo: [...options.tracesTo],
    attempts: 0,
    history: [{ status: 'open', detail: options.description }],
  });
}

/**
 * Route a filed (or reopened) defect back through Implement or Design
 * (TST-5, ORC-1).
 *
 * Only from `open` or `reopened` — a defect already `routed` has a route on
 * record, and this is not how it changes (there is no re-route; a wrong
 * route is a fresh finding for whoever owns the target to send back, the same
 * way a merge refusal is not silently reinterpreted). `reason` is required
 * for the same audit reason {@link reopenPhase} (`src/gate/reopen.ts`)
 * requires one: routing costs a phase or a task's worth of work, and an
 * unexplained one is not a record anyone can act on later (HIL-5).
 */
export function routeDefect(defect: Defect, route: DefectRoute, reason: string): Defect {
  if (defect.status !== 'open' && defect.status !== 'reopened') {
    throw new DefectLifecycleError('route', defect.status, ['open', 'reopened']);
  }
  if (reason.trim() === '') {
    throw new DefectDataError(
      'routing a defect must say why (CONV-3, mirrors GateError)',
    );
  }

  return build({
    ...commonFieldsOf(defect),
    attempts: defect.attempts,
    status: 'routed',
    route,
    history: [...defect.history, { status: 'routed', detail: reason }],
  });
}

/**
 * Record the fix a routed defect's target produced.
 *
 * Only from `routed` — recording a fix for a defect nothing has routed yet
 * would be exactly the out-of-band patch TST-5 refuses: a change that shows
 * up with no defect record saying where it was sent.
 */
export function recordFix(defect: Defect, fix: DefectFix): Defect {
  if (defect.status !== 'routed') {
    throw new DefectLifecycleError('record a fix for', defect.status, ['routed']);
  }

  return build({
    ...commonFieldsOf(defect),
    attempts: defect.attempts,
    status: 'fix-pending',
    route: defect.route,
    fix,
    history: [...defect.history, { status: 'fix-pending', detail: fix.summary }],
  });
}

export interface RetestResult {
  /** Whether the same evidence (`defect.evidence.caseId`) passed this time. */
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Re-test a fix-pending defect against the same evidence that caught it
 * (TST-5's second obligation, and the reason the round trip is a round trip
 * rather than a straight line).
 *
 * A held fix closes the defect: `verified`, with `verifies` set to exactly
 * the requirements this defect traced to — a re-test is what turns a
 * citation into a check (TST-2's distinction, `src/trace/links.ts`). A fix
 * that did not hold reopens it instead of discarding it: `attempts`
 * increments, the route and fix that did not work stay on record as the
 * newest history entry, and the defect is back in a status
 * {@link routeDefect} accepts — ready to be routed again, by the same path
 * or a different one, rather than silently dropped.
 */
export function retestDefect(defect: Defect, result: RetestResult): Defect {
  if (defect.status !== 'fix-pending') {
    throw new DefectLifecycleError('retest', defect.status, ['fix-pending']);
  }

  if (result.passed) {
    return build({
      ...commonFieldsOf(defect),
      attempts: defect.attempts,
      status: 'verified',
      route: defect.route,
      fix: defect.fix,
      verifies: defect.tracesTo,
      history: [...defect.history, { status: 'verified', detail: result.detail }],
    });
  }

  return build({
    ...commonFieldsOf(defect),
    attempts: defect.attempts + 1,
    status: 'reopened',
    route: defect.route,
    fix: defect.fix,
    history: [...defect.history, { status: 'reopened', detail: result.detail }],
  });
}

/**
 * Defects the Test gate refuses to pass while any remain open (REQUIREMENTS:
 * "no open critical/high defects"). `verified` is the only status TST-5's
 * round trip ends at, so anything else — including a `reopened` one still
 * mid-round-trip — counts as open here.
 */
export function blocksGate(defects: readonly Defect[]): readonly Defect[] {
  return defects.filter(
    (defect) =>
      defect.status !== 'verified' &&
      (defect.severity === 'critical' || defect.severity === 'high'),
  );
}

export interface DesignReopenRequestOptions {
  readonly runId: string;
  /** Why the reopen is happening — becomes `ReopenRequest.reason`. */
  readonly reason: string;
}

/**
 * Turn a `design`-routed defect into the {@link ReopenRequest} `planReopen`/
 * `reopenPhase` (`src/gate/reopen.ts`) consume — ORC-1's "or Design, per
 * ORC-1" half of TST-5, cashed out as the same request shape a phase reopen
 * always takes rather than a parallel mechanism this module would have to
 * keep in sync with that one.
 *
 * Refuses a defect not routed to `design` at all — routing to Implement and
 * asking for a Design reopen request is a caller error, not something to
 * silently reinterpret as "reopen anyway".
 */
export function designReopenRequest(
  defect: Defect,
  options: DesignReopenRequestOptions,
): ReopenRequest {
  if (defect.status === 'open') {
    throw new DefectLifecycleError('build a design reopen request for', defect.status, [
      'routed',
      'fix-pending',
      'reopened',
      'verified',
    ]);
  }
  if (defect.route.to !== 'design') {
    throw new DefectDataError(
      `defect is routed to '${defect.route.to}', not 'design' — a reopen request ` +
        `can only be built for a defect ORC-1 actually sent to Design`,
    );
  }

  return {
    runId: options.runId,
    phase: defect.route.phase,
    reason: options.reason,
    changed: defect.route.changed,
  };
}
