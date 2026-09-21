import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import type { AdversarialCaseResult, AdversarialVerdict } from './adversarial.js';
import {
  defectSchema,
  fileDefect,
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
 * `runAdversarialSuite` directly and never calls `SessionRunner.runTask`,
 * which is the only call site in this codebase that appends `TaskCompleted`
 * at all (`src/agent/runner.ts`). No `TaskCompleted` ever names a step id
 * these steps use, by either route, so a defect filed here is exactly the
 * "step that writes an artifact but runs no session at all" case
 * `escaped-defect-rate.ts`'s own doc already names as `undated`'s live
 * example (alongside a panel's tally) — not a new case this task adds, and
 * not one this task closes either. It stays `undated` however the defect is
 * later routed: nothing in `src/test/defect.ts`'s round trip appends a
 * `TaskCompleted` either (module doc's closing section — routing is left to
 * a caller this codebase does not yet have).
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

/** `artifacts/defect/<id>.md` for a failed adversarial case, stable across reruns of the same case so a repeat failure versions the same artifact rather than filing a fresh one. */
export function adversarialDefectId(caseId: string): string {
  return `defect-adversarial-${caseId}`;
}

/** `artifacts/defect/<id>.md` for a below-threshold quantified NFR, keyed the same stable way. */
export function nfrDefectId(requirementId: string): string {
  return `defect-nfr-${requirementId}`;
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
 * - **`routed`, `reopened` or `verified`.** None of these is a status
 *   {@link retestDefect} accepts (only `fix-pending` is), and there is
 *   nothing else in `src/test/defect.ts`'s lifecycle that means "still
 *   failing" from here: `routed` has no fix yet to have failed, `reopened`
 *   already records this same failure, and `verified` closed on a fix this
 *   function was never asked to re-open. Writing a fresh `fileDefect` result
 *   over any of them would silently reset the defect to `open`, discarding
 *   whatever route and fix already got recorded — precisely the edge-skip
 *   the lifecycle union in `src/test/defect.ts` exists to make
 *   unrepresentable (module doc there). So this function leaves the existing
 *   version untouched and hands it back instead of writing anything.
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
      if (existingDefect.status === 'fix-pending') {
        const reopened = retestDefect(existingDefect, {
          passed: false,
          detail: options.evidence.detail,
        });
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

/**
 * Where a filed defect goes from here is deliberately not this module's job.
 *
 * `routeDefect` (`src/test/defect.ts`) needs a judgement call — "does this
 * invalidate a design assumption" — that ORC-1 hands to a person or an agent,
 * never to an inference over the evidence this module just filed. This
 * module only ever produces `open` or `reopened` defects — `reopened` when a
 * rerun finds the same case or row still failing against a route and fix
 * already on record (`fileAndWriteDefect`'s own doc above) — and never
 * decides where either goes next; the caller that decides `implement`
 * vs. `design` and calls `routeDefect` is either an operator (the same class
 * of call as `mpgm approve`/`mpgm reopen`) or a future triage role reading
 * the filed artifact, and either way it runs after this one, over the
 * artifact this one already wrote — never inside it.
 */
