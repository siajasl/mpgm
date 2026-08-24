import { describe, expect, it } from 'vitest';
import { PlaybookLoadError } from './errors.js';
import type { SessionStep, TallyStep } from './graph.js';
import { parsePlaybook } from './loader.js';

/**
 * Expansion is exercised through the loader rather than directly: a pattern
 * node that expands correctly but fails the loader's cross-reference checks is
 * still a playbook that will not run.
 */
function playbook(body: string): string {
  return ['phase: scope', 'description: a phase', body].join('\n');
}

const load = (body: string) => parsePlaybook('scope.yaml', playbook(body));

const sessions = (graph: {
  steps: readonly (SessionStep | TallyStep)[];
}): SessionStep[] =>
  graph.steps.filter((step): step is SessionStep => step.kind === 'session');

describe('ordinary tasks', () => {
  it('loads a playbook that names no pattern at all', () => {
    const result = load(`
artifacts:
  brief:
    schema: definition
    path: artifacts/brief.md
    description: the brief
tasks:
  - id: draft
    role: analyst
    description: draft it
    prompt: write the brief
    produces: brief
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: the brief exists
      artifact: brief
`);

    // No `kind:` anywhere, and the graph is the task list unchanged.
    expect(result.graph.steps.map((step) => step.id)).toStrictEqual(['draft']);
    expect(result.graph.terminal).toStrictEqual({ draft: 'draft' });
  });
});

describe('fan-out expansion', () => {
  const body = `
artifacts:
  survey:
    schema: findings
    path: artifacts/survey.md
    description: the survey
tasks:
  - id: seed
    role: analyst
    description: seed it
    prompt: state the question
  - kind: fan-out
    id: prior-art
    description: survey prior art
    dependsOn: [seed]
    workers:
      role: researcher
      prompt: survey prior art for this problem
      count: 3
    collect:
      role: analyst
      prompt: reconcile the surveys
      produces: survey
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: survey exists
      artifact: survey
`;

  it('expands into n workers and a collector', () => {
    const { graph } = load(body);

    expect(graph.steps.map((step) => step.id)).toStrictEqual([
      'seed',
      'prior-art-worker-1',
      'prior-art-worker-2',
      'prior-art-worker-3',
      'prior-art-collect',
    ]);
    expect(graph.terminal['prior-art']).toBe('prior-art-collect');
    expect(graph.members['prior-art']).toHaveLength(4);
  });

  it('runs the workers in parallel and joins them at the collector', () => {
    const { graph } = load(body);
    const byId = new Map(graph.steps.map((step) => [step.id, step]));

    // Every worker waits only on the node's own dependency, so all three are
    // ready at once — the whole point of the primitive.
    for (const index of [1, 2, 3]) {
      expect(byId.get(`prior-art-worker-${String(index)}`)?.dependsOn).toStrictEqual([
        'seed',
      ]);
    }
    expect(byId.get('prior-art-collect')?.dependsOn).toStrictEqual([
      'prior-art-worker-1',
      'prior-art-worker-2',
      'prior-art-worker-3',
    ]);
  });

  it('tells each worker it is one of several working independently', () => {
    const workers = sessions(load(body).graph).filter((step) =>
      step.id.includes('worker'),
    );

    expect(workers[0]?.prompt).toContain('member 1 of 3');
    expect(workers[2]?.prompt).toContain('member 3 of 3');
    expect(workers[0]?.prompt).toContain('must not assume what they');
  });

  it('gives each worker its own lens when lenses are declared', () => {
    const { graph } = load(`
artifacts:
  survey:
    schema: findings
    path: artifacts/survey.md
    description: the survey
tasks:
  - kind: fan-out
    id: review
    description: review it
    workers:
      role: researcher
      prompt: review the design
      lenses: [security, performance, operability]
    collect:
      role: analyst
      prompt: reconcile
      produces: survey
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: survey exists
      artifact: survey
`);

    const workers = sessions(graph).filter((step) => step.id.includes('worker'));
    expect(workers).toHaveLength(3);
    expect(workers[0]?.prompt).toContain('Your assigned lens is: security');
    expect(workers[1]?.prompt).toContain('Your assigned lens is: performance');
    expect(workers[2]?.prompt).toContain('Your assigned lens is: operability');
  });

  it('refuses a member count it cannot determine', () => {
    const withBoth = body.replace(
      '      count: 3',
      '      count: 3\n      lenses: [a, b]',
    );
    expect(() => load(withBoth)).toThrow(/declares both 'count' and 'lenses'/);

    const withNeither = body.replace('      count: 3\n', '');
    expect(() => load(withNeither)).toThrow(/neither 'count' nor 'lenses'/);
  });
});

describe('pipeline expansion', () => {
  it('chains the stages and ends at the last one', () => {
    const { graph } = load(`
artifacts:
  reqs:
    schema: definition
    path: artifacts/reqs.md
    description: requirements
tasks:
  - kind: pipeline
    id: derive
    description: derive requirements
    stages:
      - id: extract
        role: analyst
        description: extract candidate requirements
        prompt: extract them
      - id: dedupe
        role: analyst
        description: remove duplicates
        prompt: dedupe them
      - id: prioritise
        role: analyst
        description: apply MoSCoW
        prompt: prioritise them
        produces: reqs
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: requirements exist
      artifact: reqs
`);

    const byId = new Map(graph.steps.map((step) => [step.id, step]));
    expect([...byId.keys()]).toStrictEqual([
      'derive-extract',
      'derive-dedupe',
      'derive-prioritise',
    ]);
    expect(byId.get('derive-extract')?.dependsOn).toStrictEqual([]);
    expect(byId.get('derive-dedupe')?.dependsOn).toStrictEqual(['derive-extract']);
    expect(byId.get('derive-prioritise')?.dependsOn).toStrictEqual(['derive-dedupe']);
    expect(graph.terminal.derive).toBe('derive-prioritise');
  });

  it('refuses two stages with the same name', () => {
    expect(() =>
      load(`
tasks:
  - kind: pipeline
    id: derive
    description: derive
    stages:
      - { id: a, role: analyst, description: one, prompt: one }
      - { id: a, role: analyst, description: two, prompt: two }
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: agent-assertion
      description: ok
      fromTask: derive
      field: ok
`),
    ).toThrow(/two stages named 'a'/);
  });
});

describe('critic-of expansion', () => {
  const body = (criticRole: string) => `
artifacts:
  brief:
    schema: definition
    path: artifacts/brief.md
    description: the brief
  findings:
    schema: findings
    path: artifacts/findings.md
    description: the findings
tasks:
  - id: draft
    role: analyst
    description: draft it
    prompt: write it
    produces: brief
  - kind: critic-of
    id: challenge
    description: review the draft
    target: draft
    role: ${criticRole}
    prompt: find what is wrong with it
    produces: findings
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: findings exist
      artifact: findings
`;

  it('depends on its target without being told to', () => {
    const { graph } = load(body('reviewer'));
    const critic = graph.steps.find((step) => step.id === 'challenge');

    expect(critic?.dependsOn).toStrictEqual(['draft']);
    expect((critic as SessionStep).prompt).toContain("result of 'draft'");
    expect((critic as SessionStep).prompt).toContain('which you did not');
  });

  it('refuses a critic running the same role as its target', () => {
    // A reviewer sharing the author's role shares its blind spots, so its
    // approval is evidence of consistency rather than of correctness.
    expect(() => load(body('analyst'))).toThrow(/shares its blind spots/);
  });

  it('fans out across lenses and collects, staying independent throughout', () => {
    const { graph } = load(`
artifacts:
  findings:
    schema: findings
    path: artifacts/findings.md
    description: the findings
tasks:
  - id: draft
    role: analyst
    description: draft it
    prompt: write it
  - kind: critic-of
    id: challenge
    description: review the draft
    target: draft
    role: reviewer
    prompt: find what is wrong with it
    lenses: [scalability, security, operability, simplicity]
    collect:
      role: reviewer
      prompt: merge the reviews
      produces: findings
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: findings exist
      artifact: findings
`);

    expect(graph.steps.map((step) => step.id)).toStrictEqual([
      'draft',
      'challenge-lens-1',
      'challenge-lens-2',
      'challenge-lens-3',
      'challenge-lens-4',
      'challenge-collect',
    ]);
    // Every lens reviews the target directly; none waits on another, and none
    // can see what another found.
    for (const index of [1, 2, 3, 4]) {
      expect(
        graph.steps.find((step) => step.id === `challenge-lens-${String(index)}`)
          ?.dependsOn,
      ).toStrictEqual(['draft']);
    }
    expect(graph.terminal.challenge).toBe('challenge-collect');

    const first = graph.steps[1];
    expect(first?.kind === 'session' && first.prompt).toContain(
      'Your assigned lens is: scalability',
    );
    expect(first?.kind === 'session' && first.prompt).toContain("result of 'draft'");
  });

  it('refuses a lensed critic that writes the artifact itself', () => {
    // Each lens sees only its own part of the review, so none of them can
    // write the whole finding set.
    expect(() =>
      load(`
artifacts:
  findings:
    schema: findings
    path: artifacts/findings.md
    description: the findings
tasks:
  - id: draft
    role: analyst
    description: draft it
    prompt: write it
  - kind: critic-of
    id: challenge
    description: review
    target: draft
    role: reviewer
    prompt: review it
    produces: findings
    lenses: [a, b]
    collect: { role: reviewer, prompt: merge }
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: findings exist
      artifact: findings
`),
    ).toThrow(/move 'produces' onto 'collect'/);
  });

  it('refuses a collector on a critic with nothing to collect from', () => {
    expect(() =>
      load(`
tasks:
  - id: draft
    role: analyst
    description: draft it
    prompt: write it
  - kind: critic-of
    id: challenge
    description: review
    target: draft
    role: reviewer
    prompt: review it
    collect: { role: reviewer, prompt: merge }
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: agent-assertion
      description: ok
      fromTask: challenge
      field: ok
`),
    ).toThrow(/nothing to collect from/);
  });

  it('holds the collector to the same independence as the lenses', () => {
    expect(() =>
      load(`
tasks:
  - id: draft
    role: analyst
    description: draft it
    prompt: write it
  - kind: critic-of
    id: challenge
    description: review
    target: draft
    role: reviewer
    prompt: review it
    lenses: [a, b]
    collect: { role: analyst, prompt: merge }
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: agent-assertion
      description: ok
      fromTask: challenge
      field: ok
`),
    ).toThrow(/shares its blind spots/);
  });

  it('refuses a target that does not exist', () => {
    expect(() =>
      load(body('reviewer').replace('target: draft', 'target: ghost')),
    ).toThrow(/targets 'ghost'/);
  });
});

describe('panel expansion', () => {
  const body = `
tasks:
  - kind: panel
    id: select
    description: choose the architecture
    judges:
      role: judge
      prompt: judge the candidates
      count: 3
    ballot:
      type: choice
      field: pick
      options: [event-sourced, crud]
    vote: plurality
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: vote-carried
      description: the panel reached a decision
      panel: select
`;

  it('expands into judges and a kernel tally', () => {
    const { graph } = load(body);

    expect(graph.steps.map((step) => step.id)).toStrictEqual([
      'select-judge-1',
      'select-judge-2',
      'select-judge-3',
      'select-tally',
    ]);
    const tallyStep = graph.steps.at(-1);
    // The tally is not a session: no role, no prompt, no model call.
    expect(tallyStep?.kind).toBe('tally');
    expect(tallyStep).not.toHaveProperty('role');
    expect(tallyStep?.dependsOn).toHaveLength(3);
    expect(graph.terminal.select).toBe('select-tally');
  });

  it('tells each judge which field carries its vote', () => {
    const judges = sessions(load(body).graph);

    expect(judges[0]?.prompt).toContain('`pick`');
    expect(judges[0]?.prompt).toContain('event-sourced, crud');
    expect(judges[0]?.prompt).toContain('spoiled');
  });

  it('states the ballot semantics for an approval panel', () => {
    const judges = sessions(
      load(`
tasks:
  - kind: panel
    id: sign-off
    description: sign off
    judges: { role: judge, prompt: judge it, count: 3 }
    ballot: { type: approval, field: approve }
    vote: unanimous
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: vote-carried
      description: carried
      panel: sign-off
`).graph,
    );

    expect(judges[0]?.prompt).toContain('true to approve, false to reject');
  });

  it('refuses a vote rule that cannot count the ballot', () => {
    expect(() => load(body.replace('vote: plurality', 'vote: majority'))).toThrow(
      /majority over more/,
    );
    expect(() =>
      load(
        body
          .replace('      type: choice\n', '      type: approval\n')
          .replace('      options: [event-sourced, crud]\n', ''),
      ),
    ).toThrow(/under another name/);
  });

  it('refuses to read a kernel tally as an agent assertion', () => {
    expect(() =>
      load(
        body.replace(
          `    - id: c
      kind: vote-carried
      description: the panel reached a decision
      panel: select`,
          `    - id: c
      kind: agent-assertion
      description: the panel reached a decision
      fromTask: select
      field: carried`,
        ),
      ),
    ).toThrow(/counted by the\s+kernel, not asserted by an agent/);
  });
});

describe('graph-level checks', () => {
  it('resolves a dependency on a pattern node to its last step', () => {
    const { graph } = load(`
tasks:
  - kind: fan-out
    id: explore
    description: explore
    workers: { role: researcher, prompt: explore, count: 2 }
    collect: { role: analyst, prompt: reconcile }
  - id: decide
    role: analyst
    description: decide
    prompt: decide
    dependsOn: [explore]
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: agent-assertion
      description: decided
      fromTask: decide
      field: decided
`);

    // "after the fan-out" means after its collector, not after some worker.
    expect(graph.steps.find((step) => step.id === 'decide')?.dependsOn).toStrictEqual([
      'explore-collect',
    ]);
  });

  it('refuses a generated id that collides with a declared task', () => {
    expect(() =>
      load(`
tasks:
  - kind: fan-out
    id: explore
    description: explore
    workers: { role: researcher, prompt: explore, count: 2 }
    collect: { role: analyst, prompt: reconcile }
  - id: explore-collect
    role: analyst
    description: a task that clashes with the collector
    prompt: hello
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: agent-assertion
      description: ok
      fromTask: explore-collect
      field: ok
`),
    ).toThrow(PlaybookLoadError);
  });

  it('names the declared nodes when reporting a cycle, not the generated steps', () => {
    expect(() =>
      load(`
tasks:
  - kind: pipeline
    id: first
    description: first
    dependsOn: [second]
    stages:
      - { id: a, role: analyst, description: a, prompt: a }
      - { id: b, role: analyst, description: b, prompt: b }
  - id: second
    role: analyst
    description: second
    prompt: second
    dependsOn: [first]
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: agent-assertion
      description: ok
      fromTask: second
      field: ok
`),
    ).toThrow(/cycle among: first, second/);
  });

  it('refuses two tasks writing the same artifact', () => {
    expect(() =>
      load(`
artifacts:
  brief:
    schema: definition
    path: artifacts/brief.md
    description: the brief
tasks:
  - kind: pipeline
    id: derive
    description: derive
    stages:
      - { id: a, role: analyst, description: a, prompt: a, produces: brief }
      - { id: b, role: analyst, description: b, prompt: b, produces: brief }
gate:
  id: g
  description: done
  criteria:
    - id: c
      kind: artifact-exists
      description: brief exists
      artifact: brief
`),
    ).toThrow(/produced by more than one task \(derive-a, derive-b\)/);
  });
});
