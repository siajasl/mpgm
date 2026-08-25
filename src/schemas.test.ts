import { describe, expect, it } from 'vitest';
import {
  designCandidateSchema,
  designCandidatesSchema,
  designElementIds,
  designSchema,
  designVerdictSchema,
  planSchema,
  projectArtifactSchemas,
  projectOutputSchemas,
  requirementSchema,
  scopeSchema,
} from './schemas.js';

const functional = {
  kind: 'functional' as const,
  id: 'FUN-1',
  statement: 'The service accepts a job over HTTP.',
  rationale: 'Derived from the Definition goal "submit work remotely".',
  priority: 'must' as const,
  acceptanceCriteria: ['POST /jobs with a valid body returns 202'],
  tracesTo: ['goal: submit work remotely'],
};

const nonFunctional = {
  kind: 'non-functional' as const,
  id: 'NFR-1',
  statement: 'A job is acknowledged quickly under normal load.',
  rationale: 'Derived from the Definition constraint on operator wait time.',
  priority: 'should' as const,
  acceptanceCriteria: ['p95 acknowledgement latency stays within the threshold'],
  tracesTo: ['constraint: operators will not wait'],
  threshold: {
    metric: 'p95 acknowledgement latency',
    value: 200,
    unit: 'ms',
    measuredBy: 'load test at 100 concurrent submitters',
  },
};

const scope = {
  summary: 'Requirements derived from the Definition.',
  requirements: [functional, nonFunctional],
  outOfScope: [{ item: 'A web UI', why: 'The Definition names the CLI as the surface.' }],
};

describe('the requirement schema (SCP-1)', () => {
  it('accepts a functional and a non-functional requirement', () => {
    expect(requirementSchema.safeParse(functional).success).toBe(true);
    expect(requirementSchema.safeParse(nonFunctional).success).toBe(true);
  });

  it('will not express a non-functional requirement without a threshold', () => {
    const { threshold: _omitted, ...unquantified } = nonFunctional;

    // Not a warning and not a lint: SCP-1 makes these thresholds binding on the
    // Test gate (TST-3), so "fast enough" must be unrepresentable rather than
    // merely discouraged.
    expect(requirementSchema.safeParse(unquantified).success).toBe(false);
  });

  it('rejects a threshold nobody can say how to measure', () => {
    const vague = {
      ...nonFunctional,
      threshold: { ...nonFunctional.threshold, measuredBy: '' },
    };

    expect(requirementSchema.safeParse(vague).success).toBe(false);
  });

  it('rejects a requirement with no way to tell whether it has been met', () => {
    expect(
      requirementSchema.safeParse({ ...functional, acceptanceCriteria: [] }).success,
    ).toBe(false);
  });

  it('rejects a requirement traced to nothing', () => {
    expect(requirementSchema.safeParse({ ...functional, tracesTo: [] }).success).toBe(
      false,
    );
  });

  it('rejects an id that downstream artifacts could not cite', () => {
    expect(requirementSchema.safeParse({ ...functional, id: 'req one' }).success).toBe(
      false,
    );
  });
});

describe('the scope schema (SCP-2, SCP-3)', () => {
  it('accepts a complete requirement set', () => {
    expect(scopeSchema.safeParse(scope).success).toBe(true);
  });

  it('rejects duplicate requirement ids', () => {
    const clashing = {
      ...scope,
      requirements: [functional, { ...nonFunctional, id: 'FUN-1' }],
    };
    const result = scopeSchema.safeParse(clashing);

    // Two requirements sharing an id means every downstream trace to it is
    // ambiguous (ART-2).
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unique');
  });

  it('requires an explicit scope boundary', () => {
    expect(scopeSchema.safeParse({ ...scope, outOfScope: [] }).success).toBe(false);
  });

  it('requires at least one requirement', () => {
    expect(scopeSchema.safeParse({ ...scope, requirements: [] }).success).toBe(false);
  });
});

const candidate = {
  stance: 'simplest' as const,
  name: 'Single-process ledger',
  summary: 'One service, one SQLite file, no queue.',
  components: [{ name: 'loan-service', responsibility: 'Records loans and returns.' }],
  keyDecisions: ['Store loans in SQLite on the intranet server.'],
  tradeOffs: [
    { gain: 'Nothing to operate but one process.', cost: 'No horizontal scale.' },
  ],
  risks: ['A single machine failure loses availability until it is restarted.'],
  tracesTo: ['FUN-1'],
};

const design = {
  chosen: 'simplest' as const,
  summary: 'The single-process ledger, as chosen by the panel.',
  components: [
    {
      id: 'C-1',
      name: 'loan-service',
      responsibility: 'Records loans and returns.',
      tracesTo: ['FUN-1'],
    },
  ],
  interfaces: [
    {
      id: 'I-1',
      name: 'POST /loans',
      kind: 'api' as const,
      contract: 'Accepts a member id and a book id; returns the loan record.',
      tracesTo: ['FUN-1'],
    },
  ],
  dataModel: [
    {
      id: 'D-1',
      entity: 'Loan',
      fields: ['id', 'memberId', 'bookId', 'dueAt'],
      notes: '',
    },
  ],
  technologies: [
    {
      id: 'T-1',
      choice: 'SQLite',
      why: 'No service to operate on the intranet box.',
      tracesTo: ['NFR-1'],
    },
  ],
  crossCutting: [
    {
      id: 'X-1',
      concern: 'authn' as const,
      approach: 'School directory SSO.',
      tracesTo: ['FUN-1'],
    },
    {
      id: 'X-2',
      concern: 'authz' as const,
      approach: 'Librarian and member roles.',
      tracesTo: ['FUN-1'],
    },
    {
      id: 'X-3',
      concern: 'observability' as const,
      approach: 'Structured logs on disk.',
      tracesTo: ['NFR-1'],
    },
    {
      id: 'X-4',
      concern: 'failure-modes' as const,
      approach: 'Write-ahead log; restart replays it.',
      tracesTo: ['NFR-1'],
    },
  ],
  adrs: [
    {
      id: 'ADR-1',
      title: 'Store loans in SQLite',
      context: 'One intranet machine, no budget for a database service.',
      decision: 'Use an embedded SQLite database.',
      alternatives: [{ option: 'PostgreSQL', whyNot: 'Another service to operate.' }],
      consequences: ['One writer at a time.'],
      tracesTo: ['NFR-1'],
    },
  ],
};

describe('the design schemas (DSG-1, DSG-2, DSG-4)', () => {
  it('accepts a candidate and a design', () => {
    expect(designCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(designSchema.safeParse(design).success).toBe(true);
  });

  it('will not express a candidate with no stated cost', () => {
    // A candidate with no trade-offs has not been designed, it has been
    // advocated for, and a panel cannot weigh advocacy.
    expect(designCandidateSchema.safeParse({ ...candidate, tradeOffs: [] }).success).toBe(
      false,
    );
  });

  it('requires DSG-1 to be a choice rather than a proposal', () => {
    const set = {
      summary: 'One candidate.',
      candidates: [candidate],
      comparison: [
        {
          dimension: 'operability',
          assessment: [{ stance: 'simplest' as const, note: 'trivial' }],
        },
      ],
    };

    expect(designCandidatesSchema.safeParse(set).success).toBe(false);
  });

  it('rejects two candidates taking the same stance', () => {
    const set = {
      summary: 'Two candidates, one stance.',
      candidates: [candidate, { ...candidate, name: 'Also simple' }],
      comparison: [
        {
          dimension: 'operability',
          assessment: [
            { stance: 'simplest' as const, note: 'a' },
            { stance: 'most-operable' as const, note: 'b' },
          ],
        },
      ],
    };
    const result = designCandidatesSchema.safeParse(set);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('different stance');
  });

  it('makes an element that traces to nothing unrepresentable (DSG-4)', () => {
    const goldPlated = {
      ...design,
      components: [{ ...design.components[0], tracesTo: [] }],
    };

    expect(designSchema.safeParse(goldPlated).success).toBe(false);
  });

  it('makes a design element with no id unrepresentable (ART-2)', () => {
    // The Plan cites these to say what it implements. An element with no id
    // has nothing stable to be cited by, and two Plan runs against the same
    // design invented two different ways to name it.
    const anonymous = {
      ...design,
      components: design.components.map(({ id: _dropped, ...rest }) => rest),
    };

    expect(designSchema.safeParse(anonymous).success).toBe(false);
  });

  it('refuses an id shaped so the trace index would read it as prose', () => {
    const prose = {
      ...design,
      components: [{ ...design.components[0], id: 'loan-service' }],
    };

    expect(designSchema.safeParse(prose).success).toBe(false);
  });

  it('refuses the same id on two elements', () => {
    // Two components rather than a component and an interface: a clash across
    // kinds is already refused by the prefix, so testing it there would pass
    // without the uniqueness rule ever running (CONV-6).
    const clashing = {
      ...design,
      components: [design.components[0], { ...design.components[0], name: 'other' }],
    };
    const result = designSchema.safeParse(clashing);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unique');
  });

  it('lists every id the design declares, for downstream artifacts to cite', () => {
    expect(designElementIds(design)).toStrictEqual([
      'C-1',
      'I-1',
      'D-1',
      'T-1',
      'X-1',
      'X-2',
      'X-3',
      'X-4',
      'ADR-1',
    ]);
  });

  it('requires every cross-cutting concern DSG-2 names', () => {
    const missingAuthz = {
      ...design,
      crossCutting: design.crossCutting.filter((entry) => entry.concern !== 'authz'),
    };
    const result = designSchema.safeParse(missingAuthz);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('authz');
  });

  it('rejects an ADR with no alternatives', () => {
    // An ADR without them cannot be revisited by anyone who was not in the
    // room, which is the only reason to write one down.
    const memo = { ...design, adrs: [{ ...design.adrs[0], alternatives: [] }] };

    expect(designSchema.safeParse(memo).success).toBe(false);
  });

  it('rejects duplicate ADR ids', () => {
    const clashing = { ...design, adrs: [design.adrs[0], design.adrs[0]] };

    expect(designSchema.safeParse(clashing).success).toBe(false);
  });

  it('accepts only the declared stances as a ballot', () => {
    expect(
      designVerdictSchema.safeParse({
        pick: 'simplest',
        reasoning: 'it fits',
        reservations: [],
      }).success,
    ).toBe(true);
    expect(
      designVerdictSchema.safeParse({
        pick: 'whatever',
        reasoning: 'x',
        reservations: [],
      }).success,
    ).toBe(false);
  });
});

const taskA = {
  id: 'T1.1.1',
  title: 'Loan store',
  completionCriteria: ['A recorded loan is readable after restart.'],
  dependsOn: [] as string[],
  tracesTo: ['LOAN-1'],
};

const taskB = {
  id: 'T1.1.2',
  title: 'Loan API',
  completionCriteria: ['POST /loans returns the stored record.'],
  dependsOn: ['T1.1.1'],
  tracesTo: ['LOAN-1'],
};

const milestone = {
  id: 'M1.1',
  title: 'Loan recording',
  verification: 'A loan recorded through the API survives a kill -9.',
  validatesRisk: 'R1' as string | null,
  tasks: [taskA, taskB],
};

const risk = {
  id: 'R1',
  assumption: 'A single SQLite writer keeps up with the issue desk.',
  validatedBy: ['M1.1'],
};

const planPhase = {
  id: 'P1',
  title: 'Walking skeleton',
  intent: 'Prove the risky parts end to end before building breadth.',
  milestones: [milestone],
};

const plan = {
  summary: 'Walking skeleton first, then breadth.',
  risks: [risk],
  phases: [planPhase],
};

/** The same plan with a different task list, so each case states one change. */
const withTasks = (tasks: (typeof milestone)['tasks']): typeof plan => ({
  ...plan,
  phases: [{ ...planPhase, milestones: [{ ...milestone, tasks }] }],
});

/** The same plan with a different milestone. */
const withMilestone = (replacement: typeof milestone): typeof plan => ({
  ...plan,
  phases: [{ ...planPhase, milestones: [replacement] }],
});

describe('the plan schema (PLN-1..3)', () => {
  it('accepts a three-level plan', () => {
    expect(planSchema.safeParse(plan).success).toBe(true);
  });

  it('refuses a plan that could never be scheduled', () => {
    // A cycle means no task ever becomes ready, and the phase would present
    // as one that silently does nothing.
    const cyclic = withTasks([
      { ...taskA, dependsOn: ['T1.1.2'] },
      { ...taskB, dependsOn: ['T1.1.1'] },
    ]);
    const result = planSchema.safeParse(cyclic);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('cycle');
  });

  it('refuses a task that depends on itself', () => {
    const selfish = withTasks([{ ...taskA, dependsOn: ['T1.1.1'] }]);

    expect(planSchema.safeParse(selfish).success).toBe(false);
  });

  it('refuses a dependency on a task nobody declared', () => {
    const ghost = withTasks([{ ...taskA, dependsOn: ['T9.9.9'] }]);

    expect(planSchema.safeParse(ghost).success).toBe(false);
  });

  it('refuses duplicate task ids', () => {
    // A duplicate makes every dependency on it ambiguous.
    const clashing = withTasks([taskA, { ...taskB, id: 'T1.1.1', dependsOn: [] }]);

    expect(planSchema.safeParse(clashing).success).toBe(false);
  });

  it('refuses a task with no way to tell it is finished', () => {
    const vague = withTasks([{ ...taskA, completionCriteria: [] }]);

    expect(planSchema.safeParse(vague).success).toBe(false);
  });

  it('refuses a task the project never agreed to do', () => {
    const untraced = withTasks([{ ...taskA, tracesTo: [] }]);

    expect(planSchema.safeParse(untraced).success).toBe(false);
  });

  it('holds risks and milestones to each other (PLN-2)', () => {
    const orphanRisk = { ...plan, risks: [{ ...risk, validatedBy: ['M9.9'] }] };
    expect(planSchema.safeParse(orphanRisk).success).toBe(false);

    const inventedRisk = withMilestone({ ...milestone, validatesRisk: 'R9' });
    expect(planSchema.safeParse(inventedRisk).success).toBe(false);
  });

  it('requires a milestone to say what must demonstrably work (PLN-3)', () => {
    expect(
      planSchema.safeParse(withMilestone({ ...milestone, verification: '' })).success,
    ).toBe(false);
  });
});

describe('schema registration', () => {
  it('registers scope as both a session output and a stored artifact', () => {
    expect(projectOutputSchemas().has('scope')).toBe(true);
    expect(projectArtifactSchemas().families).toContain('scope');
  });

  it('registers every design schema the playbook names', () => {
    const outputs = projectOutputSchemas();
    for (const id of [
      'design-candidate',
      'design-candidates',
      'design-verdict',
      'design',
    ]) {
      expect(outputs.has(id)).toBe(true);
    }
    expect(projectArtifactSchemas().families).toContain('design');
  });

  it('derives an object-topped JSON Schema for every registered output', () => {
    // Every one of these is handed to the API as a tool input schema, and a
    // top-level union emits `oneOf` with no `type` — refused only after the
    // session has been dispatched.
    const outputs = projectOutputSchemas();
    for (const id of outputs.ids) {
      expect(outputs.jsonSchema(id).type, id).toBe('object');
    }
  });

  it('derives a JSON Schema the structured-output tool can accept', () => {
    // The requirement union is nested inside an object rather than at the top
    // level: a top-level union emits `oneOf` with no `type`, which the API
    // rejects only once the session has been dispatched.
    const json = projectOutputSchemas().jsonSchema('scope');

    expect(json.type).toBe('object');
    expect(json).not.toHaveProperty('$schema');
    const requirements = (json.properties as Record<string, { items?: unknown }>)
      .requirements;
    expect(requirements?.items).toHaveProperty('oneOf');
  });
});
