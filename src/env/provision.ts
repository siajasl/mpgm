import { z } from 'zod';
import type { ContractSpec } from '../contract/capability.js';

/**
 * The `env.provision` capability (DESIGN §4.7/§9, DEP-1, DEP-4).
 *
 * The kernel does not run containers, call a cloud API, or decide what
 * "healthy" means for a service it knows nothing about — the provider is the
 * thing that actually stands the environment up, the same way `ci.checks`
 * treats CI as the oracle for whether a check passed rather than re-deriving
 * a verdict from a log. What lives here is the one decision every operation's
 * output must agree with: whether the services a provider reports add up to
 * an environment that is actually up (see {@link environmentUp}).
 */

export const serviceStates = [
  'running',
  'restarting',
  'paused',
  'exited',
  'dead',
  'created',
  'unknown',
] as const;

export type ServiceState = (typeof serviceStates)[number];

export const serviceHealths = ['healthy', 'unhealthy', 'starting', 'none'] as const;

export type ServiceHealth = (typeof serviceHealths)[number];

export const serviceStatusSchema = z.object({
  /** The service name as the environment's compose file declares it. */
  name: z.string().min(1),
  state: z.enum(serviceStates),
  /** `none` for a service with no healthcheck declared, not "unknown". */
  health: z.enum(serviceHealths).default('none'),
  /** Empty where a provider has none to report — never invented. */
  containerId: z.string().default(''),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const envRequestInput = z.object({
  /** `owner/repo`, or a filesystem path for a local checkout. */
  repo: z.string().min(1),
  /** The environment's name, as declared in the project's own manifest. */
  env: z.string().min(1),
});

export type EnvRequestInput = z.infer<typeof envRequestInput>;

export const envUpInput = envRequestInput.extend({
  /**
   * Overrides the image the environment's compose file defaults to.
   *
   * Absent, the default runs — which is what lets the committed IaC alone
   * stand up a real environment before any release artifact exists to point
   * it at (this task's own completion criterion). A release pipeline
   * (DEP-3, T4.1.2) supplies this once one exists.
   */
  image: z.string().min(1).optional(),
});

export type EnvUpInput = z.infer<typeof envUpInput>;

export const envStatusOutput = z.object({
  env: z.string().min(1),
  /**
   * Whether the environment is actually reachable — see
   * {@link environmentUp}. Never asserted independently by a provider; every
   * operation computes it the same way, from the same `services`.
   */
  up: z.boolean(),
  services: z.array(serviceStatusSchema),
});

export type EnvStatusOutput = z.infer<typeof envStatusOutput>;

/**
 * Is this environment up?
 *
 * True only when there is at least one reported service and every one of
 * them is `running` with a health of `healthy` or `none` (no healthcheck
 * declared). Fails closed: a service the provider cannot account for, one
 * still `starting`, or no services reported at all, all read as **not up** —
 * `starting` is not "probably fine", it is "ask again", refused exactly as
 * `unhealthy` is, and an environment with nothing running is not up by
 * default the way an unconfigured CI check is not passing by default
 * (`ci.checks`, DESIGN §4.7).
 *
 * Pure, and the single place every operation's `up` field is computed, so a
 * caller never has to trust that `up` and `down` and `status` agree with each
 * other — they are all this function applied to whatever `services` came
 * back.
 */
export function environmentUp(services: readonly ServiceStatus[]): boolean {
  return (
    services.length > 0 &&
    services.every(
      (service) =>
        service.state === 'running' &&
        (service.health === 'healthy' || service.health === 'none'),
    )
  );
}

/**
 * The contract specification. `contracts/env.provision.md` is the prose half;
 * this is the half the kernel validates against.
 */
export const envProvisionContract: ContractSpec = {
  name: 'env.provision',
  summary:
    "Bring a declared environment up or down from the project's own IaC (DEP-1, DEP-4).",
  operations: [
    {
      name: 'up',
      summary:
        'Bring the environment up from its compose file, waiting until it is reachable.',
      input: envUpInput,
      output: envStatusOutput,
      // Re-running converges on the same running set rather than piling up
      // containers, provided a provider keys its stack by the environment's
      // own declared identity (contracts/env.provision.md).
      effects: 'idempotent',
    },
    {
      name: 'down',
      summary: 'Tear the environment down. A no-op, not an error, if already down.',
      input: envRequestInput,
      output: envStatusOutput,
      effects: 'idempotent',
    },
    {
      name: 'status',
      summary: 'Report whether the environment is up, without changing anything.',
      input: envRequestInput,
      output: envStatusOutput,
      effects: 'read-only',
    },
  ],
};
