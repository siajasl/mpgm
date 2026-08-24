import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRolesFrozen,
  digestOf,
  roleDrift,
  RoleFreezeError,
  roleFreezeSchema,
  unapprovedDrift,
} from './freeze.js';

const tempDirs: string[] = [];

function roleDirectory(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-freeze-'));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.md`), body);
  }
  return dir;
}

function freeze(digests: Readonly<Record<string, string>>, exemptions: unknown[] = []) {
  return roleFreezeSchema.parse({
    reason: 'switchover',
    frozenAt: '2026-08-24',
    digests,
    exemptions,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the role freeze (PLAN section 1)', () => {
  const original = '---\nname: implementer\n---\n\nDo the work.\n';

  it('passes when nothing has moved', () => {
    const directory = roleDirectory({ implementer: original });

    expect(
      assertRolesFrozen(freeze({ implementer: digestOf(original) }), directory),
    ).toEqual([]);
  });

  it('refuses a role that changed without an exemption', () => {
    const directory = roleDirectory({ implementer: `${original}And also this.\n` });

    expect(() =>
      assertRolesFrozen(freeze({ implementer: digestOf(original) }), directory),
    ).toThrow(RoleFreezeError);
  });

  it('names every drifted role at once, not the first', () => {
    const directory = roleDirectory({ implementer: 'a\n', reviewer: 'b\n' });
    const manifest = freeze({
      implementer: digestOf(original),
      reviewer: digestOf(original),
    });

    let message = '';
    try {
      assertRolesFrozen(manifest, directory);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('implementer');
    expect(message).toContain('reviewer');
    expect(message).toContain('2 have moved');
  });

  it('allows a change an exemption names, by digest', () => {
    const changed = `${original}Revised.\n`;
    const directory = roleDirectory({ implementer: changed });
    const manifest = freeze({ implementer: digestOf(original) }, [
      {
        role: 'implementer',
        digest: digestOf(changed),
        approvedBy: 'macg',
        reason: 'the role was asking for the wrong thing in review',
        at: '2026-08-25',
      },
    ]);

    const drift = assertRolesFrozen(manifest, directory);

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ kind: 'changed', exempt: true });
  });

  it('does not let an exemption cover a later change as well', () => {
    // The exemption names a digest, so approving one revision does not approve
    // the next — the same reasoning as a code review approving a commit.
    const approved = `${original}Revised.\n`;
    const directory = roleDirectory({ implementer: `${approved}And again.\n` });
    const manifest = freeze({ implementer: digestOf(original) }, [
      {
        role: 'implementer',
        digest: digestOf(approved),
        approvedBy: 'macg',
        reason: 'approved the first revision',
        at: '2026-08-25',
      },
    ]);

    expect(() => assertRolesFrozen(manifest, directory)).toThrow(RoleFreezeError);
  });

  it('reports an added role, which no eval has ever seen', () => {
    const directory = roleDirectory({ implementer: original, newcomer: 'x\n' });

    const drift = roleDrift(freeze({ implementer: digestOf(original) }), {
      implementer: digestOf(original),
      newcomer: digestOf('x\n'),
    });

    expect(drift).toEqual([
      expect.objectContaining({ role: 'newcomer', kind: 'added', exempt: false }),
    ]);
    expect(unapprovedDrift(drift)).toHaveLength(1);
    expect(() =>
      assertRolesFrozen(freeze({ implementer: digestOf(original) }), directory),
    ).toThrow();
  });

  it('reports a removed role', () => {
    const drift = roleDrift(
      freeze({ implementer: 'a'.repeat(64), gone: 'b'.repeat(64) }),
      {
        implementer: 'a'.repeat(64),
      },
    );

    expect(drift).toEqual([expect.objectContaining({ role: 'gone', kind: 'removed' })]);
  });

  it('does not fire because somebody checked out on Windows', () => {
    expect(digestOf('a\r\nb\r\n')).toBe(digestOf('a\nb\n'));
  });

  it('refuses an exemption with no reason', () => {
    expect(() =>
      freeze({}, [
        {
          role: 'implementer',
          digest: 'a'.repeat(64),
          approvedBy: 'macg',
          reason: '',
          at: 'x',
        },
      ]),
    ).toThrow();
  });
});

describe("mpgm's own freeze", () => {
  it('matches the roles in this repository', () => {
    // If this fails, a role was edited without updating roles/freeze.json.
    // That is the freeze working: add the new digest, say who approved it and
    // why, and the change goes through the merge gate like any other.
    const projectRoot = join(import.meta.dirname, '..', '..');
    const manifest = roleFreezeSchema.parse(
      JSON.parse(
        execFileSync('cat', [join(projectRoot, 'roles', 'freeze.json')], {
          encoding: 'utf8',
        }),
      ),
    );

    expect(() => assertRolesFrozen(manifest, join(projectRoot, 'roles'))).not.toThrow();
  });
});
