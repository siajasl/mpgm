import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY, openDatabase } from '../database.js';
import { z } from 'zod';
import { kernelRegistry } from '../event/catalog.js';
import { defineEvent, EventRegistry } from '../event/registry.js';
import { EventLog } from '../event/store.js';
import {
  BlobIntegrityError,
  BlobNotFoundError,
  BlobStore,
  hashContent,
} from './store.js';

const tempDirs: string[] = [];

function newStore(): BlobStore {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-blob-'));
  tempDirs.push(dir);
  return BlobStore.open(join(dir, 'blobs'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('BlobStore round-trip', () => {
  it('returns exactly the bytes it was given, for any content', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const store = newStore();
        const content = Buffer.from(bytes);

        const ref = store.put(content);

        expect(store.get(ref.hash)).toStrictEqual(content);
        expect(store.resolve(ref)).toStrictEqual(content);
        expect(ref.size).toBe(content.byteLength);
        expect(ref.hash).toBe(hashContent(content));
      }),
      { numRuns: 40 },
    );
  });

  it('round-trips text through UTF-8', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const store = newStore();
        const ref = store.putText(text);

        expect(store.getText(ref.hash)).toBe(text);
      }),
      { numRuns: 40 },
    );
  });

  it('handles empty content', () => {
    const store = newStore();
    const ref = store.put(Buffer.alloc(0));

    expect(ref.size).toBe(0);
    expect(store.get(ref.hash)).toStrictEqual(Buffer.alloc(0));
  });
});

describe('BlobStore deduplication', () => {
  it('stores identical content once, however many times it is written', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 2, max: 6 }),
        (text, writes) => {
          const store = newStore();

          const refs = Array.from({ length: writes }, () => store.putText(text));

          // Same reference every time...
          expect(new Set(refs.map((ref) => ref.hash)).size).toBe(1);
          // ...and exactly one file on disk.
          expect(store.count()).toBe(1);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('does not rewrite a blob that is already present', () => {
    const store = newStore();
    const ref = store.putText('once');
    const path = join(store.root, ref.hash.slice(0, 2), ref.hash.slice(2));
    const firstWrite = statSync(path).mtimeMs;

    store.putText('once');

    expect(statSync(path).mtimeMs).toBe(firstWrite);
  });

  it('keeps distinct content distinct', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 8 }),
        (texts) => {
          const store = newStore();

          const hashes = texts.map((text) => store.putText(text).hash);

          expect(new Set(hashes).size).toBe(texts.length);
          expect(store.count()).toBe(texts.length);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('BlobStore integrity', () => {
  it('detects content that no longer matches its hash', () => {
    const store = newStore();
    const ref = store.putText('trustworthy');
    const path = join(store.root, ref.hash.slice(0, 2), ref.hash.slice(2));

    writeFileSync(path, 'tampered');

    expect(() => store.get(ref.hash)).toThrow(BlobIntegrityError);
    // Verification can be waived deliberately, never by accident.
    expect(store.get(ref.hash, { verify: false }).toString()).toBe('tampered');
  });

  it('rejects a reference whose recorded size is wrong', () => {
    const store = newStore();
    const ref = store.putText('exact');

    expect(() => store.resolve({ hash: ref.hash, size: ref.size + 1 })).toThrow(
      BlobIntegrityError,
    );
  });

  it('reports a missing blob rather than returning nothing', () => {
    const store = newStore();

    expect(() => store.get('a'.repeat(64))).toThrow(BlobNotFoundError);
    expect(store.has('a'.repeat(64))).toBe(false);
  });

  it('refuses a malformed hash', () => {
    const store = newStore();

    expect(() => store.get('not-a-hash')).toThrow(/sha256 hex digest/);
  });
});

describe('BlobStore crash residue', () => {
  it('sweeps temporary files left by an interrupted write', () => {
    const store = newStore();
    const ref = store.putText('real');
    const shard = join(store.root, ref.hash.slice(0, 2));
    writeFileSync(join(shard, `${ref.hash.slice(2)}.tmp-abandoned`), 'partial');

    // A stray temporary is never referenced by a hash, so it cannot be mistaken
    // for content, and the count ignores it.
    expect(store.count()).toBe(1);
    expect(store.sweepTemporaries()).toBe(1);
    expect(store.getText(ref.hash)).toBe('real');
  });
});

describe('blob references in events', () => {
  it('carries a blob reference through the log and back', () => {
    const store = newStore();
    const transcript = 'a very large tool output\n'.repeat(500);
    const ref = store.putText(transcript);

    const db = openDatabase(MEMORY);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.append({
        runId: 'run-1',
        type: 'ToolCallLogged',
        payload: {
          taskId: 'T1.1.4',
          tool: 'Bash',
          decision: 'allowed',
          detail: 'output offloaded',
          outputBlob: ref,
        },
      });

      const [event] = log.read();
      const payload = event?.payload as { outputBlob: { hash: string; size: number } };

      expect(payload.outputBlob).toStrictEqual(ref);
      expect(store.resolve(payload.outputBlob).toString('utf8')).toBe(transcript);
    } finally {
      db.close();
    }
  });

  it('upcasts pre-blob-store events to carry a null reference', () => {
    // Write through a registry that predates the blob store, then read through
    // the current one. Both attach to the same connection, so this is exactly
    // what a log written by an older build looks like to a newer one -- no
    // tampering with stored rows required.
    const legacyRegistry = new EventRegistry([
      defineEvent(
        'ToolCallLogged',
        z.object({
          taskId: z.string(),
          tool: z.string(),
          decision: z.enum(['allowed', 'denied']),
          detail: z.string().default(''),
        }),
      ),
    ]);

    const db = openDatabase(MEMORY);
    try {
      const legacyLog = EventLog.attach(db, { registry: legacyRegistry });
      legacyLog.append({
        runId: 'run-1',
        type: 'ToolCallLogged',
        payload: { taskId: 'T1.1.4', tool: 'Bash', decision: 'allowed', detail: 'old' },
      });

      const currentLog = EventLog.attach(db, { registry: kernelRegistry() });
      const [stored] = currentLog.readRaw();
      const [migrated] = currentLog.read();
      const payload = migrated?.payload as { outputBlob: unknown; detail: string };

      expect(stored?.schemaVersion).toBe(1);
      expect(migrated?.schemaVersion).toBe(2);
      expect(payload.outputBlob).toBeNull();
      expect(payload.detail).toBe('old');
    } finally {
      db.close();
    }
  });
});
