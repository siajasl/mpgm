import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import {
  ComposeProviderError,
  UndeclaredEnvironmentError,
  composeProvider,
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
      '  - name: staging',
      '    compose: deploy/environments/staging/compose.yaml',
      '    project: mpgm-staging',
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
      },
      {
        name: 'staging',
        compose: 'deploy/environments/staging/compose.yaml',
        project: 'mpgm-staging',
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
      ['environments:', '  - name: test', '    compose: some/file.yaml', ''].join('\n'),
    );
    expect(() => loadDeclaredEnvironments(repo)).toThrow(/project/);
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
    const provider = composeProvider(repo, { cli });

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
    const provider = composeProvider(repo, { cli });

    await operation(
      provider,
      'up',
    )({ repo, env: 'test', image: 'registry/app:7' } as never);

    expect(calls[0]?.env).toEqual({ MPGM_SERVICE_IMAGE: 'registry/app:7' });
  });

  it('up without an image override passes no compose env at all', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider(repo, { cli });

    await operation(provider, 'up')({ repo, env: 'test' } as never);

    expect(calls[0]?.env).toBeUndefined();
  });

  it('up throws when docker compose never becomes healthy — a partial success is never reported', async () => {
    const { cli } = scriptedCli([fail('container mpgm-test-service-1 is unhealthy')]);
    const provider = composeProvider(repo, { cli });

    await expect(
      operation(provider, 'up')({ repo, env: 'test' } as never),
    ).rejects.toThrow(/did not become healthy/);
  });

  it('down tears the environment down and reports it not up, with no services', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider(repo, { cli });

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
    const provider = composeProvider(repo, { cli });

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
    const provider = composeProvider(repo, { cli });

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
  });

  it('refuses an environment the manifest does not declare (fail closed)', async () => {
    const { cli } = scriptedCli([ok()]);
    const provider = composeProvider(repo, { cli });

    await expect(
      operation(provider, 'up')({ repo, env: 'production' } as never),
    ).rejects.toThrow(UndeclaredEnvironmentError);
  });

  it('uses the environment-specific compose file and project for staging, not test', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider(repo, { cli });

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
