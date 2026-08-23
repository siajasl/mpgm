import { execFileSync } from 'node:child_process';

/**
 * Derived git markers for gate decisions (ADR-3).
 *
 * Gate truth lives in the event log. A tag is a convenience for humans and
 * for tooling that speaks git — it is written after the decision is already
 * recorded, and losing it costs nothing. Nothing reads a tag to decide whether
 * a gate is open.
 */

export class GitTagError extends Error {}

function git(repo: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    throw new GitTagError(
      `git ${args.join(' ')} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export function isGitRepository(repo: string): boolean {
  try {
    return git(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

export interface GateTagRequest {
  readonly repo: string;
  readonly phase: string;
  readonly version: number;
  readonly gateId: string;
  readonly by: string;
}

export function gateTagName(phase: string, version: number): string {
  return `gate/${phase}/v${String(version)}`;
}

/**
 * Commit any pending artifact changes and write the annotated tag.
 *
 * Returns the tag name and the commit it points at, so the caller can record
 * the commit on the artifact reference — the log stores path plus commit hash
 * (DESIGN §5), and until something commits, that hash is genuinely unknown.
 */
export function tagGate(request: GateTagRequest): { tag: string; commit: string } {
  const { repo } = request;

  git(repo, ['add', '--all', 'artifacts']);
  // An empty commit is fine: the tag must point somewhere even when the
  // artifacts were already committed by an earlier step.
  git(repo, [
    'commit',
    '--allow-empty',
    '-m',
    `Gate ${request.gateId} approved by ${request.by}`,
  ]);

  const tag = gateTagName(request.phase, request.version);
  git(repo, ['tag', '-a', tag, '-m', `${request.gateId} approved by ${request.by}`]);

  return { tag, commit: git(repo, ['rev-parse', 'HEAD']) };
}

export function listGateTags(repo: string): string[] {
  return git(repo, ['tag', '--list', 'gate/*'])
    .split('\n')
    .filter((line) => line.trim() !== '');
}
