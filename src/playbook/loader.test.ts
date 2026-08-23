import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadPlaybookFile,
  parsePlaybook,
  PlaybookLoadError,
  PlaybookRegistry,
} from './loader.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const phasesDir = join(projectRoot, 'phases');

/** A minimal valid playbook, as YAML, with `overrides` spliced in. */
function yaml(body: string): string {
  return body.trimStart();
}

const MINIMAL = yaml(`
phase: sample
description: A sample phase.
artifacts:
  brief:
    schema: brief.v1
    path: artifacts/brief.md
    description: The brief.
tasks:
  - id: draft
    role: analyst
    description: Draft it.
    prompt: Write the brief.
    produces: brief
gate:
  id: sample-gate
  description: The brief exists.
  criteria:
    - id: brief-present
      kind: artifact-exists
      description: A brief exists.
      artifact: brief
`);

describe('the definition playbook', () => {
  // The completion criterion for T1.3.1.
  it('loads and validates', () => {
    const playbook = loadPlaybookFile(join(phasesDir, 'definition.yaml'));

    expect(playbook.phase).toBe('definition');
    expect(playbook.tasks.map((task) => task.id)).toStrictEqual([
      'draft-brief',
      'challenge-brief',
    ]);
    expect(playbook.order).toStrictEqual(['draft-brief', 'challenge-brief']);
    expect(Object.keys(playbook.artifacts)).toStrictEqual([
      'definition-brief',
      'ambiguity-findings',
    ]);
    expect(playbook.gate.criteria).toHaveLength(3);
  });

  it('does not auto-approve its gate', () => {
    // HIL-1: auto-approval only where the operator configured it, so a
    // playbook that says nothing must mean "ask".
    const playbook = loadPlaybookFile(join(phasesDir, 'definition.yaml'));

    expect(playbook.gate.autoApprove).toBe(false);
  });

  it('loads through the registry', () => {
    const registry = PlaybookRegistry.fromDirectory(phasesDir);

    expect(registry.has('definition')).toBe(true);
    expect(registry.get('definition').gate.id).toBe('definition-gate');
  });
});

describe('task ordering', () => {
  it('orders dependencies before dependants', () => {
    const playbook = parsePlaybook(
      'x.yaml',
      MINIMAL.replace(
        '    produces: brief\n',
        `    produces: brief
  - id: review
    role: reviewer
    description: Review it.
    prompt: Review the brief.
    dependsOn: [draft]
`,
      ),
    );

    expect(playbook.order).toStrictEqual(['draft', 'review']);
  });

  it('rejects a dependency cycle rather than hanging at dispatch', () => {
    // A cycle means no task ever becomes ready, which would look like a phase
    // that silently does nothing.
    const cyclic = MINIMAL.replace(
      '    produces: brief\n',
      `    produces: brief
    dependsOn: [review]
  - id: review
    role: reviewer
    description: Review it.
    prompt: Review the brief.
    dependsOn: [draft]
`,
    );

    expect(() => parsePlaybook('x.yaml', cyclic)).toThrow(
      /form a cycle among: draft, review/,
    );
  });
});

describe('cross-reference checks', () => {
  const cases: [string, string, RegExp][] = [
    [
      'a dependency that is not a task',
      MINIMAL.replace(
        '    produces: brief',
        '    produces: brief\n    dependsOn: [ghost]',
      ),
      /depends on 'ghost', which is not a task/,
    ],
    [
      'an artifact that is not declared',
      MINIMAL.replace('produces: brief', 'produces: phantom'),
      /produces 'phantom', which is not a declared artifact/,
    ],
    [
      'a gate criterion naming an undeclared artifact',
      MINIMAL.replace('      artifact: brief', '      artifact: phantom'),
      /names artifact 'phantom', which is not declared/,
    ],
    [
      'a gate criterion naming a task that does not exist',
      MINIMAL.replace(
        `    - id: brief-present
      kind: artifact-exists
      description: A brief exists.
      artifact: brief`,
        `    - id: asserted
      kind: agent-assertion
      description: Something was asserted.
      fromTask: ghost
      field: ok`,
      ),
      /names task 'ghost', which is not a task/,
    ],
  ];

  for (const [label, source, expected] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => parsePlaybook('x.yaml', source)).toThrow(PlaybookLoadError);
      expect(() => parsePlaybook('x.yaml', source)).toThrow(expected);
    });
  }

  it('rejects a task consuming something neither declared nor produced', () => {
    const source = MINIMAL.replace(
      '    produces: brief',
      '    produces: brief\n    consumes: [nowhere]',
    );

    expect(() => parsePlaybook('x.yaml', source)).toThrow(
      /consumes 'nowhere', which is neither a declared input/,
    );
  });

  it('accepts a task consuming a declared input', () => {
    const source = MINIMAL.replace(
      'artifacts:',
      `inputs:
  elicitation:
    schema: elicitation.v1
    path: artifacts/elicitation.md
    description: Prior dialogue.
artifacts:`,
    ).replace('    produces: brief', '    produces: brief\n    consumes: [elicitation]');

    const playbook = parsePlaybook('x.yaml', source);

    expect(Object.keys(playbook.inputs)).toStrictEqual(['elicitation']);
    // Inputs need no producer: the phase reads them, it does not write them.
    expect(playbook.tasks[0]?.consumes).toStrictEqual(['elicitation']);
  });

  it('rejects an artifact nothing produces, which the gate would wait on forever', () => {
    const orphaned = MINIMAL.replace(
      '  brief:',
      `  orphan:
    schema: orphan.v1
    path: artifacts/orphan.md
    description: Nobody writes this.
  brief:`,
    );

    expect(() => parsePlaybook('x.yaml', orphaned)).toThrow(
      /artifact 'orphan' is declared but no task produces it/,
    );
  });

  it('rejects duplicate task ids', () => {
    const duplicated = MINIMAL.replace(
      '    produces: brief\n',
      `    produces: brief
  - id: draft
    role: reviewer
    description: Again.
    prompt: Again.
`,
    );

    expect(() => parsePlaybook('x.yaml', duplicated)).toThrow(
      /duplicate task id 'draft'/,
    );
  });
});

describe('schema errors', () => {
  it('rejects an unknown field rather than ignoring it', () => {
    expect(() => parsePlaybook('x.yaml', `${MINIMAL}\nsuperpowers: true\n`)).toThrow(
      /superpowers/,
    );
  });

  it('reports the field path', () => {
    expect(() =>
      parsePlaybook('x.yaml', MINIMAL.replace('phase: sample', 'phase: Sample')),
    ).toThrow(/phase.*kebab-case/s);
  });

  it('rejects a playbook with no tasks', () => {
    expect(() =>
      parsePlaybook('x.yaml', MINIMAL.replace(/tasks:[\s\S]*?gate:/, 'tasks: []\ngate:')),
    ).toThrow(/tasks/);
  });

  it('reports malformed YAML with a line number', () => {
    expect(() => parsePlaybook('x.yaml', 'phase: "unterminated\n')).toThrow(
      /not valid YAML/,
    );
  });

  it('names the file in every message', () => {
    expect(() => parsePlaybook('phases/broken.yaml', 'phase: 1')).toThrow(
      /phases\/broken\.yaml/,
    );
  });

  it('requires the declared phase to match the file name', () => {
    expect(() => loadPlaybookFile(join(phasesDir, 'definition.yaml'))).not.toThrow();
    expect(() => parsePlaybook('x.yaml', MINIMAL)).not.toThrow();
  });

  it('reports a missing file clearly', () => {
    expect(() => loadPlaybookFile(join(phasesDir, 'nope.yaml'))).toThrow(
      /could not be read/,
    );
  });
});

describe('PlaybookRegistry', () => {
  it('lists loaded phases when asked for one that does not exist', () => {
    const registry = PlaybookRegistry.fromDirectory(phasesDir);

    expect(() => registry.get('scope')).toThrow(/Loaded: definition/);
  });

  it('refuses duplicates', () => {
    const playbook = parsePlaybook('x.yaml', MINIMAL);

    expect(() => new PlaybookRegistry([playbook, playbook])).toThrow(
      /duplicate playbook/,
    );
  });

  it('reports a missing directory clearly', () => {
    expect(() => PlaybookRegistry.fromDirectory(join(projectRoot, 'nowhere'))).toThrow(
      /playbook directory could not be read/,
    );
  });
});
