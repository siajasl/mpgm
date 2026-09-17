import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentSessionProvider } from '../agent/session.js';
import { SessionRunner } from '../agent/runner.js';
import type { OutputSchemaRegistry } from '../agent/output-registry.js';
import { ArtifactStore } from '../artifact/store.js';
import type { ArtifactSchemaRegistry } from '../artifact/schema-registry.js';
import { CapabilityRegistry, type BoundContract } from '../contract/capability.js';
import { DEFAULT_EGRESS_POLICY, type EgressPolicy } from '../context/egress.js';
import { loadKnowledgeBase, type KbDocument } from '../context/knowledge-base.js';
import { DashboardServer } from '../dashboard/server.js';
import { openDatabase } from '../database.js';
import {
  composeProvider,
  gatedEnvironments,
  loadDeclaredEnvironments,
  type EnvironmentEntry,
} from '../env/compose-provider.js';
import { envProvisionContract } from '../env/provision.js';
import { KERNEL_TASK, kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { elicit, type OperatorIo } from '../elicit/session.js';
import { GateManager, gateOracleFromState } from '../gate/manager.js';
import { isGitRepository, tagGate } from '../git/tag.js';
import { runPhase } from '../phase/runner.js';
import { TraceIndex } from '../trace/index-store.js';
import { planReopen, reopenPhase } from '../gate/reopen.js';
import { TraceIndexer } from '../trace/indexer.js';
import { PlaybookRegistry } from '../playbook/loader.js';
import {
  assertRollbackReady,
  crossRunLedger,
  type ConfirmationSpent,
  type DryRunNeeded,
} from '../policy/deploy-gate.js';
import {
  releaseDeliverContract,
  releaseArtifactSchema,
  type ReleaseArtifact,
} from '../release/deliver.js';
import { dockerReleaseProvider } from '../release/docker-provider.js';
import { RoleRegistry } from '../role/loader.js';
import { commandNfrProvider } from '../test/nfr-provider.js';
import { testNfrContract } from '../test/nfr.js';
import {
  approvalKey,
  assertRolesFrozen,
  loadRoleFreeze,
  roleDigests,
} from '../role/freeze.js';
import { awaitChecks, mergeVerdict } from '../implement/checks.js';
import {
  fetchCheckLog,
  fetchCheckRuns,
  openPullRequest,
} from '../implement/github-checks.js';
import { implementTask } from '../implement/loop.js';
import { verifyOperatorMerge } from '../implement/merge.js';
import { renderProgress } from '../implement/progress.js';
import { targetRefusal, type TargetFacts } from '../implement/target.js';
import { branchNameFor, WorktreeManager } from '../implement/worktree.js';
import { completedTaskIds, ingestPlan, readyTasks } from '../plan/ingest.js';
import { computeGateRates, type RunGateRates } from '../state/gate-rates.js';
import { computeRunMetrics, type AggregateMetric } from '../state/metrics.js';
import {
  computeHarnessOverhead,
  NFR3_OVERHEAD_THRESHOLD,
  type HarnessOverhead,
} from '../state/overhead.js';
import { Projector } from '../state/projector.js';
import { fold } from '../state/reduce.js';
import { SnapshotStore } from '../state/snapshot-store.js';

/**
 * Operator console verbs (DESIGN §4.4, HIL-3).
 *
 * Every verb is a function of a context, so the same code path the operator
 * drives is the one the end-to-end script drives. A CLI that could only be
 * exercised by a human would be a CLI nobody tests.
 */

export interface CliContext {
  /** Project root; the log lives at `<root>/.mpgm/state.db`. */
  readonly root: string;
  readonly provider: AgentSessionProvider;
  readonly io: OperatorIo;
  readonly outputSchemas: OutputSchemaRegistry;
  readonly artifactSchemas: ArtifactSchemaRegistry;
  readonly policy?: EgressPolicy;
  /** Defaults to `<root>/kb`, when it exists. */
  readonly kb?: readonly KbDocument[];
  readonly write: (line: string) => void;
  /**
   * Stops a verb that would otherwise run until the operator interrupts it.
   *
   * Only `serve` reads it. The binary passes none, so an operator gets the
   * signal handling they expect; a caller embedding the console — the
   * end-to-end script, above all — passes one, because a verb that can only
   * be stopped by killing the process is a verb no test can exercise.
   */
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly detail: string;
}

function open(context: CliContext) {
  const db = openDatabase(join(context.root, '.mpgm', 'state.db'));
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  return { db, log, projector };
}

function knowledgeBase(context: CliContext): readonly KbDocument[] {
  if (context.kb !== undefined) {
    return context.kb;
  }
  try {
    return loadKnowledgeBase(join(context.root, 'kb'));
  } catch {
    return [];
  }
}

/**
 * What git says about a candidate `--into`, for `targetRefusal` to judge.
 *
 * Every question is asked with a command that fails loudly when the answer is
 * "there is none", so a missing HEAD or remote arrives here as `undefined`
 * rather than as an empty string that reads like an answer.
 */
function targetFacts(path: string): TargetFacts {
  const resolved = (candidate: string | undefined): string | undefined => {
    try {
      return candidate === undefined ? undefined : realpathSync(candidate);
    } catch {
      return candidate;
    }
  };
  const ask = (args: readonly string[]): string | undefined => {
    try {
      return execFileSync('git', [...args], {
        cwd: path,
        encoding: 'utf8',
        // Silenced: every one of these questions has "there is none" as an
        // ordinary answer, and git says so on stderr. Letting it through would
        // print `fatal: not a git repository` above the refusal that explains
        // it, which reads like a crash.
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  };

  return {
    path,
    // `realpathSync` because git reports the resolved path, and on macOS a
    // repository under /tmp is reached through a symlink — comparing the two
    // unresolved would refuse every temporary checkout as "not its own top
    // level".
    topLevel: resolved(ask(['rev-parse', '--show-toplevel'])),
    head: ask(['rev-parse', 'HEAD']),
    originUrl: ask(['remote', 'get-url', 'origin']),
  };
}

/**
 * What a phase's kernel-computed steps need and a playbook cannot supply
 * (T4.3.2).
 *
 * All optional, and every one of them blocks the step that needs it rather
 * than being guessed at: a phase with no `nfr` or `suite` node — which is
 * every phase before the Test phase — runs exactly as it did before, and one
 * that has them refuses to measure the wrong repo or to execute
 * model-authored code somewhere nobody named.
 */
export interface RunOptions {
  /** `owner/name` an `nfr` step's `test.nfr#run` calls report against. */
  readonly repo?: string;
  /** The ref measured — a sha or a branch. Never inferred from the checkout. */
  readonly ref?: string;
  /**
   * Where a `suite` step's generated `node:test` file is written and run.
   *
   * There is no default on purpose, here least of all: defaulting it to
   * `context.root` would run agent-authored test bodies inside the operator's
   * own project with the kernel's privileges, and `nodeTestExecutor`'s
   * subject restriction is not a confinement boundary
   * (`src/test/adversarial.ts`).
   */
  readonly testProjectDir?: string;
}

/**
 * `mpgm run <phase>` — execute a phase and present its gate.
 *
 * `test.nfr` is bound here, to {@link commandNfrProvider} over the project's
 * own `test/nfr.yaml`, the same way `rollback` binds `env.provision` to the
 * real `composeProvider`: the capability is bound from the entry point an
 * operator actually uses, not only from a test. The provider reads that
 * manifest when it is invoked rather than when it is bound, so a project
 * with no NFR measurements to declare — every project running a phase with no
 * `nfr` node — is unaffected, and one that declares an `nfr` node without the
 * manifest blocks with a message naming the file and the fields it wants
 * (CONV-3).
 */
export async function run(
  context: CliContext,
  runId: string,
  phase: string,
  options: RunOptions = {},
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: 'operator' },
      });
    }

    const traces = TraceIndex.attach(db);
    const playbook = PlaybookRegistry.fromDirectory(join(context.root, 'phases')).get(
      phase,
    );
    const roles = RoleRegistry.fromDirectory(join(context.root, 'roles'));
    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
      gates: gateOracleFromState(projector.project(), runId),
    });

    const capabilities = new CapabilityRegistry();
    capabilities.bind(testNfrContract, commandNfrProvider({ root: context.root }));

    const result = await runPhase({
      runId,
      playbook,
      roles,
      artifacts,
      capabilities,
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...(options.testProjectDir === undefined
        ? {}
        : { testProjectDir: options.testProjectDir }),
      sessions: new SessionRunner({
        log,
        provider: context.provider,
        schemas: context.outputSchemas,
        policyRoot: context.root,
      }),
      gates: new GateManager({ log, projector, traces }),
      log,
      projector,
      kb: knowledgeBase(context),
      policy: context.policy ?? DEFAULT_EGRESS_POLICY,
      // Kept current as artifacts are written, so `trace`, gate invalidation
      // and `traces-resolve` see the phase's output without waiting for a
      // commit.
      traces,
    });

    if (result.outcome.status === 'stopped') {
      context.write(`run ${runId} is ${result.outcome.control}; nothing dispatched`);
      return { ok: false, detail: result.outcome.control };
    }

    if (result.outcome.status === 'blocked') {
      context.write(`task ${result.outcome.taskId} blocked: ${result.outcome.reason}`);
      return { ok: false, detail: result.outcome.reason };
    }

    const packet = result.outcome.packet;
    context.write(`\nGate: ${packet.gateId} (${packet.phase})`);
    context.write(packet.description.trim());
    context.write('\nCriteria');
    for (const criterion of packet.criteria) {
      context.write(
        `  ${criterion.met ? 'met ' : 'UNMET'}  ${criterion.id}: ${criterion.detail}`,
      );
    }
    context.write('\nOptions');
    for (const option of packet.options) {
      context.write(`  - ${option}`);
    }
    context.write('\nTrade-offs');
    for (const tradeOff of packet.tradeOffs) {
      context.write(`  - ${tradeOff}`);
    }
    context.write(`\nRecommendation: ${packet.recommendation}`);
    context.write(
      packet.autoApproved
        ? '\nAuto-approved per playbook.'
        : `\nApprove with: mpgm approve ${packet.gateId} --by <you>`,
    );

    return { ok: true, detail: packet.gateId };
  } finally {
    db.close();
  }
}

/**
 * One line of `mpgm status --metrics` — cost (spend and tokens, OBS-2),
 * latency, retries and success for a bucket (overall, one phase, or one
 * role).
 *
 * `successRate`/`avgLatencyMs` render as `-` rather than `0%`/`0ms` when
 * null: a bucket with no settled task has not failed, it has nothing to
 * report yet, and the two must not read alike.
 */
function formatMetric(label: string, metric: AggregateMetric): string {
  const success =
    metric.successRate === null
      ? '-'
      : `${(metric.successRate * 100).toFixed(0)}% (${String(metric.completed)}/${String(metric.completed + metric.blocked)})`;
  const latency =
    metric.avgLatencyMs === null ? '-' : `${String(Math.round(metric.avgLatencyMs))}ms`;
  return (
    `  ${label}: tasks ${String(metric.tasks)}  cost $${metric.costUsd.toFixed(4)}  ` +
    `tokens ${String(metric.inputTokens + metric.outputTokens)}  ` +
    `avg-latency ${latency}  retries ${String(metric.retries)}  success ${success}`
  );
}

/**
 * `mpgm status --metrics`'s overhead line (T4.2.9, NFR-3) — one line for the
 * whole run, not a bucket `formatMetric` renders per phase or role: NFR-3
 * bounds overhead against the run's own wall-clock time, so a per-phase or
 * per-role figure would compare against a denominator NFR-3 never asked
 * about.
 *
 * `T4.2.1`'s own `avgLatencyMs` above is a task's dispatch-to-completion
 * span, not harness overhead — a slow model call inflates it exactly as
 * much as a slow scheduler would — so it does not measure NFR-3 despite
 * that task's `tracesTo` naming it. This line, not that one, is what does
 * (`../state/overhead.ts`'s module doc has the formula, why the denominator
 * is the merged union of the rounds that produced it rather than their sum,
 * and the null discipline this renders).
 *
 * `coverage` renders next to `ratio` rather than being left for a reader to
 * infer: a ratio built from one instrumented task out of two hundred looks
 * exactly like one built from all of them unless the fraction that produced
 * it is on the same line (module doc's `run-1` example).
 */
function formatOverhead(overhead: HarnessOverhead): string {
  const pct = overhead.ratio === null ? '-' : `${(overhead.ratio * 100).toFixed(1)}%`;
  const ms = (value: number | null): string =>
    value === null ? '-' : `${String(Math.round(value))}ms`;
  const coverage =
    overhead.coverage === null
      ? '-'
      : `${String(overhead.components.instrumentedTaskCount)}/${String(overhead.components.settledTaskCount)} tasks (${(overhead.coverage * 100).toFixed(0)}%)`;
  return (
    `  overhead ${pct} of NFR-3's ${String(NFR3_OVERHEAD_THRESHOLD * 100)}% threshold ` +
    `(${ms(overhead.overheadMs)} context-assembly / ${ms(overhead.instrumentedSpanMs)} ` +
    `instrumented task span, coverage ${coverage}; run busy span ` +
    `${ms(overhead.observedMs)}; context-assembly ${ms(overhead.components.contextAssemblyMs)} ` +
    `over ${String(overhead.components.contextAssemblyCount)} calls; non-API session time ` +
    `${ms(overhead.components.nonApiSessionMs)} over ` +
    `${String(overhead.components.sessionsWithDuration)} sessions (agent tool execution, ` +
    `not harness — excluded from the ratio); cannot see ${overhead.unmeasured.join(', ')})`
  );
}

/**
 * `mpgm status --rates` — gate rejection, rework and escaped-defect rates for
 * a run (OBS-4).
 *
 * Separate lines rather than summed: the phase gate an operator decides, the
 * merge gate CI and review decide, and the escaped-defect rate the Test phase
 * measures against what already merged are different failures with different
 * remedies (glossary, "Gate"; T4.2.2b). `-` renders a null rate for the same
 * reason `formatMetric` renders one — nothing decided (or, for escaped
 * defects, nothing filed) yet is not a 0% rate, it is nothing to report.
 */
function formatGateRates(rates: RunGateRates): readonly string[] {
  const pct = (rate: number | null): string =>
    rate === null ? '-' : `${(rate * 100).toFixed(0)}%`;
  return [
    '  rates:',
    `    phase-gate ${pct(rates.phaseGate.rate)} (${String(rates.phaseGate.rejected)}/${String(rates.phaseGate.decided)} decided rejected)`,
    `    merge-gate ${pct(rates.mergeGate.rate)} (${String(rates.mergeGate.refusals)}/${String(rates.mergeGate.attempts)} reconstructed from ChecksReported+ChangeReviewed; ${String(rates.mergeGate.budgetExhausted)} out of repair/review rounds (BudgetExceeded); cannot see ${rates.mergeGate.unobservable.join(', ')})`,
    `    rework ${pct(rates.rework.rate)} (${String(rates.rework.reworked)}/${String(rates.rework.reviewed)} reviews sent the change back)`,
    `    escaped-defects ${pct(rates.escapedDefects.rate)} (${String(rates.escapedDefects.escaped)}/${String(rates.escapedDefects.merged)} merged tasks; ${String(rates.escapedDefects.filed)} defects filed project-wide; ${String(rates.escapedDefects.unrouted)} filed but not yet routed to a task; ${String(rates.escapedDefects.undated)} routed but not datable from TaskCompleted)`,
  ];
}

/**
 * `mpgm status` — folded run state (OBS-3), with per-phase/role/run metrics
 * and the run's harness-overhead figure (NFR-3, T4.2.9) on `--metrics`
 * (OBS-2) and gate/rework/escaped-defect rates on `--rates` (OBS-4). The
 * escaped-defect figure (T4.2.2b) joins this report rather than
 * arriving on a surface of its own — it is one more rate `computeGateRates`
 * folds in, not a second flag or a second command a reader would have to know
 * to ask for.
 *
 * `--rates` is a flag here rather than a verb of its own, for the same
 * reason `--metrics` is: with no `--run` this already prints one block per
 * run, so a longitudinal reader already gets each run's rates without this
 * adding a second way to ask for "every run".
 *
 * That per-run order is read from the log's own `RunStarted` events, not
 * from `Object.values(state.runs)`: run ids are free-form strings an
 * operator supplies (`--run 2` is as legal as `--run zz`), and JS objects
 * enumerate integer-like keys in ascending numeric order *before*
 * insertion-ordered string keys — so a run started third under an
 * integer-like id would print first, ahead of two runs the log shows
 * starting before it. Reading `RunStarted` straight from the log has no
 * such trap: it is a plain array, and `EventLog.read` yields it in the
 * order it was appended.
 */
export function status(
  context: CliContext,
  runId?: string,
  options: { readonly metrics?: boolean; readonly rates?: boolean } = {},
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const state = projector.project();
    const runOrder =
      runId === undefined
        ? log
            .read({ type: 'RunStarted' })
            .map((event) => event.runId)
            .filter((id) => state.runs[id] !== undefined)
        : [runId];
    const runs = runOrder.map((id) => state.runs[id]);

    if (runs.length === 0 || runs[0] === undefined) {
      context.write('no runs');
      return { ok: true, detail: 'no runs' };
    }

    for (const current of runs) {
      if (current === undefined) {
        continue;
      }
      context.write(
        `run ${current.runId} [${current.control}] phase=${current.currentPhase ?? '-'}`,
      );
      context.write(
        `  spend $${current.usage.costUsd.toFixed(4)}  ` +
          `tokens ${String(current.usage.inputTokens + current.usage.outputTokens)}  ` +
          `interventions ${String(current.interventions)}`,
      );
      const tasks = Object.values(current.tasks);
      for (const task of tasks.filter((entry) => entry.status !== 'attested')) {
        // `status` alone would still read a task an operator merged by hand
        // after `BudgetExceeded` as stuck there forever — the log is
        // append-only, so `task.status` never becomes anything but `blocked`
        // (T4.2.15). `merged` is the second fact a reader has to combine with
        // it, the same reading `pm/projection.ts`'s `columnFor` and
        // `dashboard/projection.ts` already give it; printed here so `status`
        // does too, rather than leaving an operator to fold the log a second
        // time to see what the board and the dashboard already show.
        const merge = task.merged;
        const mergedSuffix =
          merge === null
            ? ''
            : ` — merged${merge.by === '' ? '' : ` by ${merge.by}`} at ${merge.commit.slice(0, 12)}`;
        context.write(
          `  task ${task.taskId} ${task.status}${mergedSuffix} (${task.role} on ${task.model})`,
        );
      }
      // Summarised rather than listed: an attested task has no role, model,
      // usage or review to report, and a bootstrap can be dozens of them. One
      // line keeps them visible without burying the run that is happening.
      const attested = tasks.filter((entry) => entry.status === 'attested');
      if (attested.length > 0) {
        context.write(
          `  attested outside the harness: ${String(attested.length)} — ` +
            attested.map((entry) => entry.taskId).join(', '),
        );
      }
      for (const gate of Object.values(current.gates)) {
        context.write(
          `  gate ${gate.gateId} ${gate.status}${gate.decidedBy === null ? '' : ` by ${gate.decidedBy}`}`,
        );
      }

      // Surfaced even though `intervene` already checks the id it is given
      // (T4.2.4): a redirect can still name a task correctly and reach
      // nothing, if the task never runs again before the run ends. An
      // operator watching only the terminal that issued it would have no way
      // to tell a note delivered from one still waiting.
      const redirects = Object.entries(current.redirects);
      if (redirects.length > 0) {
        for (const [redirectedTask, note] of redirects) {
          context.write(`  redirected: ${redirectedTask} — ${note}`);
        }
      }

      if (options.metrics === true) {
        const runEvents = log.read({ runId: current.runId });
        const report = computeRunMetrics(current, runEvents);
        context.write('  metrics:');
        context.write(formatMetric('run', report.overall));
        for (const [phase, metric] of Object.entries(report.byPhase)) {
          context.write(formatMetric(`phase ${phase}`, metric));
        }
        for (const [role, metric] of Object.entries(report.byRole)) {
          context.write(formatMetric(`role ${role}`, metric));
        }
        context.write(formatOverhead(computeHarnessOverhead(current, runEvents)));
      }

      if (options.rates === true) {
        // The whole log, not this run's slice: the escaped-defect figure
        // needs to see a `ChangeMerged` that may belong to a different run
        // than `current.runId` (`./escaped-defect-rate.ts`'s own doc says
        // why); `computeGateRates`'s other three figures already filter by
        // `runId` themselves, so this changes nothing for them.
        const defects = new ArtifactStore({
          root: context.root,
          schemas: context.artifactSchemas,
        })
          .list('artifacts/defect')
          .map((entry) => entry.artifact);
        const rates = computeGateRates(current.runId, log.read(), defects);
        for (const line of formatGateRates(rates)) {
          context.write(line);
        }
      }
    }

    return { ok: true, detail: `seq ${String(state.lastSeq)}` };
  } finally {
    db.close();
  }
}

/**
 * The port `serve` binds when the operator names none.
 *
 * Fixed rather than ephemeral so the dashboard has an address worth
 * bookmarking; `--port 0` still asks the kernel for a free one.
 */
export const DEFAULT_DASHBOARD_PORT = 4400;

/** Resolves when the operator asks for the server back. */
function untilStopped(signal: AbortSignal | undefined): Promise<string> {
  if (signal !== undefined) {
    return signal.aborted
      ? Promise.resolve('aborted')
      : new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve('aborted');
          });
        });
  }

  return new Promise((resolve) => {
    const stop = (name: string) => () => {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      resolve(name);
    };
    const onInt = stop('SIGINT');
    const onTerm = stop('SIGTERM');
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
  });
}

/**
 * `mpgm serve` — the operator's live view of running work (OBS-3).
 *
 * The dashboard is a library that renders folded state; this is the verb that
 * puts it somewhere an operator can look. Read-only all the way down: the
 * server dispatches nothing but `GET`, and this holds the log open for reads
 * without ever appending, so a dashboard left running through an implement
 * task cannot change what that task does.
 *
 * Runs until interrupted, which is the point — a live view that exits is a
 * report.
 */
export async function serve(
  context: CliContext,
  port: string | number = DEFAULT_DASHBOARD_PORT,
): Promise<CommandResult> {
  // The flag arrives as whatever the operator typed, and is parsed here rather
  // than at the boundary so that the refusal can name it (CONV-3). Digits only:
  // `Number` alone would take ' 80', '0x50' and '1e3', and an operator who
  // typed one of those did not mean the port they would get.
  const wanted =
    typeof port === 'number' ? port : /^\d+$/.test(port) ? Number(port) : NaN;
  // No lower bound: `^\d+$` cannot produce a negative, and a caller passing
  // one programmatically is caught by `listen` below. A branch nothing can
  // reach is a branch no test can fail on.
  if (!Number.isInteger(wanted) || wanted > 65535) {
    context.write(
      `--port must be a whole number from 0 to 65535, not '${String(port)}'; ` +
        `0 asks for any free port`,
    );
    return { ok: false, detail: 'bad port' };
  }

  const { db, log, projector } = open(context);
  // The run page's per-phase/per-role/per-task metrics and quality rates
  // (T4.2.6) are read from the run's own events and the Defect artifacts on
  // disk, not from folded `RunState` — this is the same log and artifact
  // store `status --metrics`/`--rates` already read from (above), plumbed
  // through so the two surfaces never disagree about the same run.
  const server = new DashboardServer({
    projector,
    traces: TraceIndex.attach(db),
    log,
    artifacts: new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
    }),
  });
  // Tracked, because closing a server that never bound throws
  // ERR_SERVER_NOT_RUNNING — which would replace the reason the operator
  // needs (a port already in use, or one they may not have) with a message
  // about the cleanup.
  let listening = false;
  try {
    let bound: number;
    try {
      bound = await server.listen(wanted);
      listening = true;
    } catch (cause) {
      context.write(
        `could not listen on port ${String(wanted)}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
      return { ok: false, detail: 'could not listen' };
    }

    context.write(`dashboard on http://127.0.0.1:${String(bound)}`);
    // Said out loud because none of it is visible from the page: the operator
    // cannot tell by looking whether what they are reading is stale, nor
    // whether anyone else can reach it.
    context.write('  loopback only, and read-only — nothing here can change a run');
    context.write('  the trace page shows whatever `mpgm trace` last indexed');
    context.write('  stop with ctrl-c');
    const reason = await untilStopped(context.signal);
    return { ok: true, detail: `served on ${String(bound)}, stopped by ${reason}` };
  } finally {
    if (listening) {
      await server.close();
    }
    db.close();
  }
}

/**
 * `mpgm pause|resume|kill|redirect` — operator control, recorded (HIL-3,
 * HIL-5).
 *
 * `taskId` names what a redirection is aimed at (DESIGN §4.4 `redirect
 * <task>`): the implement loop reads it back before dispatching that task's
 * next session (`redirectNoteFor`, T4.2.4). `pause`/`resume`/`kill` act on
 * the whole run and pass none.
 *
 * DESIGN §4.4 glosses `redirect` as "revise a task's instructions/context and
 * requeue". There is no separate requeue step here, and none is added: this
 * harness has no scheduler that pulls Implement-phase tasks off a queue on
 * its own — `mpgm implement <task>` is what dispatches one, named, every
 * time, and a blocked task was already the operator's to reissue that
 * command against before this task existed. What redirecting changes is
 * what that next invocation's first session — and, once a task is already
 * in flight, whichever session comes after the redirect, review included —
 * is told. A task that has already merged is deliberately not put back in
 * front of the scheduler: `done` meaning merged, never reopened, is load-
 * bearing elsewhere (§4.8, the PM projector) — a redirect that resurrected a
 * merged task would contradict it, and a fresh plan task is where further
 * work on a merged change belongs.
 *
 * Two overloads rather than one signature with `taskId?: string` (CONV-5,
 * review): the event schema (`operatorIntervened`, T4.2.4) already makes a
 * redirect naming no task, or a pause/resume/kill naming one, unrepresentable
 * at `EventLog.append` — a single optional parameter here let a caller build
 * exactly that state in memory before ever reaching it. `runCli` already only
 * ever calls this correctly (`main.ts`); the overloads are what stop a caller
 * from doing otherwise compiling.
 */
export function intervene(
  context: CliContext,
  runId: string,
  action: 'pause' | 'resume' | 'kill',
  detail?: string,
): CommandResult;
export function intervene(
  context: CliContext,
  runId: string,
  action: 'redirect',
  detail: string,
  taskId: string,
): CommandResult;
export function intervene(
  context: CliContext,
  runId: string,
  action: 'pause' | 'resume' | 'kill' | 'redirect',
  detail = '',
  taskId?: string,
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      context.write(`no such run: ${runId}`);
      return { ok: false, detail: 'unknown run' };
    }

    // A redirect nothing checks reaches the operator as success and nothing
    // at all — a task that has already merged or was never dispatched reads
    // no session's next prompt, so a typo'd or stale id is silently inert
    // (CONV-3, T4.2.4). Checked against two sources, because a task's id
    // exists in one or the other depending on when in its life the redirect
    // is aimed at it: the run's own folded tasks (dispatched already, this
    // run) and the gated Plan graph (an Implement-phase task not yet
    // dispatched). Neither is required to exist on its own — a redirect
    // aimed at a phase-playbook task the Plan schema has never heard of is
    // still a task this run may have dispatched, and one aimed ahead of a
    // plan task's first session is still one the gated Plan already lists.
    if (taskId !== undefined) {
      const dispatched = Object.keys(projector.project().runs[runId]?.tasks ?? {});
      let planned: string[] = [];
      const artifacts = new ArtifactStore({
        root: context.root,
        schemas: context.artifactSchemas,
      });
      // Absent is not refused for that alone — a redirect can still be aimed
      // at a task this run has already dispatched with no Plan artifact in
      // sight, the way the sample-service and phase-playbook tasks always
      // are. `known` below falls back to `dispatched` alone in that case,
      // silently, because there is genuinely nothing else to consult.
      //
      // A Plan that exists but fails to read or parse is a different case
      // and is not swallowed the same way (CONV-3): silently falling back
      // here too would leave "unknown task" claiming the gated Plan was
      // checked when it was not, sending an operator chasing a typo that
      // was never the cause. `planError` carries the real one through to the
      // refusal message below instead.
      let planError: string | undefined;
      if (artifacts.latestVersion(PLAN_ARTIFACT) > 0) {
        try {
          planned = ingestPlan(artifacts.read(PLAN_ARTIFACT).data as never).tasks.map(
            (task) => task.id,
          );
        } catch (error) {
          planError = error instanceof Error ? error.message : String(error);
        }
      }
      const known = new Set([...dispatched, ...planned]);
      if (!known.has(taskId)) {
        context.write(
          planError === undefined
            ? `no task '${taskId}' in run ${runId} or the gated Plan at ${PLAN_ARTIFACT}. ` +
                `Known: ${[...known].sort().join(', ') || '(none)'}`
            : `no task '${taskId}' in run ${runId}, and the gated Plan at ${PLAN_ARTIFACT} ` +
                `could not be consulted: ${planError}. Known (run only): ` +
                ([...known].sort().join(', ') || '(none)'),
        );
        return { ok: false, detail: 'unknown task' };
      }
    }

    log.append({
      runId,
      type: 'OperatorIntervened',
      payload: { action, detail, ...(taskId === undefined ? {} : { taskId }) },
    });
    const control = projector.project().runs[runId]?.control ?? 'running';
    context.write(
      taskId === undefined
        ? `run ${runId} is now ${control}`
        : `run ${runId} is now ${control}; ${taskId} is redirected`,
    );
    return { ok: true, detail: control };
  } finally {
    db.close();
  }
}

/**
 * `mpgm implement <task>` — run one plan task through the implement loop
 * (IMP-1 to IMP-5, PLAN T3.1.8).
 *
 * The self-hosting entry point: mpgm reads its own gated Plan, finds the task,
 * gives it a worktree, and does not come back until the change has merged or
 * something an operator should look at has stopped it.
 *
 * The role freeze is checked first and refuses the run outright. From
 * switchover the agents writing the code are the agents whose definitions are
 * in the repository, and until the eval harness lands nothing would notice a
 * role getting quietly worse (PLAN section 1).
 */
export async function implement(
  context: CliContext,
  runId: string,
  taskId: string,
  repo: string,
  into: string = context.root,
): Promise<CommandResult> {
  // Resolved the same way git reports it, so the top-level comparison is
  // between two paths of the same kind.
  const target = realpathSync(resolve(into));
  const { db, log, projector } = open(context);
  try {
    // The freeze first, and the target second. Both refuse before anything is
    // dispatched, but they answer different questions and only one of them is
    // about safety: whether agents may run under these definitions at all
    // comes before where their work would land.
    try {
      assertRolesFrozen(
        loadRoleFreeze(join(context.root, 'roles', 'freeze.json')),
        join(context.root, 'roles'),
        approvedRoles(log),
      );
    } catch (error) {
      context.write(error instanceof Error ? error.message : String(error));
      return { ok: false, detail: 'role freeze' };
    }

    const refusal = targetRefusal(targetFacts(target), repo);
    if (refusal !== undefined) {
      context.write(refusal);
      return { ok: false, detail: 'unusable target' };
    }

    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
    });
    let graph;
    try {
      graph = ingestPlan(artifacts.read(PLAN_ARTIFACT).data as never);
    } catch (error) {
      context.write(
        `could not read the gated Plan at ${PLAN_ARTIFACT}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return { ok: false, detail: 'no plan' };
    }

    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      context.write(
        `no task '${taskId}' in the plan. Ready now: ` +
          (readyTasks(graph, completedTaskIds(projector.project().runs[runId]?.tasks))
            .map((candidate) => candidate.id)
            .join(', ') || '(none)'),
      );
      return { ok: false, detail: 'unknown task' };
    }

    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: 'operator' },
      });
    }

    const result = await implementTask({
      runId,
      task,
      // The code follows the target; the roles, the plan and the log stay with
      // mpgm. `policyRoot` above all: the paths a role is allowed to write are
      // relative to the checkout the agent is working in, so leaving it on
      // `context.root` would point the policy hook at a tree the task never
      // touches.
      repo: target,
      worktrees: new WorktreeManager({ repo: target }),
      sessions: new SessionRunner({
        log,
        provider: context.provider,
        schemas: context.outputSchemas,
        policyRoot: target,
      }),
      roles: RoleRegistry.fromDirectory(join(context.root, 'roles')),
      log,
      kb: knowledgeBase(context),
      policy: context.policy ?? DEFAULT_EGRESS_POLICY,
      // A task runs 20-40 minutes across several sessions and, until now,
      // printed nothing between dispatch and its final line — the terminal
      // that started it could not tell an implementing session from a
      // review, or a stall from one still in progress (OBS-3, NFR-2).
      onProgress: (event) => {
        context.write(renderProgress(event));
      },
      // The kernel publishes; agents cannot (the destructive guard refuses
      // `git push`). Without this the branch is invisible to CI and every
      // required check reports nothing, which blocks rather than merges.
      publish: async (branch) => {
        await Promise.resolve(
          execFileSync('git', ['push', '--force-with-lease', 'origin', branch], {
            cwd: target,
            stdio: 'ignore',
          }),
        );
      },
      // The pull request is what makes the checks exist: a repository whose CI
      // runs on `pull_request` sees nothing at all from a pushed branch, and
      // the loop would then wait out its grace period for checks nobody asked
      // for. It is also what puts the task on the board (PMG-2).
      openPullRequest: async ({ branch, into, task: planTask }) =>
        openPullRequest(repo, {
          branch,
          into,
          title: `${planTask.id} — ${planTask.title}`,
          body: [
            `Implements ${planTask.id} (${planTask.milestone}).`,
            '',
            'Done when:',
            ...planTask.completionCriteria.map((criterion) => `- ${criterion}`),
            '',
            `Advances: ${planTask.tracesTo.join(', ')}.`,
            '',
            'Opened by mpgm. An independent reviewing agent and the merge gate',
            'stand between this branch and the trunk.',
          ].join('\n'),
        }),
      checks: async (ref) => {
        const settled = await awaitChecks({
          poll: async () => mergeVerdict({ ref, runs: await fetchCheckRuns(repo, ref) }),
        });
        if (settled.outcome === 'no-checks') {
          // Said plainly, because the cause is configuration rather than a red
          // build: the ref is one no workflow watches. Without this an
          // operator reads "checks did not report" as a flaky CI.
          context.write(
            `no CI check ever reported for ${ref}. Nothing is watching that ref — ` +
              `check the workflow's triggers cover pull requests into the trunk.`,
          );
        }
        return settled.verdict;
      },
      logsFor: (check, ref) => fetchCheckLog(repo, ref, check),
    });

    if (result.status === 'merged') {
      context.write(
        `${result.taskId} merged as ${String(result.commit)} ` +
          `(reviewed by ${result.review?.reviewerRole ?? 'nobody'})`,
      );
      if (result.pullRequest !== undefined) {
        context.write(`Its pull request was #${String(result.pullRequest)}.`);
      }
      return { ok: true, detail: 'merged' };
    }

    context.write(
      `${result.taskId} did not merge: ${result.reason ?? 'no reason given'}`,
    );
    if (result.pullRequest !== undefined) {
      context.write(`Its pull request is #${String(result.pullRequest)}.`);
    }
    context.write(`Its worktree is left at ${result.worktree} on ${result.branch}.`);
    return { ok: false, detail: 'blocked' };
  } finally {
    db.close();
  }
}

/** Task ids a run has completed, for the ready set. */
/** Where a project's gated Plan lives. */
const PLAN_ARTIFACT = 'artifacts/plan/plan.md';

/**
 * `mpgm confirm <fingerprint>` — let a simulated destructive call proceed
 * (SAF-4, HIL-2).
 *
 * Only a call that has actually been simulated can be confirmed: the operator
 * is approving *what the dry run did*, and an unknown fingerprint means there
 * is nothing to have looked at. Confirming by hand what nothing simulated
 * would be approving a description.
 */
export function confirm(
  context: CliContext,
  runId: string,
  fingerprint: string,
  by: string,
  reason = '',
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const run = projector.project().runs[runId];
    if (run === undefined) {
      context.write(`no such run: ${runId}`);
      return { ok: false, detail: 'unknown run' };
    }

    const call = run.destructiveCalls[fingerprint];
    if (!call?.dryRun) {
      context.write(
        `nothing has been simulated with fingerprint ${fingerprint} in ${runId}. ` +
          `A destructive call must be dry-run before it can be confirmed (SAF-4).`,
      );
      return { ok: false, detail: 'no dry run' };
    }

    log.append({
      runId,
      type: 'DestructiveOpConfirmed',
      payload: { taskId: call.taskId, tool: call.tool, fingerprint, by, reason },
    });
    context.write(`${call.tool} (${fingerprint.slice(0, 12)}) confirmed by ${by}`);
    return { ok: true, detail: 'confirmed' };
  } finally {
    db.close();
  }
}

/**
 * `mpgm rollback <env> --repo <path> --to-version <v> --to-image <img>
 * --to-digest <sha256:...> --to-changelog <s> [--to-rollback-version <v>
 * --to-rollback-digest <sha256:...> | --to-first-release] --by <who>
 * [--reason <s>]` — restore a prior release to a declared environment from
 * the CLI (DEP-2, DESIGN §9 decision 11, HIL-5).
 *
 * Wired exactly the way `scripts/demo/deploy-gate.mjs` wires the same
 * providers for its own verification: `dockerReleaseProvider` over a
 * `composeProvider`-bound `env.provision`, sharing one `gate` object so a
 * confirmation either sees is visible to both — this is the release-path
 * deploy gate (`../policy/deploy-gate.ts`), applied at construction, so this
 * is not a second, unguarded way to reach `release.deliver#rollback`
 * alongside whatever else this repository ever builds (DESIGN §9 decision
 * 10). `to` is a full release artifact rather than a bare ref, because
 * `release.deliver#rollback`'s own input is (DEP-3) — there is no durable
 * store of past release artifacts yet (that arrives with T4.1.6), so an
 * operator supplies the one they mean to restore from their own record of
 * it, the same way they would type a fingerprint into `mpgm confirm`.
 *
 * **What gets recorded, and when, is the point of this function, not a
 * detail of it (T4.1.5).** Four refusals are reachable before the
 * environment is ever touched — `to` is not a valid release artifact; `repo`
 * has no readable environments manifest; `env` is not declared in it; or
 * `env` is gated and `{repo, env, to.digest}` was never confirmed
 * (`assertRollbackReady`, `../policy/deploy-gate.ts`) — and every one of
 * them is checked *before* anything downstream of it runs, each recorded as
 * its own `ReleaseRollbackRefused` event (HIL-5: an attempt that was refused
 * is still an attempt, so an operator who tried is in the log either way),
 * never as a `ReleaseRolledBack`, which is reserved for a call that actually
 * reached the environment.
 *
 * Once every refusal above has passed, a `ReleaseRollbackStarted` event is
 * appended *before* `release.deliver#rollback` is ever invoked — the same
 * idiom `EffectIntended` applies to a task's own effects (DESIGN §6,
 * `../effect/journal.ts`), applied here to an operator-invoked one: the
 * ordering is durable, not a flag held in memory, so a process killed
 * between this append and the `ReleaseRolledBack` that follows still leaves
 * a record that the environment was about to be — or already was — touched,
 * rather than silence. This is what makes the distinction possible at all:
 * `assertRollbackReady` runs the identical check `gateProductionRelease`
 * itself applies (there is exactly one place that check is written), so by
 * the time it returns without throwing, nothing left standing between here
 * and the provider call can still refuse this rollback before it reaches
 * `env.provision#up`.
 *
 * `ReleaseRolledBack` is appended once the call resolves, whether it
 * returns or throws: `dockerReleaseProvider#rollback` delegates straight to
 * `env.provision#up`, and `composeProvider#up` runs `docker compose up -d
 * --wait` before it ever throws (`../env/compose-provider.ts`) — the
 * containers are already recreated on the restored digest by the time a
 * non-zero exit is reported, which is the commonest way a real rollback
 * fails, so a throw here is recorded the same as a call that returned,
 * `up: false`, with the failure folded into `reason` and, on the operator's
 * console, alongside a caveat that the environment may already be serving
 * the restored digest and that this was recorded regardless (CONV-3).
 *
 * `deps.envProvision` is injectable, and only for tests: `rollback` never
 * calls `docker build` (`dockerReleaseProvider#rollback` delegates straight
 * to `env.provision#up`, with no `assemble` step in between), so a fake
 * `env.provision` provider is enough to exercise the real gate
 * (`gateProductionRelease`, applied inside `dockerReleaseProvider` exactly
 * as it is here) and the real event recording below with no Docker daemon
 * involved — the same reasoning `docker-provider.test.ts`'s own
 * `boundEnvProvision` fake already relies on. Left undefined, this
 * constructs the real `composeProvider`, which is what every real
 * invocation of this verb gets (DESIGN §9 decision 10: no code path here
 * obtains an unguarded `rollback`, and none obtains one bound to a fake
 * environment either, outside a test that asks for it by name).
 */
export interface RollbackDeps {
  readonly envProvision?: BoundContract;
}

export async function rollback(
  context: CliContext,
  runId: string,
  env: string,
  repo: string,
  to: ReleaseArtifact,
  by: string,
  reason = '',
  deps: RollbackDeps = {},
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: by },
      });
    }

    // Every refusal below is recorded the same way: HIL-5 wants the attempt
    // in the log even when it was turned away, and `reason` carries the
    // refusal's own message — the exact text printed to the operator
    // (CONV-3) — rather than a category, because the detail that would let
    // someone fix the cause lives only in that message.
    const refuse = (message: string): CommandResult => {
      context.write(message);
      log.append({
        runId,
        type: 'ReleaseRollbackRefused',
        payload: { repo, env, by, reason: message },
      });
      return { ok: false, detail: 'rollback refused' };
    };

    const parsedTo = releaseArtifactSchema.safeParse(to);
    if (!parsedTo.success) {
      return refuse(`'to' is not a valid release artifact: ${parsedTo.error.message}`);
    }

    let declared: readonly EnvironmentEntry[];
    try {
      declared = loadDeclaredEnvironments(repo);
    } catch (cause) {
      return refuse(cause instanceof Error ? cause.message : String(cause));
    }
    if (!declared.some((entry) => entry.name === env)) {
      return refuse(
        `'${env}' is not declared in this repo's environments manifest; declared ` +
          `environments are: ` +
          (declared.length > 0
            ? declared.map((entry) => entry.name).join(', ')
            : '(none)'),
      );
    }

    const onDryRunNeeded = (record: DryRunNeeded): void => {
      log.append({
        runId,
        type: 'DryRunRecorded',
        payload: {
          taskId: KERNEL_TASK,
          tool: record.tool,
          fingerprint: record.fingerprint,
          summary:
            `deploy ${record.target.env} -> ` +
            (record.target.label ?? record.target.digest.slice(0, 12)),
        },
      });
    };
    const onConfirmationSpent = (record: ConfirmationSpent): void => {
      log.append({
        runId,
        type: 'DeployConfirmationSpent',
        payload: {
          taskId: KERNEL_TASK,
          tool: record.tool,
          fingerprint: record.fingerprint,
        },
      });
    };
    const gate = {
      gatedEnvs: gatedEnvironments,
      ledger: crossRunLedger(() => projector.project()),
      onDryRunNeeded,
      onConfirmationSpent,
    };

    // The identical check `gateProductionRelease#rollback` applies inside
    // the gated provider below, run here first so a refusal (a gated
    // environment whose digest was never confirmed, or a tag-shaped digest)
    // is caught, and recorded, before anything is constructed that could
    // reach the environment (DESIGN §9 decision 10 is not weakened by
    // checking twice: the actual call below still goes through the same
    // gate regardless of what this pre-check decided).
    try {
      assertRollbackReady(
        { repo, env, digest: parsedTo.data.digest, version: parsedTo.data.version },
        gate,
      );
    } catch (cause) {
      return refuse(cause instanceof Error ? cause.message : String(cause));
    }

    // Every refusal this verb can reach in advance has now passed. Recorded
    // *before* the provider is ever called — the way every other side
    // effect in this kernel is recorded (`EffectIntended`,
    // `../effect/journal.ts`, DESIGN §6) — so a rollback killed mid-call
    // still leaves this fact in the log rather than silence.
    log.append({
      runId,
      type: 'ReleaseRollbackStarted',
      payload: {
        repo,
        env,
        to: { version: parsedTo.data.version, digest: parsedTo.data.digest },
        by,
      },
    });

    const registry = new CapabilityRegistry();
    const envContract =
      deps.envProvision ?? registry.bind(envProvisionContract, composeProvider({ gate }));
    const release = registry.bind(
      releaseDeliverContract,
      // Required at construction — there is no unwrapped provider this
      // function, or any other caller in this repository, could obtain
      // (DESIGN §9 decision 10).
      dockerReleaseProvider({ envProvision: envContract, gate }),
    );

    let status: { readonly up: boolean };
    try {
      status = await release.invoke<{ readonly up: boolean }>('rollback', {
        repo,
        env,
        to: parsedTo.data,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Reached only after `ReleaseRollbackStarted` was already durably
      // recorded above, so this is never the gate's refusal branch: whatever
      // threw did so once the gate had already let this call through, which
      // means `env.provision#up` had already begun — `composeProvider#up`
      // runs `docker compose up -d --wait` and only then throws on a
      // non-zero exit (`../env/compose-provider.ts`), by which point the
      // containers are already recreated on the restored digest. Told to the
      // operator alongside the provider's own message, not instead of it
      // (CONV-3): what this failure means for the environment, and that it
      // was recorded regardless of the outcome.
      context.write(
        `${message} The environment may already be serving the restored digest ` +
          `— 'ReleaseRollbackStarted' was recorded before this call began (HIL-5), ` +
          `and a 'ReleaseRolledBack' event recording this failure (up: false) has ` +
          `now been appended too; check '${env}' directly before retrying.`,
      );
      const failedReason =
        reason === ''
          ? `rollback failed: ${message}`
          : `${reason} — rollback failed: ${message}`;
      log.append({
        runId,
        type: 'ReleaseRolledBack',
        payload: {
          repo,
          env,
          to: { version: parsedTo.data.version, digest: parsedTo.data.digest },
          by,
          reason: failedReason,
          up: false,
        },
      });
      return { ok: false, detail: 'rollback failed' };
    }

    log.append({
      runId,
      type: 'ReleaseRolledBack',
      payload: {
        repo,
        env,
        to: { version: parsedTo.data.version, digest: parsedTo.data.digest },
        by,
        reason,
        up: status.up,
      },
    });

    const summary =
      `'${env}' rolled back to ${parsedTo.data.version} ` +
      `(${parsedTo.data.digest.slice(0, 12)}) by ${by} — `;
    context.write(
      status.up
        ? `${summary}up`
        : // The provider returned rather than threw, which for
          // `composeProvider#up` means `docker compose up -d --wait`
          // completed and `servicesOf` reported back — the containers were
          // already recreated on the restored digest and are merely not
          // reporting healthy, not that the rollback never touched the
          // environment. Told alongside the provider's own summary, not
          // instead of it (CONV-3): what this outcome means for the
          // environment, and that it was recorded regardless.
          `${summary}NOT up — check the environment; it may already be ` +
            `serving the restored digest but is not reporting healthy. ` +
            `'ReleaseRollbackStarted' was recorded before the call began ` +
            `(HIL-5), and a 'ReleaseRolledBack' event recording this ` +
            `outcome (up: false) has now been appended too.`,
    );
    return { ok: status.up, detail: status.up ? 'up' : 'not up' };
  } finally {
    db.close();
  }
}

/** `mpgm approve <gate>` — record a gate decision (HIL-5). */
/**
 * Withdraw a phase's approval and cascade to what traced to it (ORC-6).
 *
 * `--dry-run` shows the plan without recording it. Reopening a Design gate can
 * cost a whole phase to redo, and an append-only log is not where to discover
 * that.
 */
export function reopen(
  context: CliContext,
  runId: string,
  phase: string,
  reason: string,
  changed: readonly string[],
  dryRun = false,
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const index = TraceIndex.attach(db);
    const request = {
      runId,
      phase,
      reason,
      ...(changed.length === 0 ? {} : { changed }),
    };

    let plan;
    try {
      plan = dryRun
        ? planReopen(projector.project(), index, request)
        : reopenPhase({ log, projector, index, request });
    } catch (cause) {
      context.write(cause instanceof Error ? cause.message : String(cause));
      return { ok: false, detail: 'reopen refused' };
    }

    context.write(
      `${dryRun ? 'Would reopen' : 'Reopened'} phase ${plan.phase} of run ${runId}`,
    );
    context.write(`Changed: ${plan.changed.join(', ')}`);

    context.write('\nInvalidated');
    for (const gate of plan.invalidated) {
      context.write(`  ${gate.gateId} (${gate.phase}) — ${gate.because}`);
    }
    if (plan.invalidated.length === 0) {
      context.write('  (none)');
    }

    // Printed, not merely omitted: ORC-6's second half is that unaffected
    // approvals survive, and an operator has to be able to see that it held.
    context.write('\nRetained');
    for (const gate of plan.retained) {
      context.write(`  ${gate.gateId} (${gate.phase}) — ${gate.because}`);
    }
    if (plan.retained.length === 0) {
      context.write('  (none)');
    }

    return { ok: true, detail: dryRun ? 'planned' : 'reopened' };
  } finally {
    db.close();
  }
}

/**
 * Show the traceability graph around an id, or a coverage report (ADR-4).
 *
 * The index is brought up to the repository first: it is derived, so a stale
 * answer is a bug in the reader rather than in the data, and `trace` is
 * exactly where a stale answer would mislead.
 */
export function trace(
  context: CliContext,
  id: string | undefined,
  mode: 'node' | 'coverage' | 'dangling' = 'node',
): CommandResult {
  const { db } = open(context);
  try {
    const index = TraceIndex.attach(db);
    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
    });
    const report = new TraceIndexer({ repo: context.root, index, artifacts }).update();

    // Surfaced ahead of whatever mode was asked for: a trailer that read as
    // nothing is not something a coverage figure or a dangling-reference
    // count would ever reveal on its own.
    for (const entry of report.unrecognisedTrailers) {
      context.write(
        `NOTE: unrecognised trailer '${entry.key}:' with an id-shaped value in ${entry.sha} — not read as a trace claim.`,
      );
    }
    for (const entry of report.unindexedTrailerValues) {
      context.write(
        `NOTE: '${entry.key}: ${entry.value}' in ${entry.sha} is not id-shaped — reported, not indexed.`,
      );
    }

    if (mode === 'dangling') {
      const dangling = index.danglingReferences();
      context.write(
        dangling.length === 0
          ? 'No citation resolves to nothing.'
          : `${String(dangling.length)} citation(s) resolve to nothing:`,
      );
      for (const entry of dangling) {
        context.write(`  ${entry.src} -> ${entry.dst}  (${entry.source})`);
      }

      // Printed after the dangling count, not folded into it: T4.2.16 — a
      // convention id cited via Traces:/tracesTo is excluded on purpose
      // (DESIGN.md §4.3, IMP-4/ART-2/DSG-4 — enforced by
      // conventionTraceIssues, src/context/conventions.ts — states that a
      // convention is never a trace target), and the exclusion is reported
      // rather than made invisible.
      const excluded = index.excludedReferences();
      if (excluded.length > 0) {
        context.write(
          `${String(excluded.length)} citation(s) excluded (not counted above):`,
        );
        for (const entry of excluded) {
          context.write(
            `  ${entry.src} -> ${entry.dst}  (${entry.source}) — ${entry.reason}`,
          );
        }
      }

      return { ok: dangling.length === 0, detail: `${String(dangling.length)} dangling` };
    }

    if (mode === 'coverage') {
      // Requirements are the elements declared by artifacts stored under the
      // `scope` schema. Everything else an artifact declares — an ADR, a plan
      // task — is not something TST-2 asks for coverage of.
      const scopeSources = new Set(
        artifacts
          .list()
          .filter((entry) => entry.artifact.schema === 'scope')
          .map((entry) => entry.relativePath),
      );
      const requirements = index
        .declaredElements()
        .filter((element) => scopeSources.has(element.source))
        .map((element) => element.id);

      const rows = index.coverage(requirements);
      const verified = rows.filter((row) => row.verified).length;

      context.write(
        `Requirement coverage: ${String(verified)}/${String(rows.length)} verified (TST-2)`,
      );
      for (const row of rows) {
        context.write(
          `  ${row.verified ? 'verified  ' : 'UNVERIFIED'} ${row.id}` +
            (row.verifiedBy.length > 0 ? `  by ${row.verifiedBy.join(', ')}` : '') +
            (row.verifiedBy.length === 0 && row.tracedBy.length > 0
              ? `  (traced by ${row.tracedBy.join(', ')}, but nothing verifies it)`
              : ''),
        );
      }
      if (rows.length === 0) {
        context.write('  (no requirements are declared yet)');
      }
      return { ok: true, detail: `${String(verified)}/${String(rows.length)}` };
    }

    if (id === undefined) {
      context.write('trace: an id is required, or --coverage / --dangling');
      return { ok: false, detail: 'no id' };
    }

    const declarations = index.declarationsOf(id);
    const from = index.tracesFrom(id);
    const to = index.tracesTo(id);

    if (declarations.length === 0 && from.length === 0 && to.length === 0) {
      context.write(`Nothing in the trace graph mentions '${id}'.`);
      return { ok: false, detail: 'unknown id' };
    }

    context.write(id);
    for (const declaration of declarations) {
      context.write(
        `  declared in ${declaration.source}` +
          (declaration.label === '' ? '' : ` — ${declaration.label}`),
      );
    }
    if (declarations.length > 1) {
      // Two artifacts claiming the same id makes every citation of it
      // ambiguous, so it is called out rather than merely listed.
      context.write(`  WARNING: declared in ${String(declarations.length)} places`);
    }

    context.write('\nTraces to');
    for (const link of from) {
      context.write(`  ${link.relation}  ${link.dst}`);
    }
    if (from.length === 0) {
      context.write('  (nothing)');
    }

    context.write('\nTraced from');
    for (const link of to) {
      context.write(`  ${link.src}  ${link.relation}`);
    }
    if (to.length === 0) {
      context.write('  (nothing)');
    }

    const downstream = index.downstreamOf(id);
    context.write('\nEverything a change here would reach (ORC-6)');
    context.write(downstream.length === 0 ? '  (nothing)' : `  ${downstream.join(', ')}`);

    return { ok: true, detail: `${String(downstream.length)} downstream` };
  } finally {
    db.close();
  }
}

export function approve(
  context: CliContext,
  runId: string,
  gateId: string,
  by: string,
  reject = false,
  reason = '',
  tag = false,
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    // Validated before anything is appended. The log is append-only, so an
    // event that cannot be folded -- a decision naming a run or gate that does
    // not exist -- would break every subsequent projection permanently. A
    // typo must not be able to do that.
    const state = projector.project();
    const run = state.runs[runId];
    if (run === undefined) {
      context.write(`no such run: ${runId}`);
      return { ok: false, detail: 'unknown run' };
    }
    if (run.gates[gateId] === undefined) {
      const known = Object.keys(run.gates);
      context.write(
        `run ${runId} has no gate '${gateId}'. Presented gates: ${known.join(', ') || '(none)'}`,
      );
      return { ok: false, detail: 'unknown gate' };
    }

    const gates = new GateManager({ log, projector });
    if (reject) {
      gates.reject(runId, gateId, by, reason);
    } else {
      gates.approve(runId, gateId, by);
    }

    const gate = projector.project().runs[runId]?.gates[gateId];
    const status = gate?.status ?? 'unknown';
    context.write(`gate ${gateId} ${status} by ${by}`);

    // The tag is written after the decision is recorded, and only then. It is
    // a derived marker (ADR-3): if tagging fails, the gate is still approved.
    if (!reject && tag && isGitRepository(context.root)) {
      const version = gate?.artifactRefs[0]?.version ?? 1;
      try {
        const written = tagGate({
          repo: context.root,
          phase: gate?.phase ?? 'unknown',
          version,
          gateId,
          by,
        });
        context.write(`tagged ${written.tag} at ${written.commit.slice(0, 8)}`);
      } catch (error) {
        context.write(
          `gate approved, but tagging failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { ok: true, detail: status };
  } finally {
    db.close();
  }
}

/**
 * Role definitions an operator has approved, from the log.
 *
 * Read rather than folded into projected state: this is a property of the
 * project across every run, not of one run — a role approved during the
 * Definition phase is still approved when an Implement task dispatches
 * months later.
 */
export function approvedRoles(log: {
  read: (options?: { type?: string }) => readonly { payload: unknown }[];
}): Set<string> {
  return new Set(
    log.read({ type: 'RoleApproved' }).map((event) => {
      const payload = event.payload as { role: string; digest: string };
      return approvalKey(payload.role, payload.digest);
    }),
  );
}

/**
 * `mpgm approve-role <role> --digest <d> --by <who> --reason <why>` — vouch
 * for a role definition (AGT-6, PLAN section 1).
 *
 * The freeze manifest proposes a role and says why; this says an operator
 * agreed. Kept apart because the manifest lives in the repository and a task
 * that can write a change can write a name into it — one already wrote an
 * operator's, for a role that operator had never seen. A task cannot append
 * to the log, so this is the half that cannot be forged.
 *
 * The digest is required rather than computed from the file on disk: an
 * operator approves a definition they have read, and re-reading the file here
 * would approve whatever it says now.
 */
/** `<who>`, `<why>`, `<read the role and say...>` — a template nobody filled in. */
const PLACEHOLDER = /<[^<>]*>/;

export function approveRole(
  context: CliContext,
  runId: string,
  role: string,
  digest: string,
  by: string,
  reason: string,
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      context.write(`'${digest}' is not a sha256 digest; see the freeze manifest`);
      return { ok: false, detail: 'bad digest' };
    }

    // A reason that is still the placeholder is a rubber stamp, which is what
    // the freeze exists to prevent — and the schema takes it, because it is
    // not empty. This catches only the paste-the-template mistake, which has
    // already happened once here; nothing detects a reason that is merely
    // thoughtless, and pretending otherwise would be its own rubber stamp.
    if (PLACEHOLDER.test(reason)) {
      context.write(
        `that reason is still the placeholder: ${reason.trim()}\n\n` +
          `Read the definition and say why it is acceptable. The reason is the ` +
          `only part of this record a later reader cannot reconstruct.`,
      );
      return { ok: false, detail: 'placeholder reason' };
    }

    const onDisk = roleDigests(join(context.root, 'roles'))[role];
    if (onDisk === undefined) {
      context.write(`no role '${role}' in ${join(context.root, 'roles')}`);
      return { ok: false, detail: 'unknown role' };
    }
    if (onDisk !== digest) {
      // Approving a digest the file does not have would approve nothing, and
      // would read afterwards as though it had.
      context.write(
        `roles/${role}.md is ${onDisk.slice(0, 12)}, not ${digest.slice(0, 12)} — ` +
          `read the definition you mean to approve and name its digest`,
      );
      return { ok: false, detail: 'digest mismatch' };
    }

    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: by },
      });
    }
    log.append({ runId, type: 'RoleApproved', payload: { role, digest, by, reason } });

    context.write(`${role}@${digest.slice(0, 12)} approved by ${by}`);
    return { ok: true, detail: 'approved' };
  } finally {
    db.close();
  }
}

/**
 * `mpgm attest <task> --by <who> --evidence <what>` — record work done
 * outside the harness.
 *
 * For the bootstrap, and for nothing else if a project can help it. mpgm's
 * own P1-M3.1 were built by operator-driven sessions before the harness could
 * run them, and the plan graph gates each milestone behind the previous one's
 * tasks — so with no record of that work the scheduler offers to build what
 * already exists.
 *
 * Refuses anything the plan does not declare, and anything this run already
 * ran. An attestation is a person's word standing in for a session; it can
 * cover work the harness never saw, and it must not be able to overwrite work
 * the harness did see.
 */
export function attest(
  context: CliContext,
  runId: string,
  taskId: string,
  by: string,
  evidence: string,
  note = '',
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
    });
    let graph;
    try {
      graph = ingestPlan(artifacts.read(PLAN_ARTIFACT).data as never);
    } catch (error) {
      context.write(
        `could not read the gated Plan at ${PLAN_ARTIFACT}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return { ok: false, detail: 'no plan' };
    }

    // Attesting a task the plan does not have would put a claim in the log
    // that nothing can ever be checked against.
    if (!graph.tasks.some((candidate) => candidate.id === taskId)) {
      context.write(`no task '${taskId}' in the plan at ${PLAN_ARTIFACT}`);
      return { ok: false, detail: 'unknown task' };
    }

    // Checked before anything is appended. `append` validates the payload but
    // does not fold, and the log is append-only — so an event the reducer will
    // refuse would break every later projection permanently, with no way to
    // take it back.
    const ran = projector.project().runs[runId]?.tasks[taskId];
    if (ran !== undefined) {
      context.write(
        `cannot attest ${taskId}: run ${runId} already ran it (status '${ran.status}')`,
      );
      return { ok: false, detail: 'already ran' };
    }

    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: by },
      });
    }

    log.append({
      runId,
      type: 'TaskAttested',
      payload: { taskId, by, evidence, note },
    });

    context.write(`${taskId} attested by ${by} — ${evidence}`);
    return { ok: true, detail: 'attested' };
  } finally {
    db.close();
  }
}

/**
 * `mpgm record-merge <task> --commit <sha> --by <who>` — record a merge an
 * operator performed by hand, e.g. by approving a pull request on GitHub
 * after the implement loop gave up on a budget (T4.2.15, HIL-5, OBS-1).
 *
 * The kernel observes the trunk here rather than trusting the operator's
 * word for it: this verb is how an operator *tells* the kernel a merge
 * happened, but what gets appended is decided by asking the repository
 * itself (`verifyOperatorMerge`, `implement/merge.ts`), the same way
 * `gitMergeContract.check` already asks it for the kernel's own merges. An
 * operator's claim that does not check out is refused, not written
 * unverifiable (CONV-4) — a `commit` no clone can resolve is exactly the
 * defect T4.2.12 closed for `mergeChange`, reopened here if nothing checked
 * an operator's word the same way. Two halves of that: `--commit` is
 * recorded as the sha git resolved it to, so a symbolic ref cannot enter an
 * append-only log as itself, and the commit has to be tied to *this* task —
 * carrying its branch, or naming it in the merge message — so that any trunk
 * commit cannot be recorded as any task's merge.
 *
 * Distinct from `attest` (see `TaskAttested`'s own doc): the sessions that
 * produced this change ran inside the harness, and their cost is already in
 * the ledger — only the merge itself happened outside it, so this requires a
 * task the harness actually dispatched, and refuses one it never ran.
 *
 * Distinct from a plain `ChangeMerged` too: the merge gate never cleared
 * this change — a task only reaches this path after budget exhaustion, most
 * often `BudgetExceeded{kind: 'reviews'}` — so `ChangeMergedByOperator`
 * records what the task's last review actually found (approved, rejected,
 * or none at all) rather than reusing `ChangeMerged`'s own `reviewTaskId`,
 * whose empty value is documented to mean "no review authorised, which the
 * kernel refuses" — the opposite of what happened here.
 */
export async function recordMerge(
  context: CliContext,
  runId: string,
  taskId: string,
  commit: string,
  by: string,
  reason = '',
  repo?: string,
  into = 'main',
  branch?: string,
  remote?: string,
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
    const task = projector.project().runs[runId]?.tasks[taskId];
    if (task === undefined) {
      context.write(
        `no task '${taskId}' has run in run '${runId}' — record-merge is for a ` +
          `task the harness dispatched and then abandoned, not one it never ran`,
      );
      return { ok: false, detail: 'unknown task' };
    }
    if (task.merged !== null) {
      context.write(
        `${taskId} is already recorded merged, at ${task.merged.commit} — the log ` +
          `is append-only and this would not overwrite that record, only sit ` +
          `beside it`,
      );
      return { ok: false, detail: 'already merged' };
    }

    const repoPath = repo ?? context.root;
    const taskBranch = branch ?? branchNameFor(taskId);
    const verification = await verifyOperatorMerge({
      repo: repoPath,
      claimedCommit: commit,
      into,
      taskId,
      branch: taskBranch,
      ...(remote === undefined ? {} : { remote }),
    });
    if (!verification.verified) {
      context.write(`refusing to record ${taskId} merged: ${verification.detail}`);
      return { ok: false, detail: 'unverified merge' };
    }

    // `verification.commit`, never the operator's own `commit` string: what
    // goes in the log is the sha git resolved, so a `HEAD` or a `main` typed
    // here cannot become a value that resolves elsewhere to something else,
    // or here to something else tomorrow (T4.2.12's defect, arriving through
    // the operator's keyboard).
    const resolved = verification.commit;

    log.append({
      runId,
      type: 'ChangeMergedByOperator',
      payload: {
        taskId,
        branch: taskBranch,
        into,
        commit: resolved,
        by,
        reason,
        lastReviewApproved: task.review?.approved ?? null,
        lastReviewTaskId: task.review?.reviewTaskId ?? '',
      },
    });

    context.write(
      `${taskId} recorded merged by ${by} at ${resolved.slice(0, 12)} (${verification.detail})`,
    );
    return { ok: true, detail: 'merged' };
  } finally {
    db.close();
  }
}

/** `mpgm chat <phase>` — operator elicitation (DEF-1). */
export async function chat(
  context: CliContext,
  runId: string,
  phase: string,
  brief = '',
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      log.append({
        runId,
        type: 'RunStarted',
        payload: { project: context.root, operator: 'operator' },
      });
    }

    const roles = RoleRegistry.fromDirectory(join(context.root, 'roles'));
    const elicitor = roles.get('elicitor');

    // Dispatch before completion: the elicitation is a task like any other,
    // and recording it is what makes its spend attributable and the run
    // reconstructable from the log alone.
    log.append({
      runId,
      type: 'TaskDispatched',
      payload: { taskId: 'elicit', role: elicitor.name, model: elicitor.model },
    });

    const result = await elicit({
      provider: context.provider,
      role: elicitor,
      io: context.io,
      brief,
    });

    const artifacts = new ArtifactStore({
      root: context.root,
      schemas: context.artifactSchemas,
      gates: gateOracleFromState(projector.project(), runId),
    });
    const artifact = artifacts.write({
      id: `${phase}-elicitation`,
      basePath: `artifacts/${phase}/elicitation.md`,
      schema: 'elicitation',
      data: { conclusions: result.conclusions, transcript: result.transcript },
      producedBy: {
        task: 'elicit',
        role: 'elicitor',
        model: elicitor.model,
        runId,
      },
    });

    log.append({
      runId,
      type: 'TaskCompleted',
      payload: {
        taskId: 'elicit',
        artifactRefs: [
          {
            id: artifact.id,
            path: artifact.path,
            commit: null,
            version: artifact.version,
          },
        ],
      },
    });

    context.write(
      `elicitation complete after ${String(result.turns)} turns → ${artifact.path}`,
    );
    return { ok: true, detail: artifact.path };
  } finally {
    db.close();
  }
}

/**
 * `mpgm replay` — re-derive state from the log alone (ORC-3).
 *
 * Folds from seq 1 with snapshots ignored, and reports whether the result
 * matches the projector's. A divergence means state was reached by some path
 * other than the log, which is the one thing event sourcing is supposed to
 * make impossible.
 */
export function replay(context: CliContext, runId?: string): CommandResult {
  const { db, log, projector } = open(context);
  try {
    const events = log.read();
    const replayed = fold(events);
    const projected = projector.rebuild();
    const matches = JSON.stringify(replayed) === JSON.stringify(projected);

    context.write(`replayed ${String(events.length)} events`);
    for (const event of events) {
      if (runId !== undefined && event.runId !== runId) {
        continue;
      }
      context.write(`  ${String(event.seq).padStart(4)}  ${event.ts}  ${event.type}`);
    }
    context.write(
      matches
        ? 'replay reproduces the run exactly'
        : 'REPLAY DIVERGED from the projected state',
    );

    return { ok: matches, detail: matches ? 'identical' : 'diverged' };
  } finally {
    db.close();
  }
}
