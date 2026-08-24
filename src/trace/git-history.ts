import { execFileSync } from 'node:child_process';
import type { CommitRecord } from './links.js';

/**
 * Reading commit trailers and changed paths (ADR-4).
 *
 * Separated from the index so the index itself needs no git at all: a project
 * whose artifacts are not yet committed still gets a usable graph, and the
 * tests can drive the index without a repository.
 */

export class GitHistoryError extends Error {}

/**
 * ASCII record and unit separators, used to delimit `git log` output.
 *
 * Newlines cannot do the job: a commit body contains them, and splitting on
 * them is how a trailer in one commit ends up attributed to the next.
 */
const RECORD = '\x1e';
const FIELD = '\x1f';

function git(repo: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    throw new GitHistoryError(
      `git ${args.join(' ')} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export function headCommit(repo: string): string | null {
  try {
    return git(repo, ['rev-parse', 'HEAD']).trim();
  } catch {
    // No commits yet. Not an error: a project can have artifacts before it has
    // history, and the index should cover what exists.
    return null;
  }
}

/**
 * Commits in `range`, oldest first.
 *
 * `range` is any revision range git accepts — omit it for every commit
 * reachable from HEAD, or pass `a..b` for what `b` has that `a` does not.
 */
export function readCommits(repo: string, range?: string): CommitRecord[] {
  const output = git(repo, [
    'log',
    '--reverse',
    '--no-merges',
    `--format=${RECORD}%H${FIELD}%s${FIELD}%b`,
    ...(range === undefined ? [] : [range]),
  ]);

  return output
    .split(RECORD)
    .slice(1)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split(FIELD);
      return { sha: sha.trim(), subject: subject.trim(), body };
    })
    .filter((commit) => commit.sha !== '');
}

/** Paths touched between two commits, repo-relative. */
export function changedPaths(repo: string, from: string, to: string): string[] {
  return git(repo, ['diff', '--name-only', `${from}..${to}`])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
