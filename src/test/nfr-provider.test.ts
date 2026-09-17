import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoundContract } from '../contract/capability.js';
import { commandNfrProvider, NfrProviderError } from './nfr-provider.js';
import { runNfrSuite, testNfrContract, type NfrRequirement } from './nfr.js';

function project(manifest: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mpgm-nfr-provider-'));
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', 'nfr.yaml'), manifest, 'utf8');
  return root;
}

/** A command that really runs and really prints a number. */
function printing(value: number): string {
  return `node\n    args: ['-e', 'console.log(${String(value)})']`;
}

const LATENCY: NfrRequirement = {
  id: 'PERF-1',
  metric: 'p95-latency',
  value: 300,
  unit: 'ms',
  measuredBy: 'k6',
};

describe('commandNfrProvider (T4.3.2, TST-3)', () => {
  it('runs the declared command and reports the number it printed', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: ${printing(250)}
`);
    const contract = new BoundContract(testNfrContract, commandNfrProvider({ root }));

    const result = await contract.invoke('run', {
      repo: 'siajasl/library-loans',
      ref: 'abc123',
      requirementId: 'PERF-1',
      metric: 'p95-latency',
      value: 300,
      unit: 'ms',
      measuredBy: 'k6',
    });

    expect(result).toMatchObject({
      requirementId: 'PERF-1',
      metric: 'p95-latency',
      measured: 250,
      unit: 'ms',
      passed: true,
    });
  });

  it('reads a ceiling and a floor in opposite directions, from the same number', async () => {
    // The contract reserves this judgement to the provider precisely because
    // nothing in a threshold says which way it reads. 250 against 300 holds
    // as a ceiling and fails as a floor, and a provider that returned a fixed
    // verdict would report the same thing for both.
    const manifest = (direction: string) => `
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: ${direction}
    command: ${printing(250)}
`;
    const input = {
      repo: 'siajasl/library-loans',
      ref: 'abc123',
      requirementId: 'PERF-1',
      metric: 'p95-latency',
      value: 300,
      unit: 'ms',
      measuredBy: 'k6',
    };

    const ceiling = await new BoundContract(
      testNfrContract,
      commandNfrProvider({ root: project(manifest('at-most')) }),
    ).invoke<{ passed: boolean }>('run', input);
    const floor = await new BoundContract(
      testNfrContract,
      commandNfrProvider({ root: project(manifest('at-least')) }),
    ).invoke<{ passed: boolean }>('run', input);

    expect(ceiling.passed).toBe(true);
    expect(floor.passed).toBe(false);
  });

  it('folds through runNfrSuite into a coverage report', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: ${printing(900)}
    evidence: reports/latency.json
`);
    const contract = new BoundContract(testNfrContract, commandNfrProvider({ root }));

    const rows = await runNfrSuite({
      repo: 'siajasl/library-loans',
      ref: 'abc123',
      requirements: [LATENCY],
      run: (input) => contract.invoke('run', input),
    });

    expect(rows).toStrictEqual([
      {
        id: 'PERF-1',
        verified: false,
        problem: 'below-threshold',
        measured: 900,
        evidence: 'reports/latency.json',
        verifiedBy: [],
      },
    ]);
  });

  it('refuses a requirement the manifest does not declare, rather than inventing a measurement', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: ${printing(250)}
`);
    const provider = commandNfrProvider({ root });

    await expect(
      new BoundContract(testNfrContract, provider).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'SEC-1',
        metric: 'critical-findings',
        value: 0,
        unit: 'findings',
        measuredBy: 'ZAP',
      }),
    ).rejects.toThrow(
      /declares no measurement for requirement 'SEC-1'.*declares: PERF-1/s,
    );
  });

  it('refuses a manifest entry that has drifted from the threshold it is asked about (CONV-4)', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: s
    direction: at-most
    command: ${printing(0.25)}
`);

    // Same metric, different unit: 0.25s and 300ms are not comparable, and
    // reporting one against the other would verify a threshold nobody
    // measured.
    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/declared as p95-latency in s, but the threshold/);
  });

  it('refuses a command that printed nothing, rather than measuring it as zero (CONV-4)', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: node
    args: ['-e', '']
`);

    // Number('') is 0, and 0 is within every ceiling there is: a command that
    // measured nothing would otherwise verify the requirement.
    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/printed nothing to stdout/);
  });

  it('refuses output whose last line is not a number', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: node
    args: ['-e', 'console.log("p95: fast enough")']
`);

    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(
      /'p95: fast enough' as its last stdout line, which is not a number/,
    );
  });

  it('reports a failing command as unverified, never as a threshold that held', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: node
    args: ['-e', 'process.exit(3)']
`);

    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/failed:/);
  });

  it('names the manifest and its fields when there is none (CONV-3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-nfr-provider-'));
    const provider = commandNfrProvider({ root });

    await expect(
      new BoundContract(testNfrContract, provider).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(NfrProviderError);
    await expect(
      new BoundContract(testNfrContract, provider).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/no NFR measurement manifest at 'test\/nfr\.yaml'.*direction/s);
  });

  it('refuses a manifest that declines to say which way a threshold reads (CONV-5)', async () => {
    const root = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    command: ${printing(250)}
`);

    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc123',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/is malformed/);
  });
});
