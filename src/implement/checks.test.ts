import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BoundContract,
  CapabilityRegistry,
  ContractError,
} from '../contract/capability.js';
import {
  blockingReasons,
  ciChecksContract,
  MergeBlockedError,
  mergeVerdict,
  requireMergeable,
  REQUIRED_CHECK_KINDS,
  type CheckRun,
} from './checks.js';
import { fetchCheckRuns, githubChecksProvider } from './github-checks.js';

function run(name: string, conclusion: CheckRun['conclusion'] = 'success'): CheckRun {
  return { name, status: 'completed', conclusion, url: '' };
}

/** Every required kind green, as a starting point to spoil one at a time. */
function allGreen(): CheckRun[] {
  return [
    run('build'),
    run('lint'),
    run('typecheck'),
    run('test (node 24.x)'),
    run('test (node 26.x)'),
    run('scan'),
  ];
}

describe('mergeVerdict', () => {
  it('allows a merge when every required kind passed', () => {
    const verdict = mergeVerdict({ ref: 'abc', runs: allGreen() });

    expect(verdict.mergeable).toBe(true);
    expect(verdict.summary).toBe('all required checks passed');
    expect(verdict.kinds.map((kind) => kind.kind)).toEqual([...REQUIRED_CHECK_KINDS]);
  });

  // T3.1.2a completion criterion: red CI blocks merge.
  it.each([...REQUIRED_CHECK_KINDS])('blocks the merge when %s fails', (kind) => {
    const runs = allGreen().map((check) =>
      check.name.startsWith(kind) ? run(check.name, 'failure') : check,
    );

    const verdict = mergeVerdict({ ref: 'abc', runs });

    expect(verdict.mergeable).toBe(false);
    expect(verdict.summary).toContain(`failing: ${kind}`);
    expect(() => {
      requireMergeable(verdict);
    }).toThrow(MergeBlockedError);
  });

  it('blocks the merge when a required check never ran', () => {
    const verdict = mergeVerdict({
      ref: 'abc',
      runs: allGreen().filter((check) => check.name !== 'scan'),
    });

    expect(verdict.mergeable).toBe(false);
    expect(blockingReasons(verdict)).toEqual(['scan: no check reported a result']);
  });

  it('blocks on an empty report rather than reading silence as success', () => {
    const verdict = mergeVerdict({ ref: 'abc', runs: [] });

    expect(verdict.mergeable).toBe(false);
    expect(blockingReasons(verdict)).toHaveLength(REQUIRED_CHECK_KINDS.length);
  });

  it('does not accept a skipped check as a pass', () => {
    // SAF-5: a scan that was skipped is not a scan.
    const runs = allGreen().map((check) =>
      check.name === 'scan' ? run('scan', 'skipped') : check,
    );

    const verdict = mergeVerdict({ ref: 'abc', runs });

    expect(verdict.mergeable).toBe(false);
    expect(blockingReasons(verdict)).toEqual(['scan: no check reported a result']);
  });

  it('waits for a check that is still running', () => {
    const runs: CheckRun[] = allGreen().map((check) =>
      check.name === 'build'
        ? { ...check, status: 'in_progress', conclusion: null }
        : check,
    );

    const verdict = mergeVerdict({ ref: 'abc', runs });

    expect(verdict.mergeable).toBe(false);
    expect(verdict.summary).toContain('pending: build');
  });

  it('blocks on a failing check that covers no required kind', () => {
    const runs = [...allGreen(), run('licence-audit', 'failure')];

    const verdict = mergeVerdict({ ref: 'abc', runs });

    expect(verdict.mergeable).toBe(false);
    expect(verdict.summary).toContain('other failing checks: licence-audit');
    expect(blockingReasons(verdict)).toEqual(['licence-audit: failing']);
  });

  it('needs every covering run, not just one, to be clean', () => {
    const runs = allGreen().map((check) =>
      check.name === 'test (node 26.x)' ? run(check.name, 'failure') : check,
    );

    expect(mergeVerdict({ ref: 'abc', runs }).mergeable).toBe(false);
  });

  it('takes the mapping from the project, not from the check names', () => {
    // One job covering everything — the arrangement a project that has not
    // split its workflow will have (EXT-2/3).
    const verdict = mergeVerdict({
      ref: 'abc',
      runs: [run('everything')],
      mapping: [{ pattern: '^everything$', covers: [...REQUIRED_CHECK_KINDS] }],
    });

    expect(verdict.mergeable).toBe(true);
  });
});

describe('ci.checks contract', () => {
  it('validates what a provider returns', async () => {
    const registry = new CapabilityRegistry();
    const bound = registry.bind(ciChecksContract, {
      status: () =>
        Promise.resolve({ ref: 'abc', runs: [{ name: 'build', status: 'nonsense' }] }),
    });

    await expect(bound.invoke('status', { repo: 'o/r', ref: 'abc' })).rejects.toThrow(
      ContractError,
    );
  });

  it('refuses a provider that does not implement the contract', () => {
    expect(() => new BoundContract(ciChecksContract, {})).toThrow(ContractError);
  });

  it('refuses to guess when no provider is bound', () => {
    expect(() => new CapabilityRegistry().require('ci.checks')).toThrow(ContractError);
  });

  it('carries GitHub check runs through to a verdict', async () => {
    const page = {
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'u1' },
        { name: 'scan', status: 'completed', conclusion: 'failure', html_url: 'u2' },
        {
          name: 'test (node 24.x)',
          status: 'in_progress',
          conclusion: null,
          html_url: 'u3',
        },
      ],
    };
    const registry = new CapabilityRegistry();
    const bound = registry.bind(
      ciChecksContract,
      githubChecksProvider({ api: () => Promise.resolve(JSON.stringify([page])) }),
    );

    const status = await bound.invoke<{ ref: string; runs: CheckRun[] }>('status', {
      repo: 'siajasl/mpgm',
      ref: 'abc',
    });
    const verdict = mergeVerdict({ ref: status.ref, runs: status.runs });

    expect(verdict.mergeable).toBe(false);
    expect(blockingReasons(verdict)).toEqual([
      'lint: no check reported a result',
      'typecheck: no check reported a result',
      'test: pending (test (node 24.x))',
      'scan: failing (scan)',
    ]);
  });
});

describe('github check runs', () => {
  it('reads every page rather than the first', async () => {
    const pages = [
      { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
      { check_runs: [{ name: 'scan', status: 'completed', conclusion: 'success' }] },
    ];

    const runs = await fetchCheckRuns('o/r', 'abc', {
      api: () => Promise.resolve(JSON.stringify(pages)),
    });

    expect(runs.map((check) => check.name)).toEqual(['build', 'scan']);
  });

  it('treats a status it has never seen as "no result yet"', async () => {
    const runs = await fetchCheckRuns('o/r', 'abc', {
      api: () =>
        Promise.resolve(
          JSON.stringify({
            check_runs: [{ name: 'build', status: 'waiting', conclusion: null }],
          }),
        ),
    });

    expect(runs[0]).toMatchObject({ status: 'queued', conclusion: null });
  });

  it('treats a conclusion it has never seen as a failure', async () => {
    const runs = await fetchCheckRuns('o/r', 'abc', {
      api: () =>
        Promise.resolve(
          JSON.stringify({
            check_runs: [{ name: 'scan', status: 'completed', conclusion: 'exploded' }],
          }),
        ),
    });

    expect(runs[0]?.conclusion).toBe('failure');
    expect(mergeVerdict({ ref: 'abc', runs }).mergeable).toBe(false);
  });
});

describe('capability registry', () => {
  it('binds a capability once', () => {
    const registry = new CapabilityRegistry();
    const spec = {
      name: 'test.thing',
      summary: 'a thing',
      operations: [
        {
          name: 'go',
          summary: 'go',
          input: z.object({}),
          output: z.object({}),
          effects: 'read-only' as const,
        },
      ],
    };
    registry.bind(spec, { go: () => Promise.resolve({}) });

    expect(registry.names()).toEqual(['test.thing']);
    expect(() => registry.bind(spec, { go: () => Promise.resolve({}) })).toThrow(
      ContractError,
    );
  });
});
