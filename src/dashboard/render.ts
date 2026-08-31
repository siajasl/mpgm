import type {
  DashboardGate,
  DashboardRun,
  DashboardSummary,
  DashboardTask,
  TraceGraph,
} from './projection.js';

/**
 * HTML panels over the projection API (DESIGN §4.4, OBS-3, T3.2.5b).
 *
 * Every function here is a pure string transform of a projection value from
 * `projection.ts` — same discipline as that module: nothing here reads a
 * clock, a socket or the DOM, so a panel is testable by calling it with a
 * fixture and checking the string it returns, with no browser involved. The
 * HTTP layer (`server.ts`) calls these when a request's `Accept` header
 * prefers HTML over JSON; the data underneath is identical either way.
 *
 * "Live" is a page property, not a rendering one: each request re-runs the
 * projection before these functions ever see it (`server.ts`), and every
 * rendered page carries a short `<meta http-equiv="refresh">` so a page left
 * open keeps reflecting the log without any client-side script.
 */

const REFRESH_SECONDS = 5;

/** Escape untrusted text before it lands in HTML — task ids, reasons and
 * summaries all originate in event payloads, which is attacker-reachable
 * input (a role's session output), not operator-typed content. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="${String(REFRESH_SECONDS)}" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
  h1, h2 { margin-bottom: 0.25rem; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: left; font-size: 0.9rem; }
  th { background: #f2f2f2; }
  .blocked, .awaiting { background: #fff3cd; }
  .muted { color: #666; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
<nav><a href="/">runs</a> <a href="/trace">trace</a></nav>
${body}
</body>
</html>
`;
}

/** A minimal page for an error response negotiated as HTML. */
export function errorPage(status: number, message: string): string {
  return page(
    `mpgm dashboard — ${String(status)}`,
    `<h1>${String(status)}</h1><p>${escapeHtml(message)}</p>`,
  );
}

function summaryRow(summary: DashboardSummary): string {
  return `<tr>
<td><a href="/runs/${encodeURIComponent(summary.runId)}">${escapeHtml(summary.runId)}</a></td>
<td>${escapeHtml(summary.project)}</td>
<td>${escapeHtml(summary.control)}</td>
<td>${escapeHtml(summary.currentPhase ?? '-')}</td>
<td>${money(summary.usage.costUsd)}</td>
<td class="${summary.blockedTasks > 0 ? 'blocked' : ''}">${String(summary.blockedTasks)}</td>
<td class="${summary.pendingApprovals > 0 ? 'awaiting' : ''}">${String(summary.pendingApprovals)}</td>
</tr>`;
}

/** The list view — every run the log currently knows about, one row each. */
export function runListPage(summaries: readonly DashboardSummary[]): string {
  const body =
    summaries.length === 0
      ? '<h1>Runs</h1><p class="muted">no runs in the log</p>'
      : `<h1>Runs</h1>
<table>
<thead><tr><th>run</th><th>project</th><th>control</th><th>phase</th><th>spend</th><th>blocked</th><th>pending approvals</th></tr></thead>
<tbody>
${summaries.map(summaryRow).join('\n')}
</tbody>
</table>`;
  return page('mpgm dashboard', body);
}

function taskRow(task: DashboardTask): string {
  return `<tr class="${task.blocked ? 'blocked' : ''}">
<td>${escapeHtml(task.taskId)}</td>
<td>${escapeHtml(task.role)}</td>
<td>${escapeHtml(task.model)}</td>
<td>${escapeHtml(task.status)}</td>
<td>${task.review === null ? '-' : task.review.approved ? 'approved' : 'not approved'}</td>
<td>${task.merged === null ? '-' : escapeHtml(task.merged.commit)}</td>
<td>${money(task.usage.costUsd)}</td>
</tr>`;
}

function gateRow(gate: DashboardGate): string {
  return `<tr class="${gate.awaitingApproval ? 'awaiting' : ''}">
<td>${escapeHtml(gate.gateId)}</td>
<td>${escapeHtml(gate.phase)}</td>
<td>${escapeHtml(gate.status)}</td>
<td>${gate.decidedBy === null ? '-' : escapeHtml(gate.decidedBy)}</td>
<td>${escapeHtml(gate.reason)}</td>
</tr>`;
}

/** The detail view for one run: state, approvals and spend (DESIGN §4.4). */
export function runDetailPage(run: DashboardRun): string {
  const tasks =
    run.tasks.length === 0
      ? '<p class="muted">no tasks yet</p>'
      : `<table>
<thead><tr><th>task</th><th>role</th><th>model</th><th>status</th><th>review</th><th>merged</th><th>spend</th></tr></thead>
<tbody>
${run.tasks.map(taskRow).join('\n')}
</tbody>
</table>`;

  const gates =
    run.gates.length === 0
      ? '<p class="muted">no gates yet</p>'
      : `<table>
<thead><tr><th>gate</th><th>phase</th><th>status</th><th>decided by</th><th>reason</th></tr></thead>
<tbody>
${run.gates.map(gateRow).join('\n')}
</tbody>
</table>`;

  const destructiveCalls =
    run.destructiveCalls.length === 0
      ? '<p class="muted">none recorded</p>'
      : `<table>
<thead><tr><th>tool</th><th>task</th><th>dry run</th><th>confirmed by</th></tr></thead>
<tbody>
${run.destructiveCalls
  .map(
    (call) => `<tr>
<td>${escapeHtml(call.tool)}</td>
<td>${escapeHtml(call.taskId)}</td>
<td>${String(call.dryRun)}</td>
<td>${call.confirmedBy === null ? '-' : escapeHtml(call.confirmedBy)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>`;

  const body = `<h1>${escapeHtml(run.runId)}</h1>
<p>project ${escapeHtml(run.project)} &middot; control ${escapeHtml(run.control)} &middot; phase ${escapeHtml(run.currentPhase ?? '-')}</p>
<p>spend ${money(run.usage.costUsd)} &middot; tokens ${String(run.usage.inputTokens + run.usage.outputTokens)} &middot; interventions ${String(run.interventions)}</p>
<h2>Tasks</h2>
${tasks}
<h2>Approvals</h2>
${gates}
<h2>Destructive calls</h2>
${destructiveCalls}
`;
  return page(`mpgm dashboard — ${run.runId}`, body);
}

/** The trace graph the index currently holds (ADR-4). */
export function traceGraphPage(graph: TraceGraph): string {
  const nodes =
    graph.nodes.length === 0
      ? '<p class="muted">no declarations indexed</p>'
      : `<table>
<thead><tr><th>id</th><th>kind</th><th>label</th><th>source</th></tr></thead>
<tbody>
${graph.nodes
  .map(
    (node) => `<tr>
<td>${escapeHtml(node.id)}</td>
<td>${escapeHtml(node.kind)}</td>
<td>${escapeHtml(node.label)}</td>
<td>${escapeHtml(node.source)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>`;

  const links =
    graph.links.length === 0
      ? '<p class="muted">no links indexed</p>'
      : `<table>
<thead><tr><th>from</th><th>relation</th><th>to</th><th>source</th></tr></thead>
<tbody>
${graph.links
  .map(
    (link) => `<tr>
<td>${escapeHtml(link.src)}</td>
<td>${escapeHtml(link.relation)}</td>
<td>${escapeHtml(link.dst)}</td>
<td>${escapeHtml(link.source)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>`;

  const body = `<h1>Trace graph</h1>
<h2>Nodes</h2>
${nodes}
<h2>Links</h2>
${links}
`;
  return page('mpgm dashboard — trace', body);
}
