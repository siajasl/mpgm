import type { RunGateRates } from '../state/gate-rates.js';
import type { AggregateMetric, RunMetrics } from '../state/metrics.js';
import type {
  DashboardGate,
  DashboardRun,
  DashboardSummary,
  DashboardTask,
  TraceGraph,
} from './projection.js';

/**
 * HTML panels over the projection API (DESIGN §4.4, OBS-2/3/4, T3.2.5b,
 * T4.2.6).
 *
 * The run-detail page's Metrics and Quality rates sections render
 * `DashboardRun.metrics`/`.rates` — `RunMetrics` and `RunGateRates`
 * (T4.2.1/T4.2.2a/b) folded from the run's own events and the artifact
 * store, not from `RunState` (`projection.ts`). A null `successRate` or
 * `avgLatencyMs` renders as `-`, never `0%`/`0ms`: an empty bucket has
 * nothing to report, and the two must not read alike (OBS-2).
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

/**
 * A string already known to be safe HTML: the escaped-and-assembled output
 * of `markup` below, and nothing else. The constructor is private, so the
 * only way to produce one is `markup`, which escapes every interpolation —
 * there is no way to construct a `SafeHtml` from a plain string without
 * going through it. That is what makes bypassing escaping a deliberate act
 * rather than an omission: a new `<td>${task.someNewField}</td>` written as
 * a plain template literal where a `SafeHtml` is expected is a type error,
 * not a silent XSS waiting for someone to notice the missing `escapeHtml`
 * call (CONV-5). A nested `markup` result — including an array of them, as
 * every row-per-item table below composes — is recognised by `escapeValue`
 * and spliced in verbatim rather than double-escaped.
 *
 * (Named `markup` rather than the more obvious `html`: Prettier treats a
 * tagged template literal whose tag is literally named `html` as embedded
 * HTML and reformats its contents on every `format` run, which would rewrite
 * the whitespace of every page this module renders as a side effect of
 * running the formatter. `markup` gets the same tagged-template mechanism
 * without that.)
 */
class SafeHtml {
  private constructor(readonly value: string) {}

  static of(value: string): SafeHtml {
    return new SafeHtml(value);
  }

  toString(): string {
    return this.value;
  }
}

function escapeValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(escapeValue).join('');
  }
  return escapeHtml(String(value));
}

/**
 * Tagged template that escapes every interpolated value by default. A
 * nested `markup` result is recognised as already-safe and spliced in
 * verbatim rather than double-escaped; a plain string, number or boolean —
 * including one drawn straight from an event payload — is always escaped.
 * There is no interpolation path here that skips escaping.
 */
function markup(strings: TemplateStringsArray, ...values: readonly unknown[]): SafeHtml {
  let result = strings[0] ?? '';
  values.forEach((value, i) => {
    result += escapeValue(value);
    result += strings[i + 1] ?? '';
  });
  return SafeHtml.of(result);
}

function money(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function percent(rate: number | null): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(0)}%`;
}

/**
 * `successRate`/`avgLatencyMs` render as `-` rather than `0%`/`0ms` when
 * null — a bucket with no settled task has nothing to report, not a 0%
 * success rate (`../state/metrics.ts`, OBS-2). Printing 0% for a run where
 * no task has finished would report total failure (T4.2.6, test).
 */
function successText(metric: AggregateMetric): string {
  return metric.successRate === null
    ? '-'
    : `${percent(metric.successRate)} (${String(metric.completed)}/${String(metric.completed + metric.blocked)})`;
}

function latencyText(metric: AggregateMetric): string {
  return metric.avgLatencyMs === null
    ? '-'
    : `${String(Math.round(metric.avgLatencyMs))}ms`;
}

function metricRow(scope: string, metric: AggregateMetric): SafeHtml {
  return markup`<tr>
<td>${scope}</td>
<td>${metric.tasks}</td>
<td>${money(metric.costUsd)}</td>
<td>${metric.inputTokens + metric.outputTokens}</td>
<td>${latencyText(metric)}</td>
<td>${metric.retries}</td>
<td>${successText(metric)}</td>
</tr>`;
}

function metricTable(
  caption: string,
  scopeHeader: string,
  rows: readonly [string, AggregateMetric][],
): SafeHtml {
  if (rows.length === 0) {
    return markup`<h3>${caption}</h3><p class="muted">no tasks yet</p>`;
  }
  return markup`<h3>${caption}</h3>
<table>
<thead><tr><th>${scopeHeader}</th><th>tasks</th><th>cost</th><th>tokens</th><th>avg latency</th><th>retries</th><th>success</th></tr></thead>
<tbody>
${rows.map(([label, metric]) => metricRow(label, metric))}
</tbody>
</table>`;
}

/**
 * Cost, latency, retries and success — per phase, per role and for the run
 * overall (OBS-2, T4.2.1/T4.2.6). Read from `RunMetrics`, which folds the
 * run's own event slice rather than `RunState` (`projection.ts`).
 */
function metricsSection(metrics: RunMetrics): SafeHtml {
  const overall = markup`<h3>Overall</h3>
<table>
<thead><tr><th>scope</th><th>tasks</th><th>cost</th><th>tokens</th><th>avg latency</th><th>retries</th><th>success</th></tr></thead>
<tbody>
${metricRow('run', metrics.overall)}
</tbody>
</table>`;
  return markup`<h2>Metrics</h2>
${overall}
${metricTable('By phase', 'phase', Object.entries(metrics.byPhase))}
${metricTable('By role', 'role', Object.entries(metrics.byRole))}
`;
}

/**
 * Phase-gate, merge-gate, rework and escaped-defect rates (OBS-4,
 * T4.2.2a/b/T4.2.6). `-` renders a null rate for the same reason
 * `successText` renders one — nothing decided (or, for escaped defects,
 * nothing filed) yet is not a 0% rate.
 */
function gateRatesSection(rates: RunGateRates): SafeHtml {
  return markup`<h2>Quality rates</h2>
<table>
<thead><tr><th>rate</th><th>value</th><th>detail</th></tr></thead>
<tbody>
<tr>
<td>phase-gate rejection</td>
<td>${percent(rates.phaseGate.rate)}</td>
<td>${rates.phaseGate.rejected}/${rates.phaseGate.decided} decided rejected</td>
</tr>
<tr>
<td>merge-gate refusal</td>
<td>${percent(rates.mergeGate.rate)}</td>
<td>${rates.mergeGate.refusals}/${rates.mergeGate.attempts} attempts; ${rates.mergeGate.budgetExhausted} budget-exhausted; cannot see ${rates.mergeGate.unobservable.join(', ')}</td>
</tr>
<tr>
<td>rework</td>
<td>${percent(rates.rework.rate)}</td>
<td>${rates.rework.reworked}/${rates.rework.reviewed} reviews sent back</td>
</tr>
<tr>
<td>escaped defects</td>
<td>${percent(rates.escapedDefects.rate)}</td>
<td>${rates.escapedDefects.escaped}/${rates.escapedDefects.merged} merged tasks; ${rates.escapedDefects.filed} filed; ${rates.escapedDefects.unrouted} unrouted; ${rates.escapedDefects.undated} undated</td>
</tr>
</tbody>
</table>`;
}

function page(title: string, body: SafeHtml): SafeHtml {
  return markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="${REFRESH_SECONDS}" />
<title>${title}</title>
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
    markup`<h1>${status}</h1><p>${message}</p>`,
  ).toString();
}

function summaryRow(summary: DashboardSummary): SafeHtml {
  return markup`<tr>
<td><a href="/runs/${encodeURIComponent(summary.runId)}">${summary.runId}</a></td>
<td>${summary.project}</td>
<td>${summary.control}</td>
<td>${summary.currentPhase ?? '-'}</td>
<td>${money(summary.usage.costUsd)}</td>
<td class="${summary.blockedTasks > 0 ? 'blocked' : ''}">${summary.blockedTasks}</td>
<td class="${summary.pendingApprovals > 0 ? 'awaiting' : ''}">${summary.pendingApprovals}</td>
</tr>`;
}

/** The list view — every run the log currently knows about, one row each. */
export function runListPage(summaries: readonly DashboardSummary[]): string {
  const body =
    summaries.length === 0
      ? markup`<h1>Runs</h1><p class="muted">no runs in the log</p>`
      : markup`<h1>Runs</h1>
<table>
<thead><tr><th>run</th><th>project</th><th>control</th><th>phase</th><th>spend</th><th>blocked</th><th>pending approvals</th></tr></thead>
<tbody>
${summaries.map(summaryRow)}
</tbody>
</table>`;
  return page('mpgm dashboard', body).toString();
}

function taskRow(task: DashboardTask): SafeHtml {
  return markup`<tr class="${task.blocked ? 'blocked' : ''}">
<td>${task.taskId}</td>
<td>${task.role}</td>
<td>${task.model}</td>
<td>${task.status}</td>
<td>${task.review === null ? '-' : task.review.approved ? 'approved' : 'not approved'}</td>
<td>${task.merged === null ? '-' : task.merged.commit}</td>
<td>${money(task.usage.costUsd)}</td>
</tr>`;
}

function gateRow(gate: DashboardGate): SafeHtml {
  return markup`<tr class="${gate.awaitingApproval ? 'awaiting' : ''}">
<td>${gate.gateId}</td>
<td>${gate.phase}</td>
<td>${gate.status}</td>
<td>${gate.decidedBy ?? '-'}</td>
<td>${gate.reason}</td>
</tr>`;
}

/** The detail view for one run: state, approvals and spend (DESIGN §4.4). */
export function runDetailPage(run: DashboardRun): string {
  const tasks =
    run.tasks.length === 0
      ? markup`<p class="muted">no tasks yet</p>`
      : markup`<table>
<thead><tr><th>task</th><th>role</th><th>model</th><th>status</th><th>review</th><th>merged</th><th>spend</th></tr></thead>
<tbody>
${run.tasks.map(taskRow)}
</tbody>
</table>`;

  const gates =
    run.gates.length === 0
      ? markup`<p class="muted">no gates yet</p>`
      : markup`<table>
<thead><tr><th>gate</th><th>phase</th><th>status</th><th>decided by</th><th>reason</th></tr></thead>
<tbody>
${run.gates.map(gateRow)}
</tbody>
</table>`;

  const destructiveCalls =
    run.destructiveCalls.length === 0
      ? markup`<p class="muted">none recorded</p>`
      : markup`<table>
<thead><tr><th>tool</th><th>task</th><th>dry run</th><th>confirmed by</th></tr></thead>
<tbody>
${run.destructiveCalls.map(
  (call) => markup`<tr>
<td>${call.tool}</td>
<td>${call.taskId}</td>
<td>${call.dryRun}</td>
<td>${call.confirmedBy ?? '-'}</td>
</tr>`,
)}
</tbody>
</table>`;

  const body = markup`<h1>${run.runId}</h1>
<p>project ${run.project} &middot; control ${run.control} &middot; phase ${run.currentPhase ?? '-'}</p>
<p>spend ${money(run.usage.costUsd)} &middot; tokens ${run.usage.inputTokens + run.usage.outputTokens} &middot; interventions ${run.interventions}</p>
${metricsSection(run.metrics)}
${gateRatesSection(run.rates)}
<h2>Tasks</h2>
${tasks}
<h2>Approvals</h2>
${gates}
<h2>Destructive calls</h2>
${destructiveCalls}
`;
  return page(`mpgm dashboard — ${run.runId}`, body).toString();
}

/** The trace graph the index currently holds (ADR-4). */
export function traceGraphPage(graph: TraceGraph): string {
  const nodes =
    graph.nodes.length === 0
      ? markup`<p class="muted">no declarations indexed</p>`
      : markup`<table>
<thead><tr><th>id</th><th>kind</th><th>label</th><th>source</th></tr></thead>
<tbody>
${graph.nodes.map(
  (node) => markup`<tr>
<td>${node.id}</td>
<td>${node.kind}</td>
<td>${node.label}</td>
<td>${node.source}</td>
</tr>`,
)}
</tbody>
</table>`;

  const links =
    graph.links.length === 0
      ? markup`<p class="muted">no links indexed</p>`
      : markup`<table>
<thead><tr><th>from</th><th>relation</th><th>to</th><th>source</th></tr></thead>
<tbody>
${graph.links.map(
  (link) => markup`<tr>
<td>${link.src}</td>
<td>${link.relation}</td>
<td>${link.dst}</td>
<td>${link.source}</td>
</tr>`,
)}
</tbody>
</table>`;

  const body = markup`<h1>Trace graph</h1>
<h2>Nodes</h2>
${nodes}
<h2>Links</h2>
${links}
`;
  return page('mpgm dashboard — trace', body).toString();
}
