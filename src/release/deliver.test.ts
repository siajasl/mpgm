import { describe, expect, it } from 'vitest';
import {
  BoundContract,
  CapabilityRegistry,
  ContractError,
} from '../contract/capability.js';
import type { ServiceStatus } from '../env/provision.js';
import {
  nextRelease,
  releaseArtifactSchema,
  releaseAssembleInput,
  releaseDeliverContract,
  releaseDeliverInput,
  releaseRollbackInput,
  releaseStatusOutput,
} from './deliver.js';

function service(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: 'service',
    state: 'running',
    health: 'healthy',
    containerId: 'abc',
    ...overrides,
  };
}

function release(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: '1.0.0',
    image: 'mpgm-sample-service:1.0.0',
    digest: 'sha256:aaa',
    changelog: 'Initial release.',
    rollbackTo: null,
    ...overrides,
  };
}

describe('releaseArtifactSchema', () => {
  it('accepts a first release with no rollback path', () => {
    expect(releaseArtifactSchema.safeParse(release()).success).toBe(true);
  });

  it('accepts a release naming what it supersedes', () => {
    expect(
      releaseArtifactSchema.safeParse(
        release({ rollbackTo: { version: '0.9.0', digest: 'sha256:zzz' } }),
      ).success,
    ).toBe(true);
  });

  it('rejects a release with no changelog — DEP-3 asks for one on every release', () => {
    expect(releaseArtifactSchema.safeParse(release({ changelog: '' })).success).toBe(
      false,
    );
  });

  it('rejects a release with no version', () => {
    expect(releaseArtifactSchema.safeParse(release({ version: '' })).success).toBe(false);
  });

  it('rejects a release with no digest — a version is not an immutable artifact', () => {
    expect(releaseArtifactSchema.safeParse(release({ digest: '' })).success).toBe(false);
  });
});

describe('nextRelease', () => {
  it("echoes exactly the caller's previous ref as rollbackTo, not a reconstruction", () => {
    const previous = { version: '1.0.0', digest: 'sha256:aaa' };
    const built = nextRelease(
      { version: '2.0.0', changelog: 'Second release.', previous },
      'sha256:bbb',
      'mpgm-sample-service:2.0.0',
    );
    expect(built).toEqual({
      version: '2.0.0',
      image: 'mpgm-sample-service:2.0.0',
      digest: 'sha256:bbb',
      changelog: 'Second release.',
      rollbackTo: previous,
    });
  });

  it('carries rollbackTo: null through for a first release', () => {
    const built = nextRelease(
      { version: '1.0.0', changelog: 'Initial release.', previous: null },
      'sha256:aaa',
      'mpgm-sample-service:1.0.0',
    );
    expect(built.rollbackTo).toBeNull();
  });
});

describe('releaseAssembleInput', () => {
  it('defaults buildArgs to empty', () => {
    const parsed = releaseAssembleInput.parse({
      repo: 'org/repo',
      context: 'deploy/sample-service',
      image: 'mpgm-sample-service',
      version: '1.0.0',
      changelog: 'Initial release.',
      previous: null,
    });
    expect(parsed.buildArgs).toEqual({});
  });

  it('accepts an explicit previous: null for a first release', () => {
    const parsed = releaseAssembleInput.parse({
      repo: 'org/repo',
      context: 'deploy/sample-service',
      image: 'mpgm-sample-service',
      version: '1.0.0',
      changelog: 'Initial release.',
      previous: null,
    });
    expect(parsed.previous).toBeNull();
  });

  it('rejects an omitted previous — a rollback path is stated, not defaulted (CONV-5)', () => {
    expect(
      releaseAssembleInput.safeParse({
        repo: 'org/repo',
        context: 'deploy/sample-service',
        image: 'mpgm-sample-service',
        version: '1.0.0',
        changelog: 'Initial release.',
        // previous omitted deliberately — must fail, not default to null.
      }).success,
    ).toBe(false);
  });

  it('rejects a request with no changelog', () => {
    expect(
      releaseAssembleInput.safeParse({
        repo: 'org/repo',
        context: 'deploy/sample-service',
        image: 'mpgm-sample-service',
        version: '1.0.0',
        changelog: '',
      }).success,
    ).toBe(false);
  });
});

describe('releaseDeliverInput / releaseRollbackInput', () => {
  it('deliver carries a full release artifact', () => {
    expect(
      releaseDeliverInput.safeParse({ repo: 'org/repo', env: 'test', release: release() })
        .success,
    ).toBe(true);
  });

  it('rollback carries the artifact being restored, under `to`', () => {
    expect(
      releaseRollbackInput.safeParse({ repo: 'org/repo', env: 'test', to: release() })
        .success,
    ).toBe(true);
  });

  it('rollback rejects a request with no target release', () => {
    expect(
      releaseRollbackInput.safeParse({ repo: 'org/repo', env: 'test' }).success,
    ).toBe(false);
  });
});

describe('releaseStatusOutput', () => {
  it('rejects up: true when services disagree — never asserted independently', () => {
    expect(
      releaseStatusOutput.safeParse({
        env: 'test',
        release: { version: '1.0.0', digest: 'sha256:aaa' },
        up: true,
        services: [],
      }).success,
    ).toBe(false);
  });

  it('rejects up: true with an unhealthy service', () => {
    expect(
      releaseStatusOutput.safeParse({
        env: 'test',
        release: { version: '1.0.0', digest: 'sha256:aaa' },
        up: true,
        services: [service({ health: 'unhealthy' })],
      }).success,
    ).toBe(false);
  });

  it('accepts up agreeing with environmentUp(services)', () => {
    expect(
      releaseStatusOutput.safeParse({
        env: 'test',
        release: { version: '1.0.0', digest: 'sha256:aaa' },
        up: true,
        services: [service()],
      }).success,
    ).toBe(true);
  });
});

describe('releaseDeliverContract', () => {
  it('declares assemble, deliver and rollback, all idempotent', () => {
    const byName = Object.fromEntries(
      releaseDeliverContract.operations.map((operation) => [
        operation.name,
        operation.effects,
      ]),
    );
    expect(byName).toEqual({
      assemble: 'idempotent',
      deliver: 'idempotent',
      rollback: 'idempotent',
    });
  });

  it("refuses a provider's deliver output the contract does not allow (fail closed)", async () => {
    const registry = new CapabilityRegistry();
    const bound: BoundContract = registry.bind(releaseDeliverContract, {
      assemble: () => Promise.resolve(release()),
      deliver: () =>
        Promise.resolve({
          env: 'test',
          release: { version: '1.0.0', digest: 'sha256:aaa' },
          up: true,
          services: [],
        }),
      rollback: () =>
        Promise.resolve({
          env: 'test',
          release: { version: '1.0.0', digest: 'sha256:aaa' },
          up: false,
          services: [],
        }),
    });

    await expect(
      bound.invoke('deliver', { repo: 'org/repo', env: 'test', release: release() }),
    ).rejects.toThrow(ContractError);
  });

  it('validates a well-formed rollback round-trip end to end', async () => {
    const registry = new CapabilityRegistry();
    const bound = registry.bind(releaseDeliverContract, {
      assemble: () => Promise.resolve(release()),
      deliver: () =>
        Promise.resolve({
          env: 'test',
          release: { version: '2.0.0', digest: 'sha256:bbb' },
          up: true,
          services: [service()],
        }),
      rollback: () =>
        Promise.resolve({
          env: 'test',
          release: { version: '1.0.0', digest: 'sha256:aaa' },
          up: true,
          services: [service()],
        }),
    });

    const rolledBack = await bound.invoke('rollback', {
      repo: 'org/repo',
      env: 'test',
      to: release(),
    });
    expect(rolledBack).toEqual({
      env: 'test',
      release: { version: '1.0.0', digest: 'sha256:aaa' },
      up: true,
      services: [service()],
    });
  });
});
