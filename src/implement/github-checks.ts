import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Provider } from '../contract/capability.js';
import { checkRunSchema, type CheckRun } from './checks.js';

/**
 * `ci.checks` over GitHub Actions (DESIGN §4.7, §9 — Actions is the v1 CI).
 *
 * The whole provider is a translation: GitHub's check-run vocabulary into the
 * contract's. Nothing here decides anything — the merge decision lives in
 * `checks.ts` and is the same whichever CI answered.
 */

const run = promisify(execFile);

export class GitHubChecksError extends Error {}

/**
 * Runs a `gh` command and returns stdout. Injectable so tests need no network.
 *
 * `stdin` carries a request body for `gh api --input -`. Passing JSON on the
 * command line would put it in the process table, and a request body is
 * exactly where a credential or a customer's data would be.
 */
export type GitHubApi = (args: readonly string[], stdin?: string) => Promise<string>;

export const ghCli: GitHubApi = async (args, stdin) => {
  if (stdin === undefined) {
    try {
      const { stdout } = await run('gh', [...args], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new GitHubChecksError(`gh ${args.join(' ')} failed: ${detail}`, { cause });
    }
  }

  // `execFile` has no way to supply stdin, so a request body needs `spawn`.
  return new Promise<string>((resolve, reject) => {
    const child = spawn('gh', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.on('data', (chunk: string) => (err += chunk));
    child.on('error', (cause) => {
      reject(
        new GitHubChecksError(`gh ${args.join(' ')} failed: ${cause.message}`, { cause }),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(
          new GitHubChecksError(
            `gh ${args.join(' ')} exited ${String(code)}: ${err.trim() || out.trim()}`,
          ),
        );
      }
    });
    child.stdin.end(stdin);
  });
};

/**
 * What GitHub returns, narrowed to what the contract uses.
 *
 * `status` is loose because GitHub has added values to it over time
 * (`waiting`, `requested`, `pending`) and a provider that threw on an
 * unrecognised status would report "CI is broken" for what is really "CI has
 * not started" — the two have opposite consequences for a merge.
 */
const githubCheckRunSchema = z.object({
  name: z.string().min(1),
  status: z.string(),
  conclusion: z.string().nullable().default(null),
  html_url: z.string().default(''),
});

const checkRunsPageSchema = z.object({
  check_runs: z.array(githubCheckRunSchema).default([]),
});

/** GitHub statuses that are not `completed` all mean "no result yet". */
function normalizeStatus(status: string): CheckRun['status'] {
  return status === 'completed'
    ? 'completed'
    : status === 'in_progress'
      ? 'in_progress'
      : 'queued';
}

/**
 * An unfamiliar conclusion is treated as a failure.
 *
 * The alternative — treating it as a pass, or as absent — decides a merge on
 * a value this code does not understand. Failing closed costs a manual look;
 * failing open merges past a check nobody read.
 */
function normalizeConclusion(conclusion: string | null): CheckRun['conclusion'] {
  const parsed = checkRunSchema.shape.conclusion.safeParse(conclusion);
  return parsed.success ? parsed.data : 'failure';
}

export function toCheckRun(raw: z.infer<typeof githubCheckRunSchema>): CheckRun {
  return {
    name: raw.name,
    status: normalizeStatus(raw.status),
    conclusion: raw.status === 'completed' ? normalizeConclusion(raw.conclusion) : null,
    url: raw.html_url,
  };
}

export interface GitHubChecksOptions {
  readonly api?: GitHubApi;
}

/**
 * Every check run GitHub reports for a ref.
 *
 * `--paginate --slurp` gives one JSON array of pages, so a ref with more than
 * a hundred checks is not silently truncated to its first page — a truncation
 * that would drop checks, and dropped checks read as "not required" rather
 * than as an error.
 */
export async function fetchCheckRuns(
  repo: string,
  ref: string,
  options: GitHubChecksOptions = {},
): Promise<CheckRun[]> {
  const api = options.api ?? ghCli;
  const stdout = await api([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/commits/${ref}/check-runs?per_page=100`,
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new GitHubChecksError(`gh returned output that is not JSON`, { cause });
  }

  // `--slurp` wraps the pages in an array; a single un-slurped page is
  // tolerated too, because that is what a hand-written stub tends to produce.
  const pages = z.array(checkRunsPageSchema).safeParse(parsed);
  const result = pages.success ? pages.data : [checkRunsPageSchema.parse(parsed)];

  return result.flatMap((page) => page.check_runs.map(toCheckRun));
}

const pullRequestSchema = z.object({ number: z.number().int().positive() });

/**
 * Open the pull request for a branch, or return the one already open for it.
 *
 * Idempotent by looking first: a task re-run after an interruption has to find
 * its existing pull request, and a second PR for the same branch would split
 * the task's checks and its review across two places.
 *
 * The body is written for whoever opens the PR rather than for the kernel —
 * the plan task, what it must satisfy, and the fact that a reviewing agent and
 * the merge gate stand between this branch and the trunk.
 */
export async function openPullRequest(
  repo: string,
  request: {
    readonly branch: string;
    readonly into: string;
    readonly title: string;
    readonly body: string;
  },
  options: GitHubChecksOptions = {},
): Promise<number> {
  const api = options.api ?? ghCli;
  const owner = repo.split('/')[0] ?? '';
  const existing = await api([
    'api',
    `repos/${repo}/pulls?head=${owner}:${request.branch}&base=${request.into}&state=open`,
  ]);

  const open = z.array(pullRequestSchema).safeParse(JSON.parse(existing));
  const first = open.success ? open.data[0] : undefined;
  if (first !== undefined) {
    return first.number;
  }

  // The body goes over stdin, not the command line: a process table is the
  // wrong place for anything a task wrote.
  const created = await api(
    ['api', '--method', 'POST', `repos/${repo}/pulls`, '--input', '-'],
    JSON.stringify({
      title: request.title,
      body: request.body,
      head: request.branch,
      base: request.into,
    }),
  );

  const parsed = pullRequestSchema.safeParse(JSON.parse(created));
  if (!parsed.success) {
    throw new GitHubChecksError(
      `opening a pull request for ${request.branch} returned no number: ${created.slice(0, 200)}`,
    );
  }
  return parsed.data.number;
}

/**
 * The Actions job behind a check run.
 *
 * A check run's `html_url` ends `/job/<id>` for Actions; the job id is what
 * the logs endpoint takes. Parsed rather than requested separately because the
 * check-runs response already carries it, and a second round-trip per failing
 * check is a second thing that can fail while an agent waits.
 */
export function jobIdFromUrl(url: string): string | undefined {
  return /\/job\/(\d+)\b/.exec(url)?.[1];
}

/**
 * What a failing check printed.
 *
 * Returns empty text when the check cannot be found or has no job behind it.
 * Empty is a legitimate answer under the contract: the repair loop then feeds
 * back the verdict alone, which is worse feedback but honest, rather than
 * failing the whole repair because a log was unavailable.
 */
export async function fetchCheckLog(
  repo: string,
  ref: string,
  check: string,
  options: GitHubChecksOptions = {},
): Promise<string> {
  const api = options.api ?? ghCli;
  const runs = await fetchCheckRuns(repo, ref, options);
  const jobId = jobIdFromUrl(runs.find((run) => run.name === check)?.url ?? '');
  if (jobId === undefined) {
    return '';
  }
  try {
    return await api(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
  } catch {
    // A log that has expired or been redacted is not a reason to abandon the
    // repair; the verdict still says what failed.
    return '';
  }
}

/** A provider satisfying `ciChecksContract` against GitHub Actions. */
export function githubChecksProvider(options: GitHubChecksOptions = {}): Provider {
  return {
    status: async (input: never): Promise<unknown> => {
      const { repo, ref } = input as { repo: string; ref: string };
      return { ref, runs: await fetchCheckRuns(repo, ref, options) };
    },
    logs: async (input: never): Promise<unknown> => {
      const { repo, ref, check } = input as { repo: string; ref: string; check: string };
      return { check, text: await fetchCheckLog(repo, ref, check, options) };
    },
  };
}
