import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { designStances } from '../schemas.js';
import type { Playbook } from './graph.js';
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
      'survey-prior-art',
      'draft-brief',
      'challenge-brief',
    ]);
    expect(playbook.order).toStrictEqual([
      'survey-prior-art',
      'draft-brief',
      'challenge-brief',
    ]);
    expect(Object.keys(playbook.artifacts)).toStrictEqual([
      'prior-art',
      'definition-brief',
      'ambiguity-findings',
    ]);
    expect(playbook.gate.criteria.map((criterion) => criterion.id)).toStrictEqual([
      'prior-art-surveyed',
      'brief-present',
      'findings-present',
      'ambiguities-resolved',
    ]);
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

describe('the scope playbook', () => {
  const playbook = (): Playbook => loadPlaybookFile(join(phasesDir, 'scope.yaml'));

  it('expands its SCP-3 review into one critic per lens plus a collector', () => {
    const { graph } = playbook();

    expect(graph.steps.map((step) => step.id)).toStrictEqual([
      'derive-requirements',
      'flag-issues-worker-1',
      'flag-issues-worker-2',
      'flag-issues-worker-3',
      'flag-issues-collect',
    ]);
    // SCP-3 names three pathologies; one critic each, and none of them can see
    // what the others found.
    for (const index of [1, 2, 3]) {
      expect(
        graph.steps.find((step) => step.id === `flag-issues-worker-${String(index)}`)
          ?.dependsOn,
      ).toStrictEqual(['derive-requirements']);
    }
  });

  it('gives each critic a different pathology to look for', () => {
    const prompts = playbook()
      .graph.steps.filter((step) => step.id.includes('worker'))
      .map((step) => (step.kind === 'session' ? step.prompt : ''));

    expect(prompts[0]).toContain('Conflicts');
    expect(prompts[1]).toContain('Duplicates');
    expect(prompts[2]).toContain('Acceptance-criteria gaps');
  });

  it('gates on the collector attestation, not on the review having run', () => {
    const criterion = playbook().gate.criteria.find(
      (entry) => entry.id === 'issues-resolved',
    );

    expect(criterion).toMatchObject({
      kind: 'agent-assertion',
      fromTask: 'flag-issues',
      field: 'allResolved',
    });
    expect(playbook().gate.autoApprove).toBe(false);
  });

  it('cannot run without a gated Definition to derive from', () => {
    expect(playbook().inputs['definition-brief']?.optional).toBe(false);
  });

  it('shows the collector the requirement set it is merging reviews of', () => {
    // The collector depends on the workers, not on the derivation, so the
    // requirement set reaches it only by being named in `consumes`.
    const collector = playbook().graph.steps.find(
      (step) => step.id === 'flag-issues-collect',
    );

    expect(collector?.kind === 'session' && collector.consumes).toContain(
      'requirement-set',
    );
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

    // Asserted against what the registry actually loaded, so adding a phase
    // is not a reason for this test to fail.
    expect(() => registry.get('deploy')).toThrow(
      new RegExp(`Loaded: ${registry.phases.join(', ')}`),
    );
    expect(registry.phases.length).toBeGreaterThan(1);
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

describe('the design playbook', () => {
  const playbook = (): Playbook => loadPlaybookFile(join(phasesDir, 'design.yaml'));

  it('generates candidates in parallel and judges them with a panel', () => {
    const { graph } = playbook();

    expect(graph.steps.map((step) => step.id)).toStrictEqual([
      'propose-candidates-worker-1',
      'propose-candidates-worker-2',
      'propose-candidates-worker-3',
      'propose-candidates-collect',
      'select-candidate-judge-1',
      'select-candidate-judge-2',
      'select-candidate-judge-3',
      'select-candidate-tally',
      'record-design',
      'review-design-lens-1',
      'review-design-lens-2',
      'review-design-lens-3',
      'review-design-lens-4',
      'review-design-collect',
    ]);
    // DSG-1: at least two candidates, generated without seeing each other.
    expect(graph.members['propose-candidates']).toHaveLength(4);
  });

  it('votes on exactly the stances it generates candidates for', () => {
    const panel = playbook().tasks.find((node) => node.id === 'select-candidate');
    const workers = playbook()
      .graph.steps.filter((step) => step.id.startsWith('propose-candidates-worker'))
      .map((step) => (step.kind === 'session' ? step.prompt : ''));

    // Three places have to agree: the ballot, the lenses that generate the
    // candidates, and `designStances`. A ballot offering an option nobody
    // generated is a vote for nothing.
    const options =
      panel?.kind === 'panel' && panel.ballot.type === 'choice'
        ? panel.ballot.options
        : [];

    expect(options).toStrictEqual([...designStances]);
    for (const [index, id] of designStances.entries()) {
      expect(workers[index]).toContain(`Stance id \`${id}\``);
    }
  });

  it('judges vote alone: no judge depends on another', () => {
    const judges = playbook().graph.steps.filter((step) =>
      step.id.startsWith('select-candidate-judge'),
    );

    for (const judge of judges) {
      expect(judge.dependsOn).toStrictEqual(['propose-candidates-collect']);
    }
  });

  it('reads the panel result as a kernel count, not as an agent assertion', () => {
    const criterion = playbook().gate.criteria.find(
      (entry) => entry.id === 'selection-decided',
    );

    expect(criterion).toMatchObject({ kind: 'vote-carried', panel: 'select-candidate' });
    expect(playbook().gate.autoApprove).toBe(false);
  });

  it('reviews the design along the four DSG-3 lenses, independently', () => {
    const { graph } = playbook();
    const lenses = graph.steps.filter((step) => step.id.startsWith('review-design-lens'));

    // Four reviews rather than one reviewer with a longer checklist, and each
    // waits only on the design — none can see what another found.
    expect(lenses).toHaveLength(4);
    for (const lens of lenses) {
      expect(lens.dependsOn).toStrictEqual(['record-design']);
      expect(lens.kind === 'session' && lens.role).toBe('design-critic');
    }
    const prompts = lenses.map((lens) => (lens.kind === 'session' ? lens.prompt : ''));
    for (const [index, named] of [
      'Scalability',
      'Security',
      'Operability',
      'Simplicity',
    ].entries()) {
      expect(prompts[index]).toContain(named);
    }
  });

  it('keeps the reviewers out of the architect role they are attacking', () => {
    // Enforced by the loader, not by convention: `critic-of` refuses a critic
    // whose role also produced the target.
    const review = playbook().tasks.find((node) => node.id === 'review-design');
    const architect = playbook().tasks.find((node) => node.id === 'record-design');

    expect(review?.kind === 'critic-of' && review.role).not.toBe(
      architect?.kind === 'task' && architect.role,
    );
    expect(review?.kind === 'critic-of' && review.collect?.role).toBe('design-critic');
  });

  it('gates on the review attestation, not on the review having run', () => {
    const criterion = playbook().gate.criteria.find(
      (entry) => entry.id === 'findings-resolved',
    );

    expect(criterion).toMatchObject({
      kind: 'agent-assertion',
      fromTask: 'review-design',
      field: 'allResolved',
    });
  });

  it('shows the architect the candidates as well as the tally', () => {
    // The architect depends on the tally, which produces no artifact, so the
    // candidates reach it only by being named in `consumes`.
    const architect = playbook().graph.steps.find((step) => step.id === 'record-design');

    expect(architect?.kind === 'session' && architect.consumes).toStrictEqual([
      'requirement-set',
      'design-candidates',
    ]);
    expect(architect?.dependsOn).toStrictEqual(['select-candidate-tally']);
  });
});

describe('the plan playbook', () => {
  const playbook = (): Playbook => loadPlaybookFile(join(phasesDir, 'plan.yaml'));

  it('decomposes, then reviews along three lenses', () => {
    const { graph } = playbook();

    expect(graph.steps.map((step) => step.id)).toStrictEqual([
      'decompose',
      'review-plan-lens-1',
      'review-plan-lens-2',
      'review-plan-lens-3',
      'review-plan-collect',
    ]);
  });

  it('checks at the gate only what the schema cannot (PLN-1)', () => {
    const kinds = playbook().gate.criteria.map((criterion) => criterion.kind);

    // Acyclicity, unique ids and resolvable dependencies are schema
    // refinements: a plan failing them cannot be scheduled at all, so it must
    // not be storable. Whether its citations point at things that *exist* is
    // a fact about other artifacts, so it is checked here.
    expect(kinds).toStrictEqual([
      'artifact-exists',
      'traces-resolve',
      'artifact-exists',
      'agent-assertion',
    ]);
    expect(
      playbook().gate.criteria.find((criterion) => criterion.kind === 'traces-resolve'),
    ).toMatchObject({ artifact: 'plan' });
  });

  it('cannot run without both gated upstream artifacts', () => {
    const inputs = playbook().inputs;

    expect(Object.keys(inputs)).toStrictEqual(['requirement-set', 'design']);
    expect(Object.values(inputs).every((input) => !input.optional)).toBe(true);
  });
});
