import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import type { DeployGateOptions } from '../policy/deploy-gate.js';
import {
  ComposeProviderError,
  UndeclaredEnvironmentError,
  composeProvider,
  gatedEnvironmentNames,
  gatedEnvironments,
  loadDeclaredEnvironments,
  parseComposePs,
  type ComposeCli,
  type ComposeCliResult,
} from './compose-provider.js';

/**
 * `Provider`'s handlers are looked up by name (`noUncheckedIndexedAccess`), so
 * a test calling `provider.up(...)` gets a value TypeScript cannot promise is
 * there. Asserting it non-null would just be trusting the same thing this
 * helper checks — and checks with a message naming which operation vanished,
 * rather than a bare "possibly undefined" the test runner would otherwise
 * report instead of the operation actually under test.
 */
function operation(provider: Provider, name: string): (input: never) => Promise<unknown> {
  const fn = provider[name];
  if (fn === undefined) {
    throw new Error(`composeProvider does not implement '${name}'`);
  }
  return fn;
}

/**
 * `composeProvider`'s `gate` is required construction as of T4.1.4's second
 * rework (mirrors `dockerReleaseProvider`'s `noProductionGate` in
 * `../release/docker-provider.test.ts`) — every test in this file that is
 * not itself exercising the gate wants one that never refuses anything.
 * `gatedEnvs` defaults to empty, which `gateProvisionRelease` never
 * consults its ledger for at all, so a ledger that always answers "no" is
 * never actually asked to answer anything in particular.
 */
function noProductionGate(gatedEnvs: ReadonlySet<string> = new Set()): DeployGateOptions {
  return { gatedEnvs, ledger: { dryRunSeen: () => false, confirmed: () => false } };
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mpgm-env-provision-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeManifest(
  text: string,
  path = 'deploy/environments/environments.yaml',
): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function seedManifest(): void {
  writeManifest(
    [
      'environments:',
      '  - name: test',
      '    compose: deploy/environments/test/compose.yaml',
      '    project: mpgm-test',
      '    releaseOverride: deploy/environments/test/compose.release.yaml',
      '    approval: none',
      '  - name: staging',
      '    compose: deploy/environments/staging/compose.yaml',
      '    project: mpgm-staging',
      '    approval: none',
      '  - name: production',
      '    compose: deploy/environments/production/compose.yaml',
      '    project: mpgm-production',
      '    approval: required',
      '',
    ].join('\n'),
  );
}

describe('loadDeclaredEnvironments', () => {
  it('reads the declared environments from the manifest', () => {
    seedManifest();
    expect(loadDeclaredEnvironments(repo)).toEqual([
      {
        name: 'test',
        compose: 'deploy/environments/test/compose.yaml',
        project: 'mpgm-test',
        releaseOverride: 'deploy/environments/test/compose.release.yaml',
        approval: 'none',
      },
      {
        name: 'staging',
        compose: 'deploy/environments/staging/compose.yaml',
        project: 'mpgm-staging',
        approval: 'none',
      },
      {
        name: 'production',
        compose: 'deploy/environments/production/compose.yaml',
        project: 'mpgm-production',
        approval: 'required',
      },
    ]);
  });

  it('names the manifest path when there is none', () => {
    expect(() => loadDeclaredEnvironments(repo)).toThrow(
      /deploy\/environments\/environments\.yaml/,
    );
  });

  it('names what was wrong when the manifest is not valid YAML', () => {
    writeManifest('environments: [this is not: [valid');
    expect(() => loadDeclaredEnvironments(repo)).toThrow(ComposeProviderError);
  });

  it('names what was wrong when an entry is missing a required field', () => {
    writeManifest(
      [
        'environments:',
        '  - name: test',
        '    compose: some/file.yaml',
        '    approval: none',
        '',
      ].join('\n'),
    );
    expect(() => loadDeclaredEnvironments(repo)).toThrow(/project/);
  });

  /**
   * CONV-4/CONV-5: a manifest that never says whether an environment needs
   * approval is refused outright, not read as "no" — the ambiguity T4.1.4's
   * first review found (`production` gated only by a name this module used
   * to hardcode) must not resurface as a manifest that simply omits the
   * field and gets treated as ungated (T4.1.4 rework).
   */
  it('refuses an entry that never says whether it needs approval', () => {
    writeManifest(
      [
        'environments:',
        '  - name: test',
        '    compose: some/file.yaml',
        '    project: mpgm-test',
        '',
      ].join('\n'),
    );
    expect(() => loadDeclaredEnvironments(repo)).toThrow(/approval/);
  });
});

describe('gatedEnvironmentNames / gatedEnvironments', () => {
  it('names only the environments a manifest marks approval: required', () => {
    seedManifest();
    expect(gatedEnvironmentNames(loadDeclaredEnvironments(repo))).toEqual(
      new Set(['production']),
    );
    expect(gatedEnvironments(repo)).toEqual(new Set(['production']));
  });

  it('gates whichever name a project’s manifest actually uses, not "production"', () => {
    // A project whose own manifest calls its gated environment something
    // else entirely — the exact case T4.1.4's first review found unreachable
    // through a hardcoded name (CONV-4).
    writeManifest(
      [
        'environments:',
        '  - name: prod-eu',
        '    compose: deploy/environments/prod-eu/compose.yaml',
        '    project: mpgm-prod-eu',
        '    approval: required',
        '',
      ].join('\n'),
    );
    expect(gatedEnvironments(repo)).toEqual(new Set(['prod-eu']));
  });

  it('names nothing when every entry declares approval: none', () => {
    writeManifest(
      [
        'environments:',
        '  - name: test',
        '    compose: deploy/environments/test/compose.yaml',
        '    project: mpgm-test',
        '    approval: none',
        '',
      ].join('\n'),
    );
    expect(gatedEnvironments(repo)).toEqual(new Set());
  });
});

interface RecordedCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
}

/** A scripted `ComposeCli` — records every call and replays queued results. */
function scriptedCli(results: readonly ComposeCliResult[]): {
  cli: ComposeCli;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const cli: ComposeCli = (args, options) => {
    calls.push({ args, env: options.env });
    const result = results[index] ?? results[results.length - 1];
    index += 1;
    if (result === undefined) {
      throw new Error('scriptedCli: no result queued');
    }
    return Promise.resolve(result);
  };
  return { cli, calls };
}

const ok = (stdout = ''): ComposeCliResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string): ComposeCliResult => ({ stdout: '', stderr, code: 1 });

const oneHealthyRow =
  '{"Service":"service","State":"running","Health":"healthy","ID":"abc123"}';

describe('composeProvider', () => {
  beforeEach(seedManifest);

  it('up brings the environment up, waits, and reports it up', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    const result = (await operation(provider, 'up')({ repo, env: 'test' } as never)) as {
      env: string;
      up: boolean;
      services: unknown[];
    };

    expect(result).toEqual({
      env: 'test',
      up: true,
      services: [
        { name: 'service', state: 'running', health: 'healthy', containerId: 'abc123' },
      ],
    });
    expect(calls[0]?.args).toEqual([
      'compose',
      '-f',
      'deploy/environments/test/compose.yaml',
      '-p',
      'mpgm-test',
      'up',
      '-d',
      '--wait',
    ]);
  });

  it('up passes an image override through MPGM_SERVICE_IMAGE', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(
      provider,
      'up',
    )({ repo, env: 'test', image: 'registry/app:7' } as never);

    expect(calls[0]?.env).toEqual({ MPGM_SERVICE_IMAGE: 'registry/app:7' });
  });

  it('up without an image override explicitly clears MPGM_SERVICE_IMAGE, rather than leaving it to whatever this process happens to have ambient (CONV-4)', async () => {
    // T4.1.4's second review found the earlier version of this test asserted
    // `calls[0]?.env` was `undefined` on a no-image `up` — which is exactly
    // the gap that made the ambient environment variable exploitable: an
    // absent `options.env` means `dockerComposeCli` hands the *whole* of
    // this process's own `process.env` to `docker compose` unfiltered, so an
    // ambient `MPGM_SERVICE_IMAGE` (set by whatever invoked the kernel) would
    // resolve `deploy/environments/production/compose.yaml`'s
    // `${MPGM_SERVICE_IMAGE:-nginx:1.27-alpine}` to an arbitrary image, with
    // no `image` in this call's input and so no gate check at all. Explicitly
    // setting it to `''` closes that: compose reads an empty value the same
    // as unset (`:-`, not `-`), and no ambient value can override an explicit
    // one `dockerComposeCli` merges on top of `process.env`.
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(provider, 'up')({ repo, env: 'test' } as never);

    expect(calls[0]?.env).toEqual({ MPGM_SERVICE_IMAGE: '' });
  });

  it('up with an image override applies the declared releaseOverride compose file too', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(
      provider,
      'up',
    )({ repo, env: 'test', image: 'registry/app:7' } as never);

    expect(calls[0]?.args).toEqual([
      'compose',
      '-f',
      'deploy/environments/test/compose.yaml',
      '-f',
      'deploy/environments/test/compose.release.yaml',
      '-p',
      'mpgm-test',
      'up',
      '-d',
      '--wait',
    ]);
  });

  it('up without an image override never applies the releaseOverride file', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(provider, 'up')({ repo, env: 'test' } as never);

    expect(calls[0]?.args).not.toContain('deploy/environments/test/compose.release.yaml');
  });

  it('up with an image override but no declared releaseOverride still runs, on the base file alone', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(
      provider,
      'up',
    )({ repo, env: 'staging', image: 'registry/app:7' } as never);

    expect(calls[0]?.args).toEqual([
      'compose',
      '-f',
      'deploy/environments/staging/compose.yaml',
      '-p',
      'mpgm-staging',
      'up',
      '-d',
      '--wait',
    ]);
  });

  it('down never applies the releaseOverride file — a project is torn down by name, not by config', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(provider, 'down')({ repo, env: 'test' } as never);

    expect(calls[0]?.args).not.toContain('deploy/environments/test/compose.release.yaml');
  });

  it('up throws when docker compose never becomes healthy — a partial success is never reported', async () => {
    const { cli } = scriptedCli([fail('container mpgm-test-service-1 is unhealthy')]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await expect(
      operation(provider, 'up')({ repo, env: 'test' } as never),
    ).rejects.toThrow(/did not become healthy/);
  });

  it('down tears the environment down and reports it not up, with no services', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    const result = await operation(provider, 'down')({ repo, env: 'test' } as never);

    expect(result).toEqual({ env: 'test', up: false, services: [] });
    expect(calls[0]?.args).toEqual([
      'compose',
      '-f',
      'deploy/environments/test/compose.yaml',
      '-p',
      'mpgm-test',
      'down',
    ]);
  });

  it('down on an already-down environment is a no-op, not an error', async () => {
    // docker compose exits 0 on `down` even with nothing running (verified
    // against a real daemon; contracts/env.provision.md).
    const { cli } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await expect(
      operation(provider, 'down')({ repo, env: 'test' } as never),
    ).resolves.toEqual({
      env: 'test',
      up: false,
      services: [],
    });
  });

  it('status reports the current services without invoking up or down', async () => {
    const { cli, calls } = scriptedCli([ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    const result = await operation(provider, 'status')({ repo, env: 'test' } as never);

    expect(result).toEqual({
      env: 'test',
      up: true,
      services: [
        { name: 'service', state: 'running', health: 'healthy', containerId: 'abc123' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('ps');
    // Without `--all`, `docker compose ps` lists only running containers, so a
    // stopped service simply disappears from the output instead of reading as
    // not-up (verified against a live daemon; contracts/env.provision.md's
    // "Failing closed" section, CONV-4).
    expect(calls[0]?.args).toContain('--all');
  });

  it('reports not up when one of several services has stopped — a service the CLI still lists as exited must not disappear from the up decision (fail closed)', async () => {
    const twoServicesOneExited = [
      '{"Service":"web","State":"running","Health":"healthy","ID":"abc123"}',
      '{"Service":"worker","State":"exited","Health":"","ID":"def456"}',
    ].join('\n');
    const { cli } = scriptedCli([ok(twoServicesOneExited)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    const result = (await operation(
      provider,
      'status',
    )({ repo, env: 'test' } as never)) as {
      up: boolean;
      services: unknown[];
    };

    expect(result.up).toBe(false);
    expect(result.services).toHaveLength(2);
  });

  it('refuses an environment the manifest does not declare (fail closed)', async () => {
    const { cli } = scriptedCli([ok()]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await expect(
      operation(provider, 'up')({ repo, env: 'canary' } as never),
    ).rejects.toThrow(UndeclaredEnvironmentError);
  });

  it('uses the environment-specific compose file and project for staging, not test', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await operation(provider, 'up')({ repo, env: 'staging' } as never);

    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        '-f',
        'deploy/environments/staging/compose.yaml',
        '-p',
        'mpgm-staging',
      ]),
    );
  });

  it('reads the manifest and IaC named by each call, not one bound at construction', async () => {
    // The same provider instance is invoked once per checkout, each with its
    // own manifest declaring a differently-projected 'test' environment — a
    // constructor-bound repo would answer both calls from whichever checkout
    // it was built with, silently provisioning the wrong repo's IaC.
    const otherRepo = mkdtempSync(join(tmpdir(), 'mpgm-env-provision-other-'));
    try {
      const otherManifest = join(otherRepo, 'deploy/environments/environments.yaml');
      mkdirSync(dirname(otherManifest), { recursive: true });
      writeFileSync(
        otherManifest,
        [
          'environments:',
          '  - name: test',
          '    compose: deploy/environments/test/compose.yaml',
          '    project: other-test',
          '    approval: none',
          '',
        ].join('\n'),
      );

      const { cli, calls } = scriptedCli([ok(), ok(''), ok(), ok('')]);
      const provider = composeProvider({ cli, gate: noProductionGate() });

      await operation(provider, 'up')({ repo, env: 'test' } as never);
      await operation(provider, 'up')({ repo: otherRepo, env: 'test' } as never);

      expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', 'mpgm-test']));
      expect(calls[2]?.args).toEqual(expect.arrayContaining(['-p', 'other-test']));
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});

/**
 * `composeProvider`'s gate is applied inside construction, not left for a
 * caller to wrap on afterward (T4.1.4's second rework, mirroring
 * `dockerReleaseProvider`). These tests exist to fail if that stops being
 * true — T4.1.4's second review found the previous version of this module
 * had no test that would notice `gateProvisionRelease` disappearing from its
 * one caller in `src/cli/commands.ts`; with the gate now built into
 * `composeProvider` itself, reaching `up` at all without going through the
 * gate is no longer something any caller, in this file or outside it, can
 * do.
 */
describe('composeProvider gate', () => {
  beforeEach(seedManifest);

  it('refuses an up carrying an image for a gated environment without a confirmed dry run', async () => {
    const { cli } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: noProductionGate(new Set(['production'])),
    });

    await expect(
      operation(
        provider,
        'up',
      )({ repo, env: 'production', image: 'sha256:deadbeef' } as never),
    ).rejects.toThrow(/has not been simulated/);
  });

  it('lets an up carrying an image for a gated environment through once dry-run and confirmation are both on record', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: {
        gatedEnvs: new Set(['production']),
        ledger: { dryRunSeen: () => true, confirmed: () => true },
      },
    });

    const result = await operation(
      provider,
      'up',
    )({ repo, env: 'production', image: 'sha256:deadbeef' } as never);

    expect(result).toMatchObject({ env: 'production', up: true });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['-p', 'mpgm-production', 'up']),
    );
  });

  it('lets an up carrying an image for a non-gated environment through with no confirmation at all', async () => {
    const { cli } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: noProductionGate() });

    await expect(
      operation(provider, 'up')({ repo, env: 'test', image: 'sha256:deadbeef' } as never),
    ).resolves.toMatchObject({ env: 'test' });
  });

  it("lets an up with no image reach a gated environment unconfirmed — standing up declared IaC before any release exists is this contract's own reason to exist", async () => {
    const { cli } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: noProductionGate(new Set(['production'])),
    });

    await expect(
      operation(provider, 'up')({ repo, env: 'production' } as never),
    ).resolves.toMatchObject({ env: 'production' });
  });
});

describe('parseComposePs', () => {
  it('parses one JSON object per line', () => {
    const stdout = [
      '{"Service":"a","State":"running","Health":"healthy","ID":"1"}',
      '{"Service":"b","State":"exited","Health":"","ID":"2"}',
    ].join('\n');

    expect(parseComposePs(stdout)).toEqual([
      { name: 'a', state: 'running', health: 'healthy', containerId: '1' },
      { name: 'b', state: 'exited', health: 'none', containerId: '2' },
    ]);
  });

  it('reports no services for empty output rather than failing to parse', () => {
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('\n\n')).toEqual([]);
  });

  it('maps an unrecognised state to unknown', () => {
    expect(
      parseComposePs('{"Service":"a","State":"removing","Health":"","ID":"1"}'),
    ).toEqual([{ name: 'a', state: 'unknown', health: 'none', containerId: '1' }]);
  });

  it('maps an unrecognised, non-empty health to unhealthy rather than none (fail closed)', () => {
    expect(
      parseComposePs('{"Service":"a","State":"running","Health":"weird","ID":"1"}'),
    ).toEqual([{ name: 'a', state: 'running', health: 'unhealthy', containerId: '1' }]);
  });

  it('throws with the offending line when a line is not JSON', () => {
    expect(() => parseComposePs('not json')).toThrow(/not json/);
  });
});
