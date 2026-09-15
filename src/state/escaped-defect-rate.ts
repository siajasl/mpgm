import type { Artifact } from '../artifact/store.js';
import type { StoredEvent } from '../event/envelope.js';
import type { Defect } from '../test/defect.js';

/**
 * The escaped-defect rate, per run (OBS-4, T4.2.2b).
 *
 * Read from the Defect artifacts themselves (`src/test/defect.ts`), through
 * the artifact store — the event catalog has no defect event and this module
 * adds none (TST-5's artifacts are the record; the log only ever points at
 * them). A Defect history entry carries no date of its own, so the only
 * dating available for "when was this filed" is the `TaskCompleted` event
 * whose `artifactRefs` names the artifact, and the only dating for "when did
 * the task its route names merge" is that task's own `ChangeMerged` — both
 * read off the event's own `ts` (`StoredEvent.ts`), which is the whole of
 * what this module has to work with.
 *
 * A defect is **escaped** when the `ChangeMerged` for the task its route
 * names precedes the `TaskCompleted` that filed it: the change had already
 * merged, so whatever the defect found got past every gate before Test caught
 * it. A defect whose route names a task that merges *afterwards* is the fix
 * landing, not a second escape — `defect.ts`'s own doc says as much:
 * `implement` routing "names the plan task the fix lands under", which may be
 * an existing task taking rework (already merged — an escape) or a fresh one
 * added to hold the fix (not merged yet at filing time — not one). Counting
 * the second case would make the rate climb every time a defect closed, which
 * is exactly backwards.
 *
 * The denominator is the tasks that merged, not the defects filed — a run
 * that merges one task and finds one escaped defect against it reads 100%,
 * the same as a run that merges ten tasks and finds ten; scaling the
 * denominator by how many defects happened to be filed would let a run hide
 * a high per-merge escape rate behind a low filing rate. A defect still
 * `open` carries no route and so names no task at all — it cannot be placed
 * on either side of that division, and is reported beside the rate as
 * {@link EscapedDefectRate.unrouted} instead, so a run with five of those
 * does not read as a run with none. A `design`-routed defect names a phase,
 * not a task (`DefectRoute`'s `design` branch has no `taskId`), so it is
 * exactly as unattributable here and counted the same way.
 *
 * Attribution matters because the run that found a defect and the run that
 * merged the task its route names can differ — a defect filed this run
 * against a task an earlier run merged is a live example. This module
 * attributes an **escaped** defect to the run that merged the task (the run
 * whose merge is what escaped), read from that `ChangeMerged`'s own
 * `runId`, and an **unrouted** defect — which names no task and so has no
 * merge to attribute to — to the run that found it, `producedBy.runId` on
 * the artifact itself. Each is the only run-membership fact that defect's
 * data actually carries.
 *
 * `filed` counts every Defect artifact handed in, regardless of run or
 * status — the repository-wide signal that anything has ever gone through
 * `fileDefect` at all. It exists because `escaped / merged` alone cannot
 * tell "zero of five defects filed against this run's merges escaped" apart
 * from "nothing has ever been filed": both read `0` over a positive
 * denominator. `rate` is null in either case, the same reading `null`
 * already carries elsewhere in this codebase — nothing decided or measured
 * yet — rather than the `0%` that would read as a clean run.
 */
export interface EscapedDefectRate {
  readonly runId: string;
  /** `ChangeMerged` events this run produced — the rate's denominator. */
  readonly merged: number;
  /** Escaped defects attributed to this run (see module doc for which run that is). */
  readonly escaped: number;
  /** `escaped / merged`. Null when nothing has merged yet, or nothing has ever been filed. */
  readonly rate: number | null;
  /** Total Defect artifacts read, any run, any status — zero here is what makes a null `rate` read as "unfiled" rather than "clean". */
  readonly filed: number;
  /**
   * Defects attributed to this run that name no task — still `open`, or
   * routed to `design` — and so cannot be placed on either side of the rate.
   */
  readonly unrouted: number;
}

interface ArtifactRefLike {
  readonly id?: string;
  readonly path: string;
  readonly version?: number;
}

interface TaskCompletedPayload {
  readonly taskId: string;
  readonly artifactRefs: readonly ArtifactRefLike[];
}

interface ChangeMergedPayload {
  readonly taskId: string;
}

/** The task id a defect's route names, or undefined when it names none (`defect.ts`'s `open` and `design` cases). */
function namedTask(defect: Defect): string | undefined {
  if (defect.status === 'open') {
    return undefined;
  }
  return defect.route.to === 'implement' ? defect.route.taskId : undefined;
}

/** Whether `ref` — one entry of a `TaskCompleted.artifactRefs` — names `artifact`. */
function refersTo(ref: ArtifactRefLike, artifact: Artifact): boolean {
  return ref.id === artifact.id && ref.version === artifact.version;
}

/**
 * The escaped-defect rate for `runId` (OBS-4, T4.2.2b).
 *
 * `events` should cover every run, not just `runId`'s own — the task a
 * defect's route names may have merged under a different run than the one
 * that filed the defect (see module doc), and only a cross-run view can find
 * that `ChangeMerged`. Every case below still checks `runId`/`event.runId`
 * itself, so a caller handing in the whole log gets exactly this run's
 * figures back, the same latitude `computeGateRates` (`./gate-rates.ts`)
 * already takes.
 *
 * `defects` is every Defect artifact the caller has read from the artifact
 * store (e.g. `ArtifactStore.list('artifacts/defect')`) — not pre-filtered to
 * this run, for the same cross-run reason.
 */
export function computeEscapedDefectRate(
  runId: string,
  events: readonly StoredEvent[],
  defects: readonly Artifact[] = [],
): EscapedDefectRate {
  const changeMerged = events.filter(
    (event): event is StoredEvent<ChangeMergedPayload> => event.type === 'ChangeMerged',
  );
  const taskCompleted = events.filter(
    (event): event is StoredEvent<TaskCompletedPayload> => event.type === 'TaskCompleted',
  );

  const merged = changeMerged.filter((event) => event.runId === runId).length;

  let escaped = 0;
  let unrouted = 0;

  for (const artifact of defects) {
    if (artifact.schema !== 'defect') {
      continue;
    }
    const defect = artifact.data as Defect;
    const taskId = namedTask(defect);

    if (taskId === undefined) {
      if (artifact.producedBy.runId === runId) {
        unrouted += 1;
      }
      continue;
    }

    const merge = changeMerged.find((event) => event.payload.taskId === taskId);
    if (merge === undefined) {
      // The named task has not merged in what `events` covers — nothing to
      // date the "precedes" comparison against yet.
      continue;
    }

    const filed = taskCompleted.find((event) =>
      event.payload.artifactRefs.some((ref) => refersTo(ref, artifact)),
    );
    if (filed === undefined) {
      // No TaskCompleted names this artifact — the only dating this module
      // has (module doc) — so neither side of "precedes" is known.
      continue;
    }

    if (merge.ts >= filed.ts) {
      // The named task merged at or after the defect was filed: the fix
      // landing, not a defect that escaped past an earlier merge.
      continue;
    }

    if (merge.runId === runId) {
      escaped += 1;
    }
  }

  return {
    runId,
    merged,
    escaped,
    rate: merged === 0 || defects.length === 0 ? null : escaped / merged,
    filed: defects.length,
    unrouted,
  };
}
