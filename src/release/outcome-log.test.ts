import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../artifact/store.js';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { outcomeBasePath, readOutcomes, recordOutcome } from './outcome-log.js';
import { releaseOutcomeSchema, type ReleaseOutcome } from './verify.js';

const provenance = {
  task: 'release-verify',
  role: 'harness',
  model: 'n/a',
  runId: 'run-1',
};

const tempDirs: string[] = [];

function newStore(): ArtifactStore {
  const root = mkdtempSync(join(tmpdir(), 'mpgm-outcomes-'));
  tempDirs.push(root);
  return new ArtifactStore({
    root,
    schemas: new ArtifactSchemaRegistry([
      defineArtifactSchema('release-outcome', releaseOutcomeSchema),
    ]),
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function outcome(overrides: Partial<ReleaseOutcome> = {}): ReleaseOutcome {
  return {
    env: 'test',
    release: { version: '2.0.0', digest: 'sha256:bbb' },
    decision: 'promoted',
    reason: 'all 1 smoke check(s) passed',
    checks: [{ name: 'homepage', ok: true, detail: '' }],
    rolledBackTo: null,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('recordOutcome / readOutcomes', () => {
  it('reads an environment with no outcome artifact yet as no outcomes, not an error', () => {
    const store = newStore();
    expect(readOutcomes(store, 'test')).toEqual([]);
  });

  it('records a validated outcome as a versioned artifact under artifacts/deploy', () => {
    const store = newStore();
    const artifact = recordOutcome(store, {
      outcome: outcome(),
      producedBy: provenance,
    });

    expect(artifact.version).toBe(1);
    expect(artifact.path).toBe(
      join(store.root, outcomeBasePath('test').replace('.md', '.v1.md')),
    );
    expect(readOutcomes(store, 'test')).toEqual([outcome()]);
  });

  it('survives the run that produced it: the file is on disk, not under .mpgm', () => {
    const store = newStore();
    const artifact = recordOutcome(store, {
      outcome: outcome(),
      producedBy: provenance,
    });

    // Computed independently of `artifact.path` (which is, by construction,
    // exactly the path `store.write` just wrote to — asserting `existsSync`
    // on it could never fail regardless of where that path actually is).
    // This asserts the file exists at the location the contract promises.
    const expectedPath = join(
      store.root,
      outcomeBasePath('test').replace('.md', '.v1.md'),
    );
    expect(artifact.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(expectedPath).not.toMatch(/\.mpgm/);
    expect(expectedPath.startsWith(join(store.root, 'artifacts', 'deploy'))).toBe(true);

    // Real markdown with frontmatter, readable without going through this
    // module — the point of an artifact over a JSONL line (DESIGN §9.12).
    const raw = readFileSync(expectedPath, 'utf8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('schema: release-outcome');
    expect(raw).toContain('decision: promoted');
  });

  it('each recorded outcome is its own immutable version — appended, never overwritten', () => {
    const store = newStore();
    recordOutcome(store, {
      outcome: outcome({ release: { version: '1.0.0', digest: 'sha256:aaa' } }),
      producedBy: provenance,
    });
    const second = recordOutcome(store, {
      outcome: outcome({
        release: { version: '2.0.0', digest: 'sha256:bbb' },
        decision: 'rolled-back',
        reason: 'smoke checks failed; rolled back',
        rolledBackTo: { version: '1.0.0', digest: 'sha256:aaa' },
      }),
      producedBy: provenance,
    });

    expect(second.version).toBe(2);
    const recorded = readOutcomes(store, 'test');
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.release.version).toBe('1.0.0');
    expect(recorded[1]?.decision).toBe('rolled-back');

    // The first version's file is untouched — still readable on its own.
    const first = store.read(outcomeBasePath('test'), 1);
    expect((first.data as ReleaseOutcome).release.version).toBe('1.0.0');
  });

  it('keeps different environments in separate artifacts', () => {
    const store = newStore();
    recordOutcome(store, { outcome: outcome(), producedBy: provenance });
    recordOutcome(store, {
      outcome: outcome({ env: 'staging' }),
      producedBy: provenance,
    });

    expect(readOutcomes(store, 'test')).toHaveLength(1);
    expect(readOutcomes(store, 'staging')).toHaveLength(1);
  });

  it('refuses to record something releaseOutcomeSchema does not allow (fail closed)', () => {
    const store = newStore();
    expect(() =>
      recordOutcome(store, {
        outcome: outcome({ reason: '' }),
        producedBy: provenance,
      }),
    ).toThrow();
    expect(readOutcomes(store, 'test')).toEqual([]);
  });

  it('traces to DEP-5 by default', () => {
    const store = newStore();
    const artifact = recordOutcome(store, {
      outcome: outcome(),
      producedBy: provenance,
    });
    expect(artifact.tracesTo).toEqual(['DEP-5']);
  });

  it(
    "the artifact is always filed under the outcome's own env — there is no " +
      'separate env option a caller could disagree with it',
    () => {
      const store = newStore();
      // A previous version of `recordOutcome` took an independent `env` option
      // and used it to build the path, so `{ env: 'test', outcome: { ...,
      // env: 'prod' } }` filed a prod outcome under test's artifact and
      // `readOutcomes(store, 'test')` read it back as test's own history — the
      // "deploy gate deciding blind" DESIGN §9.12 exists to prevent. There is
      // no `env` option any more (TS refuses to compile one), so this asserts
      // the only path left: the outcome always lands under its own `env`.
      const artifact = recordOutcome(store, {
        outcome: outcome({ env: 'prod' }),
        producedBy: provenance,
      });
      expect(artifact.path).toBe(
        join(store.root, outcomeBasePath('prod').replace('.md', '.v1.md')),
      );
      expect(readOutcomes(store, 'prod')).toEqual([outcome({ env: 'prod' })]);
      expect(readOutcomes(store, 'test')).toEqual([]);
    },
  );

  it('refuses an env that could escape artifacts/deploy, e.g. a path traversal (fail closed)', () => {
    const store = newStore();
    expect(() =>
      recordOutcome(store, {
        outcome: outcome({ env: '../../escaped' }),
        producedBy: provenance,
      }),
    ).toThrow(/not a valid environment name/);
    // Nothing escaped: no file landed anywhere outside the store's own root.
    expect(existsSync(join(store.root, '..', 'escaped.v1.md'))).toBe(false);
    expect(existsSync(join(store.root, 'artifacts', 'deploy'))).toBe(false);
  });

  it('refuses an env with the same escape by way of readOutcomes, not only recordOutcome', () => {
    const store = newStore();
    expect(() => readOutcomes(store, '../../escaped')).toThrow(
      /not a valid environment name/,
    );
  });
});
