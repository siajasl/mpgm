import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import type { Provider } from '../contract/capability.js';
import {
  environmentUp,
  serviceHealths,
  serviceStates,
  type EnvRequestInput,
  type EnvUpInput,
  type ServiceStatus,
} from './provision.js';

/**
 * `env.provision` over Docker Compose (DESIGN §9 decision 8, §4.7).
 *
 * The whole provider is a translation, the same shape as
 * `src/implement/github-checks.ts`: `docker compose` speaks its own
 * vocabulary, and nothing here decides whether an environment is "up" — that
 * decision is {@link environmentUp} in `provision.ts`, and is the same
 * whichever provider answered.
 */

export class ComposeProviderError extends Error {}

/**
 * An environment this project has not declared (`deploy/environments/environments.yaml`).
 *
 * Refused rather than guessed at from a directory-naming convention: DEP-4
 * asks for environments the harness provisions from configuration it was
 * given, and inferring one from `deploy/environments/<env>/` existing would
 * let a stray directory provision infrastructure nothing wrote down (CONV-4).
 */
export class UndeclaredEnvironmentError extends ComposeProviderError {
  readonly env: string;
  readonly declared: readonly string[];

  constructor(manifestPath: string, env: string, declared: readonly string[]) {
    super(
      `'${env}' is not declared in '${manifestPath}'; declared environments ` +
        `are: ${declared.length > 0 ? declared.join(', ') : '(none)'}`,
    );
    this.name = 'UndeclaredEnvironmentError';
    this.env = env;
    this.declared = declared;
  }
}

const environmentEntrySchema = z.object({
  name: z.string().min(1),
  /** Path to the environment's compose file, relative to `repo`. */
  compose: z.string().min(1),
  /** The `docker compose` project name — what keys the stack (DEP-1, DEP-4). */
  project: z.string().min(1),
  /**
   * A compose file applied *in addition to* `compose`, only on `up` calls
   * that carry an explicit `image` (DEP-3, `release.deliver`, T4.1.2).
   *
   * `compose`'s own default service bind-mounts a placeholder page over
   * whatever the container image serves, which is exactly right for an
   * environment nobody has pointed at a real release yet but would silently
   * keep serving the placeholder underneath a delivered image otherwise — a
   * release reporting `up: true` while nothing about what it changed is
   * observable. This file's job is narrow: undo just that mount (Compose's
   * `!override` tag) when a caller actually supplied an image to run.
   * Optional — an environment with nothing to undo declares none.
   */
  releaseOverride: z.string().min(1).optional(),
});

export type EnvironmentEntry = z.infer<typeof environmentEntrySchema>;

const environmentManifestSchema = z.object({
  environments: z.array(environmentEntrySchema).min(1),
});

export const DEFAULT_MANIFEST_PATH = 'deploy/environments/environments.yaml';

/**
 * The environments this project declares, read from its own manifest.
 *
 * Every error here names the manifest path and, on a malformed file, what
 * zod rejected — an operator debugging a provisioning failure should not have
 * to open this module to find out what the file was supposed to look like
 * (CONV-3).
 */
export function loadDeclaredEnvironments(
  repo: string,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): readonly EnvironmentEntry[] {
  const full = join(repo, manifestPath);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (cause) {
    throw new ComposeProviderError(
      `no environments manifest at '${manifestPath}' under '${repo}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    const where =
      cause instanceof YAMLParseError && cause.linePos !== undefined
        ? ` at line ${String(cause.linePos[0].line)}`
        : '';
    throw new ComposeProviderError(
      `'${manifestPath}' is not valid YAML${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const parsed = environmentManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ComposeProviderError(
      `'${manifestPath}' is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data.environments;
}

function declaredEntry(
  entries: readonly EnvironmentEntry[],
  manifestPath: string,
  env: string,
): EnvironmentEntry {
  const found = entries.find((entry) => entry.name === env);
  if (found === undefined) {
    throw new UndeclaredEnvironmentError(
      manifestPath,
      env,
      entries.map((entry) => entry.name),
    );
  }
  return found;
}

export interface ComposeCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Runs a `docker compose` invocation. Injectable so tests need no real
 * daemon, the same shape as `GitHubApi` in `github-checks.ts`.
 *
 * Never rejects on a non-zero exit — the caller decides what a failing
 * command means (an `up` that never became healthy is a legitimate, if
 * worse, answer, not a thrown exception the caller has to unwrap).
 */
export type ComposeCli = (
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<ComposeCliResult>;

const run = promisify(execFile);

export const dockerComposeCli: ComposeCli = async (args, options) => {
  try {
    const { stdout, stderr } = await run('docker', [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; code?: number };
    if (typeof err.code === 'number') {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code };
    }
    throw new ComposeProviderError(
      `docker ${args.join(' ')} could not be run: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

const composePsRowSchema = z.object({
  Service: z.string().min(1),
  State: z.string().default(''),
  Health: z.string().default(''),
  ID: z.string().default(''),
});

const stateSet = new Set<string>(serviceStates);
const healthSet = new Set<string>(serviceHealths);

/**
 * Docker's own vocabulary, narrowed to the contract's.
 *
 * An unrecognised `State` maps to `unknown`. `Health` is different: an empty
 * string means compose declares no healthcheck for the service, which is a
 * legitimate `none`, but a *non-empty* string this code does not recognise
 * means docker reported a health value in words this code cannot read —
 * mapped to `unhealthy`, not `none`, because `none` means "no healthcheck
 * exists" and reading an unfamiliar report as "no healthcheck" would hide
 * that one is there and disagreeing with this provider's understanding of it
 * (mirrors `normalizeConclusion` in `github-checks.ts`; CONV-4).
 */
function toServiceStatus(row: z.infer<typeof composePsRowSchema>): ServiceStatus {
  const state = stateSet.has(row.State)
    ? (row.State as ServiceStatus['state'])
    : 'unknown';
  const health =
    row.Health === ''
      ? 'none'
      : healthSet.has(row.Health)
        ? (row.Health as ServiceStatus['health'])
        : 'unhealthy';
  return { name: row.Service, state, health, containerId: row.ID };
}

/**
 * `docker compose ps --format json` prints one JSON object per line, not a
 * JSON array — empty output (nothing running) is a legitimate answer, not a
 * parse failure.
 */
export function parseComposePs(stdout: string): ServiceStatus[] {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  return lines.map((line) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      throw new ComposeProviderError(
        `'docker compose ps --format json' printed a line that is not JSON: ${line}`,
        { cause },
      );
    }
    const parsed = composePsRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ComposeProviderError(
        `'docker compose ps --format json' returned something this provider does not ` +
          `recognise: ${parsed.error.message}`,
      );
    }
    return toServiceStatus(parsed.data);
  });
}

function composeArgs(
  entry: EnvironmentEntry,
  extra: readonly string[],
  options: { readonly includeReleaseOverride?: boolean } = {},
): string[] {
  const files = ['-f', entry.compose];
  // `ps`/`down` never need the override (a project's containers are found by
  // `-p`, not by which compose files last described them — verified against
  // a live daemon, `docker compose down` with only the base file tears down
  // a stack `up` brought up with the override applied) — only `up` decides
  // what should be running, so only `up` opts in.
  if (options.includeReleaseOverride === true && entry.releaseOverride !== undefined) {
    files.push('-f', entry.releaseOverride);
  }
  return ['compose', ...files, '-p', entry.project, ...extra];
}

async function servicesOf(
  cli: ComposeCli,
  repo: string,
  entry: EnvironmentEntry,
): Promise<ServiceStatus[]> {
  // `--all`: without it, `ps` lists only running containers, so a service
  // that has stopped simply disappears from the output instead of reading as
  // not-up — verified against a live daemon, a two-service stack with one
  // container stopped reports as fully up without this flag. That is exactly
  // the "provider cannot account for a service" case `environmentUp` and
  // `contracts/env.provision.md`'s "Failing closed" section both require to
  // read as **not up** (CONV-4), and it is also what makes the `exited`,
  // `dead` and `created` states in `serviceStates` reachable at all.
  const result = await cli(composeArgs(entry, ['ps', '--all', '--format', 'json']), {
    cwd: repo,
  });
  if (result.code !== 0) {
    throw new ComposeProviderError(
      `'docker compose ps' for '${entry.name}' failed: ${result.stderr || result.stdout}`,
    );
  }
  return parseComposePs(result.stdout);
}

export interface ComposeProviderOptions {
  readonly manifestPath?: string;
  readonly cli?: ComposeCli;
}

/**
 * A provider satisfying `envProvisionContract` against Docker Compose.
 *
 * Takes no `repo` at construction, and reads it from every input instead —
 * the same shape as `githubChecksProvider` and `githubPmProvider`. A
 * constructor-bound checkout would let a caller invoke `up` naming one repo
 * and silently get another's IaC standing up in its place, with no signal
 * that anything went wrong; reading `repo` per call is what
 * `envRequestInput.repo` being declared on every operation is for.
 */
export function composeProvider(options: ComposeProviderOptions = {}): Provider {
  const cli = options.cli ?? dockerComposeCli;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;

  const entryFor = (repo: string, env: string): EnvironmentEntry =>
    declaredEntry(loadDeclaredEnvironments(repo, manifestPath), manifestPath, env);

  return {
    up: async (input: never): Promise<unknown> => {
      const { repo, env, image } = input as EnvUpInput;
      const entry = entryFor(repo, env);
      const cliOptions =
        image === undefined
          ? { cwd: repo }
          : { cwd: repo, env: { MPGM_SERVICE_IMAGE: image } };
      const result = await cli(
        composeArgs(entry, ['up', '-d', '--wait'], {
          includeReleaseOverride: image !== undefined,
        }),
        cliOptions,
      );
      if (result.code !== 0) {
        throw new ComposeProviderError(
          `'docker compose up' for '${env}' did not become healthy: ${result.stderr || result.stdout}`,
        );
      }
      const services = await servicesOf(cli, repo, entry);
      return { env, up: environmentUp(services), services };
    },

    down: async (input: never): Promise<unknown> => {
      const { repo, env } = input as EnvRequestInput;
      const entry = entryFor(repo, env);
      const result = await cli(composeArgs(entry, ['down']), { cwd: repo });
      if (result.code !== 0) {
        throw new ComposeProviderError(
          `'docker compose down' for '${env}' failed: ${result.stderr || result.stdout}`,
        );
      }
      const services = await servicesOf(cli, repo, entry);
      return { env, up: environmentUp(services), services };
    },

    status: async (input: never): Promise<unknown> => {
      const { repo, env } = input as EnvRequestInput;
      const entry = entryFor(repo, env);
      const services = await servicesOf(cli, repo, entry);
      return { env, up: environmentUp(services), services };
    },
  };
}
