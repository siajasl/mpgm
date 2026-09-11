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
import { targetRefusal, type TargetFacts } from '../implement/target.js';
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

    context.write(
      `'${env}' rolled back to ${parsedTo.data.version} ` +
        `(${parsedTo.data.digest.slice(0, 12)}) by ${by} — ` +
        (status.up ? 'up' : 'NOT up — check the environment'),
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
