import { relative } from 'node:path';
import type { SessionRunner } from '../agent/runner.js';
import type { Artifact, ArtifactStore, Provenance } from '../artifact/store.js';
import { assembleContext, type UpstreamResult } from '../context/assembler.js';
import { conventionTraceIssues } from '../context/conventions.js';
import { collectDecisions, relevantDecisions } from '../context/decisions.js';
import { kbUpdatesOf, writeKbDocument } from '../context/kb-writer.js';
import type { EgressPolicy } from '../context/egress.js';
import type { KbDocument } from '../context/knowledge-base.js';
import type { CapabilityRegistry } from '../contract/capability.js';
import type { ArtifactRef } from '../event/catalog.js';
import type { EventLog } from '../event/store.js';
import type { ApprovalPacket, GateEvidence, GateManager } from '../gate/manager.js';
import { isApproved } from '../gate/manager.js';
import {
  schedule,
  type BlockedStep,
  type StepOutcome,
} from '../orchestrator/scheduler.js';
import { tally, type Tally } from '../orchestrator/tally.js';
import type { GraphStep, Playbook, SessionStep } from '../playbook/graph.js';
import type { RoleRegistry } from '../role/loader.js';
import type { Projector } from '../state/projector.js';
import { runControl } from '../state/reduce.js';
import {
  nodeTestExecutor,
  runAdversarialSuite,
  adversarialSuiteSchema,
} from '../test/adversarial.js';
import {
  nfrRequirementSourceSchema,
  quantifiedRequirements,
} from '../test/nfr-source.js';
import { runNfrSuite } from '../test/nfr.js';
import type { TraceIndex } from '../trace/index-store.js';

/**
 * Executes one phase from its playbook (DESIGN §4.1).
 *
 * The playbook's pattern nodes are already expanded into an ordinary task
 * graph by the loader, so this schedules steps whose dependencies are complete
 * up to a concurrency bound — it has no notion of a fan-out or a panel beyond
 * counting one's ballots. Each step is given context assembled from the
 * artifacts and results its dependencies produced, never from their sessions.
 * The phase ends by presenting the gate; it never approves it.
 */

/**
 * Steps dispatched at once when the caller does not say.
 *
 * A limit, not a target: a phase of strictly sequential tasks runs one at a
 * time whatever this says. Configuration rather than an architectural ceiling
 * (NFR-3).
 */
export const DEFAULT_CONCURRENCY = 4;

export interface PhaseRunOptions {
  readonly runId: string;
  readonly playbook: Playbook;
  readonly roles: RoleRegistry;
  readonly artifacts: ArtifactStore;
  readonly sessions: SessionRunner;
  readonly gates: GateManager;
  readonly log: EventLog;
  readonly projector: Projector;
  readonly kb: readonly KbDocument[];
  readonly policy: EgressPolicy;
  readonly concurrency?: number;
  /**
   * Derived trace index (ADR-4), updated as artifacts are written.
   *
   * Indexed here rather than only on commit, because an artifact that exists
   * but has not been committed is exactly the state a phase is in when it
   * reaches its gate — and the gate is what wants to know what traces to what.
   */
  readonly traces?: TraceIndex;
  /**
   * Bound MCP capability contracts an `nfr` step invokes (T4.3.2, DESIGN
   * §4.7, EXT-1). Absent means a playbook declaring an `nfr` node blocks
   * rather than silently skipping the measurement — the same fail-closed
   * reading `CapabilityRegistry.require` already gives a caller reaching for
   * an unbound capability by name.
   */
  readonly capabilities?: CapabilityRegistry;
  /** `repo`/`ref` an `nfr` step's `test.nfr#run` calls are measured against. */
  readonly repo?: string;
  readonly ref?: string;
  /**
   * Where a `suite` step's generated `node:test` file is written and run
   * (T4.3.2, `nodeTestExecutor`). Deliberately not defaulted to this
   * project's own root: a generated case is model-authored code run with the
   * kernel's own privileges wherever it executes, and choosing that target is
   * a decision a caller makes explicitly, never a fallback this option
   * supplies on its own.
   */
  readonly testProjectDir?: string;
}

export type PhaseOutcome =
  | { readonly status: 'gate-presented'; readonly packet: ApprovalPacket }
  | {
      readonly status: 'blocked';
      readonly taskId: string;
      readonly reason: string;
      /** Every step that blocked, when more than one was in flight. */
      readonly blocked: readonly BlockedStep[];
    }
  | { readonly status: 'stopped'; readonly control: 'paused' | 'killed' };

export interface PhaseResult {
  readonly outcome: PhaseOutcome;
  readonly produced: Readonly<Record<string, Artifact>>;
  /** Step id → its result, aliased under the node id for a node's last step. */
  readonly outputs: Readonly<Record<string, unknown>>;
}

function blockedOutcome(blocked: readonly BlockedStep[]): PhaseOutcome {
  const first = blocked[0];
  if (first === undefined) {
    // Only reachable if the scheduler reported `blocked` with nothing in it.
    return { status: 'blocked', taskId: '(unknown)', reason: 'blocked', blocked };
  }
  const rest = blocked.slice(1);
  const also =
    rest.length === 0
      ? ''
      : ` (${String(rest.length)} other step(s) also blocked: ` +
        `${rest.map((entry) => entry.id).join(', ')})`;
  return {
    status: 'blocked',
    taskId: first.id,
    reason: `${first.reason}${also}`,
    blocked,
  };
}

/**
 * The `NfrRequirement[]` an `nfr` step measures, read off its upstream
 * node's result.
 *
 * A session's structured output is always an object at its top level — the
 * SDK's own structured-output tool refuses a bare array there — so the array
 * an `nfr` step needs lives under a `requirements` field: the field the Scope
 * artifact itself uses (`scopeSchema`, `src/schemas.ts`), whose elements this
 * step parses with `nfrRequirementSourceSchema` so that a real, mixed Scope
 * list is what it reads rather than a flat shape nothing in this project
 * produces. A kernel-computed upstream result that already is an array is read
 * as-is.
 */
function nfrRequirementsSourceOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'requirements' in value) {
    return value.requirements;
  }
  return value;
}

export async function runPhase(options: PhaseRunOptions): Promise<PhaseResult> {
  const { runId, playbook, log } = options;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const produced: Record<string, Artifact> = {};
  const outputs: Record<string, unknown> = {};

  // Refused before anything is dispatched, not when the gate is reached: by
  // then the phase has already spent its whole budget re-deriving artifacts
  // that supersede approved ones nobody asked to replace.
  if (isApproved(options.projector.project(), runId, playbook.gate.id)) {
    return {
      outcome: {
        status: 'blocked',
        taskId: '(gate)',
        reason:
          `gate '${playbook.gate.id}' is already approved. Reopen the phase first ` +
          `before running it again.`,
        blocked: [],
      },
      produced,
      outputs,
    };
  }

  // Checked before the phase is recorded as entered. A refused attempt that
  // still logged PhaseEntered would leave the log claiming a phase was entered
  // twice when the first attempt never dispatched anything.
  const initial = runControl(options.projector.project(), runId);
  if (initial !== 'running') {
    return {
      outcome: { status: 'stopped', control: initial },
      produced,
      outputs,
    };
  }

  log.append({ runId, type: 'PhaseEntered', payload: { phase: playbook.phase } });

  // Load the artifacts this phase reads but does not write. A required input
  // that is absent blocks the phase: running anyway is how a phase produces a
  // confident artifact about material it never saw.
  const available: Record<string, Artifact> = {};
  for (const [inputId, template] of Object.entries(playbook.inputs)) {
    try {
      const input = options.artifacts.read(template.path);
      available[inputId] = input;
      // Indexed as well as read: what a phase's own artifacts cite lands in
      // the index when they are written, but the ids they cite are declared
      // by these — and a `traces-resolve` criterion over an index that never
      // saw them would report every citation as dangling.
      options.traces?.indexArtifactAs(
        input,
        relative(options.artifacts.root, input.path),
      );
    } catch (cause) {
      if (!template.optional) {
        return {
          outcome: {
            status: 'blocked',
            taskId: '(inputs)',
            reason:
              `required input '${inputId}' is missing at '${template.path}': ` +
              (cause instanceof Error ? cause.message : String(cause)),
            blocked: [],
          },
          produced,
          outputs,
        };
      }
    }
  }

  const graph = playbook.graph;
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));

  // Decisions already recorded anywhere the phase can see, so a task can be
  // shown the ones it might contradict (CTX-3).
  const decisions = collectDecisions(Object.values(available));

  /** Artifacts a step should see: its dependencies' output, plus what it consumes. */
  const upstreamOf = (step: GraphStep): Artifact[] => {
    const artifacts: Artifact[] = [];
    const seen = new Set<string>();
    const add = (artifactId: string | undefined): void => {
      if (artifactId === undefined || seen.has(artifactId)) {
        return;
      }
      seen.add(artifactId);
      const artifact = available[artifactId] ?? produced[artifactId];
      if (artifact !== undefined) {
        artifacts.push(artifact);
      }
    };

    for (const dependency of step.dependsOn) {
      add(stepById.get(dependency)?.produces);
    }
    // Inputs the phase did not produce — an earlier phase's artifact, or an
    // operator dialogue held outside any playbook.
    if (step.kind === 'session') {
      for (const consumed of step.consumes) {
        add(consumed);
      }
    }
    return artifacts;
  };

  /**
   * Dependency results that never became artifacts — fan-out workers, panel
   * judges, a tally. A dependency that wrote an artifact is already carried by
   * `upstreamOf`; passing it twice would only invite the two to disagree.
   */
  const resultsFor = (step: GraphStep): UpstreamResult[] => {
    const results: UpstreamResult[] = [];
    for (const dependency of step.dependsOn) {
      const source = stepById.get(dependency);
      if (source === undefined || source.produces !== undefined) {
        continue;
      }
      if (dependency in outputs) {
        results.push({
          taskId: dependency,
          description: source.description,
          data: outputs[dependency],
        });
      }
    }
    return results;
  };

  const writeArtifact = (
    step: GraphStep,
    role: string,
    model: string,
    data: unknown,
  ): Artifact | undefined => {
    if (step.produces === undefined) {
      return undefined;
    }
    const template = playbook.artifacts[step.produces];
    if (template === undefined) {
      throw new Error(
        `task '${step.id}' produces undeclared artifact '${step.produces}'`,
      );
    }
    const provenance: Provenance = { task: step.id, role, model, runId };
    const artifact = options.artifacts.write({
      id: step.produces,
      basePath: template.path,
      schema: template.schema,
      data,
      producedBy: provenance,
      ...(template.egress === undefined ? {} : { egress: template.egress }),
    });
    produced[step.produces] = artifact;
    options.traces?.indexArtifactAs(
      artifact,
      relative(options.artifacts.root, artifact.path),
    );
    return artifact;
  };

  /** `TaskCompleted.artifactRefs` naming one written artifact (T4.2.7). */
  const refFor = (artifact: Artifact): ArtifactRef => ({
    id: artifact.id,
    path: artifact.path,
    commit: null,
    version: artifact.version,
  });

  const record = (step: GraphStep, value: unknown): void => {
    outputs[step.id] = value;
    // A node's result is its last step's result, so a gate criterion naming
    // the node reads the same thing whether or not the node expanded.
    if (graph.terminal[step.node] === step.id) {
      outputs[step.node] = value;
    }
  };

  /**
   * Ids the material in front of a step touches — what it cites and what it
   * declares. A decision about none of them is one this step has no way to
   * contradict.
   */
  const touchedBy = (upstream: readonly Artifact[]): Set<string> => {
    const ids = new Set<string>();
    const index = options.traces;
    if (index === undefined) {
      return ids;
    }
    for (const artifact of upstream) {
      const node = `${artifact.id}@${String(artifact.version)}`;
      for (const link of index.tracesFrom(node)) {
        ids.add(link.dst);
        if (link.relation === 'declares') {
          for (const nested of index.tracesFrom(link.dst)) {
            ids.add(nested.dst);
          }
        }
      }
    }
    return ids;
  };

  const runSession = async (step: SessionStep): Promise<StepOutcome<unknown>> => {
    const role = options.roles.get(step.role);
    const upstream = upstreamOf(step);
    // Timed and logged (T4.2.9, NFR-3): this call happens before
    // `sessions.runTask`, so it is outside the span `SessionUsage.durationMs`
    // covers, and would otherwise be invisible to any harness-overhead
    // figure computed from the log alone.
    const contextStartedAt = performance.now();
    const context = assembleContext({
      task: step,
      upstream,
      results: resultsFor(step),
      decisions: relevantDecisions({
        decisions,
        touching: touchedBy(upstream),
        alreadyPresent: new Set(upstream.map((artifact) => artifact.id)),
      }),
      kb: options.kb,
      policy: options.policy,
    });
    log.append({
      runId,
      type: 'ContextAssembled',
      payload: {
        taskId: step.id,
        site: 'phase',
        durationMs: performance.now() - contextStartedAt,
      },
    });

    // Written inside `onCompleted`, before `TaskCompleted` is appended,
    // rather than after `runTask` returns: written afterwards, the artifact
    // does not exist yet when the event that is supposed to name it is
    // written (T4.2.7). `SessionRunner` holds no artifact store of its own,
    // so it calls back into this one at the point its own output has
    // validated.
    const outcome = await options.sessions.runTask({
      runId,
      taskId: step.id,
      role,
      prompt: context.prompt,
      // The conventions this task was actually shown, which is the set it can
      // be held to. Checked here rather than trusted to the prompt: `tracesTo`
      // is the only id-shaped field most artifacts have, so it is where an id
      // goes when an agent has one and nowhere to put it (IMP-4, DSG-4).
      validate: (output) => conventionTraceIssues(output, context.conventions),
      onCompleted: (output) => {
        const artifact = writeArtifact(step, role.name, role.model, output);
        return artifact === undefined ? [] : [refFor(artifact)];
      },
    });

    if (outcome.status !== 'completed') {
      return { status: 'blocked', reason: outcome.reason };
    }

    record(step, outcome.output);

    if (step.updatesKb === true) {
      const provenance: Provenance = {
        task: step.id,
        role: role.name,
        model: role.model,
        runId,
      };
      for (const update of kbUpdatesOf(outcome.output)) {
        try {
          const path = writeKbDocument({
            root: options.artifacts.root,
            update,
            producedBy: provenance,
          });
          log.append({
            runId,
            type: 'KnowledgeBaseUpdated',
            payload: {
              taskId: step.id,
              path,
              title: update.title,
              rationale: update.rationale,
            },
          });
        } catch (cause) {
          // A rejected path is the task's mistake, not the kernel's: block
          // rather than silently dropping the update it thinks it made.
          return {
            status: 'blocked',
            reason: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }
    }

    return { status: 'completed', value: outcome.output };
  };

  const runTally = (step: GraphStep & { kind: 'tally' }): StepOutcome<unknown> => {
    const ballots = step.dependsOn.map(
      (judge) => [judge, outputs[judge]] as readonly [string, unknown],
    );

    let counted: Tally;
    try {
      counted = tally(step.ballot, step.vote, ballots);
    } catch (cause) {
      return {
        status: 'blocked',
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }

    log.append({
      runId,
      type: 'VoteTallied',
      payload: {
        taskId: step.id,
        node: step.node,
        rule: counted.rule,
        carried: counted.carried,
        summary: counted.summary,
        ballots: counted.ballots.map((cast) => ({
          judge: cast.judge,
          value: cast.value,
        })),
      },
    });

    record(step, counted);
    // The kernel counted it, so the kernel is the producer of record.
    writeArtifact(step, 'kernel', '(none)', counted);
    return { status: 'completed', value: counted };
  };

  const runNfr = async (
    step: GraphStep & { kind: 'nfr' },
  ): Promise<StepOutcome<unknown>> => {
    const parsedRequirements = nfrRequirementSourceSchema.safeParse(
      nfrRequirementsSourceOf(outputs[step.requirements]),
    );
    if (!parsedRequirements.success) {
      return {
        status: 'blocked',
        reason:
          `nfr '${step.id}' expected '${step.requirements}' to hold a non-empty ` +
          `array of requirements — Scope's own elements (a 'non-functional' entry ` +
          `carrying its 'threshold', a 'functional' one carrying none) or the flat ` +
          `{id, metric, value, unit, measuredBy} shape — and it did not: ` +
          parsedRequirements.error.message,
      };
    }

    const requirements = quantifiedRequirements(parsedRequirements.data);
    if (requirements.length === 0) {
      return {
        status: 'blocked',
        reason:
          `nfr '${step.id}' found nothing to measure in '${step.requirements}': ` +
          `${String(parsedRequirements.data.length)} requirement(s), none of them ` +
          `quantified. TST-3 binds every quantified NFR Scope declares to a suite, ` +
          `so a step that measured none of them is refused here rather than ` +
          `completing with a coverage report of no rows — absence read as success ` +
          `is exactly what 'nfrCoverage' refuses one level down (CONV-4). Either ` +
          `the upstream step declared no non-functional requirement, or it declared ` +
          `them somewhere this step does not read.`,
      };
    }

    if (!options.capabilities?.has('test.nfr')) {
      return {
        status: 'blocked',
        reason:
          `nfr '${step.id}' needs the 'test.nfr' capability bound (TST-3, DESIGN ` +
          `§4.7), and this run bound none. Bind a provider via ` +
          `PhaseRunOptions.capabilities before running a phase that declares an ` +
          `'nfr' node — an unbound capability is refused rather than read as ` +
          `nothing to measure (CONV-4). 'mpgm run' binds 'commandNfrProvider' ` +
          `(src/test/nfr-provider.ts), which measures what 'test/nfr.yaml' ` +
          `declares.`,
      };
    }
    if (options.repo === undefined || options.ref === undefined) {
      return {
        status: 'blocked',
        reason:
          `nfr '${step.id}' has no 'repo'/'ref' to measure against. Pass both on ` +
          `PhaseRunOptions — from the CLI, 'mpgm run <phase> --repo <owner/name> ` +
          `--ref <ref>'. 'test.nfr#run' reports against a specific repo and ref, ` +
          `and neither is guessed.`,
      };
    }

    const contract = options.capabilities.require('test.nfr');
    let rows;
    try {
      rows = await runNfrSuite({
        repo: options.repo,
        ref: options.ref,
        requirements,
        run: (input) => contract.invoke('run', input),
      });
    } catch (cause) {
      return {
        status: 'blocked',
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }

    record(step, rows);
    // The kernel measured it, so the kernel is the producer of record — the
    // same reasoning `runTally` already gives its own written artifact.
    writeArtifact(step, 'kernel', '(none)', rows);
    return { status: 'completed', value: rows };
  };

  const runSuite = async (
    step: GraphStep & { kind: 'suite' },
  ): Promise<StepOutcome<unknown>> => {
    const parsedSuite = adversarialSuiteSchema.safeParse(outputs[step.suite]);
    if (!parsedSuite.success) {
      return {
        status: 'blocked',
        reason:
          `suite '${step.id}' expected '${step.suite}' to hold an AdversarialSuite, ` +
          `and it did not: ${parsedSuite.error.message}`,
      };
    }
    if (options.testProjectDir === undefined) {
      return {
        status: 'blocked',
        reason:
          `suite '${step.id}' has no project directory to run against. Running a ` +
          `generated suite executes model-authored code with the privileges ` +
          `wherever it runs — nodeTestExecutor's subject restriction is not a ` +
          `confinement boundary (src/test/adversarial.ts) — so pass ` +
          `'testProjectDir' on PhaseRunOptions explicitly — from the CLI, ` +
          `'mpgm run <phase> --test-project-dir <path>'; it is a decision, not a ` +
          `default this phase supplies on its own.`,
      };
    }

    let verdict;
    try {
      verdict = await runAdversarialSuite({
        suite: parsedSuite.data,
        execute: nodeTestExecutor({ projectDir: options.testProjectDir }),
      });
    } catch (cause) {
      return {
        status: 'blocked',
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }

    record(step, verdict);
    writeArtifact(step, 'kernel', '(none)', verdict);
    return { status: 'completed', value: verdict };
  };

  const report = await schedule<GraphStep, unknown>({
    steps: graph.steps,
    concurrency,
    shouldDispatch: () => {
      // Checked before every dispatch, not once at the start: an operator who
      // pauses mid-phase expects the steps already running to be the last ones
      // (HIL-3).
      const control = runControl(options.projector.project(), runId);
      return control === 'running'
        ? { proceed: true }
        : { proceed: false, reason: control };
    },
    run: (step) => {
      switch (step.kind) {
        case 'tally':
          return Promise.resolve(runTally(step));
        case 'nfr':
          return runNfr(step);
        case 'suite':
          return runSuite(step);
        default:
          return runSession(step);
      }
    },
  });

  if (report.status === 'blocked') {
    return { outcome: blockedOutcome(report.blocked), produced, outputs };
  }

  if (report.status === 'stopped') {
    const control = report.stoppedReason === 'killed' ? 'killed' : 'paused';
    return { outcome: { status: 'stopped', control }, produced, outputs };
  }

  const evidence: GateEvidence = { artifacts: produced, outputs };
  return {
    outcome: {
      status: 'gate-presented',
      packet: options.gates.present(runId, playbook, evidence),
    },
    produced,
    outputs,
  };
}
