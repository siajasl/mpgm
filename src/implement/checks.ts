import { z } from 'zod';
import type { ContractSpec } from '../contract/capability.js';

/**
 * The `ci.checks` capability (DESIGN §4.7, IMP-2, SAF-5).
 *
 * The kernel treats CI as an oracle: it does not run builds, it asks. What it
 * owns is the *decision* — whether what CI reported is enough to merge — and
 * that decision is made here, from data, with no model involved.
 *
 * The rule the whole file exists to enforce: **absence is not success.** A
 * required check that never ran, was skipped, or is still running blocks the
 * merge exactly as a failing one does. The dangerous version of this component
 * is the one that merges because it found nothing wrong.
 */

/** The checks IMP-2 requires before any merge. `scan` is SAF-5. */
export const CHECK_KINDS = ['build', 'lint', 'typecheck', 'test', 'scan'] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

export const checkKindSchema = z.enum(CHECK_KINDS);

/**
 * Every kind must pass before a merge (IMP-2). Exposed as a constant rather
 * than as configuration: a project that can switch off its own security scan
 * has a merge gate in name only.
 */
export const REQUIRED_CHECK_KINDS: readonly CheckKind[] = CHECK_KINDS;

export const checkRunSchema = z.object({
  /** The check's name as CI reports it, e.g. `test (node 24.x)`. */
  name: z.string().min(1),
  status: z.enum(['queued', 'in_progress', 'completed']),
  /**
   * Null while the check is still running. `neutral` and `skipped` are results
   * that are neither pass nor fail — a skipped scan is not a scan — so they
   * satisfy nothing.
   */
  conclusion: z
    .enum([
      'success',
      'failure',
      'neutral',
      'cancelled',
      'timed_out',
      'action_required',
      'skipped',
      'stale',
    ])
    .nullable(),
  url: z.string().default(''),
});

export type CheckRun = z.infer<typeof checkRunSchema>;

/**
 * Which check names cover which kinds.
 *
 * The mapping, not the contract, is what knows how a project's CI is laid out
 * — that is what lets the same kernel code sit in front of a workflow whose
 * jobs are named after the kinds and one whose single job does everything
 * (EXT-2/3). `pattern` is an anchored regular expression over the check name.
 */
export const checkMappingSchema = z.object({
  pattern: z.string().min(1),
  covers: z.array(checkKindSchema).min(1),
});

export type CheckMapping = z.infer<typeof checkMappingSchema>;

/**
 * The mapping for a workflow whose jobs are named after the kinds — which is
 * how mpgm's own CI is laid out, and the arrangement worth defaulting to,
 * since it makes the workflow say out loud which obligation each job serves.
 */
export const DEFAULT_CHECK_MAPPING: readonly CheckMapping[] = [
  { pattern: '^build\\b', covers: ['build'] },
  { pattern: '^lint\\b', covers: ['lint'] },
  { pattern: '^typecheck\\b', covers: ['typecheck'] },
  { pattern: '^test\\b', covers: ['test'] },
  { pattern: '^scan\\b', covers: ['scan'] },
];

function covers(
  mapping: readonly CheckMapping[],
  run: CheckRun,
  kind: CheckKind,
): boolean {
  return mapping.some(
    (entry) => entry.covers.includes(kind) && new RegExp(entry.pattern).test(run.name),
  );
}

export function passed(run: CheckRun): boolean {
  return run.status === 'completed' && run.conclusion === 'success';
}

export function failed(run: CheckRun): boolean {
  return (
    run.status === 'completed' &&
    run.conclusion !== null &&
    ['failure', 'cancelled', 'timed_out', 'action_required', 'stale'].includes(
      run.conclusion,
    )
  );
}

export function pending(run: CheckRun): boolean {
  return run.status !== 'completed';
}

/** Why a required kind is not satisfied. */
export type KindProblem = 'failing' | 'pending' | 'uncovered';

export interface KindVerdict {
  readonly kind: CheckKind;
  readonly satisfied: boolean;
  readonly problem?: KindProblem;
  /** The runs consulted, so a report can name them. */
  readonly runs: readonly string[];
}

export interface MergeVerdict {
  readonly ref: string;
  readonly mergeable: boolean;
  readonly kinds: readonly KindVerdict[];
  /** Names of every run that concluded badly, required or not. */
  readonly failing: readonly string[];
  readonly summary: string;
}

export interface MergeVerdictInput {
  readonly ref: string;
  readonly runs: readonly CheckRun[];
  readonly mapping?: readonly CheckMapping[];
  readonly required?: readonly CheckKind[];
}

/**
 * Decide whether a ref may merge.
 *
 * Pure. Given the same reported checks it always returns the same verdict,
 * which is what lets the decision be replayed from the log rather than
 * re-asked of CI (ORC-3).
 */
export function mergeVerdict(input: MergeVerdictInput): MergeVerdict {
  const mapping = input.mapping ?? DEFAULT_CHECK_MAPPING;
  const required = input.required ?? REQUIRED_CHECK_KINDS;
  const failing = input.runs.filter(failed).map((run) => run.name);

  const kinds = required.map<KindVerdict>((kind) => {
    const covering = input.runs.filter((run) => covers(mapping, run, kind));
    const names = covering.map((run) => run.name);
    if (covering.some(failed)) {
      return { kind, satisfied: false, problem: 'failing', runs: names };
    }
    if (covering.some(pending)) {
      return { kind, satisfied: false, problem: 'pending', runs: names };
    }
    if (covering.some(passed)) {
      return { kind, satisfied: true, runs: names };
    }
    // Nothing covering it produced a result: either no check claims this kind,
    // or the ones that do were skipped. Both mean nobody checked.
    return { kind, satisfied: false, problem: 'uncovered', runs: names };
  });

  const unsatisfied = kinds.filter((verdict) => !verdict.satisfied);
  // A failing check nobody mapped still blocks. It is red, and merging over a
  // red check because the mapping did not mention it is how a gate becomes
  // decorative.
  const mergeable = unsatisfied.length === 0 && failing.length === 0;

  return {
    ref: input.ref,
    mergeable,
    kinds,
    failing,
    summary: summarize(mergeable, unsatisfied, failing),
  };
}

function summarize(
  mergeable: boolean,
  unsatisfied: readonly KindVerdict[],
  failing: readonly string[],
): string {
  if (mergeable) {
    return 'all required checks passed';
  }
  const parts: string[] = [];
  for (const problem of ['failing', 'pending', 'uncovered'] as const) {
    const kinds = unsatisfied
      .filter((verdict) => verdict.problem === problem)
      .map((verdict) => verdict.kind);
    if (kinds.length > 0) {
      parts.push(`${problem}: ${kinds.join(', ')}`);
    }
  }
  const unmapped = failing.filter((name) =>
    unsatisfied.every((verdict) => !verdict.runs.includes(name)),
  );
  if (unmapped.length > 0) {
    parts.push(`other failing checks: ${unmapped.join(', ')}`);
  }
  return parts.join('; ');
}

/** Reasons a merge was refused, one line each, for the log and the operator. */
export function blockingReasons(verdict: MergeVerdict): string[] {
  const reasons = verdict.kinds
    .filter((kind) => !kind.satisfied)
    .map((kind) =>
      kind.problem === 'uncovered'
        ? `${kind.kind}: no check reported a result`
        : `${kind.kind}: ${String(kind.problem)}${kind.runs.length > 0 ? ` (${kind.runs.join(', ')})` : ''}`,
    );
  for (const name of verdict.failing) {
    if (!verdict.kinds.some((kind) => !kind.satisfied && kind.runs.includes(name))) {
      reasons.push(`${name}: failing`);
    }
  }
  return reasons;
}

export class MergeBlockedError extends Error {
  readonly verdict: MergeVerdict;

  constructor(verdict: MergeVerdict) {
    super(
      `merge of ${verdict.ref} blocked by CI (IMP-2): ${blockingReasons(verdict).join('; ')}`,
    );
    this.verdict = verdict;
  }
}

/**
 * Refuse to go on unless every required check passed.
 *
 * Callers that want to decide for themselves read {@link mergeVerdict}; this
 * exists so the merge path cannot be written as an `if` somebody later
 * inverts.
 */
export function requireMergeable(verdict: MergeVerdict): void {
  if (!verdict.mergeable) {
    throw new MergeBlockedError(verdict);
  }
}

export const checksStatusInput = z.object({
  /** `owner/repo`. */
  repo: z.string().min(1),
  /** Commit sha, branch or tag whose checks are wanted. */
  ref: z.string().min(1),
});

export const checksStatusOutput = z.object({
  ref: z.string().min(1),
  runs: z.array(checkRunSchema),
});

/**
 * The contract specification. `contracts/ci.checks.md` is the prose half;
 * this is the half the kernel validates against.
 */
export const ciChecksContract: ContractSpec = {
  name: 'ci.checks',
  summary: 'Report the merge checks a provider has run for a ref (IMP-2, SAF-5).',
  operations: [
    {
      name: 'status',
      summary: 'Every check run reported for the ref, however it concluded.',
      input: checksStatusInput,
      output: checksStatusOutput,
      // Asking costs nothing and changes nothing, so no intent needs recording
      // before it (DESIGN §6).
      effects: 'read-only',
    },
  ],
};
