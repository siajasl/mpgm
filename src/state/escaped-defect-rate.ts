import type { Artifact } from '../artifact/store.js';
import type { StoredEvent } from '../event/envelope.js';
import { defectSchema, type Defect } from '../test/defect.js';

/**
 * The escaped-defect rate, per run (OBS-4, T4.2.2b).
 *
 * Read from the Defect artifacts themselves (`src/test/defect.ts`), through
 * the artifact store — the event catalog has no defect event and this module
 * adds none (TST-5's artifacts are the record; the log only ever points at
 * them). A Defect history entry carries no date of its own, so "when did the
 * task its route names merge" is dated from that task's own `ChangeMerged`
 * — or `ChangeMergedByOperator` (T4.2.15), read identically here; see
 * `computeEscapedDefectRate`'s own comment for what recording one late does
 * to this dating — and "when was this filed" is dated primarily from the `TaskCompleted`
 * event whose `artifactRefs` names the artifact — both read off the event's
 * own `ts` (`StoredEvent.ts`).
 *
 * "When was this filed" is dated from the *earliest* `TaskCompleted` that
 * names the artifact's `id` in `artifactRefs`, at any version — not from
 * whichever `TaskCompleted` happens to name the version this module reduced
 * the defect to (`latestPerId`). The lifecycle writes one version per
 * transition (`filed`'s doc below), so for any defect that has been routed
 * — the only defects that can escape at all — the current version is never
 * the one `fileDefect` wrote, and a `TaskCompleted` naming a later version
 * is some later transition's own completion, not the filing. Filing is
 * always the earliest mention of the id, whichever version it names.
 *
 * When no `TaskCompleted` names the artifact that way at all, a fallback
 * takes over: the *lowest*-version Defect record for that id names, in its
 * own `producedBy.task`, the task that wrote it — `fileDefect`'s task, since
 * filing is always the first transition (immediately above) — and that
 * task's own `TaskCompleted` dates the filing just as well, `artifactRefs`
 * or no. Not the *latest* version's provenance: after `latestPerId` reduces
 * to one record per id, the surviving version's `producedBy.task` is
 * whichever transition wrote it last — `routeDefect`'s or `retestDefect`'s
 * task, for a routed or verified defect — and that task completes *after*
 * the merge this module compares it against, which would flip a fix landing
 * into a false escape.
 *
 * The task id the fallback matches is a phase *step* id (`src/phase/runner.ts`
 * stamps `producedBy.task: step.id`), which is not unique across a whole log:
 * the same step id completes once per invocation of that phase, and one run
 * id can cover many invocations over the run's lifetime (T4.2.9). So the
 * fallback also requires the match to sit in the same run as the artifact's
 * `producedBy.runId` — the run that actually wrote this version — not merely
 * the same task id wherever in the log it turns up; a `TaskCompleted` for the
 * same step id under a different run is a different invocation entirely, and
 * can predate the artifact by weeks. And within that one run, the step id is
 * still only unique if it completed once: if it completed more than once,
 * nothing here says *which* of those completions wrote this version, so the
 * fallback finds none rather than guessing — the same `undated` reading as no
 * match at all (`filedAt`'s own doc).
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
 * A routed defect whose named task has merged but which neither `filed by
 * artifactRefs` nor the `producedBy.task` fallback above can date cannot be
 * dated at all — neither escaped nor a fix, because "precedes" has nothing to
 * compare. Dropping it silently would let it vanish into a confident-looking
 * rate; instead it is reported as {@link EscapedDefectRate.undated}, on the
 * run that merged the task, the same way `unrouted` surfaces defects this
 * module can place on neither side of the division rather than absorbing
 * them into it.
 *
 * A task still running is not what reaches this: a step's artifact is
 * written before that step's own `TaskCompleted` is appended (`SessionRunner`
 * calls back into the artifact store at the point its output validates,
 * `src/agent/runner.ts`, T4.2.7), so the artifact never post-dates the event
 * that names it. What does reach it is a step that writes an artifact but
 * runs no session at all — a panel's tally, the one place `src/playbook/graph.ts`
 * gives a step a `produces` outside a session step, written by
 * `src/phase/runner.ts` and followed by `VoteTallied`, never `TaskCompleted`.
 * A Defect artifact a tally produced would be datable by neither route: no
 * `TaskCompleted.artifactRefs` names it, and `producedBy.task` names a task id
 * no `TaskCompleted` was ever appended for either. That is `undated`'s live
 * case, not a hypothetical one.
 *
 * `phases/test.yaml` (T4.3.3) now runs `nfr`/`suite` steps that call
 * `fileDefect` (T4.3.4, `src/test/defect-filing.ts`, `src/phase/runner.ts`),
 * so this repository's own log can carry real Defect artifacts. That does
 * not make this module's rate measurable for a run that only ran Test,
 * though, on two separate counts `src/test/defect-filing.ts`'s own module
 * doc states in full: a Test phase run files defects but merges nothing, so
 * `merged` — and with it `rate` — reads `0`/`null` for that run regardless of
 * what got filed; and every defect an `nfr`/`suite` step files is `undated`
 * by construction, because those are kernel steps that never call
 * `SessionRunner.runTask` — the only call site that appends `TaskCompleted`
 * at all (`src/agent/runner.ts`) — so neither `filedAt` route above ever
 * finds one to date the filing with. That is this module's own `undated`
 * case (module doc above), not a hypothetical one and not one T4.3.4 closes.
 * T4.2.7 makes `TaskCompleted.artifactRefs` and the `producedBy.task`
 * fallback both *measurable*; a defect filed by a kernel step that never
 * dispatches at all is outside what either can reach.
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

/**
 * Whether `ref` — one entry of a `TaskCompleted.artifactRefs` — names the
 * defect artifact `id`, at *any* version.
 *
 * Filing dates by the earliest `TaskCompleted` that names the artifact at
 * all, not by the one that happens to name the version this module reduced
 * the defect to (`latestPerId`). The lifecycle writes one version per
 * transition — `fileDefect` names v1, `routeDefect` v2, and so on — so a
 * `TaskCompleted` naming a *later* version is never the filing; it is
 * whatever transition wrote that version, which for a routed defect can be
 * the fix task's own completion. Matching on `id` alone, across every
 * version this artifact ever held, is what lets the earliest of those
 * events be found regardless of which version happened to be current when
 * this module looked.
 */
function refersTo(ref: ArtifactRefLike, artifactId: string): boolean {
  return ref.id === artifactId;
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
 * One `DefectRecord` per artifact `id`, the *lowest* `version` — the version
 * {@link fileDefect} wrote, whoever's task that was — for the filing-date
 * fallback (module doc's correction). Only ever read from, never counted:
 * `records` (the caller's own `latestPerId` reduction) stays what everything
 * else in this module counts over, so a defect still reads once regardless of
 * how many versions it holds.
 */
function earliestPerId(
  records: readonly DefectRecord[],
): ReadonlyMap<string, DefectRecord> {
  const earliest = new Map<string, DefectRecord>();
  for (const record of records) {
    const current = earliest.get(record.artifact.id);
    if (current === undefined || record.artifact.version < current.artifact.version) {
      earliest.set(record.artifact.id, record);
    }
  }
  return earliest;
}

/**
 * The `TaskCompleted` that dates `artifact`'s filing, primary route or
 * fallback (module doc's correction) — whichever finds one.
 *
 * The primary route matches `artifactRefs` against `artifact.id` at *any*
 * version (`refersTo`'s own doc). The fallback fires only when that finds
 * nothing: `filedVersion`'s own `producedBy` — the task *and run* that wrote
 * the lowest version on record for this id — read directly against
 * `TaskCompleted.taskId` and the event's own `runId`, no `artifactRefs`
 * involved at all. Reached exactly when the emitter recorded no refs
 * (T4.2.7's own gap before this task, and still true of any caller that
 * declares no artifact for a task that writes one some other way).
 *
 * Both `producedBy.task` and `producedBy.runId` must match, not `task`
 * alone: `task` is a phase step id, which repeats every time that phase runs
 * — under the same run id across many invocations, and in principle under a
 * different run id entirely (module doc). A `TaskCompleted` for the same
 * step id under a *different* run is a different invocation's completion,
 * not this one, and matching on the id alone can find one that predates the
 * artifact by an arbitrary margin. Scoping to `producedBy.runId` as well
 * still leaves one case unresolved: the same step id completing more than
 * once *within* that run. Nothing here says which of those completions wrote
 * this version, so rather than pick one by read order — the same mistake
 * scoped to a narrower set of candidates — the fallback reports none, which
 * `computeEscapedDefectRate` reads the same way it reads no match at all:
 * `undated`, not a guess.
 */
function filedAt(
  taskCompleted: readonly StoredEvent<TaskCompletedPayload>[],
  artifactId: string,
  filedVersion: DefectRecord | undefined,
): StoredEvent<TaskCompletedPayload> | undefined {
  const byRef = taskCompleted.filter((event) =>
    event.payload.artifactRefs.some((ref) => refersTo(ref, artifactId)),
  );
  const earliestByRef = byRef.reduce<StoredEvent<TaskCompletedPayload> | undefined>(
    (earliest, event) =>
      earliest === undefined || event.ts < earliest.ts ? event : earliest,
    undefined,
  );
  if (earliestByRef !== undefined) {
    return earliestByRef;
  }

  const filedTaskId = filedVersion?.artifact.producedBy.task;
  const filedRunId = filedVersion?.artifact.producedBy.runId;
  if (filedTaskId === undefined || filedRunId === undefined) {
    return undefined;
  }

  const candidates = taskCompleted.filter(
    (event) => event.runId === filedRunId && event.payload.taskId === filedTaskId,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
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
  // `ChangeMergedByOperator` (T4.2.15) counts here exactly as `ChangeMerged`
  // does: both mean the same fact — a task's change reached the trunk — and
  // the only difference between them is who performed the merge, which this
  // module never asks. Leaving the operator-recorded kind out would keep the
  // denominator below exactly as wrong as the gap this task closes: a task
  // whose change is on `main` still not counted among the tasks that merged.
  //
  // What does change for a hand-recorded merge: its `ts` is *this* event's
  // own append time, weeks or more after the real GitHub merge it records
  // (the log is append-only, DESIGN §6, and neither event type is ever
  // rewritten). The `merge.ts >= filed.ts` comparison below reads that
  // recorded `ts`, not history — a defect actually filed between the real
  // merge and this record would compare as filed *before* the merge and read
  // as the fix landing rather than an escape, undercounting `escaped` for
  // exactly the two tasks this task exists to bring into the denominator at
  // all. There is no fix for this within the log's own append-only
  // guarantee (§6): the true merge time was never recorded, so nothing here
  // can recover it, and this module does not pretend otherwise by
  // backdating the comparison.
  const changeMerged = events.filter(
    (event): event is StoredEvent<ChangeMergedPayload> =>
      event.type === 'ChangeMerged' || event.type === 'ChangeMergedByOperator',
  );
  const taskCompleted = events.filter(
    (event): event is StoredEvent<TaskCompletedPayload> => event.type === 'TaskCompleted',
  );

  const merged = changeMerged.filter((event) => event.runId === runId).length;

  const parsed = parseDefects(defects);
  const records = latestPerId(parsed);
  // Read from only: the fallback's dating source, never counted itself (see
  // `earliestPerId`'s own doc).
  const filedVersions = earliestPerId(parsed);

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

    const filed = filedAt(taskCompleted, artifact.id, filedVersions.get(artifact.id));
    if (filed === undefined) {
      // Neither `artifactRefs` nor the `producedBy.task` fallback dates
      // this — the only dating this module has (module doc) — so neither
      // side of "precedes" is known. Reported rather than dropped: see
      // `undated` on the interface.
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
