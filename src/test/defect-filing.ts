import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import type { AdversarialCaseResult, AdversarialVerdict } from './adversarial.js';
import {
  defectSchema,
  fileDefect,
  regressDefect,
  retestDefect,
  type Defect,
  type DefectSeverity,
  type FileDefectOptions,
} from './defect.js';
import type { NfrCoverageRow } from './nfr.js';

/**
 * Turns what TST-4's suite and TST-3's NFR measurement actually found into
 * filed `Defect` artifacts (T4.3.4).
 *
 * This is where that code lives, and deliberately not inside
 * `src/test/defect.ts`: that module's own doc says filing is agnostic to
 * where evidence comes from, and reading a producer's own shape — an
 * `AdversarialCaseResult`, an `NfrCoverageRow` — is exactly the opposite,
 * something specific to each producer. Nor does it live behind a playbook
 * node's `produces`: a `suite`/`nfr` step writes exactly one declared
 * artifact at one fixed `basePath` (`writeArtifact`, `src/phase/runner.ts`),
 * and a fan-out's own workers get no `produces` at all — only its collect
 * step does (`src/playbook/graph.ts`). A verdict with seven failing cases
 * needs seven `Defect` artifacts, not one `adversarial-verdict` row further
 * inflated, and seven versions written under one declared id would collapse
 * to whichever the store's `latestPerId` (`src/state/escaped-defect-rate.ts`)
 * happened to read last. So `src/phase/runner.ts` calls the functions below
 * directly, once per failure, and writes each straight to the store at a
 * `basePath` this module derives from the finding's own id — outside
 * `step.produces` entirely, under `artifacts/defect/`, which is the one path
 * `mpgm status --rates` reads a filed defect back from (`src/cli/commands.ts`,
 * `src/dashboard/server.ts`) — that path existing is not the same claim as
 * "so filing here feeds the escaped-defect rate", and it does not, on two
 * separate counts that a run of `phases/test.yaml` hits every time:
 *
 * First, `computeEscapedDefectRate` (`src/state/escaped-defect-rate.ts`)
 * divides by the run's own `ChangeMerged` events, and a Test phase run
 * files defects but merges nothing — it emits none. The rate for that run
 * reads `null` regardless of what got filed; it only becomes readable for a
 * run that both merges a task and files a defect against it, and the merge
 * has to be datable at all (T4.2.7) before "did the merge precede the
 * filing" can be answered.
 *
 * Second, even once some other run's merges give the division a denominator,
 * every defect this module files is itself undated, permanently, by how it
 * is filed rather than by anything about that later run. `filedAt`
 * (`escaped-defect-rate.ts`) dates a filing from a `TaskCompleted` — either
 * one whose `artifactRefs` names the artifact, or, failing that, one whose
 * `taskId`/`runId` match the lowest version's own `producedBy`. `nfr`/`suite`
 * steps are kernel steps: `src/phase/runner.ts` calls `runNfrSuite`/
 * `runAdversarialSuite` directly and never calls `SessionRunner.runTask`.
 * The three call sites that do append a `TaskCompleted` in this codebase all
 * name something else: `SessionRunner.runTask` names the dispatched task
 * (`src/agent/runner.ts`), `chat` names the fixed `elicit` task
 * (`src/cli/commands.ts`), and the demo workload names its own fixture ids
 * (`src/demo/workload.ts`). No `TaskCompleted` ever names a step id an
 * `nfr`/`suite` step uses, by either route, so a defect filed here is exactly the
 * "step that writes an artifact but runs no session at all" case
 * `escaped-defect-rate.ts`'s own doc already names as `undated`'s live
 * example (alongside a panel's tally) — not a new case this task adds, and
 * not one this task closes either. It stays `undated` however the defect is
 * later routed: nothing in `src/test/defect.ts`'s round trip appends a
 * `TaskCompleted` either, and neither does the operator verb that routes it
 * (`mpgm defect`, `src/cli/commands.ts` — this module's closing section).
 *
 * Both producers hand back less than `fileDefect` needs, and this module
 * supplies the rest rather than assuming either one grows a field it does not
 * have:
 *
 * - **`severity` and `title`.** Neither `AdversarialCaseResult` nor
 *   `NfrCoverageRow` carries either — there is nothing to pass through, only
 *   something to decide. `title` is built here, from fields both shapes
 *   already guarantee non-empty (`about`, `id`), so it is never itself the
 *   reason a filing throws. `severity` cannot be built the same way — nothing
 *   in either producer says how badly a given failure matters — so it is
 *   taken as a parameter every function below requires, which
 *   `src/phase/runner.ts` in turn takes as `PhaseRunOptions.defectSeverity`
 *   and refuses to run an `nfr`/`suite` step without (mirroring
 *   `testProjectDir`'s own "a decision, not a default"): a value this module
 *   invented on its own — 'high' because a failure sounds bad, say — would be
 *   exactly the "assumed" this task's own criteria rule out.
 * - **A non-empty evidence `detail`.** `defectEvidenceSchema` requires one;
 *   `AdversarialExecution.detail` and `nfrRunOutput.evidence` are both
 *   allowed to come back `''` (a runner that gives no diagnostics, a
 *   provider with no report to link). Passing either straight through would
 *   make `fileDefect` throw `DefectDataError` on exactly the run that found
 *   something to file — the worst possible run for filing to fail on. Each
 *   function below falls back to a detail that is guaranteed non-empty by a
 *   *different* field's own schema: the case's own `defect` account (`.min(1)`
 *   on `adversarialCaseSchema`) for an adversarial failure, and the measured
 *   value alongside a stated absence of evidence for a below-threshold NFR
 *   row (`measured` is always set by `nfrCoverage` on that branch).
 */

const ADVERSARIAL_EVIDENCE_KIND = 'adversarial';
const NFR_EVIDENCE_KIND = 'nfr';

/**
 * Characters a defect id may be built from.
 *
 * The id becomes a path (`artifacts/defect/<id>.md`), and neither producer's
 * own id is constrained tightly enough to be trusted with one: an
 * `AdversarialCaseResult.id` is whatever the `adversarial-tester` role
 * returned (`.min(1)`, nothing more), and an `NfrCoverageRow.id` is whatever
 * the upstream Scope listed. A case id of `../../.mpgm/state` would otherwise
 * be a filing that writes outside the store. Refused rather than sanitised
 * (CONV-4): a silently rewritten id no longer matches the case a re-test
 * reruns, so two different findings could collapse onto one artifact.
 */
const DEFECT_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Raised when a finding's own id cannot be made into a defect artifact id (CONV-3, CONV-4). */
export class DefectIdError extends Error {}

function safeSegment(kind: string, value: string): string {
  if (!DEFECT_ID_SEGMENT.test(value) || value.includes('..')) {
    throw new DefectIdError(
      `cannot file a defect for ${kind} '${value}': a defect is written to ` +
        `artifacts/defect/<id>.md, so its id must be letters, digits, '.', '_' or ` +
        `'-' (starting with a letter or digit) and must not contain '..'. Fix the ` +
        `id at its source — the suite's own case id, or the requirement id in Scope ` +
        `— rather than here: a rewritten id no longer names the case a re-test reruns.`,
    );
  }
  return value;
}

/** `artifacts/defect/<id>.md` for a failed adversarial case, stable across reruns of the same case so a repeat failure versions the same artifact rather than filing a fresh one. */
export function adversarialDefectId(caseId: string): string {
  return `defect-adversarial-${safeSegment('adversarial case', caseId)}`;
}

/** `artifacts/defect/<id>.md` for a below-threshold quantified NFR, keyed the same stable way. */
export function nfrDefectId(requirementId: string): string {
  return `defect-nfr-${safeSegment('quantified NFR', requirementId)}`;
}

/**
 * `FileDefectOptions` for one failed adversarial case (module doc above).
 *
 * `row.outcome` is not checked here — a caller passes only failed rows
 * (`defectsFromAdversarialVerdict` below does exactly that), and asking this
 * function to re-derive "is this actually a failure" from a result that
 * already answered the question is a second copy of `adversarialVerdict`'s
 * own judgement to keep in sync with it.
 */
export function adversarialDefectOptions(
  row: AdversarialCaseResult,
  severity: DefectSeverity,
): FileDefectOptions {
  const detail = row.detail.trim() !== '' ? row.detail : row.defect;
  return {
    title: `Adversarial case '${row.id}' failed: ${row.about}`,
    severity,
    description: row.defect,
    evidence: { kind: ADVERSARIAL_EVIDENCE_KIND, caseId: row.id, detail },
    tracesTo: row.tracesTo,
  };
}

/**
 * `FileDefectOptions` for one below-threshold quantified NFR row (module doc
 * above).
 *
 * `row.id` is the NFR's own requirement id (`NfrCoverageRow.id`,
 * `src/test/nfr.ts`) and is what `tracesTo` names — the one producer of the
 * two that already carried a requirement id before this task.
 */
export function nfrDefectOptions(
  row: NfrCoverageRow,
  severity: DefectSeverity,
): FileDefectOptions {
  const measuredText =
    row.measured === undefined
      ? 'no measurement was recorded'
      : `measured ${String(row.measured)}`;
  const evidence = row.evidence?.trim();
  const detail =
    evidence !== undefined && evidence !== ''
      ? evidence
      : `${measuredText}; the provider supplied no evidence text`;
  return {
    title: `Quantified NFR '${row.id}' is below its Scope threshold`,
    severity,
    description: `test.nfr reported '${row.id}' below threshold (${measuredText}).`,
    evidence: { kind: NFR_EVIDENCE_KIND, caseId: row.id, detail },
    tracesTo: [row.id],
  };
}

/** One finding a phase step is about to file: the artifact id it will be written under, and the options `fileDefect` takes. */
export interface DefectToFile {
  readonly id: string;
  readonly file: FileDefectOptions;
}

/**
 * Every failed case in `verdict`, as `DefectToFile` entries (T4.3.4).
 *
 * Only `verdict.defects` — `notReported` cases are neither a pass nor a
 * caught defect (`adversarialVerdict`'s own doc), and filing one as though a
 * case had actually run and failed would misreport what happened.
 */
export function defectsFromAdversarialVerdict(
  verdict: AdversarialVerdict,
  severity: DefectSeverity,
): readonly DefectToFile[] {
  return verdict.defects.map((row) => ({
    id: adversarialDefectId(row.id),
    file: adversarialDefectOptions(row, severity),
  }));
}

/**
 * Every below-threshold row in `rows`, as `DefectToFile` entries (T4.3.4).
 *
 * Only `problem === 'below-threshold'` — a `'not-run'` row is TST-3's own gap
 * (nothing measured it), not a measurement that came back failing, and is not
 * this module's finding to file.
 */
export function defectsFromNfrCoverage(
  rows: readonly NfrCoverageRow[],
  severity: DefectSeverity,
): readonly DefectToFile[] {
  return rows
    .filter(
      (row): row is NfrCoverageRow & { problem: 'below-threshold' } =>
        row.problem === 'below-threshold',
    )
    .map((row) => ({ id: nfrDefectId(row.id), file: nfrDefectOptions(row, severity) }));
}

export interface FiledDefectRecord {
  readonly artifact: Artifact;
  readonly defect: Defect;
}

/**
 * File `options` (TST-5's first obligation) and write it straight to the
 * store at `artifacts/defect/<id>.md`, outside any playbook node's
 * `produces` (module doc above).
 *
 * A rerun of the same case or requirement reuses `id`, so a still-`open`
 * defect versions forward (`ArtifactStore.write` always writes the next
 * version) rather than filing a second, unrelated-looking defect for what is
 * really the same finding recurring. Once the defect has moved past `open`,
 * though, `id` alone is no longer enough to decide what a rerun means:
 *
 * - **`fix-pending`.** A route and a fix are already on record, and the case
 *   or row failed again against them — the fix did not hold. This is exactly
 *   {@link retestDefect}'s failing branch, so that is what runs, moving the
 *   defect to `reopened` rather than discarding the route and fix underneath
 *   it. `options.evidence.detail` — guaranteed non-empty by
 *   `defectEvidenceSchema` — becomes the re-test's own `detail`.
 * - **`verified`.** The defect closed on a fix that held, and the same case
 *   or row is failing again: a regression of exactly the behaviour this
 *   defect covers. {@link regressDefect} moves it to `reopened`, carrying the
 *   route and fix that regressed. Leaving it alone would be the worse of the
 *   two failures this function can have, because `verified` is the one status
 *   `blocksGate` (`src/test/defect.ts`) treats as not blocking: a Test gate
 *   would read "no open defects" over a case that failed on this very run,
 *   and the run would have no Defect artifact for that failure at all.
 * - **`routed` or `reopened`.** Neither is a status {@link retestDefect}
 *   accepts (only `fix-pending` is), and neither is a regression:
 *   `routed` has no fix yet to have failed, and `reopened` already records
 *   this same failure. Both already block the gate, so nothing is hidden by
 *   leaving them as they are — and writing a fresh `fileDefect` result over
 *   either would silently reset the defect to `open`, discarding whatever
 *   route and fix already got recorded, precisely the edge-skip the lifecycle
 *   union in `src/test/defect.ts` exists to make unrepresentable (module doc
 *   there). So this function leaves the existing version untouched and hands
 *   it back instead of writing anything.
 */
export function fileAndWriteDefect(
  artifacts: ArtifactStore,
  id: string,
  options: FileDefectOptions,
  producedBy: Provenance,
): FiledDefectRecord {
  const basePath = `artifacts/defect/${id}.md`;
  const latest = artifacts.latestVersion(basePath);
  if (latest > 0) {
    const existingArtifact = artifacts.read(basePath, latest);
    const parsedExisting = defectSchema.safeParse(existingArtifact.data);
    if (parsedExisting.success && parsedExisting.data.status !== 'open') {
      const existingDefect = parsedExisting.data;
      if (
        existingDefect.status === 'fix-pending' ||
        existingDefect.status === 'verified'
      ) {
        const reopened =
          existingDefect.status === 'fix-pending'
            ? retestDefect(existingDefect, {
                passed: false,
                detail: options.evidence.detail,
              })
            : regressDefect(existingDefect, options.evidence.detail);
        const artifact = artifacts.write({
          id,
          basePath,
          schema: 'defect',
          data: reopened,
          producedBy,
          tracesTo: reopened.tracesTo,
        });
        return { artifact, defect: reopened };
      }
      return { artifact: existingArtifact, defect: existingDefect };
    }
  }

  const defect = fileDefect(options);
  const artifact = artifacts.write({
    id,
    basePath,
    schema: 'defect',
    data: defect,
    producedBy,
    tracesTo: options.tracesTo,
  });
  return { artifact, defect };
}

/** One case or row that passed this run, and the defect id its pass would close. */
export interface DefectToVerify {
  readonly id: string;
  /** What passed, in the run's own words — becomes the re-test's `detail`. */
  readonly detail: string;
}

/**
 * Every passing case in `verdict`, as the defect ids a re-test would close
 * (T4.3.4).
 *
 * `verdict.rows` filtered to `passed`, not `notReported`: the kernel refuses
 * to read silence as a pass anywhere else (`AdversarialOutcome`'s own doc),
 * and reading it as one here would close a defect on a case that did not run.
 */
export function defectsToVerifyFromAdversarialVerdict(
  verdict: AdversarialVerdict,
): readonly DefectToVerify[] {
  return verdict.rows
    .filter((row) => row.outcome === 'passed')
    .map((row) => ({
      id: adversarialDefectId(row.id),
      detail: `adversarial case '${row.id}' passed on re-run`,
    }));
}

/** Every verified row in `rows`, as the defect ids a re-test would close (T4.3.4). */
export function defectsToVerifyFromNfrCoverage(
  rows: readonly NfrCoverageRow[],
): readonly DefectToVerify[] {
  return rows
    .filter((row) => row.verified)
    .map((row) => ({
      id: nfrDefectId(row.id),
      detail:
        row.measured === undefined
          ? `quantified NFR '${row.id}' met its threshold on re-run`
          : `quantified NFR '${row.id}' met its threshold on re-run (measured ${String(row.measured)})`,
    }));
}

/**
 * Close a `fix-pending` defect whose evidence passed this run (TST-5's
 * second obligation, T4.3.4).
 *
 * This is the half of the round trip the phase can decide on its own, and the
 * reason there is no operator verb for it: {@link retestDefect}'s passing
 * branch is a *result*, not a judgement — the same case id that caught the
 * defect ran again against the recorded fix and passed. An operator marking a
 * defect `verified` by assertion would be exactly the out-of-band close TST-5
 * refuses, while the suite that caught it is right there and can be re-run.
 *
 * Returns `undefined` — writing nothing — for every other state, because none
 * of them is a re-test:
 *
 * - **no defect filed under `id`.** The usual case: a case that passes and
 *   never failed has nothing to close.
 * - **`open` or `routed`.** No fix is on record, so a pass is not evidence
 *   that anything was fixed; it is the same finding not reproducing, which
 *   {@link retestDefect} has no branch for and this function will not invent
 *   one for. The defect stays where it is, blocking the gate, until something
 *   is routed and fixed.
 * - **`reopened`.** The fix on record already failed once; the defect is
 *   waiting to be routed again, and the fix it would be re-tested against
 *   does not exist yet.
 * - **`verified`.** Already closed. A passing run leaves it exactly as it is
 *   (a failing one reopens it — {@link fileAndWriteDefect}).
 */
export function verifyFixedDefect(
  artifacts: ArtifactStore,
  id: string,
  detail: string,
  producedBy: Provenance,
): FiledDefectRecord | undefined {
  const basePath = `artifacts/defect/${id}.md`;
  const latest = artifacts.latestVersion(basePath);
  if (latest === 0) {
    return undefined;
  }

  const parsed = defectSchema.safeParse(artifacts.read(basePath, latest).data);
  if (!parsed.success || parsed.data.status !== 'fix-pending') {
    return undefined;
  }

  const verified = retestDefect(parsed.data, { passed: true, detail });
  const artifact = artifacts.write({
    id,
    basePath,
    schema: 'defect',
    data: verified,
    producedBy,
    tracesTo: verified.tracesTo,
  });
  return { artifact, defect: verified };
}

/**
 * Who routes a filed defect, and on what evidence.
 *
 * **The operator, through `mpgm defect route <id>` (`defect`,
 * `src/cli/commands.ts`).** Not a role and not an inference: `routeDefect`
 * (`src/test/defect.ts`) needs the judgement call "does this invalidate a
 * design assumption, or is it a bug in the implementation", and ORC-1 puts
 * that with a person, the same class of decision as `mpgm approve` and
 * `mpgm reopen`. The evidence it is decided on is the filed artifact's own,
 * which that verb prints before it writes anything: severity, title, the
 * requirement ids in `tracesTo`, the suite kind and case id that caught it,
 * and the finder's `detail` — everything {@link fileDefect} recorded, which
 * is why filing supplies each of those rather than leaving one empty.
 *
 * That divides TST-5's round trip in two, and the division is the point:
 *
 * - **The kernel files and re-tests.** A `suite`/`nfr` step files what it
 *   found ({@link fileAndWriteDefect}), reopens a defect whose case is
 *   failing again — whether the fix never held (`fix-pending`) or held and
 *   then regressed (`verified`) — and closes a `fix-pending` one whose case
 *   now passes ({@link verifyFixedDefect}). None of those is a judgement: each
 *   is the same case id, re-run, reported by the same executor.
 * - **The operator routes and records the fix.** `mpgm defect route` decides
 *   where it goes; `mpgm defect fix` names the ref the route produced. Both
 *   are decisions a run cannot make for itself — which task owns the fix, and
 *   which commit is the fix.
 *
 * There is deliberately no verb that marks a defect `verified`: closing one
 * is a re-test result, and a verdict asserted by hand over a suite that could
 * simply be re-run is the out-of-band close TST-5 exists to refuse.
 */
