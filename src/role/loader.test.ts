import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoleFile, parseRole, RoleLoadError, RoleRegistry } from './loader.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const valid = join(fixtures, 'valid');
const invalid = join(fixtures, 'invalid');

describe('loadRoleFile', () => {
  it('loads frontmatter and system prompt', () => {
    const role = loadRoleFile(join(valid, 'analyst.md'));

    expect(role.name).toBe('analyst');
    expect(role.model).toBe('claude-sonnet-5');
    expect(role.tools.allow).toStrictEqual(['Read', 'Grep', 'Glob']);
    expect(role.paths.write).toStrictEqual(['artifacts/definition/**']);
    expect(role.budgets).toStrictEqual({
      tokens: 200000,
      costUsd: 5,
      steps: 40,
      wallClockSeconds: 900,
    });
    expect(role.output.schema).toBe('schemas/definition.json');
    expect(role.systemPrompt).toContain('You are the analyst');
    expect(role.sourcePath).toContain('analyst.md');
  });

  it('defaults an undeclared toolset to nothing, so roles fail closed', () => {
    const role = parseRole(
      'inline.md',
      [
        '---',
        'name: inline',
        'description: no tools declared',
        'model: claude-sonnet-5',
        'budgets: { tokens: 1, costUsd: 1, steps: 1, wallClockSeconds: 1 }',
        'output: { schema: s.json }',
        '---',
        'Body.',
      ].join('\n'),
    );

    expect(role.tools.allow).toStrictEqual([]);
    expect(role.paths).toStrictEqual({ read: [], write: [] });
  });
});

describe('actionable errors', () => {
  /** Each case: fixture, and a phrase the message must contain to be useful. */
  const cases = [
    ['no-frontmatter.md', /must begin with a line containing exactly "---"/],
    ['bad-yaml.md', /not valid YAML/],
    ['missing-budget.md', /budgets/],
    ['unknown-field.md', /superpowers/],
    ['name-mismatch.md', /declares name 'something-else'.*named 'name-mismatch\.md'/s],
    ['empty-body.md', /body after the frontmatter is the system prompt/],
  ] as const;

  for (const [file, expected] of cases) {
    it(`rejects ${file} with an error that says what is wrong`, () => {
      expect(() => loadRoleFile(join(invalid, file))).toThrow(RoleLoadError);
      expect(() => loadRoleFile(join(invalid, file))).toThrow(expected);
    });
  }

  it('names the offending file in every message', () => {
    for (const [file] of cases) {
      expect(() => loadRoleFile(join(invalid, file))).toThrow(new RegExp(file));
    }
  });

  it('reports the field path for a schema violation', () => {
    expect(() =>
      parseRole(
        'x.md',
        [
          '---',
          'name: x',
          'description: bad budget',
          'model: claude-sonnet-5',
          'budgets: { tokens: -1, costUsd: 1, steps: 1, wallClockSeconds: 1 }',
          'output: { schema: s.json }',
          '---',
          'Body.',
        ].join('\n'),
      ),
    ).toThrow(/budgets\.tokens/);
  });

  it('rejects a name that is not kebab-case, and says what is wanted', () => {
    expect(() =>
      parseRole(
        'x.md',
        [
          '---',
          'name: Design_Critic',
          'description: bad name',
          'model: claude-sonnet-5',
          'budgets: { tokens: 1, costUsd: 1, steps: 1, wallClockSeconds: 1 }',
          'output: { schema: s.json }',
          '---',
          'Body.',
        ].join('\n'),
      ),
    ).toThrow(/kebab-case/);
  });

  it('reports a missing file rather than failing obscurely', () => {
    expect(() => loadRoleFile(join(valid, 'nope.md'))).toThrow(/could not be read/);
  });
});

describe('RoleRegistry', () => {
  it('loads every role in a directory', () => {
    const registry = RoleRegistry.fromDirectory(valid);

    expect(registry.names).toStrictEqual(['analyst', 'reviewer']);
    expect(registry.get('reviewer').model).toBe('claude-opus-5');
    expect(registry.has('analyst')).toBe(true);
  });

  it('lists known roles when asked for one that does not exist', () => {
    const registry = RoleRegistry.fromDirectory(valid);

    expect(() => registry.get('nobody')).toThrow(/Loaded roles: analyst, reviewer/);
  });

  it('refuses duplicates', () => {
    const role = loadRoleFile(join(valid, 'analyst.md'));

    expect(() => new RoleRegistry([role, role])).toThrow(/duplicate role 'analyst'/);
  });

  it('fails the whole directory load if any role is invalid', () => {
    expect(() => RoleRegistry.fromDirectory(invalid)).toThrow(RoleLoadError);
  });

  it('reports a missing directory clearly', () => {
    expect(() => RoleRegistry.fromDirectory(join(fixtures, 'nowhere'))).toThrow(
      /role directory could not be read/,
    );
  });
});
