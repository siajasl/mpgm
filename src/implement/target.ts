/**
 * The working copy an implementation task lands in (IMP-1, IMP-2).
 *
 * Until now the answer was always the mpgm checkout: the plan being executed
 * and the code being written lived in one repository, so nothing had to say
 * which. T3.2.6 builds the sample service in a repository of its own, and P4
 * deploys it, so the two come apart — mpgm's plan still says what to build,
 * and somewhere else is where it lands.
 *
 * What stays behind matters as much as what moves. Roles and the freeze
 * manifest are mpgm's, because they are what the harness runs agents under
 * rather than anything about the project being built; so is the event log,
 * because one operator has one log. What follows the target is the code: the
 * worktrees, the branch that gets published, and the paths the policy hook
 * will let an agent write.
 */

/** What is known about a candidate working copy, gathered by the caller. */
export interface TargetFacts {
  /** Absolute path, as the operator gave it. */
  readonly path: string;
  /**
   * The top level of the repository `path` is in, or undefined when it is in
   * none.
   *
   * The top level rather than a yes/no, because git answers "are you in a
   * repository" by walking upwards: every subdirectory of a checkout says yes.
   * A worktree root is placed relative to the path it was given, so accepting
   * a subdirectory would scatter checkouts inside the source tree of the one
   * repository this is all meant to keep clean.
   */
  readonly topLevel: string | undefined;
  /** The commit the trunk is on, or undefined when there are no commits. */
  readonly head: string | undefined;
  /** `origin`'s URL, or undefined when there is no such remote. */
  readonly originUrl: string | undefined;
}

/**
 * `owner/name` from a GitHub remote URL, or undefined if it is not one.
 *
 * Both forms git hands out are accepted, because which one a checkout has
 * depends on how it was cloned and has nothing to do with whether it is the
 * right repository.
 */
export function githubSlug(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const ssh = /^git@[^:]+:([^/]+\/[^/]+)$/.exec(trimmed);
  if (ssh?.[1] !== undefined) {
    return ssh[1];
  }
  const https = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)$/.exec(trimmed);
  return https?.[1];
}

/**
 * Why this working copy cannot be implemented into, phrased for the operator.
 *
 * Returns the message, or undefined when it is usable. Every branch names the
 * thing to do next rather than the rule that was broken (CONV-3), because the
 * operator reading it is mid-command and wants the fix.
 *
 * Refusing is the whole point (CONV-4). Each of these would otherwise fail
 * somewhere expensive and confusing: an empty repository fails when the
 * worktree manager looks for a commit to branch from, and a mismatched remote
 * does not fail at all — it pushes the branch to one repository and reads the
 * checks from another, so every required kind reports nothing and the task
 * blocks on a CI that was never asked.
 */
export function targetRefusal(facts: TargetFacts, repo: string): string | undefined {
  if (facts.topLevel === undefined) {
    return (
      `'${facts.path}' is not a git repository. --into names the working copy ` +
      `the task is implemented in, and it must be a checkout of ${repo}.`
    );
  }

  if (facts.topLevel !== facts.path) {
    return (
      `'${facts.path}' is inside a repository rather than being one: its top ` +
      `level is '${facts.topLevel}'. Pass that instead, or the task's worktrees ` +
      `would be created inside a source tree.`
    );
  }

  if (facts.head === undefined) {
    return (
      `'${facts.path}' has no commits, so there is no trunk to branch from. ` +
      `Give it an initial commit and push it, then run this again.`
    );
  }

  if (facts.originUrl === undefined) {
    return (
      `'${facts.path}' has no 'origin' remote. The kernel publishes the task's ` +
      `branch so that CI can see it, and there is nowhere to publish it to.`
    );
  }

  const slug = githubSlug(facts.originUrl);
  if (slug === undefined) {
    return (
      `could not read a GitHub repository out of origin '${facts.originUrl}' at ` +
      `'${facts.path}'. --repo says ${repo}, and the two have to be the same ` +
      `repository or the checks would be read from somewhere the branch is not.`
    );
  }

  if (slug.toLowerCase() !== repo.toLowerCase()) {
    return (
      `'${facts.path}' has origin ${slug}, but --repo says ${repo}. The branch ` +
      `would be pushed to one repository and its checks read from another, so ` +
      `nothing would ever report.`
    );
  }

  return undefined;
}
