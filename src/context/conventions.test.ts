import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EGRESS_POLICY } from './egress.js';
import { assembleContext } from './assembler.js';
import {
  conventionTraceIssues,
  duplicateConventionIds,
  parseConventions,
  undeclaredDeviations,
} from './conventions.js';
import { parseKbDocument, type KbDocument } from './knowledge-base.js';

const CONVENTIONS = parseKbDocument(
  'conventions.md',
  [
    '---',
    'title: Conventions',
    'kind: conventions',
    'egress: internal',
    '---',
    '',
    '# Conventions',
    '',
    'Some framing prose that is not a rule.',
    '',
    '- **CONV-1** One logical change per commit, with a body explaining why',
    '  rather than what.',
    '- **CONV-2** Security controls fail closed.',
    '',
    '- not a numbered convention',
  ].join('\n'),
);

const GLOSSARY = parseKbDocument(
  'glossary.md',
  [
    '---',
    'title: Glossary',
    'egress: internal',
    '---',
    '',
    '- **GLOSS-1** Not a rule.',
  ].join('\n'),
);

const task = { description: 'Implement T1.', prompt: 'Do the thing.' };

function assemble(kb: readonly KbDocument[]) {
  return assembleContext({ task, upstream: [], kb, policy: DEFAULT_EGRESS_POLICY });
}

describe('parseConventions', () => {
  it('reads numbered rules and keeps their continuations', () => {
    expect(parseConventions([CONVENTIONS])).toEqual([
      {
        id: 'CONV-1',
        text: 'One logical change per commit, with a body explaining why rather than what.',
        source: 'conventions.md',
      },
      { id: 'CONV-2', text: 'Security controls fail closed.', source: 'conventions.md' },
    ]);
  });

  it('reads only documents that declare themselves conventions', () => {
    // A glossary entry written as a bullet is not a rule to hold people to.
    expect(parseConventions([GLOSSARY])).toEqual([]);
  });

  it('notices ids used twice, which would make a deviation ambiguous', () => {
    const other = parseKbDocument(
      'more.md',
      ['---', 'kind: conventions', '---', '- **CONV-1** Something else.'].join('\n'),
    );

    expect(duplicateConventionIds(parseConventions([CONVENTIONS, other]))).toEqual([
      'CONV-1',
    ]);
  });
});

describe('conventions in an implementation task’s context (CTX-1, IMP-4)', () => {
  it('puts them in front of the agent as binding, with their ids', () => {
    const context = assemble([CONVENTIONS, GLOSSARY]);

    expect(context.conventions).toEqual(['CONV-1', 'CONV-2']);
    expect(context.prompt).toContain('## Conventions');
    expect(context.prompt).toContain('These are binding on this project');
    expect(context.prompt).toContain('**CONV-1**');
    // Both halves of the deviation instruction, because a task whose output
    // has no `deviations` field otherwise has nowhere to put the thought — and
    // puts it in `tracesTo`, which is what broke the Design demo.
    expect(context.prompt).toContain('`deviations` field');
    expect(context.prompt).toContain('Where it has no such field');
    expect(context.prompt).toContain('A convention id is never a trace target');
  });

  it('does not repeat the conventions in the knowledge-base digest', () => {
    const context = assemble([CONVENTIONS, GLOSSARY]);

    expect(context.prompt).toContain('## Knowledge base');
    expect(context.prompt.match(/One logical change per commit/g)).toHaveLength(1);
    expect(context.prompt).toContain('GLOSS-1');
  });

  it('says nothing about conventions when the project has none', () => {
    const context = assemble([GLOSSARY]);

    expect(context.conventions).toEqual([]);
    expect(context.prompt).not.toContain('## Conventions');
  });

  it('still withholds a conventions document the egress policy excludes', () => {
    const restricted = parseKbDocument(
      'secret.md',
      [
        '---',
        'kind: conventions',
        'egress: restricted',
        '---',
        '- **CONV-9** Hidden.',
      ].join('\n'),
    );

    const context = assemble([restricted]);

    expect(context.conventions).toEqual([]);
    expect(context.prompt).not.toContain('CONV-9');
    expect(context.withheld.map((item) => item.path)).toEqual(['secret.md']);
  });
});

describe('undeclaredDeviations', () => {
  it('is the difference between what was found and what was declared', () => {
    expect(undeclaredDeviations(['CONV-1', 'CONV-2'], ['CONV-2'])).toEqual(['CONV-1']);
    expect(undeclaredDeviations(['CONV-1'], ['CONV-1'])).toEqual([]);
    expect(undeclaredDeviations([], ['CONV-1'])).toEqual([]);
  });

  it('does not count the same one twice', () => {
    expect(undeclaredDeviations(['CONV-1', 'CONV-1'], [])).toEqual(['CONV-1']);
  });

  it('matches on the id, however either side glossed it', () => {
    // Every one of these is a string a reviewer actually wrote about the same
    // two rules across six reviews of one task. The author writes its
    // declaration before the review exists, so it cannot spell the gloss the
    // reviewer will choose; comparing whole strings made a declaration match
    // only by luck.
    expect(
      undeclaredDeviations(['CONV-1 (one logical change per commit)'], ['CONV-1']),
    ).toEqual([]);
    expect(
      undeclaredDeviations(['CONV-1'], ['CONV-1 (one logical change per commit)']),
    ).toEqual([]);
    expect(
      undeclaredDeviations(
        ['CONV-5 (express an obligation as unrepresentable rather than checked)'],
        ['CONV-5 (express an obligation as something that cannot be represented)'],
      ),
    ).toEqual([]);
    expect(
      undeclaredDeviations(
        [
          'CONV-6 — every test must be able to fail; a test that passes against ' +
            'the unmodified code reports coverage that does not exist.',
        ],
        ['CONV-6'],
      ),
    ).toEqual([]);
  });

  it('still reports a rule nobody declared, gloss or no gloss', () => {
    expect(
      undeclaredDeviations(['CONV-1 (one logical change per commit)'], ['CONV-2']),
    ).toEqual(['CONV-1 (one logical change per commit)']);
  });

  it('reads an id only where the entry names one, not where it mentions one', () => {
    // The field is called `convention` and holds one: an id at the front is a
    // naming, an id inside a sentence is a reference. Reading a reference as
    // a naming would let a declaration that merely points at another rule
    // excuse a departure from it.
    expect(undeclaredDeviations(['CONV-1'], ['see CONV-1 for context'])).toEqual([
      'CONV-1',
    ]);
  });

  it('reports the reviewer’s wording, not the bare id', () => {
    // The gloss is what tells the author which departure is meant, and the
    // feedback that goes back to it is built from this list.
    expect(undeclaredDeviations(['CONV-1 (one logical change per commit)'], [])).toEqual([
      'CONV-1 (one logical change per commit)',
    ]);
  });

  it('counts two spellings of one id as one deviation', () => {
    expect(
      undeclaredDeviations(['CONV-1', 'CONV-1 (one logical change per commit)'], []),
    ).toEqual(['CONV-1']);
  });

  it('does not excuse a rule the reviewer described without naming', () => {
    // A reviewer who wrote prose with no id named nothing an author could
    // have declared against. Treating that as excused would let the vaguest
    // possible finding be the one that passes.
    expect(
      undeclaredDeviations(['commits should be one logical change'], ['CONV-1']),
    ).toEqual(['commits should be one logical change']);
    // And two unnamed rules are two rules, not one bucket: collapsing every
    // id-less entry onto a single key would let any prose declaration excuse
    // any prose finding.
    expect(
      undeclaredDeviations(
        ['commits should be one logical change'],
        ['tests should be able to fail'],
      ),
    ).toEqual(['commits should be one logical change']);
  });
});

describe('mpgm’s own conventions', () => {
  it('parse, and are all uniquely numbered', () => {
    const path = resolve(import.meta.dirname, '../../kb/conventions.md');
    const document = parseKbDocument('kb/conventions.md', readFileSync(path, 'utf8'));
    const conventions = parseConventions([document]);

    // A conventions file whose rules stopped being readable would silently
    // hold nobody to anything, and every review would find nothing to report.
    expect(conventions.length).toBeGreaterThanOrEqual(6);
    expect(duplicateConventionIds(conventions)).toEqual([]);
  });
});

describe('convention ids are not trace targets (DSG-4, ART-2)', () => {
  const conventions = ['CONV-1', 'CONV-4'];

  it('reports a convention cited where a requirement belongs', () => {
    const issues = conventionTraceIssues(
      {
        adrs: [
          {
            id: 'ADR-3',
            title: 'The kiosk is unauthenticated',
            tracesTo: ['LOAN-6', 'CONV-4'],
          },
        ],
      },
      conventions,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('ADR-3');
    expect(issues[0]).toContain("'CONV-4' is a project convention");
    // The agent is told where the thought does belong, not merely refused.
    expect(issues[0]).toContain('say so in its own text');
  });

  it('finds them wherever they are nested, and in `verifies` too', () => {
    const issues = conventionTraceIssues(
      {
        components: [{ id: 'C1', parts: [{ id: 'C1.1', tracesTo: ['CONV-1'] }] }],
        tests: [{ id: 'T1', verifies: ['CONV-4'] }],
      },
      conventions,
    );

    expect(issues.map((issue) => issue.split(':')[0])).toEqual(['C1.1', 'T1']);
  });

  it('says nothing about requirement ids, however similar they look', () => {
    expect(
      conventionTraceIssues(
        { components: [{ id: 'C1', tracesTo: ['LOAN-1', 'CONV-99', 'NFR-2'] }] },
        conventions,
      ),
    ).toEqual([]);
  });

  it('holds a task only to the conventions it was shown', () => {
    // The set comes from the assembled context, so a task whose conventions
    // were withheld by the egress policy is not held to ids it never saw.
    expect(conventionTraceIssues({ a: { id: 'X', tracesTo: ['CONV-1'] } }, [])).toEqual(
      [],
    );
  });
});
