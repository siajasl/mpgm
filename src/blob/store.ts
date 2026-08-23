import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EventLogError } from '../event/errors.js';

/**
 * Content-addressed blob store (ADR-2).
 *
 * Large session transcripts and tool outputs are too bulky to sit in the event
 * log, so they live here and events carry only a hash reference. Addressing by
 * content rather than by name means the same output written twice occupies one
 * file, and a reference can be checked against the bytes it names.
 */

export const HASH_ALGORITHM = 'sha256';

/** A reference to stored content. This is what events carry. */
export interface BlobRef {
  /** Lowercase hex digest of the content. */
  readonly hash: string;
  /** Content length in bytes. */
  readonly size: number;
}

/** Content was requested that the store does not hold. */
export class BlobNotFoundError extends EventLogError {
  constructor(readonly hash: string) {
    super(`no blob with hash '${hash}'`);
  }
}

/** Stored bytes did not match the hash naming them. */
export class BlobIntegrityError extends EventLogError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `blob integrity check failed: content under '${expected}' hashes to '${actual}'`,
    );
  }
}

export function hashContent(content: Buffer): string {
  return createHash(HASH_ALGORITHM).update(content).digest('hex');
}

export interface GetOptions {
  /**
   * Recompute the hash and compare. On by default: a content-addressed store
   * that returns unverified bytes gives up the one guarantee it exists for.
   */
  readonly verify?: boolean;
}

export class BlobStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  /** Open (creating if absent) a store rooted at `root`, typically `.mpgm/blobs`. */
  static open(root: string): BlobStore {
    mkdirSync(root, { recursive: true });
    return new BlobStore(root);
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Store content, returning its reference.
   *
   * Idempotent by construction: identical content yields an identical hash, so
   * a second put finds the file already present and writes nothing.
   */
  put(content: Buffer | string): BlobRef {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = hashContent(buffer);
    const target = this.#pathFor(hash);

    if (!existsSync(target)) {
      mkdirSync(join(this.#root, hash.slice(0, 2)), { recursive: true });

      // Write to a unique temporary name and rename into place. Rename is
      // atomic within a filesystem, so a crash mid-write can leave a stray
      // temporary file but never a half-written blob under a valid hash.
      const temporary = `${target}.tmp-${randomUUID()}`;
      writeFileSync(temporary, buffer);
      renameSync(temporary, target);
    }

    return { hash, size: buffer.byteLength };
  }

  /** Store UTF-8 text. */
  putText(text: string): BlobRef {
    return this.put(Buffer.from(text, 'utf8'));
  }

  has(hash: string): boolean {
    return existsSync(this.#pathFor(hash));
  }

  get(hash: string, options: GetOptions = {}): Buffer {
    const target = this.#pathFor(hash);
    if (!existsSync(target)) {
      throw new BlobNotFoundError(hash);
    }

    const content = readFileSync(target);

    if (options.verify !== false) {
      const actual = hashContent(content);
      if (actual !== hash) {
        throw new BlobIntegrityError(hash, actual);
      }
    }

    return content;
  }

  getText(hash: string, options: GetOptions = {}): string {
    return this.get(hash, options).toString('utf8');
  }

  /** Resolve a reference, checking the recorded size as well as the hash. */
  resolve(ref: BlobRef, options: GetOptions = {}): Buffer {
    const content = this.get(ref.hash, options);
    if (content.byteLength !== ref.size) {
      throw new BlobIntegrityError(ref.hash, hashContent(content));
    }
    return content;
  }

  size(hash: string): number {
    const target = this.#pathFor(hash);
    if (!existsSync(target)) {
      throw new BlobNotFoundError(hash);
    }
    return statSync(target).size;
  }

  /** Number of blobs held. Walks the store, so intended for tests and tooling. */
  count(): number {
    let total = 0;
    for (const shard of readdirSync(this.#root, { withFileTypes: true })) {
      if (!shard.isDirectory()) {
        continue;
      }
      for (const entry of readdirSync(join(this.#root, shard.name))) {
        if (!entry.includes('.tmp-')) {
          total += 1;
        }
      }
    }
    return total;
  }

  /**
   * Remove temporary files left behind by a crash mid-write. Safe at any time:
   * a temporary file is never referenced by a hash.
   */
  sweepTemporaries(): number {
    let removed = 0;
    for (const shard of readdirSync(this.#root, { withFileTypes: true })) {
      if (!shard.isDirectory()) {
        continue;
      }
      const shardPath = join(this.#root, shard.name);
      for (const entry of readdirSync(shardPath)) {
        if (entry.includes('.tmp-')) {
          rmSync(join(shardPath, entry), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** Sharded by the first two hex characters, so no directory grows unbounded. */
  #pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new EventLogError(`not a ${HASH_ALGORITHM} hex digest: '${hash}'`);
    }
    return join(this.#root, hash.slice(0, 2), hash.slice(2));
  }
}
