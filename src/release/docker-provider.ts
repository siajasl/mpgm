import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BoundContract, Provider } from '../contract/capability.js';
import {
  nextRelease,
  type ReleaseArtifact,
  type ReleaseAssembleInput,
  type ReleaseDeliverInput,
  type ReleaseRef,
  type ReleaseRollbackInput,
} from './deliver.js';

/**
 * `release.deliver` over `docker build` for assembly, and the `env.provision`
 * contract for delivery (DESIGN §9 decision 8/9, §4.7).
 *
 * `assemble` is the only part of this file that talks to Docker directly —
 * `deliver` and `rollback` never invoke `docker compose` themselves. Both
 * call the `env.provision` contract this provider is handed at construction,
 * the same shape `deliverTo` is written once and reused by both operations:
 * this is the "does not implement rollout mechanics" half of DESIGN §4.7 made
 * structural rather than a comment — swap the bound `env.provision` contract
 * for one fronting a hosted or Kubernetes-native CD tool (§8's deploy-substrate
 * revisit trigger) and nothing in this file changes.
 */

export class ReleaseProviderError extends Error {}

export interface DockerCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Runs a `docker` invocation. Injectable so tests need no real daemon, the
 * same shape as `ComposeCli` in `../env/compose-provider.ts`.
 */
export type DockerCli = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<DockerCliResult>;

const run = promisify(execFile);

export const dockerCli: DockerCli = async (args, options) => {
  try {
    const { stdout, stderr } = await run('docker', [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; code?: number };
    if (typeof err.code === 'number') {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code };
    }
    throw new ReleaseProviderError(
      `docker ${args.join(' ')} could not be run: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

export interface DockerReleaseProviderOptions {
  /**
   * The `env.provision` contract `deliver`/`rollback` delegate to. Required,
   * not defaulted — a `release.deliver` provider with nowhere to delegate
   * rollout to is not a smaller version of this provider, it is a different
   * one that would have to invent its own notion of "up" (CONV-4).
   */
  readonly envProvision: BoundContract;
  readonly cli?: DockerCli;
}

async function buildImage(
  cli: DockerCli,
  repo: string,
  input: ReleaseAssembleInput,
): Promise<ReleaseArtifact> {
  const dockerfile = input.dockerfile ?? join(input.context, 'Dockerfile');
  const tag = `${input.image}:${input.version}`;
  // `--iidfile` gets its own scratch directory rather than a bare temp file:
  // docker refuses to write over a file that already exists, and a stale
  // leftover from a prior run in the same OS temp dir would then make every
  // subsequent build fail for a reason this error would not mention.
  const scratch = mkdtempSync(join(tmpdir(), 'mpgm-release-'));
  const iidFile = join(scratch, 'iid');
  try {
    const args = ['build', '-f', dockerfile, '-t', tag, '--iidfile', iidFile];
    for (const [name, value] of Object.entries(input.buildArgs)) {
      args.push('--build-arg', `${name}=${value}`);
    }
    args.push(input.context);
    const result = await cli(args, { cwd: repo });
    if (result.code !== 0) {
      throw new ReleaseProviderError(
        `'docker build' for '${tag}' failed: ${result.stderr || result.stdout}`,
      );
    }
    let digest: string;
    try {
      digest = readFileSync(iidFile, 'utf8').trim();
    } catch (cause) {
      throw new ReleaseProviderError(
        `'docker build' for '${tag}' reported success but wrote no image id ` +
          `to its --iidfile: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (digest === '') {
      throw new ReleaseProviderError(
        `'docker build' for '${tag}' wrote an empty image id to its --iidfile`,
      );
    }
    return nextRelease(input, digest, tag);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A provider satisfying `releaseDeliverContract` (`contracts/release.deliver.md`).
 *
 * Takes no `repo` at construction and reads it from every input instead —
 * the same reasoning as `composeProvider` (`../env/compose-provider.ts`): a
 * constructor-bound checkout would let a caller name one repo and silently
 * build or deliver from another's tree.
 */
export function dockerReleaseProvider(options: DockerReleaseProviderOptions): Provider {
  const cli = options.cli ?? dockerCli;
  const envProvision = options.envProvision;

  async function deliverTo(
    repo: string,
    env: string,
    release: ReleaseArtifact,
  ): Promise<{ env: string; release: ReleaseRef; up: boolean; services: unknown }> {
    const status = await envProvision.invoke<{ up: boolean; services: unknown }>('up', {
      repo,
      env,
      image: release.digest,
    });
    return {
      env,
      release: { version: release.version, digest: release.digest },
      up: status.up,
      services: status.services,
    };
  }

  return {
    assemble: async (input: never): Promise<unknown> => {
      const assembleInput = input as ReleaseAssembleInput;
      return buildImage(cli, assembleInput.repo, assembleInput);
    },

    deliver: async (input: never): Promise<unknown> => {
      const { repo, env, release } = input as ReleaseDeliverInput;
      return deliverTo(repo, env, release);
    },

    rollback: async (input: never): Promise<unknown> => {
      const { repo, env, to } = input as ReleaseRollbackInput;
      return deliverTo(repo, env, to);
    },
  };
}
