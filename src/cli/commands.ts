import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { AgentSessionProvider } from '../agent/session.js';
import { SessionRunner } from '../agent/runner.js';
import type { OutputSchemaRegistry } from '../agent/output-registry.js';
import { ArtifactStore } from '../artifact/store.js';
import type { ArtifactSchemaRegistry } from '../artifact/schema-registry.js';
import { DEFAULT_EGRESS_POLICY, type EgressPolicy } from '../context/egress.js';
import { loadKnowledgeBase, type KbDocument } from '../context/knowledge-base.js';
import { DashboardServer } from '../dashboard/server.js';
import { openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { elicit, type OperatorIo } from '../elicit/session.js';
import { GateManager, gateOracleFromState } from '../gate/manager.js';
import { isGitRepository, tagGate } from '../git/tag.js';
import { runPhase } from '../phase/runner.js';
import { TraceIndex } from '../trace/index-store.js';
import { planReopen, reopenPhase } from '../gate/reopen.js';
import { TraceIndexer } from '../trace/indexer.js';
import { PlaybookRegistry } from '../playbook/loader.js';
import { RoleRegistry } from '../role/loader.js';
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
import { WorktreeManager } from '../implement/worktree.js';
import { completedTaskIds, ingestPlan, readyTasks } from '../plan/ingest.js';
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

/** `mpgm run <phase>` — execute a phase and present its gate. */
export async function run(
  context: CliContext,
  runId: string,
  phase: string,
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

    const result = await runPhase({
      runId,
      playbook,
      roles,
      artifacts,
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

/** `mpgm status` — folded run state (OBS-3). */
export function status(context: CliContext, runId?: string): CommandResult {
  const { db, projector } = open(context);
  try {
    const state = projector.project();
    const runs = runId === undefined ? Object.values(state.runs) : [state.runs[runId]];

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
        context.write(
          `  task ${task.taskId} ${task.status} (${task.role} on ${task.model})`,
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

  const { db, projector } = open(context);
  const server = new DashboardServer({ projector, traces: TraceIndex.attach(db) });
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

/** `mpgm pause|resume|kill|redirect` — operator control, recorded (HIL-3, HIL-5). */
export function intervene(
  context: CliContext,
  runId: string,
  action: 'pause' | 'resume' | 'kill' | 'redirect',
  detail = '',
): CommandResult {
  const { db, log, projector } = open(context);
  try {
    if (projector.project().runs[runId] === undefined) {
      context.write(`no such run: ${runId}`);
      return { ok: false, detail: 'unknown run' };
    }

    log.append({ runId, type: 'OperatorIntervened', payload: { action, detail } });
    const control = projector.project().runs[runId]?.control ?? 'running';
    context.write(`run ${runId} is now ${control}`);
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
): Promise<CommandResult> {
  const { db, log, projector } = open(context);
  try {
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
      repo: context.root,
      worktrees: new WorktreeManager({ repo: context.root }),
      sessions: new SessionRunner({
        log,
        provider: context.provider,
        schemas: context.outputSchemas,
        policyRoot: context.root,
      }),
      roles: RoleRegistry.fromDirectory(join(context.root, 'roles')),
      log,
      kb: knowledgeBase(context),
      policy: context.policy ?? DEFAULT_EGRESS_POLICY,
      // The kernel publishes; agents cannot (the destructive guard refuses
      // `git push`). Without this the branch is invisible to CI and every
      // required check reports nothing, which blocks rather than merges.
      publish: async (branch) => {
        await Promise.resolve(
          execFileSync('git', ['push', '--force-with-lease', 'origin', branch], {
            cwd: context.root,
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
    new TraceIndexer({ repo: context.root, index, artifacts }).update();

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
