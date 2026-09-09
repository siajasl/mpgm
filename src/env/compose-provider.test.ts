import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Provider } from '../contract/capability.js';
import type { ServiceStatus } from './provision.js';
import {
  DeployGateError,
  deployFingerprint,
  recreateOnDefaultDigest,
  teardownDigest,
  type DeployGateOptions,
  type DeployLedger,
} from '../policy/deploy-gate.js';
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
 * `gate` is a required constructor option as of T4.1.4b (DESIGN §9 decision
 * 14) — every test in this file below that is not itself exercising the
 * gate uses this: `gatedEnvs` answers empty for every `repo`, the same
 * reasoning `docker-provider.test.ts`'s `noProductionGate` gives, so the
 * ledger only has to exist, not answer anything in particular.
 */
function ungatedGate(gatedEnvs: ReadonlySet<string> = new Set()): DeployGateOptions {
  return {
    gatedEnvs: () => gatedEnvs,
    ledger: { dryRunSeen: () => false, confirmed: () => false },
  };
}

/** A ledger over in-memory sets, mirroring `deploy-gate.test.ts`'s own. */
function ledger(seen = new Set<string>(), confirmed = new Set<string>()): DeployLedger {
  return {
    dryRunSeen: (print) => seen.has(print),
    confirmed: (print) => confirmed.has(print),
  };
}

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
      '    releaseOverride: deploy/environments/test/compose.release.yaml',
      '    approval: none',
      '  - name: staging',
      '    compose: deploy/environments/staging/compose.yaml',
      '    project: mpgm-staging',
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
   * approval is refused outright, not read as "no" — the ambiguity a
   * hardcoded gated-environment name would otherwise hide must not
   * resurface as a manifest that simply omits the field and gets treated as
   * ungated.
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
      new Set(['staging']),
    );
    expect(gatedEnvironments(repo)).toEqual(new Set(['staging']));
  });

  it('gates whichever name a project’s manifest actually uses, not a hardcoded one', () => {
    // A project whose own manifest calls its gated environment something
    // else entirely — the release-path gate must be reachable through
    // whatever name a project actually declares (CONV-4).
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

/** What `parseComposePs` turns {@link oneHealthyRow} into, for building the
 * per-state gate identity ({@link recreateOnDefaultDigest}/
 * {@link teardownDigest}) a test needs to confirm. */
const ONE_HEALTHY_SERVICE: ServiceStatus = {
  name: 'service',
  state: 'running',
  health: 'healthy',
  containerId: 'abc123',
};

describe('composeProvider', () => {
  beforeEach(seedManifest);

  it('up brings the environment up, waits, and reports it up', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

    await operation(
      provider,
      'up',
    )({ repo, env: 'test', image: 'registry/app:7' } as never);

    expect(calls[0]?.env).toEqual({ MPGM_SERVICE_IMAGE: 'registry/app:7' });
  });

  it('up without an image override explicitly clears MPGM_SERVICE_IMAGE, rather than leaving it to whatever this process happens to have ambiently (CONV-4)', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

    await operation(provider, 'up')({ repo, env: 'test' } as never);

    // Not merely absent: `dockerComposeCli` otherwise inherits this
    // process's own environment unchanged, so an ambient
    // `MPGM_SERVICE_IMAGE` would reach `docker compose` with no `image` ever
    // named in the call at all — a caller reasoning about "no image" as "the
    // compose default" needs that to actually be true.
    expect(calls[0]?.env).toEqual({ MPGM_SERVICE_IMAGE: '' });
  });

  it('up with an image override applies the declared releaseOverride compose file too', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

    await operation(provider, 'up')({ repo, env: 'test' } as never);

    expect(calls[0]?.args).not.toContain('deploy/environments/test/compose.release.yaml');
  });

  it('up with an image override but no declared releaseOverride still runs, on the base file alone', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

    await operation(provider, 'down')({ repo, env: 'test' } as never);

    expect(calls[0]?.args).not.toContain('deploy/environments/test/compose.release.yaml');
  });

  it('up throws when docker compose never becomes healthy — a partial success is never reported', async () => {
    const { cli } = scriptedCli([fail('container mpgm-test-service-1 is unhealthy')]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

    await expect(
      operation(provider, 'up')({ repo, env: 'test' } as never),
    ).rejects.toThrow(/did not become healthy/);
  });

  it('down tears the environment down and reports it not up, with no services', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
    const provider = composeProvider({ cli, gate: ungatedGate() });

    await expect(
      operation(provider, 'up')({ repo, env: 'production' } as never),
    ).rejects.toThrow(UndeclaredEnvironmentError);
  });

  it('uses the environment-specific compose file and project for staging, not test', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({ cli, gate: ungatedGate() });

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
      const provider = composeProvider({ cli, gate: ungatedGate() });

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
 * `composeProvider` always returns the result of `gateProvisionRelease`
 * (T4.1.4b, DESIGN §9 decision 14) — these tests exercise that wiring
 * through the real provider, against `staging`, the one environment
 * `seedManifest` marks `approval: required`. `deploy-gate.test.ts` covers
 * `gateProvisionRelease`'s own decision logic against a fake provider in
 * more detail (fail-closed on a missing `status`, a provider with no `down`
 * left untouched, and so on); what matters here is that the concrete
 * provider this repository ships is never constructible ungated.
 */
describe('composeProvider — the environment-path gate (T4.1.4b)', () => {
  beforeEach(seedManifest);

  const notUpRow = '{"Service":"service","State":"exited","Health":"","ID":"abc123"}';

  it('refuses up carrying an image, on a gated environment, without a recorded dry run — the underlying docker compose is never invoked', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await expect(
      operation(provider, 'up')({ repo, env: 'staging', image: 'sha256:aaa' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toHaveLength(0);
  });

  it('lets up carrying an image through once the identical {repo, env, digest} fingerprint release.deliver would compute is confirmed', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const print = deployFingerprint({ repo, env: 'staging', digest: 'sha256:aaa' });
    const provider = composeProvider({
      cli,
      gate: {
        gatedEnvs: () => new Set(['staging']),
        ledger: ledger(new Set([print]), new Set([print])),
      },
    });

    await operation(
      provider,
      'up',
    )({ repo, env: 'staging', image: 'sha256:aaa' } as never);

    expect(calls).toHaveLength(2);
  });

  /**
   * T4.1.4b review 5: `image` is documented as an override of the compose
   * default and carries no shape of its own — a tag in every other test in
   * this file (`registry/app:7`) — but the gate used to fingerprint whatever
   * string arrived, tag included, resting decision 9's "cannot be made to
   * name another build" reasoning on a value that had never been checked to
   * actually be a digest. A tag reaching a gated `up` is now refused outright,
   * before any fingerprint is computed or the ledger is consulted at all —
   * confirming it would otherwise be impossible even in principle, since a
   * caller has no digest to confirm and no way to make this call carry one.
   */
  it('refuses up carrying a tag rather than a digest, on a gated environment, before any fingerprint is computed (CONV-4)', async () => {
    const { cli, calls } = scriptedCli([ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await expect(
      operation(
        provider,
        'up',
      )({ repo, env: 'staging', image: 'registry/app:7' } as never),
    ).rejects.toThrow(/not shaped like a digest/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a no-image up on a gated environment that is already up, under the reported-state-bound "recreate on default" identity, without ever calling docker compose up', async () => {
    // The gate's own `status` check to decide "already up" — a refusal here
    // must stop before that, not after standing anything up.
    const { cli, calls } = scriptedCli([ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await expect(
      operation(provider, 'up')({ repo, env: 'staging' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toHaveLength(1);
  });

  it('lets a no-image up on an already-up gated environment through once "recreate on default" is confirmed', async () => {
    const print = deployFingerprint({
      repo,
      env: 'staging',
      digest: recreateOnDefaultDigest([ONE_HEALTHY_SERVICE]),
    });
    const { cli, calls } = scriptedCli([ok(oneHealthyRow), ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: {
        gatedEnvs: () => new Set(['staging']),
        ledger: ledger(new Set([print]), new Set([print])),
      },
    });

    await operation(provider, 'up')({ repo, env: 'staging' } as never);
    expect(calls).toHaveLength(3);
  });

  /**
   * T4.1.4b review 2: the first version of this gate let a no-image `up`
   * through untouched whenever `status` reported no service at all,
   * reasoning that standing up infrastructure nothing is serving asks
   * nothing of an operator. A review found that reachable, not theoretical:
   * `production` — declared in the same task — has never been stood up, so
   * its only reachable state *was* exactly this one, meaning any caller
   * could stand it up on the compose default with no approval anywhere
   * (HIL-2). A no-image `up` against a gated environment must now be
   * refused whatever `status` reports, nothing included.
   */
  it('refuses a no-image up on a gated environment when status reports no service at all — a first bring-up needs approval too', async () => {
    const { cli, calls } = scriptedCli([ok('')]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await expect(
      operation(provider, 'up')({ repo, env: 'staging' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toHaveLength(1);
  });

  it('lets a no-image up through once its first bring-up — nothing reported yet — is confirmed', async () => {
    const print = deployFingerprint({
      repo,
      env: 'staging',
      digest: recreateOnDefaultDigest([]),
    });
    const { cli, calls } = scriptedCli([ok(''), ok(), ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: {
        gatedEnvs: () => new Set(['staging']),
        ledger: ledger(new Set([print]), new Set([print])),
      },
    });

    await operation(provider, 'up')({ repo, env: 'staging' } as never);
    expect(calls).toHaveLength(3);
  });

  /**
   * T4.1.4b rework 1: an environment reporting one `exited` service is not
   * "nothing there" — `environmentUp` reads `exited` as `up: false`, the
   * same as truly nothing running, but the gate's own question is "is there
   * anything here to protect", not "is it healthy" (`deploy-gate.ts`'s
   * `currentServices`/`anything`). A no-image `up` here would replace an exited-but-real
   * service with the compose default, with no approval anywhere in the path.
   */
  it('refuses a no-image up on a gated environment reporting one exited service — presence, not health, decides "anything to protect"', async () => {
    const { cli, calls } = scriptedCli([ok(notUpRow)]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await expect(
      operation(provider, 'up')({ repo, env: 'staging' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toHaveLength(1);
  });

  it('refuses down on a gated environment that is up, under the reported-state-bound "torn down" identity, without ever calling docker compose down', async () => {
    const { cli, calls } = scriptedCli([ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await expect(
      operation(provider, 'down')({ repo, env: 'staging' } as never),
    ).rejects.toThrow(DeployGateError);
    expect(calls).toHaveLength(1);
  });

  it('lets down on an already-up gated environment through once "torn down" is confirmed', async () => {
    const print = deployFingerprint({
      repo,
      env: 'staging',
      digest: teardownDigest([ONE_HEALTHY_SERVICE]),
    });
    const { cli, calls } = scriptedCli([ok(oneHealthyRow), ok(), ok('')]);
    const provider = composeProvider({
      cli,
      gate: {
        gatedEnvs: () => new Set(['staging']),
        ledger: ledger(new Set([print]), new Set([print])),
      },
    });

    await operation(provider, 'down')({ repo, env: 'staging' } as never);
    expect(calls).toHaveLength(3);
  });

  it('lets down on a gated environment through untouched while it is not already up', async () => {
    const { cli, calls } = scriptedCli([ok(''), ok(), ok('')]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await operation(provider, 'down')({ repo, env: 'staging' } as never);
    expect(calls).toHaveLength(3);
  });

  it('leaves a non-gated environment fully ungated on down too — no status check, no confirmation, whatever the ledger says', async () => {
    const { cli, calls } = scriptedCli([ok(), ok('')]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await operation(provider, 'down')({ repo, env: 'test' } as never);
    // Exactly the two calls `down` itself makes ('down', then 'ps') — no
    // extra 'ps' from a `currentServices` check this environment never
    // needed.
    expect(calls).toHaveLength(2);
  });

  it('never gates status — asking costs nothing and changes nothing', async () => {
    const { cli, calls } = scriptedCli([ok(oneHealthyRow)]);
    const provider = composeProvider({
      cli,
      gate: { gatedEnvs: () => new Set(['staging']), ledger: ledger() },
    });

    await operation(provider, 'status')({ repo, env: 'staging' } as never);
    expect(calls).toHaveLength(1);
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
