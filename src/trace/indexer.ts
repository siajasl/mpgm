import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactStore } from '../artifact/store.js';
import { changedPaths, headCommit, readCommits } from './git-history.js';
import type { TraceIndex } from './index-store.js';

/**
 * Keeping the trace index in step with the repository (ADR-4).
 *
 * Two paths in, both idempotent per source, which is what lets them mix:
 *
 * - `rebuild` re-reads every artifact on disk and every commit reachable from
 *   HEAD. Always correct, and the answer everything else is measured against.
 * - `update` re-reads only what changed since the commit the index was last
 *   brought to. Same result, without walking the whole repository.
 *
 * The phase runner indexes each artifact as it writes it, so the working tree
 * is covered before anything is committed. That is deliberately not
 * git-keyed: an artifact that exists but has not been committed is exactly
 * the state a phase is in when it reaches its gate.
 */

export interface IndexerOptions {
  readonly repo: string;
  readonly index: TraceIndex;
  readonly artifacts: ArtifactStore;
  /** Subdirectory holding artifact versions. */
  readonly artifactRoot?: string;
}

export interface IndexReport {
  readonly artifacts: number;
  readonly commits: number;
  readonly forgotten: number;
  /** The commit the index now reflects, or null in a repository with none. */
  readonly indexedAt: string | null;
}

export class TraceIndexer {
  readonly #repo: string;
  readonly #index: TraceIndex;
  readonly #artifacts: ArtifactStore;
  readonly #artifactRoot: string;

  constructor(options: IndexerOptions) {
    this.#repo = options.repo;
    this.#index = options.index;
    this.#artifacts = options.artifacts;
    this.#artifactRoot = options.artifactRoot ?? 'artifacts';
  }

  /** Re-read everything. The index is derived, so this is always available. */
  rebuild(): IndexReport {
    this.#index.clear();

    let artifacts = 0;
    for (const { artifact, relativePath } of this.#artifacts.list(this.#artifactRoot)) {
      this.#index.indexArtifactAs(artifact, relativePath);
      artifacts += 1;
    }

    const head = headCommit(this.#repo);
    let commits = 0;
    if (head !== null) {
      for (const commit of readCommits(this.#repo)) {
        this.#index.indexCommit(commit);
        commits += 1;
      }
    }

    this.#index.indexedAt = head;
    return { artifacts, commits, forgotten: 0, indexedAt: head };
  }

  /**
   * Bring the index forward from the commit it last saw.
   *
   * Falls back to a full rebuild when there is nothing to go on — no recorded
   * commit, or a recorded one git no longer knows (a rewritten history). A
   * silent partial update against a commit that no longer exists would leave
   * an index that looks current and is not.
   */
  update(): IndexReport {
    const from = this.#index.indexedAt;
    const head = headCommit(this.#repo);

    if (from === null || head === null) {
      return this.rebuild();
    }
    if (from === head) {
      return { artifacts: 0, commits: 0, forgotten: 0, indexedAt: head };
    }

    let commits = 0;
    let artifacts = 0;
    let forgotten = 0;
    let touched: string[];
    try {
      for (const commit of readCommits(this.#repo, `${from}..${head}`)) {
        this.#index.indexCommit(commit);
        commits += 1;
      }
      touched = changedPaths(this.#repo, from, head);
    } catch {
      return this.rebuild();
    }

    const touchedArtifacts = touched.filter((path) =>
      path.startsWith(`${this.#artifactRoot}/`),
    );
    // Read once: `list` walks and parses the whole artifact tree, and doing
    // that per changed path is how an incremental update ends up slower than
    // the rebuild it exists to avoid.
    const onDisk = new Map(
      touchedArtifacts.length === 0
        ? []
        : this.#artifacts
            .list(this.#artifactRoot)
            .map((entry) => [entry.relativePath, entry.artifact] as const),
    );

    for (const path of touchedArtifacts) {
      const found = onDisk.get(path);
      if (found === undefined || !existsSync(join(this.#repo, path))) {
        // Gone between the two commits. Forgetting by source is why the index
        // does not accumulate links to files that no longer exist.
        this.#index.forget(path);
        forgotten += 1;
        continue;
      }
      this.#index.indexArtifactAs(found, path);
      artifacts += 1;
    }

    this.#index.indexedAt = head;
    return { artifacts, commits, forgotten, indexedAt: head };
  }
}
