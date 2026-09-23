/**
 * Conflict resolution (IMP-1, IMP-4, OBS-1).
 *
 * `WorktreeManager.catchUp` and `mergeChange` both refuse rather than resolve
 * a conflict between a task's branch and the trunk, deliberately: a
 * half-merged checkout is worse than a refused merge (`worktree.ts`,
 * `merge.ts`). Both say, in their own words, that the conflict "is a task for
 * an agent, not a state for the kernel to sit in" — but until this, nothing
 * dispatched one, at either site. `implement/loop.ts` now does, for both:
 * `catchUp`'s conflict, hit before the first session of a task ever runs,
 * and `mergeChange`'s, hit at the very end, when a filing has landed on the
 * trunk during the task's own 20-40 minute life and the branch — already
 * caught up once — has fallen behind again while it was being reviewed.
 * Both route through the same `renderConflict` prompt and the same checks
 * below, because both are the same problem at a different point in the
 * loop. T4.3.2's run hit the first of the two and stopped:
 *
 *   'mpgm/T4.3.2' is behind 'main' and merging it conflicts in PLAN.md.
 *   Resolving it is a change somebody has to make; until it is made, a pull
 *   request for this branch cannot report checks at all.
 *
 * An operator resolved it by hand and re-ran the task, spending a fresh
 * implement-and-review cycle on work that had already passed both. The
 * collision was structural, not bad luck: CLAUDE.md requires a substantive
 * document revision to bump its `**Status:** vX.Y` header and update
 * downstream `Upstream:` refs, so a task that revises DESIGN edits PLAN.md's
 * header, and every filing commit edits that same header — both land in the
 * same two lines, and both edits are wanted.
 *
 * Three ways to close this gap were on the table:
 *
 * 1. Bring the trunk into the branch and retry before refusing. This does
 *    nothing for a real conflict — the same two sides are still there on the
 *    second attempt — and only helps the different problem of a trunk that
 *    moved again between the check and the merge, which `mergeChange`
 *    already handles by fetching and fast-forwarding before it merges.
 * 2. Dispatch the resolution to an agent, the way the comment already
 *    claims happens. This is what `renderConflict` and its caller in
 *    `loop.ts` do: hand the conflicted files to the same role that authored
 *    the change, with the common ancestor visible, and ask it to reconcile
 *    the two sides honestly.
 * 3. Hold filing commits while a branch is live, so the collision never
 *    occurs. This is a process rule, not code — nothing here enforces it,
 *    and a change that chose it would have to say so instead of implying
 *    the kernel does. It is not chosen: two filings already landed on main
 *    during T4.3.2's life, so the window a hold would need to cover is not
 *    narrow, and a kernel that depends on operators remembering not to file
 *    is a kernel this project has otherwise avoided building.
 *
 * (2) is what this module dispatches. Auto-resolving by preferring one side
 * — taking the trunk's header, say — was considered and refused: it would
 * have silently dropped the branch's own true change, which is exactly what
 * IMP-4 exists to stop happening without a flag. Keeping *both* sides' edits
 * is not the same as preferring one, and where the two sides changed the
 * same thing to different values there is no rule this project can state
 * that picks between them — a conflict outside a document header, two tasks
 * editing one function, has no textual answer, and the agent is told to
 * leave it conflicted rather than guess.
 *
 * The trunk-side resolution lands on the branch after its own review already
 * ran, unlike the branch-side one, which lands before either the implementing
 * or the review session sees the branch at all. That is deliberate rather
 * than overlooked: the resolution reconciles two changes each already
 * reviewed and gated on their own way in — the task's own diff, and whatever
 * landed on `into` in the meantime — the same reconciliation a `--no-ff`
 * merge commit itself performs mechanically and unreviewed every time this
 * loop merges at all. Requiring a fresh review of the reconciliation would
 * mean a second review round for every task a filing happens to race, for a
 * commit that (per the prompt above) is not permitted to introduce anything
 * beyond what each side already changed.
 *
 * That argument is about review, not about CI, and does not stand in for it:
 * the resolver's commit is new, so nothing has run the merge checks against
 * it yet, and this project treats CI as an oracle whose absence is not
 * success (IMP-2) — a reconciliation that happens to break the build is
 * exactly the kind of thing a diff bounded to "what each side already
 * changed" can still do, two independently-fine changes combining badly
 * being the ordinary way a merge conflict turns into a broken build. So
 * `implement/loop.ts` publishes the resolved commit and asks CI about it for
 * real before merging on its strength, the same as it would for any other
 * new commit in this loop; only the review is carried forward rather than
 * re-run.
 */

/** What the resolving agent is shown for one conflict. */
export function renderConflict(request: {
  readonly taskId: string;
  readonly branch: string;
  readonly into: string;
  /** Conflicted file path to its current content, conflict markers and all. */
  readonly files: ReadonlyMap<string, string>;
}): string {
  const lines = [
    `'${request.branch}' (${request.taskId}) is behind '${request.into}' and`,
    `merging it conflicts. Resolving it is your task now, not an operator's.`,
    '',
    'Each file below is shown with conflict markers in diff3 form: your',
    "branch's own version, then the common ancestor both sides started from,",
    `then '${request.into}'s current version.`,
    '',
    'Resolve every conflict by keeping what each side actually changed from',
    'the ancestor. Where the two sides changed different things — two',
    'different lines of one document, say — the resolution keeps both',
    'changes. Dropping either one silently is not permitted (IMP-4), even',
    'when one side looks more recent or more authoritative than the other.',
    '',
    'Where the two sides changed the same thing to different values, there is',
    'no rule that says which one wins. That is a real collision, not a',
    'formatting accident, and it is not yours to decide either: leave that',
    'file conflicted, report `complete: false`, and say in `remaining` which',
    'file and which change collides. Do not guess, and do not resolve part of',
    'a file while leaving the ancestor version in for the rest.',
    '',
    'When every conflict is genuinely resolved, stage and commit the merge —',
    '`git add` the files, then `git commit --no-edit` (there is no editor in',
    'this session, and the prepared merge message needs no changes) — so',
    'that `MERGE_HEAD` clears. A resolution that edits the files but never',
    'finishes the merge commit is not recorded as one; report the resulting',
    'commit in `ref`.',
  ];
  for (const [file, content] of request.files) {
    lines.push('', `--- ${file} ---`, content);
  }
  return lines.join('\n');
}
