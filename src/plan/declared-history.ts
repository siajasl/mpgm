import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { ArtifactStore } from '../artifact/store.js';

/**
 * Did any Plan the project ever gated declare this task id? (T4.3.7, HIL-5,
 * CONV-4.)
 *
 * `supersede` retires a folded task id the current gated Plan no longer
 * declares. Absence from the current Plan is *not* evidence that the Plan
 * once declared it: a phase-step id (`draft`, `critique`, … — `phase/runner.ts`
 * dispatches through `SessionRunner.runTask` with `taskId: step.id`) and a
 * mistyped dispatch are both absent from the Plan too, and always were. A
 * rule that retired anything it could not find in the current Plan would
 * therefore silently permit on exactly the ambiguity it exists to surface,
 * and retire a genuinely blocked step out of the success denominator on the
 * operator's word alone (CONV-4).
 *
 * So the claim is checked from the positive side: some version of the Plan
 * artifact, at some point in the project's recorded history, declared this
 * id as a task. Two places hold that history, and both are searched because
 * a plan revision lands in either:
 *
 *  1. **Stored artifact versions.** `ArtifactStore.write` never overwrites a
 *     gated version, so a replan normally leaves `plan.v1.md` beside
 *     `plan.v2.md` and the older file still declares what it declared.
 *  2. **Committed revisions of those files.** mpgm's own split of T4.1.4 was
 *     applied as an in-place document revision (`4fe2c61`), which is the
 *     shape this task exists for: on disk there is only `plan.v1.md`, and the
 *     only surviving record that T4.1.4 was ever a task is the blob under an
 *     earlier commit of that file. Candidate commits are narrowed with git's
 *     pickaxe and then confirmed by parsing the blob, so a commit that merely
 *     mentions the id in prose is not mistaken for one that declares it.
 *
 * Nothing here trusts a string match: a candidate only counts once the blob
 * parses and the id appears as a task's `id` under a `tasks` array.
 */

/** Where an id was found declared, or what was searched and came up empty. */
export interface PlanDeclarationEvidence {
  readonly declared: boolean;
  /** Human-readable provenance for the decision (CONV-3). */
  readonly detail: string;
}

export interface PlanDeclarationQuery {
  readonly root: string;
  readonly artifacts: ArtifactStore;
  /** e.g. `artifacts/plan/plan.md`. */
  readonly basePath: string;
  readonly taskId: string;
}

/**
 * Task ids a parsed Plan artifact's frontmatter data declares.
 *
 * Deliberately structural and schema-tolerant rather than run through
 * `planSchema`: the blobs searched here were written against whatever plan
 * schema version was current at the time, and a historical revision that no
 * longer validates today is still evidence of what it declared. The one thing
 * required is the shape every plan schema has had — a `tasks` array whose
 * entries carry a string `id`.
 */
export function declaredTaskIds(data: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (node: unknown, insideTasks: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, insideTasks);
      }
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const record = node as Record<string, unknown>;
    if (insideTasks && typeof record.id === 'string') {
      ids.add(record.id);
    }
    for (const [key, value] of Object.entries(record)) {
      visit(value, key === 'tasks');
    }
  };
  visit(data, false);
  return ids;
}

/** Frontmatter `data` of an artifact file's text, or undefined if unreadable. */
function frontmatterData(contents: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (match === null) {
    return undefined;
  }
  try {
    const parsed = parseYaml(match[1] ?? '') as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    return (parsed as Record<string, unknown>).data;
  } catch {
    return undefined;
  }
}

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * Commits whose blobs are worth parsing: git's pickaxe on the bare id, which
 * lists every revision where the number of occurrences of that string changed
 * — so both the revision that introduced a task and the one that removed it.
 * Capped, because this is recall-oriented narrowing and each candidate costs
 * a blob read and a YAML parse; a project whose plan mentions one id in more
 * than this many commits has other problems.
 */
const MAX_CANDIDATE_COMMITS = 100;

function candidateCommits(
  root: string,
  relativePath: string,
  taskId: string,
): readonly string[] {
  const output = git(root, [
    'log',
    `--max-count=${String(MAX_CANDIDATE_COMMITS)}`,
    '--format=%H',
    `-S${taskId}`,
    '--',
    relativePath,
  ]);
  if (output === undefined) {
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function planEverDeclared(query: PlanDeclarationQuery): PlanDeclarationEvidence {
  const { root, artifacts, basePath, taskId } = query;
  const searched: string[] = [];

  // 1. Every stored version, newest first — a replan that wrote a successor
  //    leaves the predecessor on disk saying what it used to declare.
  const latest = artifacts.latestVersion(basePath);
  for (let version = latest; version >= 1; version -= 1) {
    const path = artifacts.pathFor(basePath, version);
    if (!existsSync(path)) {
      continue;
    }
    searched.push(path.slice(root.length + 1));
    let ids: Set<string>;
    try {
      ids = declaredTaskIds(artifacts.read(basePath, version).data);
    } catch {
      continue;
    }
    if (ids.has(taskId)) {
      return {
        declared: true,
        detail: `declared by ${basePath} v${String(version)}`,
      };
    }
  }

  // 2. Committed revisions of those same files — the in-place revision case,
  //    which is how mpgm's own T4.1.4 stopped being a task.
  for (let version = latest; version >= 1; version -= 1) {
    const relativePath = artifacts.pathFor(basePath, version).slice(root.length + 1);
    for (const commit of candidateCommits(root, relativePath, taskId)) {
      // The pickaxe reports the revision where the count *changed*, so the
      // commit that removed an id does not itself contain it — its parent
      // does, and both are read for that reason.
      for (const suffix of ['', '^']) {
        const ref = `${commit}${suffix}`;
        const blob = git(root, ['show', `${ref}:${relativePath}`]);
        if (blob === undefined) {
          continue;
        }
        const data = frontmatterData(blob);
        if (data !== undefined && declaredTaskIds(data).has(taskId)) {
          return {
            declared: true,
            detail:
              `declared by ${relativePath} at commit ` +
              `${commit.slice(0, 12)}${suffix}`,
          };
        }
      }
    }
  }

  return {
    declared: false,
    detail:
      searched.length === 0
        ? `no Plan artifact versions found at ${basePath}`
        : `searched ${searched.join(', ')} and every committed revision of them`,
  };
}
