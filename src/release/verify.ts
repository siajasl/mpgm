import { z } from 'zod';
import {
  releaseArtifactSchema,
  releaseRefSchema,
  type ReleaseArtifact,
  type ReleaseRef,
} from './deliver.js';

/**
 * Health verification and promote/rollback decisions (DESIGN §4.7, DEP-2, DEP-5).
 *
 * `release.deliver` (T4.1.2) hands a release to an environment and reports
 * whether the substrate underneath it is up (`env.provision`'s own
 * container-level `running`/`healthy`) — that is a real signal, but not the
 * one DEP-5 asks for: "verify post-deploy success against defined
 * SLOs/smoke checks". A container can be running and healthy by its own
 * Docker healthcheck while serving the wrong thing entirely — a stale build,
 * a config that did not take, a silent regression the container's own
 * healthcheck was never written to catch. This module is what watches for
 * that: it runs the smoke checks a release is supposed to satisfy, decides
 * promote or rollback from the result — failing closed toward rollback,
 * never toward "probably fine" (CONV-4) — executes the rollback through the
 * very `release.deliver#rollback` operation T4.1.2 built and tested,
 * confirms *that* actually worked, and returns the outcome as a single
 * validated record a caller persists (`recordOutcome`/`readOutcomes` in
 * `outcome-log.ts`) — DEP-5's "record the outcome".
 *
 * What this module does not do: implement rollout mechanics (still
 * `release.deliver`/`env.provision`'s job), or decide what a project's smoke
 * checks should assert — the same "does not decide what is deployed"
 * boundary `env.provision`'s `image` override and `release.deliver`'s
 * `buildArgs` both draw around what actually runs.
 */

/**
 * One post-deploy smoke check (DEP-5).
 *
 * `expectIncludes` is required, not optional: a smoke check with nothing to
 * assert about the response body checks nothing, and a caller who forgot to
 * state what "healthy" means should not be able to construct a check that
 * silently always passes (CONV-5). `expectStatus` defaults to `200` — the
 * ordinary meaning of "the endpoint answered successfully" — but a caller
 * checking anything else (a redirect, a documented error page) states it.
 */
export const smokeCheckSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  expectIncludes: z.string().min(1),
  expectStatus: z.number().int().default(200),
  timeoutMs: z.number().int().positive().default(5000),
});

export type SmokeCheck = z.infer<typeof smokeCheckSchema>;

/** What one smoke check found, the last time it was attempted. */
export const checkResultSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().default(''),
});

export type CheckResult = z.infer<typeof checkResultSchema>;

/**
 * How persistently a smoke check is retried before its result is taken as
 * final. A freshly delivered service can take a moment to become reachable
 * even after `env.provision` reports the container `running`/`healthy`
 * (DNS, a listener still binding) — `attempts` distinguishes that from an
 * actual regression, which keeps failing past all of them.
 */
export const healthPolicySchema = z.object({
  attempts: z.number().int().positive().default(5),
  intervalMs: z.number().int().nonnegative().default(1000),
});

export type HealthPolicy = z.infer<typeof healthPolicySchema>;

export const DEFAULT_HEALTH_POLICY: HealthPolicy = healthPolicySchema.parse({});

/**
 * The promote/rollback decision (DEP-2) an outcome records.
 *
 * `rollback-unavailable` and `rollback-failed` are both distinct from
 * `rolled-back` on purpose: an operator reading the outcome log needs to
 * tell "the bad release was replaced" from "the bad release is still live
 * because there was nothing to fall back to, or falling back did not work
 * either" — collapsing either into `rolled-back` would report a rollback
 * that never actually happened (CONV-4).
 */
export const releaseDecisions = [
  'promoted',
  'rolled-back',
  'rollback-unavailable',
  'rollback-failed',
] as const;

export type ReleaseDecision = (typeof releaseDecisions)[number];

/**
 * DEP-5's "record the outcome as a release artifact" — the single record a
 * verification run produces, whichever way it went.
 */
export const releaseOutcomeSchema = z.object({
  env: z.string().min(1),
  release: releaseRefSchema,
  decision: z.enum(releaseDecisions),
  reason: z.string().min(1),
  checks: z.array(checkResultSchema),
  /** The release now live, if a rollback happened; `null` otherwise. */
  rolledBackTo: releaseRefSchema.nullable(),
  verifiedAt: z.string().min(1),
});

export type ReleaseOutcome = z.infer<typeof releaseOutcomeSchema>;

/** A minimal HTTP response — only what a smoke check reads. */
export interface SmokeResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** Injectable so tests need no network, the same shape as `DockerCli`. */
export type Fetcher = (
  url: string,
  options: { readonly signal: AbortSignal },
) => Promise<SmokeResponse>;

const defaultFetcher: Fetcher = (url, options) => fetch(url, { signal: options.signal });

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function attemptOnce(check: SmokeCheck, fetcher: Fetcher): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, check.timeoutMs);
  try {
    const response = await fetcher(check.url, { signal: controller.signal });
    if (response.status !== check.expectStatus) {
      return {
        name: check.name,
        ok: false,
        detail: `expected status ${String(check.expectStatus)}, got ${String(response.status)}`,
      };
    }
    const body = await response.text();
    if (!body.includes(check.expectIncludes)) {
      return {
        name: check.name,
        ok: false,
        detail: `response did not include '${check.expectIncludes}': ${body.slice(0, 200)}`,
      };
    }
    return { name: check.name, ok: true, detail: '' };
  } catch (cause) {
    return {
      name: check.name,
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface RunSmokeChecksDeps {
  readonly fetcher?: Fetcher;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs every check, retrying each independently up to `policy.attempts`
 * times before its result is taken as final. One result per input check, in
 * the same order — never fewer, so a caller can always match a failure back
 * to the check that produced it.
 */
export async function runSmokeChecks(
  checks: readonly SmokeCheck[],
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
  deps: RunSmokeChecksDeps = {},
): Promise<CheckResult[]> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const sleep = deps.sleep ?? defaultSleep;

  const results: CheckResult[] = [];
  for (const check of checks) {
    let last: CheckResult = { name: check.name, ok: false, detail: 'never attempted' };
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      last = await attemptOnce(check, fetcher);
      if (last.ok) {
        break;
      }
      if (attempt < policy.attempts) {
        await sleep(policy.intervalMs);
      }
    }
    results.push(last);
  }
  return results;
}

/** Whether a set of check results counts as healthy: every one passed. Fails
 * closed on an empty set — nothing verified is not the same as everything
 * passing (CONV-4), which is also why {@link verifyReleaseInput} requires at
 * least one check. */
export function isHealthy(results: readonly CheckResult[]): boolean {
  return results.length > 0 && results.every((result) => result.ok);
}

export const verifyReleaseInput = z.object({
  env: z.string().min(1),
  /** The just-delivered release being verified. */
  release: releaseRefSchema,
  /** Smoke checks describing what a healthy `release` looks like. */
  checks: z.array(smokeCheckSchema).min(1),
  /**
   * The release this one supersedes, with the checks that describe *it* —
   * what a rollback restores and how to confirm the restore worked. `null`
   * only when `release` is this environment's first ever, the same
   * assertion `release.deliver`'s own `rollbackTo` makes (DEP-3).
   */
  previous: z
    .object({ artifact: releaseArtifactSchema, checks: z.array(smokeCheckSchema).min(1) })
    .nullable(),
  policy: healthPolicySchema.default(DEFAULT_HEALTH_POLICY),
});

export type VerifyReleaseInput = z.infer<typeof verifyReleaseInput>;

export interface VerifyReleaseDeps {
  readonly fetcher?: Fetcher;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
  /** `release.deliver#rollback`, bound to `env` and `repo` by the caller. */
  rollback(to: ReleaseArtifact): Promise<unknown>;
}

const defaultNow = (): string => new Date().toISOString();

function refOf(artifact: { version: string; digest: string }): ReleaseRef {
  return { version: artifact.version, digest: artifact.digest };
}

/**
 * Verify a just-delivered release against its smoke checks, and — failing
 * closed — roll it back when they do not pass.
 *
 * Never asserts `rolled-back` without re-running `previous.checks` against
 * the environment `rollback` leaves behind: a policy that called
 * `release.deliver#rollback` and declared victory without looking would be
 * exactly the "asserts up independently of what it observed" mistake
 * `releaseStatusOutput` refuses at the contract boundary (CONV-4) — this is
 * the same discipline one layer up, where there is no schema to refuse it
 * for us.
 */
export async function verifyRelease(
  input: VerifyReleaseInput,
  deps: VerifyReleaseDeps,
): Promise<ReleaseOutcome> {
  const parsed = verifyReleaseInput.parse(input);
  const now = deps.now ?? defaultNow;
  const checkDeps: RunSmokeChecksDeps = {
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  };

  const results = await runSmokeChecks(parsed.checks, parsed.policy, checkDeps);
  if (isHealthy(results)) {
    return releaseOutcomeSchema.parse({
      env: parsed.env,
      release: parsed.release,
      decision: 'promoted',
      reason: `all ${String(results.length)} smoke check(s) passed`,
      checks: results,
      rolledBackTo: null,
      verifiedAt: now(),
    });
  }

  const failing = results
    .filter((result) => !result.ok)
    .map((result) => result.name)
    .join(', ');

  if (parsed.previous === null) {
    return releaseOutcomeSchema.parse({
      env: parsed.env,
      release: parsed.release,
      decision: 'rollback-unavailable',
      reason:
        `smoke check(s) failed (${failing}) and '${parsed.env}' has no prior release ` +
        `to roll back to — this is this environment's first release`,
      checks: results,
      rolledBackTo: null,
      verifiedAt: now(),
    });
  }

  try {
    await deps.rollback(parsed.previous.artifact);
  } catch (cause) {
    // The ordinary failure mode of a `release.deliver#rollback` provider
    // (a compose/docker failure, or `releaseStatusOutput`'s own superRefine
    // refusing an inconsistent 'up') is a thrown error, not a rejected
    // status. Left unguarded that error would propagate out of
    // `verifyRelease` itself, so the one case DEP-5's record matters most —
    // rollback did not work either — would produce no outcome at all
    // instead of the `rollback-failed` decision that exists for it
    // (CONV-4: fail closed toward a recorded decision, never toward
    // silence). `cause`'s message is folded into `reason` so an operator
    // reading the outcome log can act on why the rollback failed without
    // having to go find and re-run it themselves (CONV-3).
    const message = cause instanceof Error ? cause.message : String(cause);
    return releaseOutcomeSchema.parse({
      env: parsed.env,
      release: parsed.release,
      decision: 'rollback-failed',
      reason:
        `smoke check(s) failed (${failing}); rolling back to ` +
        `${parsed.previous.artifact.version} failed before it could even be verified: ${message}`,
      checks: results,
      rolledBackTo: null,
      verifiedAt: now(),
    });
  }
  const rollbackResults = await runSmokeChecks(
    parsed.previous.checks,
    parsed.policy,
    checkDeps,
  );

  if (isHealthy(rollbackResults)) {
    return releaseOutcomeSchema.parse({
      env: parsed.env,
      release: parsed.release,
      decision: 'rolled-back',
      reason: `smoke check(s) failed (${failing}); rolled back to ${parsed.previous.artifact.version}, which verified healthy`,
      checks: results,
      rolledBackTo: refOf(parsed.previous.artifact),
      verifiedAt: now(),
    });
  }

  const rollbackFailing = rollbackResults
    .filter((result) => !result.ok)
    .map((result) => result.name)
    .join(', ');
  return releaseOutcomeSchema.parse({
    env: parsed.env,
    release: parsed.release,
    decision: 'rollback-failed',
    reason:
      `smoke check(s) failed (${failing}); rolled back to ${parsed.previous.artifact.version}, ` +
      `but its own smoke check(s) failed too (${rollbackFailing}) — escalate`,
    checks: results,
    rolledBackTo: null,
    verifiedAt: now(),
  });
}
