import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../contract/capability.js';
import type { Provider } from '../contract/capability.js';
import { envProvisionContract } from '../env/provision.js';
import type { DeployLedger } from '../policy/deploy-gate.js';
import {
  dockerReleaseProvider,
  ReleaseProviderError,
  type DockerCli,
  type DockerCliResult,
} from './docker-provider.js';

/**
 * `Provider`'s handlers are looked up by name, the same reasoning as
 * `operation` in `../env/compose-provider.test.ts`.
 */
function operation(provider: Provider, name: string): (input: never) => Promise<unknown> {
  const fn = provider[name];
  if (fn === undefined) {
    throw new Error(`dockerReleaseProvider does not implement '${name}'`);
  }
  return fn;
}

interface RecordedBuild {
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * A scripted `DockerCli` for `docker build`. Real `docker build --iidfile`
 * writes the built image id to the path that flag names; this stands in for
 * that side effect so a test needs no daemon, the same reasoning
 * `scriptedCli` in `../env/compose-provider.test.ts` gives for `docker
 * compose`.
 */
function scriptedBuildCli(
  digest: string | undefined,
  code = 0,
): { cli: DockerCli; calls: RecordedBuild[] } {
  const calls: RecordedBuild[] = [];
  const cli: DockerCli = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    const iidIndex = args.indexOf('--iidfile');
    if (iidIndex !== -1 && digest !== undefined) {
      const path = args[iidIndex + 1];
      if (path !== undefined) {
        writeIid(path, digest);
      }
    }
    const result: DockerCliResult =
      code === 0
        ? { stdout: '', stderr: '', code: 0 }
        : { stdout: '', stderr: 'boom', code };
    return Promise.resolve(result);
  };
  return { cli, calls };
}

function writeIid(path: string, digest: string): void {
  writeFileSync(path, digest);
}

/**
 * The gate is now a required constructor argument (`gate`, DESIGN §9
 * decision 10) — every test in this file delivers to `env: 'test'`, which
 * `gateProductionRelease` never consults, so this ledger only has to exist,
 * not answer anything in particular.
 */
function noProductionGate(): { ledger: DeployLedger } {
  return { ledger: { dryRunSeen: () => false, confirmed: () => false } };
}

function boundEnvProvision(overrides: Partial<Provider> = {}) {
  const registry = new CapabilityRegistry();
  return registry.bind(envProvisionContract, {
    up: () =>
      Promise.resolve({
        env: 'test',
        up: true,
        services: [
          { name: 'service', state: 'running', health: 'healthy', containerId: 'c1' },
        ],
      }),
    down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
    status: () => Promise.resolve({ env: 'test', up: true, services: [] }),
    ...overrides,
  });
}

describe('dockerReleaseProvider — assemble', () => {
  it('builds the default Dockerfile, tags image:version, and records the digest', async () => {
    const { cli, calls } = scriptedBuildCli('sha256:aaa');
    const provider = dockerReleaseProvider({
      envProvision: boundEnvProvision(),
      cli,
      gate: noProductionGate(),
    });

    const result = await operation(
      provider,
      'assemble',
    )({
      repo: '/repo',
      context: 'deploy/sample-service',
      image: 'mpgm-sample-service',
      version: '1.0.0',
      changelog: 'Initial release.',
      buildArgs: { APP_VERSION: '1.0.0' },
      previous: null,
    } as never);

    expect(result).toEqual({
      version: '1.0.0',
      image: 'mpgm-sample-service:1.0.0',
      digest: 'sha256:aaa',
      changelog: 'Initial release.',
      rollbackTo: null,
    });

    const call = calls[0];
    expect(call?.cwd).toBe('/repo');
    expect(call?.args).toEqual(
      expect.arrayContaining([
        'build',
        '-f',
        'deploy/sample-service/Dockerfile',
        '-t',
        'mpgm-sample-service:1.0.0',
        '--build-arg',
        'APP_VERSION=1.0.0',
        'deploy/sample-service',
      ]),
    );
  });

  it('honours an explicit dockerfile path', async () => {
    const { cli, calls } = scriptedBuildCli('sha256:aaa');
    const provider = dockerReleaseProvider({
      envProvision: boundEnvProvision(),
      cli,
      gate: noProductionGate(),
    });

    await operation(
      provider,
      'assemble',
    )({
      repo: '/repo',
      context: 'deploy/sample-service',
      dockerfile: 'deploy/sample-service/Dockerfile.alt',
      image: 'mpgm-sample-service',
      version: '1.0.0',
      changelog: 'Initial release.',
      buildArgs: {},
      previous: null,
    } as never);

    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['-f', 'deploy/sample-service/Dockerfile.alt']),
    );
  });

  it('carries the previous ref through as rollbackTo', async () => {
    const { cli } = scriptedBuildCli('sha256:bbb');
    const provider = dockerReleaseProvider({
      envProvision: boundEnvProvision(),
      cli,
      gate: noProductionGate(),
    });

    const result = (await operation(
      provider,
      'assemble',
    )({
      repo: '/repo',
      context: 'deploy/sample-service',
      image: 'mpgm-sample-service',
      version: '2.0.0',
      changelog: 'Second release.',
      buildArgs: {},
      previous: { version: '1.0.0', digest: 'sha256:aaa' },
    } as never)) as { rollbackTo: unknown };

    expect(result.rollbackTo).toEqual({ version: '1.0.0', digest: 'sha256:aaa' });
  });

  it('fails closed when docker build exits non-zero', async () => {
    const { cli } = scriptedBuildCli(undefined, 1);
    const provider = dockerReleaseProvider({
      envProvision: boundEnvProvision(),
      cli,
      gate: noProductionGate(),
    });

    await expect(
      operation(
        provider,
        'assemble',
      )({
        repo: '/repo',
        context: 'deploy/sample-service',
        image: 'mpgm-sample-service',
        version: '1.0.0',
        changelog: 'Initial release.',
        buildArgs: {},
        previous: null,
      } as never),
    ).rejects.toThrow(ReleaseProviderError);
  });

  it('fails closed when docker build reports success but writes no image id', async () => {
    const { cli } = scriptedBuildCli(undefined, 0);
    const provider = dockerReleaseProvider({
      envProvision: boundEnvProvision(),
      cli,
      gate: noProductionGate(),
    });

    await expect(
      operation(
        provider,
        'assemble',
      )({
        repo: '/repo',
        context: 'deploy/sample-service',
        image: 'mpgm-sample-service',
        version: '1.0.0',
        changelog: 'Initial release.',
        buildArgs: {},
        previous: null,
      } as never),
    ).rejects.toThrow(ReleaseProviderError);
  });

  it('cleans up its own scratch directory whether the build succeeds or fails', async () => {
    let capturedIid = '';
    const cli: DockerCli = (args) => {
      const iidIndex = args.indexOf('--iidfile');
      const path = iidIndex !== -1 ? args[iidIndex + 1] : undefined;
      if (path !== undefined) {
        capturedIid = path;
        writeIid(path, 'sha256:aaa');
      }
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    };
    const provider = dockerReleaseProvider({
      envProvision: boundEnvProvision(),
      cli,
      gate: noProductionGate(),
    });

    await operation(
      provider,
      'assemble',
    )({
      repo: '/repo',
      context: 'deploy/sample-service',
      image: 'mpgm-sample-service',
      version: '1.0.0',
      changelog: 'Initial release.',
      buildArgs: {},
      previous: null,
    } as never);

    expect(capturedIid).not.toBe('');
    expect(existsSync(capturedIid)).toBe(false);
  });
});

describe('dockerReleaseProvider — deliver / rollback', () => {
  const releaseOne = {
    version: '1.0.0',
    image: 'mpgm-sample-service:1.0.0',
    digest: 'sha256:aaa',
    changelog: 'Initial release.',
    rollbackTo: null,
  };
  const releaseTwo = {
    version: '2.0.0',
    image: 'mpgm-sample-service:2.0.0',
    digest: 'sha256:bbb',
    changelog: 'Second release.',
    rollbackTo: { version: '1.0.0', digest: 'sha256:aaa' },
  };

  it('deliver delegates to env.provision#up with the release digest as the image', async () => {
    let seenInput: unknown;
    const registry = new CapabilityRegistry();
    const envProvision = registry.bind(envProvisionContract, {
      up: (input: never) => {
        seenInput = input;
        return Promise.resolve({
          env: 'test',
          up: true,
          services: [
            { name: 'service', state: 'running', health: 'healthy', containerId: 'c1' },
          ],
        });
      },
      down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'test', up: false, services: [] }),
    });
    const provider = dockerReleaseProvider({ envProvision, gate: noProductionGate() });

    const result = await operation(
      provider,
      'deliver',
    )({ repo: '/repo', env: 'test', release: releaseTwo } as never);

    expect(seenInput).toEqual({ repo: '/repo', env: 'test', image: 'sha256:bbb' });
    expect(result).toEqual({
      env: 'test',
      release: { version: '2.0.0', digest: 'sha256:bbb' },
      up: true,
      services: [
        { name: 'service', state: 'running', health: 'healthy', containerId: 'c1' },
      ],
    });
  });

  it('rollback delegates to env.provision#up with the target release digest, never the current one', async () => {
    let seenInput: unknown;
    const registry = new CapabilityRegistry();
    const envProvision = registry.bind(envProvisionContract, {
      up: (input: never) => {
        seenInput = input;
        return Promise.resolve({
          env: 'test',
          up: true,
          services: [
            { name: 'service', state: 'running', health: 'healthy', containerId: 'c1' },
          ],
        });
      },
      down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'test', up: false, services: [] }),
    });
    const provider = dockerReleaseProvider({ envProvision, gate: noProductionGate() });

    const result = (await operation(
      provider,
      'rollback',
    )({ repo: '/repo', env: 'test', to: releaseOne } as never)) as {
      release: { digest: string };
    };

    expect(seenInput).toEqual({ repo: '/repo', env: 'test', image: 'sha256:aaa' });
    expect(result.release).toEqual({ version: '1.0.0', digest: 'sha256:aaa' });
  });

  it('propagates a failing env.provision#up rather than reporting delivered', async () => {
    const registry = new CapabilityRegistry();
    const envProvision = registry.bind(envProvisionContract, {
      up: () => Promise.reject(new Error("'docker compose up' did not become healthy")),
      down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'test', up: false, services: [] }),
    });
    const provider = dockerReleaseProvider({ envProvision, gate: noProductionGate() });

    await expect(
      operation(
        provider,
        'deliver',
      )({ repo: '/repo', env: 'test', release: releaseOne } as never),
    ).rejects.toThrow(/did not become healthy/);
  });
});

describe('dockerReleaseProvider — the production gate is not optional', () => {
  /**
   * DESIGN §9 decision 10: the gate is applied inside construction, not left
   * for a caller to wrap on afterward, so there is no way to get an
   * unguarded `deliver`/`rollback` out of this function at all. Before this
   * was true, a caller supplying only `envProvision` (as every test above
   * still does, for `env: 'test'`) would reach a real `env.provision#up` for
   * `env: 'production'` too — this test would have passed against that
   * shape, so it is the one this fix has to fail without.
   */
  it('refuses a production deliver even though the caller never wrapped the provider itself', async () => {
    const registry = new CapabilityRegistry();
    let reached = false;
    const envProvision = registry.bind(envProvisionContract, {
      up: () => {
        reached = true;
        return Promise.resolve({ env: 'production', up: true, services: [] });
      },
      down: () => Promise.resolve({ env: 'production', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'production', up: false, services: [] }),
    });
    const provider = dockerReleaseProvider({ envProvision, gate: noProductionGate() });

    await expect(
      operation(
        provider,
        'deliver',
      )({
        repo: '/repo',
        env: 'production',
        release: {
          version: '1.0.0',
          image: 'mpgm-sample-service:1.0.0',
          digest: 'sha256:aaa',
          changelog: 'Initial release.',
          rollbackTo: null,
        },
      } as never),
    ).rejects.toThrow(/has not been simulated/);
    expect(reached).toBe(false);
  });
});
