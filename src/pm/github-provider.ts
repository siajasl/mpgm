import type { Provider } from '../contract/capability.js';
import { ghCli, type GitHubApi } from '../implement/github-checks.js';
import { taskIdFromBody, TASK_COLUMNS, type TaskColumn } from './projection.js';
import type { ObservedIssue, ObservedProjection, PmOperation } from './reconcile.js';

/**
 * `pm.github` over the GitHub REST API (PMG-1 to PMG-4).
 *
 * The contract says nothing about how a column is represented, which is what
 * lets this provider encode one as a `status:<column>` label and a richer
 * Projects v2 provider encode it as a board field, with no change anywhere
 * above (EXT-2/3). Labels are what a repository has on the first day and what
 * survives a board being deleted, so they are the conservative choice for the
 * reference implementation.
 *
 * Status labels are the provider own bookkeeping: they are added and removed
 * here, and never appear in the label set the kernel reasons about.
 */

const STATUS_PREFIX = 'status:';

const STATUS_COLOURS: Readonly<Record<TaskColumn, string>> = {
  backlog: 'ededed',
  ready: 'c2e0c6',
  'in-progress': '1d76db',
  'in-review': 'fbca04',
  blocked: 'd93f0b',
  done: '0e8a16',
};

function statusLabel(column: TaskColumn): string {
  return `${STATUS_PREFIX}${column}`;
}

function columnFromLabels(labels: readonly string[]): TaskColumn {
  for (const name of labels) {
    const column = name.startsWith(STATUS_PREFIX) ? name.slice(STATUS_PREFIX.length) : '';
    if ((TASK_COLUMNS as readonly string[]).includes(column)) {
      return column as TaskColumn;
    }
  }
  // An issue mpgm created always carries one. Without it the next reconcile
  // moves the issue to wherever the plan says it belongs, which is the right
  // repair for a label somebody deleted.
  return 'backlog';
}

interface RawLabel {
  readonly name: string;
  readonly color?: string;
  readonly description?: string | null;
}

interface RawMilestone {
  readonly number: number;
  readonly title: string;
  readonly description?: string | null;
}

interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly labels?: readonly (RawLabel | string)[];
  readonly milestone?: { readonly title: string } | null;
  readonly pull_request?: unknown;
}

function labelNames(labels: readonly (RawLabel | string)[] | undefined): string[] {
  return (labels ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.name));
}

function flatten<T>(text: string): T[] {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed)
    ? parsed.flatMap((page) => (Array.isArray(page) ? (page as T[]) : [page as T]))
    : [parsed as T];
}

export interface GitHubPmOptions {
  readonly api?: GitHubApi;
}

async function get<T>(api: GitHubApi, path: string): Promise<T[]> {
  return flatten<T>(await api(['api', '--paginate', '--slurp', path]));
}

async function post(
  api: GitHubApi,
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  return api(['api', '--method', method, path, '--input', '-'], JSON.stringify(body));
}

/**
 * Read the board as the contract describes it.
 *
 * Only issues carrying a task marker are reported. Issues people opened are
 * not the projector to know about, and reporting them would make the next
 * reconcile want to "repair" work nobody asked it to touch (PMG-3).
 */
export async function observeBoard(
  repo: string,
  options: GitHubPmOptions = {},
): Promise<ObservedProjection> {
  const api = options.api ?? ghCli;

  const rawLabels = await get<RawLabel>(api, `repos/${repo}/labels?per_page=100`);
  const rawMilestones = await get<RawMilestone>(
    api,
    `repos/${repo}/milestones?state=all&per_page=100`,
  );
  const rawIssues = await get<RawIssue>(
    api,
    `repos/${repo}/issues?state=all&per_page=100`,
  );

  const issues: ObservedIssue[] = [];
  for (const raw of rawIssues) {
    if (raw.pull_request !== undefined && raw.pull_request !== null) {
      continue;
    }
    const body = raw.body ?? '';
    const key = taskIdFromBody(body);
    if (key === undefined) {
      continue;
    }
    const names = labelNames(raw.labels);
    issues.push({
      key,
      number: raw.number,
      title: raw.title,
      body,
      labels: names.filter((name) => !name.startsWith(STATUS_PREFIX)),
      milestone: raw.milestone?.title ?? '',
      column: columnFromLabels(names),
      state: raw.state === 'closed' ? 'closed' : 'open',
    });
  }

  const columns = TASK_COLUMNS.filter((column) =>
    rawLabels.some((label) => label.name === statusLabel(column)),
  );

  return {
    labels: rawLabels
      .filter((label) => !label.name.startsWith(STATUS_PREFIX))
      .map((label) => ({
        name: label.name,
        color: label.color ?? '',
        description: label.description ?? '',
      })),
    milestones: rawMilestones.map((milestone) => ({
      title: milestone.title,
      description: milestone.description ?? '',
    })),
    issues,
    columns,
    // The board exists once every column label does; there is nothing else to
    // name, so the title is reported as whatever was asked for.
    boardTitle: columns.length === TASK_COLUMNS.length ? BOARD_TITLE_MARKER : '',
  };
}

/**
 * Stands in for a board name this provider has nowhere to store.
 *
 * `reconcile` compares titles to decide whether the board exists; a provider
 * that cannot hold a title reports this constant so that a fully-labelled
 * repository is not re-created on every pass. A Projects v2 provider reports
 * the real one.
 */
export const BOARD_TITLE_MARKER = 'mpgm plan';

/** Perform one reconcile operation. */
async function performOne(
  api: GitHubApi,
  repo: string,
  operation: PmOperation,
  milestones: Map<string, number>,
  created: Record<string, number>,
): Promise<void> {
  switch (operation.kind) {
    case 'create-board':
      // The columns are labels here, so creating the board is creating them.
      // A label that already exists is a 422, which is what idempotency looks
      // like from this side; a label that genuinely failed to be created is
      // absent from the next `observe`, so the next reconcile asks again
      // rather than believing the work was done.
      for (const column of operation.columns) {
        await post(api, 'POST', `repos/${repo}/labels`, {
          name: statusLabel(column),
          color: STATUS_COLOURS[column],
          description: `Board column: ${column}`,
        }).catch(() => '');
      }
      return;

    case 'create-label':
      await post(api, 'POST', `repos/${repo}/labels`, { ...operation.label });
      return;

    case 'update-label':
      await post(api, 'PATCH', `repos/${repo}/labels/${operation.label.name}`, {
        color: operation.label.color,
        description: operation.label.description,
      });
      return;

    case 'create-milestone': {
      const response = await post(api, 'POST', `repos/${repo}/milestones`, {
        ...operation.milestone,
      });
      const parsed = JSON.parse(response) as { number?: number };
      if (parsed.number !== undefined) {
        milestones.set(operation.milestone.title, parsed.number);
      }
      return;
    }

    case 'update-milestone': {
      const number = milestones.get(operation.milestone.title);
      if (number === undefined) {
        throw new Error(
          `cannot update milestone '${operation.milestone.title}': no such milestone in ${repo}`,
        );
      }
      await post(api, 'PATCH', `repos/${repo}/milestones/${String(number)}`, {
        description: operation.milestone.description,
      });
      return;
    }

    case 'create-issue': {
      const response = await post(api, 'POST', `repos/${repo}/issues`, {
        title: operation.issue.title,
        body: operation.issue.body,
        labels: [...operation.issue.labels, statusLabel(operation.issue.column)],
        ...milestoneField(operation.issue.milestone, milestones),
      });
      const parsed = JSON.parse(response) as { number?: number };
      if (parsed.number !== undefined) {
        created[operation.issue.key] = parsed.number;
      }
      return;
    }

    case 'update-issue':
      await post(api, 'PATCH', `repos/${repo}/issues/${String(operation.number)}`, {
        title: operation.issue.title,
        body: operation.issue.body,
        labels: [...operation.issue.labels, statusLabel(operation.issue.column)],
        ...milestoneField(operation.issue.milestone, milestones),
      });
      return;

    case 'move-issue':
      await post(api, 'PATCH', `repos/${repo}/issues/${String(operation.number)}`, {
        state: operation.state,
      });
      await api([
        'api',
        '--method',
        'DELETE',
        `repos/${repo}/issues/${String(operation.number)}/labels/${statusLabel(operation.from)}`,
      ]).catch(() => '');
      await post(api, 'POST', `repos/${repo}/issues/${String(operation.number)}/labels`, {
        labels: [statusLabel(operation.to)],
      });
      return;

    case 'link-pull-request':
      await post(
        api,
        'POST',
        `repos/${repo}/issues/${String(operation.number)}/comments`,
        {
          body: `Pull request #${String(operation.pullRequest)} implements this task.`,
        },
      );
      return;
  }
}

function milestoneField(
  title: string,
  milestones: Map<string, number>,
): Record<string, number> {
  const number = milestones.get(title);
  return number === undefined ? {} : { milestone: number };
}

/**
 * A provider satisfying `pmGithubContract` against GitHub REST.
 *
 * An operation kind it does not recognise is impossible here — the switch is
 * exhaustive over `PmOperation` — but a *malformed* one still throws rather
 * than being skipped, because a skipped operation leaves the board wrong in a
 * way the next reconcile keeps trying and failing to fix.
 */
export function githubPmProvider(options: GitHubPmOptions = {}): Provider {
  const api = options.api ?? ghCli;

  return {
    observe: async (input: never): Promise<unknown> => {
      const { repo } = input as { repo: string };
      return observeBoard(repo, { api });
    },

    apply: async (input: never): Promise<unknown> => {
      const { repo, operations } = input as { repo: string; operations: PmOperation[] };
      const existing = await get<RawMilestone>(
        api,
        `repos/${repo}/milestones?state=all&per_page=100`,
      );
      const milestones = new Map(
        existing.map((milestone) => [milestone.title, milestone.number]),
      );
      const created: Record<string, number> = {};

      for (const operation of operations) {
        await performOne(api, repo, operation, milestones, created);
      }

      return { applied: operations.length, issues: created };
    },
  };
}
