import { describe, expect, it } from 'vitest';
import { githubSlug, targetRefusal, type TargetFacts } from './target.js';

const REPO = 'siajasl/library-loans';

function facts(overrides: Partial<TargetFacts> = {}): TargetFacts {
  return {
    path: '/work/library-loans',
    topLevel: '/work/library-loans',
    head: 'abc123',
    originUrl: 'https://github.com/siajasl/library-loans.git',
    ...overrides,
  };
}

describe('reading a repository out of a remote', () => {
  it('takes both forms git hands out', () => {
    // Which one a checkout has depends on how it was cloned, which says
    // nothing about whether it is the right repository.
    expect(githubSlug('https://github.com/siajasl/library-loans.git')).toBe(REPO);
    expect(githubSlug('https://github.com/siajasl/library-loans')).toBe(REPO);
    expect(githubSlug('git@github.com:siajasl/library-loans.git')).toBe(REPO);
    expect(githubSlug('  git@github.com:siajasl/library-loans  ')).toBe(REPO);
  });

  it('reads nothing out of a remote that is not one', () => {
    expect(githubSlug('/srv/git/library-loans')).toBeUndefined();
    expect(githubSlug('https://github.com/siajasl')).toBeUndefined();
    expect(githubSlug('')).toBeUndefined();
  });

  it('does not mistake a deeper path for a repository', () => {
    // A URL with more than two segments after the host is not `owner/name`,
    // and taking its first two would name a repository nobody asked for.
    expect(githubSlug('https://example.com/scm/siajasl/library-loans')).toBeUndefined();
  });
});

describe('which working copies are refused', () => {
  it('takes a checkout of the repository the checks will be read from', () => {
    expect(targetRefusal(facts(), REPO)).toBeUndefined();
  });

  it('does not care how the checkout was cloned', () => {
    expect(
      targetRefusal(facts({ originUrl: 'git@github.com:siajasl/library-loans' }), REPO),
    ).toBeUndefined();
  });

  it('ignores case, which GitHub does too', () => {
    expect(
      targetRefusal(
        facts({ originUrl: 'https://github.com/SiaJasl/Library-Loans' }),
        REPO,
      ),
    ).toBeUndefined();
  });

  it('refuses somewhere that is not a repository at all', () => {
    const refusal = targetRefusal(facts({ topLevel: undefined }), REPO);
    expect(refusal).toContain('not a git repository');
    expect(refusal).toContain(REPO);
  });

  it('refuses a subdirectory, and names the top level to use instead', () => {
    // git answers "are you in a repository" by walking upwards, so every
    // subdirectory of a checkout says yes. Worktrees are placed relative to
    // the path given, so accepting one would put checkouts inside a source
    // tree.
    const refusal = targetRefusal(
      facts({ path: '/work/library-loans/src', topLevel: '/work/library-loans' }),
      REPO,
    );
    expect(refusal).toContain('inside a repository');
    expect(refusal).toContain("'/work/library-loans'");
  });

  it('refuses a repository with no commits, and says what to do', () => {
    // The one that matters most for a repository just created on GitHub: the
    // worktree manager branches from HEAD, and an empty repository has none.
    // Without this the failure surfaces from git, deep in the loop.
    const refusal = targetRefusal(facts({ head: undefined }), REPO);
    expect(refusal).toContain('no commits');
    expect(refusal).toContain('initial commit');
  });

  it('refuses a checkout with nowhere to publish', () => {
    const refusal = targetRefusal(facts({ originUrl: undefined }), REPO);
    expect(refusal).toContain("no 'origin' remote");
  });

  it('refuses an origin it cannot read a repository out of', () => {
    const refusal = targetRefusal(facts({ originUrl: '/srv/git/library-loans' }), REPO);
    expect(refusal).toContain('could not read a GitHub repository');
    expect(refusal).toContain('/srv/git/library-loans');
  });

  it('refuses a checkout of a different repository', () => {
    // The expensive one, because nothing about it looks broken: the push
    // succeeds, and then every required kind reports nothing because the
    // checks are being read from a repository the branch is not on.
    const refusal = targetRefusal(
      facts({ originUrl: 'https://github.com/siajasl/mpgm.git' }),
      REPO,
    );
    expect(refusal).toContain('siajasl/mpgm');
    expect(refusal).toContain(REPO);
  });

  it('names the path in every refusal', () => {
    // The operator ran one command with one --into; a refusal that does not
    // say which working copy it is about sends them looking.
    const broken: Partial<TargetFacts>[] = [
      { topLevel: undefined },
      { head: undefined },
      { originUrl: undefined },
      { originUrl: '/srv/git/library-loans' },
      { originUrl: 'https://github.com/siajasl/mpgm' },
    ];

    for (const override of broken) {
      expect(targetRefusal(facts(override), REPO)).toContain('/work/library-loans');
    }
  });
});
