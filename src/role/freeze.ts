import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The role freeze (PLAN section 1, AGT-6).
 *
 * From switchover, mpgm executes its own plan. That means the agents writing
 * the code are also the agents whose definitions are in the repository, and a
 * run that quietly edits a role is a run that changed what "reviewed by an
 * independent critic" means partway through — with no eval harness yet to
 * notice that it got worse (AGT-6 lands at T5.2.1a).
 *
 * So role files are pinned by digest. Drift is not forbidden; it is made
 * visible and deliberate. Changing a role means changing this manifest in the
 * same commit, which puts it through the merge gate, which is where the
 * operator sees it.
 */

export class RoleFreezeError extends Error {}

export const roleFreezeSchema = z.object({
  /** Why the freeze exists, for whoever finds this file and wonders. */
  reason: z.string().min(1),
  /** When it was taken. */
  frozenAt: z.string().min(1),
  /** Role name to sha256 of its file, exactly as committed. */
  digests: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/)),
  /**
   * Deliberate changes proposed since the freeze.
   *
   * Each names the role, the digest being allowed and why. An exemption
   * without a reason is a rubber stamp, and the schema will not take one.
   *
   * `approvedBy` is a claim, not a fact: this file is inside the repository,
   * so anything that can write a change can write a name into it — and one
   * agent already wrote an operator's, for a role that operator had never
   * seen. What makes an exemption count is a `RoleApproved` event, which a
   * task cannot append. Read this field as who the entry *says* approved it,
   * and the log as who did.
   */
  exemptions: z
    .array(
      z.object({
        role: z.string().min(1),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        approvedBy: z.string().min(1),
        reason: z.string().min(1),
        at: z.string().min(1),
      }),
    )
    .default([]),
});

export type RoleFreeze = z.infer<typeof roleFreezeSchema>;

export function digestOf(contents: string): string {
  // Line endings are normalised: a checkout on another platform is not a
  // change to a role, and treating it as one would make the freeze fire for
  // everybody who is not on the machine that took it.
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

export interface RoleDrift {
  readonly role: string;
  readonly kind: 'changed' | 'added' | 'removed';
  readonly digest: string;
  /** True when an exemption names this exact digest. */
  readonly exempt: boolean;
  readonly detail: string;
}

/** Digests of every role file in a directory. */
export function roleDigests(directory: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const entry of readdirSync(directory).sort()) {
    if (entry.endsWith('.md')) {
      digests[entry.slice(0, -'.md'.length)] = digestOf(
        readFileSync(join(directory, entry), 'utf8'),
      );
    }
  }
  return digests;
}

/**
 * What has moved since the freeze.
 *
 * Reports additions as well as changes. A new role is not covered by any eval
 * and has never been reviewed against the frozen set, which is the same
 * problem as an edited one wearing different clothes.
 */
/** A role definition an operator approved, as `<role>@<digest>`. */
export function approvalKey(role: string, digest: string): string {
  return `${role}@${digest}`;
}

export function roleDrift(
  freeze: RoleFreeze,
  current: Record<string, string>,
  approved?: ReadonlySet<string>,
): RoleDrift[] {
  const drift: RoleDrift[] = [];
  // Both halves are required where both are available: the manifest says
  // which digest is meant to be allowed and why, the log says an operator
  // agreed, and either alone is a sentence an agent could have written.
  //
  // Omitting `approved` checks the manifest alone, and is not a weaker mood
  // of the same question — it is the only question CI can ask. The event log
  // is machine-local (`.mpgm/` is not committed), so a checkout has no way to
  // know what an operator approved. CI answers "is this manifest consistent
  // with the role files beside it"; the kernel, which does have the log,
  // answers "did anyone agree to this" before it spends money on a session.
  const exempt = (role: string, digest: string): boolean =>
    freeze.exemptions.some((entry) => entry.role === role && entry.digest === digest) &&
    (approved === undefined || approved.has(approvalKey(role, digest)));

  for (const [role, digest] of Object.entries(current)) {
    const frozen = freeze.digests[role];
    if (frozen === undefined) {
      drift.push({
        role,
        kind: 'added',
        digest,
        exempt: exempt(role, digest),
        detail: `role '${role}' did not exist at the freeze`,
      });
    } else if (frozen !== digest) {
      drift.push({
        role,
        kind: 'changed',
        digest,
        exempt: exempt(role, digest),
        detail: `role '${role}' differs from the frozen definition`,
      });
    }
  }

  for (const role of Object.keys(freeze.digests)) {
    if (current[role] === undefined) {
      drift.push({
        role,
        kind: 'removed',
        digest: '',
        // A removed role has no digest to approve, so the manifest alone
        // carries it: there is no definition left for an operator to vouch
        // for, and refusing forever would make deleting a role impossible.
        exempt: freeze.exemptions.some((entry) => entry.role === role),
        detail: `role '${role}' was frozen but is no longer present`,
      });
    }
  }

  return drift.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
}

/** Drift nobody approved. */
export function unapprovedDrift(drift: readonly RoleDrift[]): RoleDrift[] {
  return drift.filter((entry) => !entry.exempt);
}

export function loadRoleFreeze(path: string): RoleFreeze {
  try {
    return roleFreezeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (cause) {
    throw new RoleFreezeError(
      `could not read the role freeze at '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Refuse to run with roles nobody approved changing.
 *
 * Fails closed, and names every drifted role rather than the first, so one
 * commit fixes the manifest instead of one run per role.
 */
export function assertRolesFrozen(
  freeze: RoleFreeze,
  directory: string,
  approved?: ReadonlySet<string>,
): RoleDrift[] {
  const drift = roleDrift(freeze, roleDigests(directory), approved);
  const unapproved = unapprovedDrift(drift);
  if (unapproved.length > 0) {
    throw new RoleFreezeError(
      `role definitions are frozen (PLAN section 1) and ${String(unapproved.length)} have moved ` +
        `without an approved exemption:\n` +
        unapproved
          .map((entry) => `  - ${entry.detail} (${entry.digest.slice(0, 12)})`)
          .join('\n') +
        `\n\nEither restore them, or approve the new definition:\n` +
        unapproved
          .filter((entry) => entry.digest !== '')
          .map(
            (entry) =>
              `  mpgm approve-role ${entry.role} --digest ${entry.digest} --by <who> --reason <why>`,
          )
          .join('\n') +
        `\n\nThe manifest must name the same digest and say why. Both are needed: the file ` +
        `says what is meant to be allowed, and the log says an operator agreed — either alone ` +
        `is a sentence an agent could have written.`,
    );
  }
  return drift;
}
