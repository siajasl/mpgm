import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoundContract } from '../contract/capability.js';
import { commandNfrProvider, NfrProviderError } from './nfr-provider.js';
import { runNfrSuite, testNfrContract, type NfrRequirement } from './nfr.js';

/**
 * A git checkout with one commit.
 *
 * Real rather than faked: the provider refuses to measure a checkout that is
 * not at the ref it was asked about, and a test that stubbed `git` would
 * assert that refusal against its own stub rather than against what git says
 * this directory is.
 */
function commit(root: string, message: string): string {
  const env = {
    ...process.env,
    // Isolated from whoever is running the suite: a global `commit.gpgsign`
    // or hook path would otherwise decide whether this test can run.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'mpgm test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'mpgm test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const run = (args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
  if (!existsSync(join(root, '.git'))) {
    run(['init', '-q', '-b', 'main']);
  }
  run(['add', '-A']);
  run(['commit', '-q', '--no-gpg-sign', '-m', message]);
  return run(['rev-parse', 'HEAD']);
}

/** The project root, and the commit it is at — what `--ref` must name. */
function project(manifest: string): { root: string; ref: string } {
  const root = mkdtempSync(join(tmpdir(), 'mpgm-nfr-provider-'));
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', 'nfr.yaml'), manifest, 'utf8');
  return { root, ref: commit(root, 'declare the measurements') };
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
    const { root, ref } = project(`
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
      ref,
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
    const input = (ref: string) => ({
      repo: 'siajasl/library-loans',
      ref,
      requirementId: 'PERF-1',
      metric: 'p95-latency',
      value: 300,
      unit: 'ms',
      measuredBy: 'k6',
    });

    const atMost = project(manifest('at-most'));
    const atLeast = project(manifest('at-least'));
    const ceiling = await new BoundContract(
      testNfrContract,
      commandNfrProvider({ root: atMost.root }),
    ).invoke<{ passed: boolean }>('run', input(atMost.ref));
    const floor = await new BoundContract(
      testNfrContract,
      commandNfrProvider({ root: atLeast.root }),
    ).invoke<{ passed: boolean }>('run', input(atLeast.ref));

    expect(ceiling.passed).toBe(true);
    expect(floor.passed).toBe(false);
  });

  it('folds through runNfrSuite into a coverage report', async () => {
    const { root, ref } = project(`
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
      ref,
      requirements: [LATENCY],
      run: (input) => contract.invoke('run', input),
    });

    expect(rows).toStrictEqual([
      {
        id: 'PERF-1',
        verified: false,
        problem: 'below-threshold',
        measured: 900,
        // The declared evidence, and what was actually measured: the row says
        // which checkout produced the number, not only which one the caller
        // asked about.
        evidence: `reports/latency.json — measured siajasl/library-loans@${ref}`,
        verifiedBy: [],
      },
    ]);
  });

  it('refuses a requirement the manifest does not declare, rather than inventing a measurement', async () => {
    const { root, ref } = project(`
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
        ref,
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
    const { root, ref } = project(`
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
        ref,
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/declared as p95-latency in s, but the threshold/);
  });

  it('refuses a command that printed nothing, rather than measuring it as zero (CONV-4)', async () => {
    const { root, ref } = project(`
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
        ref,
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/printed nothing to stdout/);
  });

  it('refuses output whose last line is not a number', async () => {
    const { root, ref } = project(`
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
        ref,
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
    const { root, ref } = project(`
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
        ref,
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
    writeFileSync(join(root, 'README'), 'no manifest here\n', 'utf8');
    const ref = commit(root, 'a project that declares no measurements');
    const provider = commandNfrProvider({ root });

    await expect(
      new BoundContract(testNfrContract, provider).invoke('run', {
        repo: 'siajasl/library-loans',
        ref,
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
        ref,
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/no NFR measurement manifest at 'test\/nfr\.yaml'.*direction/s);
  });

  it('refuses a manifest that declines to say which way a threshold reads (CONV-5)', async () => {
    const { root, ref } = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    command: ${printing(250)}
`);

    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref,
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/is malformed/);
  });

  it('refuses to measure a checkout that is not at the ref it was asked about (CONV-4)', async () => {
    // The wrong-commit case the phase's own `--repo`/`--ref` block exists to
    // prevent, and which the provider used to walk straight past: the numbers
    // would be measurements of this working tree, filed as measurements of
    // the ref the operator named.
    const { root, ref } = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: ${printing(250)}
`);
    writeFileSync(join(root, 'CHANGED'), 'a later commit\n', 'utf8');
    const later = commit(root, 'move the checkout on');
    expect(later).not.toBe(ref);

    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref,
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(
      new RegExp(
        `refusing to measure .*it is at commit ${later}.*ref '${ref}' is commit ${ref}` +
          `.*--ref ${later}`,
        's',
      ),
    );
  });

  it('accepts a ref the checkout resolves to HEAD — a branch, not only a sha', async () => {
    const { root } = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: ${printing(250)}
`);

    const result = await new BoundContract(
      testNfrContract,
      commandNfrProvider({ root }),
    ).invoke<{ passed: boolean }>('run', {
      repo: 'siajasl/library-loans',
      ref: 'main',
      requirementId: 'PERF-1',
      metric: 'p95-latency',
      value: 300,
      unit: 'ms',
      measuredBy: 'k6',
    });

    expect(result.passed).toBe(true);
  });

  it('refuses a root whose commit cannot be read at all, rather than labelling it with a ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-nfr-provider-'));
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(
      join(root, 'test', 'nfr.yaml'),
      `measurements:\n` +
        `  - requirement: PERF-1\n` +
        `    metric: p95-latency\n` +
        `    unit: ms\n` +
        `    direction: at-most\n` +
        `    command: ${printing(250)}\n`,
      'utf8',
    );

    await expect(
      new BoundContract(testNfrContract, commandNfrProvider({ root })).invoke('run', {
        repo: 'siajasl/library-loans',
        ref: 'abc1234',
        requirementId: 'PERF-1',
        metric: 'p95-latency',
        value: 300,
        unit: 'ms',
        measuredBy: 'k6',
      }),
    ).rejects.toThrow(/cannot establish which commit .* rev-parse HEAD' failed/s);
  });

  it('records an uncommitted change in evidence rather than passing the tree off as the ref', async () => {
    // Not a refusal: a phase writes its own artifacts into the root as it
    // runs. But the row says the tree it measured was not the commit as
    // committed, which is the disagreement that would otherwise go unrecorded.
    const { root, ref } = project(`
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most
    command: ${printing(250)}
`);
    writeFileSync(join(root, 'artifact.md'), 'written by the phase\n', 'utf8');

    const result = await new BoundContract(
      testNfrContract,
      commandNfrProvider({ root }),
    ).invoke<{ evidence: string }>('run', {
      repo: 'siajasl/library-loans',
      ref,
      requirementId: 'PERF-1',
      metric: 'p95-latency',
      value: 300,
      unit: 'ms',
      measuredBy: 'k6',
    });

    expect(result.evidence).toContain(`measured siajasl/library-loans@${ref}`);
    expect(result.evidence).toContain('working tree modified');
  });
});
