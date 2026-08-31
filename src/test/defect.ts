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
 * needs no special case there. Deliberately as `traces-to` only, never
 * `verifies`: `TraceIndexStore.coverage()` (`src/trace/index-store.ts`) marks
 * a requirement verified the moment *anything* holds a `verifies` link to it,
 * with no notion of which suite that link came from or whether the same
 * check still runs on the next commit. A closed defect is exactly the wrong
 * shape for that — the round trip proves a `caseId` held once, at re-test
 * time, not that a requirement now has an ongoing check — so a `verified`
 * Defect emits nothing `extractArtifactLinks` would read as `verifies`. A
 * requirement is verified by a test the graph can point to, not by a defect
 * against it having been closed; that is TST-2's own "by which tests" and it
 * is what the Test gate's "all Must-have requirements verified" reads.
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
 * and, where the filer can say so, the ids whose content the defect calls
 * into question — the same optional `changed` set {@link ReopenRequest}
 * takes. `changed` is left optional here for the reason it is optional
 * there: an operator who cannot say what changed has said that anything
 * might have (ORC-6's safe default), and a defect filer forced to guess a
 * `changed` set to satisfy this schema would produce a narrower cascade than
 * that default on a too-narrow guess — worse than the unstated case it was
 * trying to avoid. Stated non-empty, once given, is still required: a filer
 * who names some ids and forgets one is a mistake this schema cannot catch,
 * but naming zero when the field is present at all is caught here.
 */
export const defectRouteSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('implement'), taskId: z.string().min(1) }),
  z.object({
    to: z.literal('design'),
    phase: z.string().min(1),
    changed: z.array(z.string().min(1)).min(1).optional(),
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
  /**
   * The fix ref this entry concerns, where one exists — set by
   * {@link recordFix} and carried forward by {@link retestDefect} on both
   * branches. `routed` and `open` never carry the current `fix` field
   * (routing to a fresh route is not a fix), so without this a re-route of a
   * `reopened` defect would strand the failed attempt's ref nowhere the
   * defect itself still holds it. History is append-only and never trimmed,
   * so once written here it outlives however many times the top-level `fix`
   * field gets replaced.
   */
  ref: z.string().min(1).optional(),
  /**
   * The route this entry concerns, where one exists — set by
   * {@link routeDefect} on the `routed` entry it writes (the route just
   * chosen), and carried forward by {@link retestDefect} onto the `reopened`
   * entry it writes when a fix does not hold (the route that failed). The
   * same loss `ref` above exists to prevent, one field over: `routed` is the
   * only status whose branch carries a `route` at the top level next to
   * `open`, so once a `reopened` defect is routed again the new route
   * overwrites the old one there, and without this field the superseded
   * route would survive nowhere but whatever the free-text `detail` of the
   * next `routed` entry happens to say.
   */
  route: defectRouteSchema.optional(),
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
  /** Failed fix/re-test round trips this defect has been through — 0 until
   * the first one comes back failing, so a defect verified on its first
   * re-test reports 0 here. Named for what it counts (rework, not total
   * round trips) rather than for the round trip TST-5 describes, so a reader
   * summing this across a batch of defects gets "how much re-work this
   * caused" and not an undercount of "how many times this was retested". */
  failedAttempts: z.number().int().nonnegative(),
  history: z.array(defectHistoryEntrySchema).min(1),
};

/**
 * The Defect artifact (TST-5).
 *
 * A discriminated union on `status` rather than one shape with optional
 * `route`/`fix` fields, so that "routed with no route" or "verified with no
 * fix" is not a state the type system lets through (CONV-5) — each is
 * unrepresentable rather than merely unchecked. `verified` carries no
 * `verifies` field: see this module's top-of-file doc for why a closed
 * defect must not be readable as requirement-verification evidence.
 *
 * The union alone constrains `route`/`fix` presence, not `history` — nothing
 * about the branch shapes stops a hand-built or on-disk `verified` defect
 * whose `history` array stops at `open`, an out-of-band patch's own record of
 * itself (CONV-5's obligation applies to history exactly as much as it does
 * to `route`/`fix`, and history is not a field the union's branches can reach
 * into). The `superRefine` below is the check that closes that: an
 * append-only history is only a truthful record of "how did this defect get
 * here" if it actually ends where `status` says the defect now is.
 */
export const defectSchema = z
  .discriminatedUnion('status', [
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
    }),
  ])
  .superRefine((defect, ctx) => {
    const last = defect.history[defect.history.length - 1];
    if (last !== undefined && last.status !== defect.status) {
      ctx.addIssue({
        code: 'custom',
        path: ['history'],
        message:
          `a defect's history must end with an entry matching its own status: ` +
          `status is '${defect.status}' but the last history entry is ` +
          `'${last.status}'. An append-only history that stops short of the status ` +
          `it claims is not a record of how the defect got there (CONV-5) — it is a ` +
          `hole an out-of-band change could sit in unnoticed.`,
      });
    }
  });

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
    failedAttempts: 0,
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
    failedAttempts: defect.failedAttempts,
    status: 'routed',
    route,
    history: [...defect.history, { status: 'routed', detail: reason, route }],
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
    failedAttempts: defect.failedAttempts,
    status: 'fix-pending',
    route: defect.route,
    fix,
    history: [
      ...defect.history,
      { status: 'fix-pending', detail: fix.summary, ref: fix.ref },
    ],
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
 * A held fix closes the defect: `verified`. It carries no `verifies` link
 * (module doc above) — the round trip is TST-5's "traced to requirements,
 * routed, fixed" obligation, not a claim that a requirement now has an
 * ongoing test the graph can point to. A fix that did not hold reopens it
 * instead of discarding it: `failedAttempts` increments, and the route and
 * fix that did not work stay on record as the newest history entry — `ref`
 * and `route` both included, so neither the failed attempt's ref nor the
 * route it was tried under is lost even once {@link routeDefect} moves the
 * defect on to `routed`, a status whose own `route`/`fix` fields hold only
 * whatever comes next — and the defect is back in a status
 * {@link routeDefect} accepts, ready to be routed again, by the same path or
 * a different one, rather than silently dropped.
 */
export function retestDefect(defect: Defect, result: RetestResult): Defect {
  if (defect.status !== 'fix-pending') {
    throw new DefectLifecycleError('retest', defect.status, ['fix-pending']);
  }

  if (result.passed) {
    return build({
      ...commonFieldsOf(defect),
      failedAttempts: defect.failedAttempts,
      status: 'verified',
      route: defect.route,
      fix: defect.fix,
      history: [
        ...defect.history,
        { status: 'verified', detail: result.detail, ref: defect.fix.ref },
      ],
    });
  }

  return build({
    ...commonFieldsOf(defect),
    failedAttempts: defect.failedAttempts + 1,
    status: 'reopened',
    route: defect.route,
    fix: defect.fix,
    history: [
      ...defect.history,
      {
        status: 'reopened',
        detail: result.detail,
        ref: defect.fix.ref,
        route: defect.route,
      },
    ],
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
 * silently reinterpret as "reopen anyway". Refuses an empty `reason` for the
 * same audit reason {@link routeDefect} does — {@link reopenPhase}
 * (`src/gate/reopen.ts`) would refuse it too, but not until the request has
 * already been built and handed onward, which is a call this function can
 * settle immediately instead of deferring to a caller two modules away.
 *
 * `changed` passes through exactly as the route named it, `undefined`
 * included: an unstated `changed` here becomes an unstated `changed` on the
 * {@link ReopenRequest}, which `reopenPhase` already reads as "the whole of
 * what the reopened phase's gate approved" (ORC-6) rather than a set this
 * function would have to invent.
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
  if (options.reason.trim() === '') {
    throw new DefectDataError(
      'a design reopen request must say why (CONV-3, mirrors routeDefect and GateError)',
    );
  }

  return {
    runId: options.runId,
    phase: defect.route.phase,
    reason: options.reason,
    // Omitted, not set to `undefined` — `exactOptionalPropertyTypes` and
    // `ReopenRequest.changed`'s own doc both treat "absent" and "present but
    // undefined" as different things, and it is the former this function
    // means to pass through.
    ...(defect.route.changed !== undefined ? { changed: defect.route.changed } : {}),
  };
}
