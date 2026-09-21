import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import type { AdversarialCaseResult, AdversarialVerdict } from './adversarial.js';
import {
  fileDefect,
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
 * `mpgm status --rates` already reads a filed defect back from
 * (`src/cli/commands.ts`, `src/dashboard/server.ts`).
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
 * A rerun of the same case or requirement reuses `id`, so the store versions
 * the same artifact (`ArtifactStore.write` always writes the next version)
 * rather than filing a second, unrelated-looking defect for what is really
 * the same finding recurring.
 */
export function fileAndWriteDefect(
  artifacts: ArtifactStore,
  id: string,
  options: FileDefectOptions,
  producedBy: Provenance,
): FiledDefectRecord {
  const defect = fileDefect(options);
  const artifact = artifacts.write({
    id,
    basePath: `artifacts/defect/${id}.md`,
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
 * module produces `open` defects only; the caller that decides `implement`
 * vs. `design` and calls `routeDefect` is either an operator (the same class
 * of call as `mpgm approve`/`mpgm reopen`) or a future triage role reading
 * the filed artifact, and either way it runs after this one, over the
 * artifact this one already wrote — never inside it.
 */
