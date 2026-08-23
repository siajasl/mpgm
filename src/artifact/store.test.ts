import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ArtifactStore,
  ArtifactStoreError,
  GatedArtifactError,
  StaticGateOracle,
  renderBody,
} from './store.js';
import {
  ArtifactSchemaError,
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from './schema-registry.js';

const BASE = 'artifacts/definition/brief.md';

const briefV1 = defineArtifactSchema(
  'brief',
  z.object({ problem: z.string().min(1), goals: z.array(z.string()) }),
);

/** A breaking change: `goals` becomes objects, and a field is renamed. */
const briefV2 = defineArtifactSchema(
  'brief',
  z.object({
    problemStatement: z.string().min(1),
    goals: z.array(z.object({ text: z.string() })),
  }),
  [
    (data) => {
      const old = data as { problem: string; goals: string[] };
      return {
        problemStatement: old.problem,
        goals: old.goals.map((text) => ({ text })),
      };
    },
  ],
);

const provenance = {
  task: 'draft-brief',
  role: 'analyst',
  model: 'claude-sonnet-5',
  runId: 'run-1',
};

const tempDirs: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function storeWith(
  root: string,
  schemas: ArtifactSchemaRegistry,
  gated: { id: string; version: number }[] = [],
) {
  return new ArtifactStore({ root, schemas, gates: new StaticGateOracle(gated) });
}

const v1Registry = new ArtifactSchemaRegistry([briefV1]);
const v2Registry = new ArtifactSchemaRegistry([briefV2]);

const data = { problem: 'Loans are tracked on paper.', goals: ['Digitise loans'] };

describe('writing and reading', () => {
  it('writes version 1 with frontmatter and a derived body', () => {
    const root = newRoot();
    const store = storeWith(root, v1Registry);

    const artifact = store.write({
      id: 'definition-brief',
      basePath: BASE,
      schema: 'brief',
      data,
      producedBy: provenance,
      tracesTo: ['DEF-1'],
    });

    expect(artifact.version).toBe(1);
    expect(artifact.supersedes).toBeNull();
    expect(artifact.path).toMatch(/brief\.v1\.md$/);

    const contents = readFileSync(artifact.path, 'utf8');
    expect(contents.startsWith('---\n')).toBe(true);
    // Attributable (ART-1) and traceable (ART-2).
    expect(contents).toContain('role: analyst');
    expect(contents).toContain('model: claude-sonnet-5');
    expect(contents).toContain('DEF-1');
    // Greppable prose body (ADR-3).
    expect(contents).toContain('Loans are tracked on paper.');
  });

  it('reads back exactly what was written', () => {
    const root = newRoot();
    const store = storeWith(root, v1Registry);
    store.write({
      id: 'b',
      basePath: BASE,
      schema: 'brief',
      data,
      producedBy: provenance,
    });

    const read = store.read(BASE);

    expect(read.data).toStrictEqual(data);
    expect(read.producedBy).toStrictEqual(provenance);
  });

  it('validates before anything reaches disk (ART-3)', () => {
    const root = newRoot();
    const store = storeWith(root, v1Registry);

    expect(() =>
      store.write({
        id: 'b',
        basePath: BASE,
        schema: 'brief',
        data: { problem: '', goals: [] },
        producedBy: provenance,
      }),
    ).toThrow(ArtifactSchemaError);
    expect(store.latestVersion(BASE)).toBe(0);
  });

  it('reports a missing artifact rather than returning nothing', () => {
    const store = storeWith(newRoot(), v1Registry);

    expect(() => store.read(BASE)).toThrow(ArtifactStoreError);
  });
});

describe('immutability once gated (ART-1)', () => {
  it('refuses to overwrite a gated version', () => {
    const root = newRoot();
    const store = storeWith(root, v1Registry, [{ id: 'definition-brief', version: 1 }]);
    const request = {
      id: 'definition-brief',
      basePath: BASE,
      schema: 'brief',
      data,
      producedBy: provenance,
    };
    // Written before the gate; the oracle reports it gated thereafter.
    new ArtifactStore({ root, schemas: v1Registry }).write(request);

    expect(() =>
      store.overwrite({ ...request, data: { ...data, goals: ['changed'] } }, 1),
    ).toThrow(GatedArtifactError);
    expect(() => store.overwrite(request, 1)).toThrow(
      /Create a successor version instead/,
    );
    // The approved bytes are untouched.
    expect(store.read(BASE, 1).data).toStrictEqual(data);
  });

  it('creates v+1 instead, recording what it supersedes', () => {
    const root = newRoot();
    const request = {
      id: 'definition-brief',
      basePath: BASE,
      schema: 'brief',
      data,
      producedBy: provenance,
    };
    new ArtifactStore({ root, schemas: v1Registry }).write(request);
    const store = storeWith(root, v1Registry, [{ id: 'definition-brief', version: 1 }]);

    const successor = store.write({
      ...request,
      data: { problem: 'Revised problem.', goals: ['Digitise loans', 'Report overdue'] },
    });

    expect(successor.version).toBe(2);
    expect(successor.supersedes).toBe(1);
    expect(store.latestVersion(BASE)).toBe(2);
    // Both versions remain readable without going through git history.
    expect(store.read(BASE, 1).data).toStrictEqual(data);
    expect(store.read(BASE).version).toBe(2);
  });

  it('allows overwriting a version that is not gated', () => {
    const root = newRoot();
    const store = storeWith(root, v1Registry);
    const request = {
      id: 'b',
      basePath: BASE,
      schema: 'brief',
      data,
      producedBy: provenance,
    };
    store.write(request);

    const revised = store.overwrite(
      { ...request, data: { problem: 'Corrected.', goals: [] } },
      1,
    );

    expect(revised.version).toBe(1);
    expect(store.latestVersion(BASE)).toBe(1);
    expect(store.read(BASE).data).toStrictEqual({ problem: 'Corrected.', goals: [] });
  });

  it('refuses to overwrite a version that does not exist', () => {
    const store = storeWith(newRoot(), v1Registry);

    expect(() =>
      store.overwrite(
        { id: 'b', basePath: BASE, schema: 'brief', data, producedBy: provenance },
        3,
      ),
    ).toThrow(/no version 3 to overwrite/);
  });
});

describe('breaking schema change (ART-3)', () => {
  it('migrates data written against the old schema on read', () => {
    const root = newRoot();
    // Written by a build that knew only v1 of the schema.
    new ArtifactStore({ root, schemas: v1Registry }).write({
      id: 'b',
      basePath: BASE,
      schema: 'brief',
      data,
      producedBy: provenance,
    });

    // Read by a build whose schema renamed a field and reshaped a list.
    const migrated = new ArtifactStore({ root, schemas: v2Registry }).read(BASE);

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.data).toStrictEqual({
      problemStatement: 'Loans are tracked on paper.',
      goals: [{ text: 'Digitise loans' }],
    });

    // The file itself is untouched: migration happens on read, so a gated
    // artifact is never rewritten to satisfy a newer schema.
    expect(readFileSync(migrated.path, 'utf8')).toContain('schemaVersion: 1');
  });

  it('refuses data from a schema version this build does not know', () => {
    const root = newRoot();
    new ArtifactStore({ root, schemas: v2Registry }).write({
      id: 'b',
      basePath: BASE,
      schema: 'brief',
      data: { problemStatement: 'x', goals: [] },
      producedBy: provenance,
    });

    expect(() => new ArtifactStore({ root, schemas: v1Registry }).read(BASE)).toThrow(
      /knows versions 1\.\.1/,
    );
  });

  it('derives the schema version from the migration chain', () => {
    expect(briefV1.version).toBe(1);
    expect(briefV2.version).toBe(2);
    expect(v2Registry.currentVersion('brief')).toBe(2);
  });

  it('lists registered families when asked for an unknown one', () => {
    expect(() => v1Registry.get('nope')).toThrow(/Registered: brief/);
  });
});

describe('renderBody', () => {
  it('renders fields as sections and lists', () => {
    const body = renderBody('brief', { problem: 'A problem.', goals: ['One', 'Two'] });

    expect(body).toContain('# brief');
    expect(body).toContain('## problem');
    expect(body).toContain('- One');
  });
});
