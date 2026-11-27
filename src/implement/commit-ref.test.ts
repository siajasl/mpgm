import { describe, expect, it } from 'vitest';
import { namesCommit, reconcileRef, UnplacedRefError } from './commit-ref.js';

const HEAD = 'ed8541d047f6c088dc6704bfc931bf71d17badea';

describe('whether a reported ref names the commit the checkout holds', () => {
  it('accepts the abbreviation a reviewer actually wrote', () => {
    // The exact pair that made the carried review say nothing on T4.1.6.
    expect(namesCommit('ed8541d', HEAD)).toBe(true);
  });

  it('accepts the full object name, and its own capitalisation', () => {
    expect(namesCommit(HEAD, HEAD)).toBe(true);
    expect(namesCommit(HEAD.toUpperCase(), HEAD)).toBe(true);
    expect(namesCommit('  ed8541d  ', HEAD)).toBe(true);
  });

  it('refuses a different commit that happens to start the same way', () => {
    expect(namesCommit('ed8541dffffffff', HEAD)).toBe(false);
    expect(namesCommit('2c0d089', HEAD)).toBe(false);
  });

  it('refuses an abbreviation shorter than git would resolve', () => {
    // Six characters is a prefix of a great many commits. A match there says
    // almost nothing, and the gate must not merge on almost nothing.
    expect(namesCommit('ed8541', HEAD)).toBe(false);
    expect(namesCommit('ed', HEAD)).toBe(false);
    expect(namesCommit('', HEAD)).toBe(false);
  });

  it('refuses anything that is not an object name at all', () => {
    expect(namesCommit('HEAD', HEAD)).toBe(false);
    expect(namesCommit('mpgm/T4.1.6', HEAD)).toBe(false);
    expect(namesCommit('the tip of the branch', HEAD)).toBe(false);
  });

  it('refuses to compare against anything but a full object name', () => {
    // Both sides abbreviated is how two different commits agree with each
    // other. The right-hand side comes from `rev-parse`, so it is always full;
    // if it ever is not, that is a bug to refuse on rather than guess through.
    expect(namesCommit('ed8541d', 'ed8541d')).toBe(false);
    expect(namesCommit('ed8541d', `${HEAD}0`)).toBe(false);
    expect(namesCommit('ed8541d', 'not a sha at all, forty characters long!')).toBe(
      false,
    );
  });
});

describe('what gets recorded', () => {
  it('records the commit itself when the session named it', () => {
    expect(reconcileRef('ed8541d', HEAD)).toBe(HEAD);
    expect(reconcileRef(HEAD.toUpperCase(), HEAD)).toBe(HEAD);
  });

  it('leaves a ref that names something else exactly as it was written', () => {
    // This is what keeps `review-is-stale` able to fire. Replacing it with the
    // real head would erase the evidence that the reviewer read another commit
    // and merge the change on a review of something that no longer exists.
    expect(reconcileRef('2c0d089', HEAD)).toBe('2c0d089');
    expect(reconcileRef('HEAD', HEAD)).toBe('HEAD');
  });
});

describe('UnplacedRefError (T4.3.26)', () => {
  it('names the mismatch when the worktree has a tip, and this is not it', () => {
    const error = new UnplacedRefError('2c0d089', HEAD, "repair attempt 1's output");
    expect(error.reported).toBe('2c0d089');
    expect(error.tip).toBe(HEAD);
    expect(error.source).toBe("repair attempt 1's output");
    expect(error.message).toBe(
      `the reported ref '2c0d089' (from repair attempt 1's output) does not name the worktree's tip (${HEAD})`,
    );
  });

  // The other arm — no test exercised it until now (T4.3.26's review 4): a
  // worktree gone before its tip could be read (a hard kill, DESIGN §6)
  // reports `tip: undefined` rather than any commit, and the message must
  // say the tip could not be read rather than naming one it never had.
  it('says the tip could not be read at all, rather than naming one, when there is none to read', () => {
    const error = new UnplacedRefError(
      '5925262 (branch mpgm/T4.3.22)',
      undefined,
      "the implementing session's output",
    );
    expect(error.tip).toBeUndefined();
    expect(error.message).toBe(
      'could not read the commit the worktree is on, so the reported ref ' +
        "'5925262 (branch mpgm/T4.3.22)' (from the implementing session's " +
        'output) cannot be checked against it',
    );
    expect(error.message).not.toContain('undefined');
  });
});
