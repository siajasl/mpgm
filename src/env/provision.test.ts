import { describe, expect, it } from 'vitest';
import {
  BoundContract,
  CapabilityRegistry,
  ContractError,
} from '../contract/capability.js';
import {
  environmentUp,
  envProvisionContract,
  envRequestInput,
  envStatusOutput,
  envUpInput,
  serviceStatusSchema,
  type ServiceStatus,
} from './provision.js';

function service(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: 'service',
    state: 'running',
    health: 'none',
    containerId: 'abc',
    ...overrides,
  };
}

describe('environmentUp', () => {
  it('is false with no services at all', () => {
    expect(environmentUp([])).toBe(false);
  });

  it('is true when every service is running with no healthcheck', () => {
    expect(environmentUp([service()])).toBe(true);
  });

  it('is true when every service is running and healthy', () => {
    expect(environmentUp([service({ health: 'healthy' })])).toBe(true);
  });

  it('is false while a service is still starting — fails closed, not "probably fine"', () => {
    expect(environmentUp([service({ health: 'starting' })])).toBe(false);
  });

  it('is false when a service is unhealthy', () => {
    expect(environmentUp([service({ health: 'unhealthy' })])).toBe(false);
  });

  it('is false when a service is not running, healthcheck notwithstanding', () => {
    expect(environmentUp([service({ state: 'exited', health: 'healthy' })])).toBe(false);
  });

  it('is false when any one of several services is not up', () => {
    expect(
      environmentUp([
        service({ name: 'a' }),
        service({ name: 'b', health: 'unhealthy' }),
      ]),
    ).toBe(false);
  });

  it('is true only when every one of several services is up', () => {
    expect(
      environmentUp([
        service({ name: 'a', health: 'healthy' }),
        service({ name: 'b', health: 'none' }),
      ]),
    ).toBe(true);
  });

  it('is false for a service whose state this schema does not recognise', () => {
    // `unknown` is the schema's own fallback for a docker state it could not
    // read (compose-provider.ts) — never "probably running".
    expect(environmentUp([service({ state: 'unknown' })])).toBe(false);
  });
});

describe('serviceStatusSchema', () => {
  it('defaults health to none and containerId to empty', () => {
    const parsed = serviceStatusSchema.parse({ name: 'service', state: 'running' });
    expect(parsed).toEqual({
      name: 'service',
      state: 'running',
      health: 'none',
      containerId: '',
    });
  });

  it('rejects a state outside the declared vocabulary', () => {
    expect(
      serviceStatusSchema.safeParse({ name: 'service', state: 'zombie' }).success,
    ).toBe(false);
  });

  it('rejects an empty service name', () => {
    expect(serviceStatusSchema.safeParse({ name: '', state: 'running' }).success).toBe(
      false,
    );
  });
});

describe('envUpInput / envRequestInput', () => {
  it('accepts up without an image override', () => {
    const parsed = envUpInput.safeParse({ repo: 'org/repo', env: 'test' });
    expect(parsed.success).toBe(true);
  });

  it('accepts up with an image override', () => {
    const parsed = envUpInput.safeParse({
      repo: 'org/repo',
      env: 'test',
      image: 'registry/app:1',
    });
    expect(parsed.success && parsed.data.image).toBe('registry/app:1');
  });

  it('rejects a request naming no environment', () => {
    expect(envRequestInput.safeParse({ repo: 'org/repo', env: '' }).success).toBe(false);
  });
});

describe('envProvisionContract', () => {
  it('declares up, down and status with their DESIGN §6 effect semantics', () => {
    const names = envProvisionContract.operations.map((operation) => operation.name);
    expect(names).toEqual(['up', 'down', 'status']);
    const byName = Object.fromEntries(
      envProvisionContract.operations.map((operation) => [
        operation.name,
        operation.effects,
      ]),
    );
    expect(byName).toEqual({ up: 'idempotent', down: 'idempotent', status: 'read-only' });
  });

  it("validates a provider's output against envStatusOutput on every operation", async () => {
    const registry = new CapabilityRegistry();
    const bound: BoundContract = registry.bind(envProvisionContract, {
      up: () => Promise.resolve({ env: 'test', up: true, services: [service()] }),
      down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'test', up: true, services: [service()] }),
    });

    const up = await bound.invoke('up', { repo: 'org/repo', env: 'test' });
    expect(envStatusOutput.parse(up)).toMatchObject({ env: 'test', up: true });

    const down = await bound.invoke('down', { repo: 'org/repo', env: 'test' });
    expect(envStatusOutput.parse(down)).toEqual({ env: 'test', up: false, services: [] });
  });

  it('refuses a provider whose output the contract does not allow (fail closed)', async () => {
    const registry = new CapabilityRegistry();
    const bound = registry.bind(envProvisionContract, {
      up: () => Promise.resolve({ env: 'test', up: 'yes', services: [] }),
      down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'test', up: false, services: [] }),
    });

    await expect(bound.invoke('up', { repo: 'org/repo', env: 'test' })).rejects.toThrow(
      ContractError,
    );
  });

  it('refuses input missing the environment name', async () => {
    const registry = new CapabilityRegistry();
    const bound = registry.bind(envProvisionContract, {
      up: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      down: () => Promise.resolve({ env: 'test', up: false, services: [] }),
      status: () => Promise.resolve({ env: 'test', up: false, services: [] }),
    });

    await expect(bound.invoke('up', { repo: 'org/repo' })).rejects.toThrow(ContractError);
  });
});
