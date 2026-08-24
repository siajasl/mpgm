import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from '../artifact/schema-registry.js';
import { ArtifactStore } from '../artifact/store.js';
import type { TaskTemplate } from '../playbook/definition.js';
import { assembleContext } from './assembler.js';
import { DEFAULT_EGRESS_POLICY, permitted } from './egress.js';
import { loadKnowledgeBase, parseKbDocument } from './knowledge-base.js';

const tempDirs: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-context-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const task: TaskTemplate = {
  kind: 'task',
  id: 'draft-brief',
  role: 'analyst',
  description: 'Turn elicitation material into a Definition artifact.',
  prompt: 'Produce the Definition artifact from the supplied material.',
  dependsOn: [],
  consumes: [],
  produces: 'definition-brief',
  updatesKb: false,
};

const schemas = new ArtifactSchemaRegistry([
  defineArtifactSchema(
    'brief',
    z.object({ problem: z.string(), goals: z.array(z.string()) }),
  ),
]);

function writeArtifact(root: string, egress?: 'public' | 'internal' | 'restricted') {
  const store = new ArtifactStore({ root, schemas });
  return store.write({
    id: 'definition-brief',
    basePath: 'artifacts/definition/brief.md',
    schema: 'brief',
    data: { problem: 'Loans are tracked on paper.', goals: ['Digitise loans'] },
    producedBy: {
      task: 'draft-brief',
      role: 'analyst',
      model: 'claude-sonnet-5',
      runId: 'r1',
    },
    ...(egress === undefined ? {} : { egress }),
  });
}

describe('assembled context', () => {
  it('matches its expected shape', () => {
    const root = newRoot();
    const artifact = writeArtifact(root);
    const kb = [
      parseKbDocument(
        'glossary.md',
        '---\ntitle: Glossary\negress: internal\n---\n\nArtifact: a versioned document.',
      ),
    ];

    const context = assembleContext({
      task,
      upstream: [artifact],
      kb,
      policy: DEFAULT_EGRESS_POLICY,
    });

    expect(context.prompt).toMatchInlineSnapshot(`
      "## Task

      Turn elicitation material into a Definition artifact.

      Produce the Definition artifact from the supplied material.

      ## Upstream artifacts

      ### definition-brief (v1, schema brief)

      \`\`\`json
      {
        "problem": "Loans are tracked on paper.",
        "goals": [
          "Digitise loans"
        ]
      }
      \`\`\`

      ## Knowledge base

      ### Glossary

      Artifact: a versioned document.
      "
    `);
  });

  it('reports what it included', () => {
    const root = newRoot();
    const context = assembleContext({
      task,
      upstream: [writeArtifact(root)],
      kb: [parseKbDocument('a.md', 'plain')],
      policy: DEFAULT_EGRESS_POLICY,
    });

    expect(context.includedArtifacts).toStrictEqual(['definition-brief']);
    expect(context.includedKb).toStrictEqual(['a.md']);
    expect(context.withheld).toStrictEqual([]);
  });
});

describe('egress filtering (SAF-6)', () => {
  it('excludes a restricted knowledge-base document', () => {
    const secret = parseKbDocument(
      'customers.md',
      '---\ntitle: Customer list\negress: restricted\n---\n\nAda Lovelace, ada@example.com',
    );
    const ordinary = parseKbDocument(
      'glossary.md',
      '---\negress: internal\n---\n\nTerms.',
    );

    const context = assembleContext({
      task,
      upstream: [],
      kb: [secret, ordinary],
      policy: DEFAULT_EGRESS_POLICY,
    });

    expect(context.prompt).not.toContain('Ada Lovelace');
    expect(context.prompt).not.toContain('ada@example.com');
    // Not even the filename reaches the model.
    expect(context.prompt).not.toContain('customers.md');
    expect(context.includedKb).toStrictEqual(['glossary.md']);
  });

  it('tells the model that something was withheld, but not what', () => {
    const secret = parseKbDocument(
      'customers.md',
      '---\negress: restricted\n---\n\nsecret',
    );

    const context = assembleContext({
      task,
      upstream: [],
      kb: [secret],
      policy: DEFAULT_EGRESS_POLICY,
    });

    // Silence would let the agent confabulate around a gap it cannot see.
    expect(context.prompt).toContain('1 item(s) were withheld');
    // The operator and the log get the detail.
    expect(context.withheld).toStrictEqual([
      { path: 'customers.md', egress: 'restricted' },
    ]);
  });

  it('excludes a restricted artifact too, not only knowledge-base files', () => {
    const root = newRoot();
    const artifact = writeArtifact(root, 'restricted');

    const context = assembleContext({
      task,
      upstream: [artifact],
      kb: [],
      policy: DEFAULT_EGRESS_POLICY,
    });

    expect(context.prompt).not.toContain('Loans are tracked on paper.');
    expect(context.includedArtifacts).toStrictEqual([]);
    expect(context.withheld).toHaveLength(1);
  });

  it('round-trips the egress label through the artifact store', () => {
    const root = newRoot();
    writeArtifact(root, 'restricted');

    const reread = new ArtifactStore({ root, schemas }).read(
      'artifacts/definition/brief.md',
    );

    expect(reread.egress).toBe('restricted');
  });

  it('applies the unlabelled default, and honours a fail-closed policy', () => {
    const unlabelled = parseKbDocument('notes.md', 'Some notes.');

    expect(
      assembleContext({
        task,
        upstream: [],
        kb: [unlabelled],
        policy: DEFAULT_EGRESS_POLICY,
      }).includedKb,
    ).toStrictEqual(['notes.md']);

    // A project that wants unlabelled content withheld says so.
    expect(
      assembleContext({
        task,
        upstream: [],
        kb: [unlabelled],
        policy: { maxClass: 'internal', unlabelled: 'restricted' },
      }).includedKb,
    ).toStrictEqual([]);
  });

  it('ranks classes so a stricter policy excludes more', () => {
    expect(permitted('public', { maxClass: 'public', unlabelled: 'internal' })).toBe(
      true,
    );
    expect(permitted('internal', { maxClass: 'public', unlabelled: 'internal' })).toBe(
      false,
    );
    expect(
      permitted('restricted', { maxClass: 'restricted', unlabelled: 'internal' }),
    ).toBe(true);
  });
});

describe('the project knowledge base', () => {
  it('loads every markdown document, recursively', () => {
    const root = newRoot();
    mkdirSync(join(root, 'decisions'), { recursive: true });
    writeFileSync(join(root, 'glossary.md'), '---\ntitle: Glossary\n---\n\nTerms.');
    writeFileSync(
      join(root, 'decisions', 'adr-1.md'),
      '---\ntitle: ADR 1\n---\n\nChose X.',
    );
    writeFileSync(join(root, 'ignored.txt'), 'not markdown');

    const documents = loadKnowledgeBase(root);

    expect(documents.map((doc) => doc.path)).toStrictEqual([
      'decisions/adr-1.md',
      'glossary.md',
    ]);
    expect(documents[1]?.title).toBe('Glossary');
  });

  it('falls back to the path when a document has no title', () => {
    expect(parseKbDocument('notes.md', 'Body only.').title).toBe('notes.md');
    expect(parseKbDocument('notes.md', 'Body only.').egress).toBeUndefined();
  });
});
