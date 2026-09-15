import type { Artifact } from '../artifact/store.js';
import type { StoredEvent } from '../event/envelope.js';
import { defectSchema, type Defect } from '../test/defect.js';

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
 *
 * `defects` is every artifact *version* the caller's `ArtifactStore.list`
 * returned, and a Defect artifact accrues one version per lifecycle
 * transition — `fileDefect` writes v1, `routeDefect` v2, `recordFix` v3,
 * `retestDefect` v4. Counting each version as its own defect would report a
 * single verified defect as `filed: 4`, and could credit the same escape to
 * `escaped` up to three times over (v2 routed, v3 fix-pending and v4 verified
 * all name the same task). This module reduces `defects` to one record per
 * artifact `id` — the highest `version` — before counting anything, so every
 * figure below is over defects, never over the versions a defect happened to
 * pass through. `filed` and `rate`'s null test are computed from that same
 * reduced, schema-validated set, not from `defects.length` — an artifact
 * under `artifacts/defect/` that is not a Defect (wrong `schema`, or one that
 * fails {@link defectSchema}) is excluded from both, exactly as it is
 * excluded from `escaped` and `unrouted`, rather than inflating `filed` while
 * every other figure skips it.
 *
 * A routed defect whose named task has merged but for which no
 * `TaskCompleted` names the artifact cannot be dated at all — neither
 * escaped nor a fix, because "precedes" has nothing to compare. Dropping it
 * silently would let it vanish into a confident-looking rate; instead it is
 * reported as {@link EscapedDefectRate.undated}, on the run that merged the
 * task, the same way `unrouted` surfaces defects this module can place on
 * neither side of the division rather than absorbing them into it. In this
 * repository's own log `undated` reads as "every routed defect" today:
 * `SessionRunner` (`src/agent/runner.ts`), the only production emitter of
 * `TaskCompleted` on the task path, emits `artifactRefs: []`, so nothing
 * currently populates the one field this dating depends on — the
 * escaped-defect rate is measurable only once something does.
 */
export interface EscapedDefectRate {
  readonly runId: string;
  /** `ChangeMerged` events this run produced — the rate's denominator. */
  readonly merged: number;
  /** Escaped defects attributed to this run (see module doc for which run that is). */
  readonly escaped: number;
  /** `escaped / merged`. Null when nothing has merged yet, or nothing has ever been filed. */
  readonly rate: number | null;
  /**
   * Distinct Defect artifacts read, any run, any status — one entry per
   * artifact `id` (its latest version), not per version on disk — zero here
   * is what makes a null `rate` read as "unfiled" rather than "clean".
   */
  readonly filed: number;
  /**
   * Defects attributed to this run that name no task — still `open`, or
   * routed to `design` — and so cannot be placed on either side of the rate.
   */
  readonly unrouted: number;
  /**
   * Defects attributed to this run (by the merged task their route names)
   * whose named task merged but which no `TaskCompleted` names — the only
   * dating this module has (module doc), and so a defect this module could
   * not place on either side of the rate rather than one it decided against.
   */
  readonly undated: number;
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

/** An artifact schema-validated as a {@link Defect} — the pairing this module
 * counts everything through, so a non-defect or malformed artifact under
 * `artifacts/defect/` cannot reach `filed`, `escaped` or `unrouted` any way
 * an artifact that does belong there can (CONV-5): there is no runtime flag
 * to check and no cast to trust, only artifacts that already are one. */
interface DefectRecord {
  readonly artifact: Artifact;
  readonly defect: Defect;
}

/**
 * `artifacts` narrowed to the ones that parse as a {@link Defect}, paired
 * with their parsed data. An artifact whose `schema` is not `'defect'`, or
 * whose `data` fails {@link defectSchema}, is excluded here rather than
 * merely skipped inside the counting loop — so nothing downstream can count
 * it by accident the way `defects.length` once did.
 */
function parseDefects(artifacts: readonly Artifact[]): readonly DefectRecord[] {
  const records: DefectRecord[] = [];
  for (const artifact of artifacts) {
    if (artifact.schema !== 'defect') {
      continue;
    }
    const parsed = defectSchema.safeParse(artifact.data);
    if (!parsed.success) {
      continue;
    }
    records.push({ artifact, defect: parsed.data });
  }
  return records;
}

/**
 * `records` reduced to the highest `version` per artifact `id`.
 *
 * A Defect artifact gains one version per lifecycle transition — filing,
 * routing, a recorded fix, a re-test verdict all write a successor rather
 * than editing in place (ART-1) — so `ArtifactStore.list` hands back every
 * version a single defect ever held. The highest version is the defect's
 * current state; the rest are history the lifecycle already folded forward,
 * and counting them again would count one defect as several.
 */
function latestPerId(records: readonly DefectRecord[]): readonly DefectRecord[] {
  const latest = new Map<string, DefectRecord>();
  for (const record of records) {
    const current = latest.get(record.artifact.id);
    if (current === undefined || record.artifact.version > current.artifact.version) {
      latest.set(record.artifact.id, record);
    }
  }
  return [...latest.values()];
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

  const records = latestPerId(parseDefects(defects));

  let escaped = 0;
  let unrouted = 0;
  let undated = 0;

  for (const { artifact, defect } of records) {
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
      // has (module doc) — so neither side of "precedes" is known. Reported
      // rather than dropped: see `undated` on the interface.
      if (merge.runId === runId) {
        undated += 1;
      }
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
    rate: merged === 0 || records.length === 0 ? null : escaped / merged,
    filed: records.length,
    unrouted,
    undated,
  };
}
