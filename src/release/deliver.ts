import { z } from 'zod';
import type { ContractSpec } from '../contract/capability.js';
import { environmentUp, serviceStatusSchema } from '../env/provision.js';

/**
 * The `release.deliver` capability (DESIGN §4.7/§9, DEP-2, DEP-3).
 *
 * DESIGN §4.7 draws the line explicitly: "progressive delivery is delegated
 * to existing CD tooling ... mpgm supplies release artifacts, watches health
 * signals, records outcomes, and issues promote/rollback decisions per
 * policy — it does not implement rollout mechanics." This module is the
 * first half of that sentence — `assemble` builds and names an immutable,
 * versioned artifact (DEP-3), and `deliver`/`rollback` hand it to whatever
 * already knows how to run a container rather than reimplementing that. The
 * reference provider (`docker-provider.ts`) delegates through the
 * `env.provision` contract itself, which is DESIGN §9 decision 8's compose
 * substrate today and a hosted or Kubernetes-native CD tool once §8's
 * "deploy substrate" revisit trigger fires — this contract does not change
 * either way, which is the whole point of it being a contract (EXT-2/3).
 *
 * Health verification, promote/rollback *decisions*, and outcome artifacts
 * are DEP-2/DEP-5 — T4.1.3, not here. What this contract answers is narrower:
 * given a release, can it be made to run somewhere, and can the release
 * before it be made to run there again.
 */

export const releaseRefSchema = z.object({
  version: z.string().min(1),
  /** The immutable id a build produced — never a mutable tag (DEP-3). */
  digest: z.string().min(1),
});

export type ReleaseRef = z.infer<typeof releaseRefSchema>;

/**
 * An immutable, versioned release (DEP-3): a version, the image and digest a
 * build produced, a changelog, and the release it supersedes — a rollback
 * *path* is a field every release carries, not a lookup performed only when
 * something goes wrong. `rollbackTo` is `null` only for the first release an
 * environment has ever seen; every other release names one, and there is
 * nothing else it could roll back to.
 *
 * `changelog` and `version` are required, non-empty strings rather than
 * optional ones a caller could omit and a checker could flag after the fact
 * (CONV-5) — DEP-3 asks for a changelog on *every* release, not one a
 * validator merely warns is missing.
 */
export const releaseArtifactSchema = z.object({
  version: z.string().min(1),
  /** The repository/tag name the digest was built and tagged under. */
  image: z.string().min(1),
  digest: z.string().min(1),
  changelog: z.string().min(1),
  rollbackTo: releaseRefSchema.nullable(),
});

export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;

export const releaseAssembleInput = z.object({
  repo: z.string().min(1),
  /** Build context, relative to `repo` — the tree the digest names. */
  context: z.string().min(1),
  /** Relative to `repo`; defaults to `<context>/Dockerfile`. */
  dockerfile: z.string().min(1).optional(),
  /** Repository name to tag the build under; `assemble` appends `:version`. */
  image: z.string().min(1),
  version: z.string().min(1),
  changelog: z.string().min(1),
  /**
   * `--build-arg` values, by name. `release.deliver` does not know or care
   * what a Dockerfile's build args are called — that is the same "does not
   * decide what is deployed" boundary `env.provision`'s `image` override
   * draws (`contracts/env.provision.md`).
   */
  buildArgs: z.record(z.string(), z.string()).default({}),
  /**
   * The release this one supersedes, or `null` if there is none — a caller
   * MUST say which, explicitly. `null` is not a default a forgotten field
   * falls into; it is an assertion the caller makes, the same way a first
   * release's `rollbackTo: null` is an assertion in the output artifact
   * (CONV-5). A schema default here would make "no rollback path" the
   * outcome of omitting a field rather than of stating one is actually
   * absent, which is exactly the DEP-3 obligation this field exists to
   * cover — so there is no default, and parsing without it fails.
   * `assemble` copies this straight into the output's `rollbackTo` (see
   * {@link nextRelease}); it does not reconstruct it independently.
   */
  previous: releaseRefSchema.nullable(),
});

export type ReleaseAssembleInput = z.infer<typeof releaseAssembleInput>;

/**
 * The single place a release artifact is constructed from a build's output.
 *
 * Mirrors {@link environmentUp}'s role for `env.provision`: every provider
 * MUST build the artifact this way rather than assembling the object
 * inline, so `rollbackTo` always echoes exactly the `previous` ref the
 * caller asked to supersede — never a provider's own reconstruction of what
 * it assumes came before.
 */
export function nextRelease(
  input: Pick<ReleaseAssembleInput, 'version' | 'changelog' | 'previous'>,
  digest: string,
  image: string,
): ReleaseArtifact {
  return {
    version: input.version,
    image,
    digest,
    changelog: input.changelog,
    rollbackTo: input.previous,
  };
}

export const releaseDeliverInput = z.object({
  repo: z.string().min(1),
  env: z.string().min(1),
  release: releaseArtifactSchema,
});

export type ReleaseDeliverInput = z.infer<typeof releaseDeliverInput>;

export const releaseRollbackInput = z.object({
  repo: z.string().min(1),
  env: z.string().min(1),
  /**
   * The release being restored — a full artifact, not just its ref, so a
   * rollback's own record carries the changelog and rollback path of the
   * release it puts back, the same as any other delivery would.
   */
  to: releaseArtifactSchema,
});

export type ReleaseRollbackInput = z.infer<typeof releaseRollbackInput>;

/**
 * What `deliver` and `rollback` both report: which release is now live, and
 * whether the environment underneath it is actually up.
 *
 * `up` is refused if it disagrees with `environmentUp(services)` — the exact
 * invariant `env.provision#up/down/status` enforce on themselves
 * (`contracts/env.provision.md` "Failing closed"), reused rather than
 * reinvented, because a provider that delegates delivery through
 * `env.provision` (as the reference one does) has nothing else to report
 * "up" from. A release provider asserting `up: true` for services that read
 * as down is refused at the boundary the same way, not merely flagged after
 * the fact (CONV-4, CONV-5).
 */
export const releaseStatusOutput = z
  .object({
    env: z.string().min(1),
    release: releaseRefSchema,
    up: z.boolean(),
    services: z.array(serviceStatusSchema),
  })
  .superRefine((value, ctx) => {
    const expected = environmentUp(value.services);
    if (value.up !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['up'],
        message:
          `'up: ${String(value.up)}' disagrees with the services reported — ` +
          `environmentUp(services) is ${String(expected)}; a release.deliver ` +
          `provider must never assert 'up' independently of 'services'`,
      });
    }
  });

export type ReleaseStatusOutput = z.infer<typeof releaseStatusOutput>;

/**
 * The contract specification. `contracts/release.deliver.md` is the prose
 * half; this is the half the kernel validates against.
 */
export const releaseDeliverContract: ContractSpec = {
  name: 'release.deliver',
  summary:
    'Assemble an immutable, versioned release artifact and deliver it — or a ' +
    'prior one — to a declared environment, delegating rollout mechanics (DEP-2, DEP-3).',
  operations: [
    {
      name: 'assemble',
      summary:
        'Build the service into a container image and record the immutable, ' +
        'versioned release artifact a caller can deliver or roll back to.',
      input: releaseAssembleInput,
      output: releaseArtifactSchema,
      // 'idempotent' on the kernel's definition (re-running is harmless),
      // not on digest equality: a rebuild reuses the cached image on the
      // machine that built it, but a cold rebuild (no local cache — a fresh
      // runner, or one after a prune) produces a different digest for an
      // unchanged tree. A resumed `assemble` therefore either lands the same
      // artifact (warm cache) or a new one naming the same version and
      // changelog (cold cache) — never a caller-visible failure, and never a
      // reason to withhold the retry.
      effects: 'idempotent',
    },
    {
      name: 'deliver',
      summary: 'Hand a release to the environment, delegating rollout mechanics.',
      input: releaseDeliverInput,
      output: releaseStatusOutput,
      // Delegates to `env.provision#up`, itself idempotent.
      effects: 'idempotent',
    },
    {
      name: 'rollback',
      summary:
        'Redeploy a prior release to the environment — the tested rollback ' +
        'path DEP-3 requires every release to carry.',
      input: releaseRollbackInput,
      output: releaseStatusOutput,
      effects: 'idempotent',
    },
  ],
};
