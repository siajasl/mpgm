import type { z } from 'zod';
import type { EventLog } from '../event/store.js';
import type { Role } from '../role/definition.js';
import { RolePolicy } from '../policy/role-policy.js';
import { BudgetLedger, runWithWallClock, type Now } from './budget.js';
import type { OutputSchemaRegistry } from './output-registry.js';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
  ToolGate,
} from './session.js';
import type { SecretBroker } from '../secret/broker.js';
import type { DestructiveGuard } from '../policy/destructive.js';

/**
 * Runs one SDK session per task (ADR-5) and turns its result into events.
 *
 * The kernel makes no model calls of its own: it assembles the request from
 * the role, hands it to the provider, then validates, retries and records.
 */

export interface RunTaskRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly role: Role;
  readonly prompt: string;
  /**
   * Model for this session. Resolved at dispatch time — role default unless
   * the routing table overrides it (AGT-5, DESIGN §4.2) — and recorded in
   * TaskDispatched for replay and eval attribution.
   */
  readonly model?: string;
  /**
   * Root this session's paths resolve against, overriding the runner's.
   *
   * An implementation task works in its own worktree (IMP-1, ADR-5), so its
   * root is neither the project's nor the same as any other task's. The
   * override is per task rather than per runner because one runner dispatches
   * them all.
   */
  readonly policyRoot?: string;
  /**
   * Extra checks on a validated output, returning one issue per problem.
   *
   * For rules the output schema cannot express because they depend on the
   * project rather than on the shape — which convention ids are in force,
   * which requirements exist. Issues are fed back and the session retried,
   * exactly as a schema failure is.
   */
  readonly validate?: (output: unknown) => readonly string[];
  readonly signal?: AbortSignal;
}

export type TaskOutcome =
  | { readonly status: 'completed'; readonly output: unknown; readonly attempts: number }
  | {
      readonly status: 'blocked';
      readonly reason: string;
      readonly attempts: number;
      readonly lastIssues: readonly string[];
    };

export interface SessionRunnerOptions {
  readonly log: EventLog;
  readonly provider: AgentSessionProvider;
  readonly schemas: OutputSchemaRegistry;
  /**
   * How many times a session may be re-run after its output fails validation
   * (AGT-3). Bounded: an agent that cannot satisfy its schema will not satisfy
   * it on the hundredth attempt either, and each try costs tokens.
   */
  readonly maxValidationAttempts?: number;
  /** Injectable clock, so elapsed-time behaviour is testable. */
  readonly now?: Now;
  /**
   * Project root for path policy (SAF-1). Defaults to the process working
   * directory.
   */
  readonly policyRoot?: string;
  /**
   * Resolves credential references at the tool boundary and scrubs them from
   * the session environment (SAF-2, ADR-6). Omitted for runs with no secrets:
   * a broker with nothing declared would only add a layer that never fires.
   */
  readonly secrets?: SecretBroker;
  /**
   * Refuses destructive calls that have not been simulated and confirmed
   * (SAF-4). Omitted for runs with no destructive tools in reach.
   */
  readonly destructive?: DestructiveGuard;
}

export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;

/** The CLI's own tool for returning a session's final structured output. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * What was wrong with the output the CLI gave up on.
 *
 * The result message reports how many attempts failed and nothing about why,
 * which leaves an operator with a count and a guess. The gate saw every
 * attempt on its way past, so the last one can be checked here against the
 * same schema and the real issues fed back (CONV-3, AGT-3).
 *
 * The case worth naming separately is output the kernel would have accepted:
 * that is not a model that cannot follow a schema, it is the JSON Schema sent
 * to the CLI disagreeing with the zod schema it was derived from, and no
 * amount of retrying fixes it.
 */
export function abandonedOutputIssues(
  schema: { safeParse: (value: unknown) => { success: boolean; error?: z.ZodError } },
  attempted: unknown,
  errorMessage: string,
): readonly string[] {
  const said = errorMessage === '' ? '' : ` (${errorMessage})`;
  if (attempted === undefined) {
    return [`the session ended without output satisfying the schema${said}`];
  }

  const parsed = schema.safeParse(attempted);
  if (parsed.success) {
    return [
      "the CLI rejected output that satisfies this task's schema, so the JSON " +
        `Schema it was given does not match the schema the kernel validates against${said}`,
    ];
  }

  const issues = (parsed.error?.issues ?? []).map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return issues.length === 0
    ? [`the session ended without output satisfying the schema${said}`]
    : issues;
}

export class SessionRunner {
  readonly #log: EventLog;
  readonly #provider: AgentSessionProvider;
  readonly #schemas: OutputSchemaRegistry;
  readonly #maxAttempts: number;
  readonly #now: Now | undefined;
  readonly #policyRoot: string;
  readonly #secrets: SecretBroker | undefined;
  readonly #destructive: DestructiveGuard | undefined;

  constructor(options: SessionRunnerOptions) {
    this.#log = options.log;
    this.#provider = options.provider;
    this.#schemas = options.schemas;
    this.#maxAttempts = options.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS;
    this.#now = options.now;
    this.#policyRoot = options.policyRoot ?? process.cwd();
    this.#secrets = options.secrets;
    this.#destructive = options.destructive;

    if (this.#maxAttempts < 1) {
      throw new Error('maxValidationAttempts must be at least 1');
    }
  }

  /**
   * The tool gate the session actually gets.
   *
   * Policy decides first, the broker substitutes second, and the log wraps
   * both — so a refusal to hand over a credential is an audited tool decision
   * like any other rather than a silent substitution failure, and the event
   * records the decision that was finally taken (OBS-1, DESIGN §7).
   */
  #gate(
    runId: string,
    taskId: string,
    policy: RolePolicy,
    seen: (tool: string, input: Record<string, unknown>) => void,
  ): ToolGate {
    const inner = policy.gate();
    // Destructive first, then policy, then the broker: a destructive call is
    // reported as destructive rather than as whatever else is also wrong with
    // it, and no credential is resolved for a call that is about to be
    // refused anyway.
    const brokered = this.#secrets === undefined ? inner : this.#secrets.gate(inner);
    const gate =
      this.#destructive === undefined ? brokered : this.#destructive.gate(brokered);

    return async (tool: string, input: Record<string, unknown>) => {
      const decision = await gate(tool, input);
      seen(tool, input);
      this.#log.append({
        runId,
        type: 'ToolCallLogged',
        payload: {
          taskId,
          tool,
          decision: decision.behavior === 'allow' ? 'allowed' : 'denied',
          detail: decision.behavior === 'allow' ? '' : decision.reason,
          outputBlob: null,
        },
      });
      return decision;
    };
  }

  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
    const { runId, taskId, role } = request;
    const model = request.model ?? role.model;
    const schema = this.#schemas.get(role.output.schema);
    const outputJsonSchema = this.#schemas.jsonSchema(role.output.schema);

    this.#log.append({
      runId,
      type: 'TaskDispatched',
      payload: { taskId, role: role.name, model },
    });

    const root = request.policyRoot ?? this.#policyRoot;
    const policy = new RolePolicy(role, { root });
    // Tools the gate ruled on during this session, so a denial the SDK also
    // reports is not written to the audit trail twice.
    let gatedTools = new Set<string>();
    // The last structured output the session tried to return, whether or not
    // the CLI accepted it. When the CLI gives up, this is the only evidence of
    // *what* it kept rejecting: the result message says how many attempts
    // failed and nothing about why (CONV-3).
    let lastStructured: unknown;

    let lastIssues: readonly string[] = [];
    // One ledger per task: retries share the budget, because three sessions
    // that each stay under the limit can still blow through it together.
    const ledger =
      this.#now === undefined
        ? new BudgetLedger(role.budgets)
        : new BudgetLedger(role.budgets, this.#now);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      // Never dispatch a session that has nothing left to spend. A retry with
      // maxTurns 0 cannot succeed and would report max_turns as though the
      // agent had misbehaved.
      const exhausted = ledger.breach();
      if (
        exhausted !== null ||
        ledger.remainingSteps < 1 ||
        ledger.remainingCostUsd <= 0
      ) {
        const kind = exhausted?.kind ?? (ledger.remainingSteps < 1 ? 'steps' : 'cost');
        this.#log.append({
          runId,
          type: 'BudgetExceeded',
          payload: {
            taskId,
            kind,
            limit: exhausted?.limit ?? role.budgets.steps,
            observed: exhausted?.observed ?? role.budgets.steps,
          },
        });
        return {
          status: 'blocked',
          reason: `budget exhausted before attempt ${String(attempt)}: ${kind}`,
          attempts: attempt - 1,
          lastIssues,
        };
      }

      const sessionRequest: SessionRequest = {
        model,
        systemPrompt: role.systemPrompt,
        // Feed the previous validation failure back in, so the retry has the
        // information needed to do better than repeat itself (AGT-3).
        prompt: this.#promptFor(request.prompt, lastIssues),
        allowedTools: role.tools.allow,
        // What is left of the task's budget, not the whole of it.
        maxTurns: ledger.remainingSteps,
        maxBudgetUsd: ledger.remainingCostUsd,
        outputJsonSchema,
        // The session resolves relative paths against the same root the policy
        // does, so the agent and the gate agree on what a path means.
        cwd: root,
        ...(this.#secrets === undefined
          ? {}
          : { env: this.#secrets.environment(process.env) }),
        canUseTool: this.#gate(runId, taskId, policy, (tool, input) => {
          gatedTools.add(tool);
          if (tool === STRUCTURED_OUTPUT_TOOL) {
            lastStructured = input;
          }
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      gatedTools = new Set<string>();
      lastStructured = undefined;

      const result = await runWithWallClock(
        (signal) => this.#provider.run({ ...sessionRequest, signal }),
        ledger.remainingSeconds,
      );
      ledger.record(result.usage, result.turns);
      this.#recordSession(runId, taskId, role, result, gatedTools);

      // A session the CLI abandoned for repeatedly failing its schema is a
      // validation failure that happened to be detected one layer down, so it
      // retries like one (AGT-3). Those retries were all inside one session,
      // against one context; a fresh session is a fresh sample, and the
      // shared ledger stops this costing more than any other retry would.
      if (result.termination === 'invalid_output') {
        lastIssues = abandonedOutputIssues(schema, lastStructured, result.errorMessage);
        this.#log.append({
          runId,
          type: 'ValidationFailed',
          payload: { taskId, attempt, issues: [...lastIssues] },
        });
        continue;
      }

      if (result.termination !== 'completed') {
        return {
          status: 'blocked',
          reason: `session terminated: ${result.termination}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
          attempts: attempt,
          lastIssues,
        };
      }

      // A session that has already ended cannot be terminated, and the spend
      // has already happened. Discarding output the session did produce buys
      // nothing back and loses the work as well as the money — so a breach
      // observed after the fact bounds what comes *next* rather than voiding
      // what came before. The loop's own guard refuses the following attempt,
      // and the event is written either way so the overrun is visible (AGT-4,
      // OBS-2).
      //
      // The per-session bound is the SDK's: `maxTurns` and `maxBudgetUsd` are
      // passed from what the ledger has left, so a session cannot run away
      // between checks. What the ledger adds is the total across attempts,
      // which is the part only the kernel can see.
      const breach = ledger.breach();

      const parsed = schema.safeParse(result.structuredOutput);
      if (parsed.success) {
        // Constraints the kernel knows and the schema cannot: a schema is a
        // fixed shape, while some rules depend on what this project happens
        // to hold — which conventions are in force, which requirement ids
        // exist. Fed back through the same retry as a schema failure, because
        // to the agent they are the same kind of mistake (AGT-3).
        const extra = request.validate?.(parsed.data) ?? [];
        if (extra.length === 0) {
          if (breach !== null) {
            this.#log.append({
              runId,
              type: 'BudgetExceeded',
              payload: {
                taskId,
                kind: breach.kind,
                limit: breach.limit,
                observed: breach.observed,
              },
            });
          }
          this.#log.append({
            runId,
            type: 'TaskCompleted',
            payload: { taskId, artifactRefs: [] },
          });
          return { status: 'completed', output: parsed.data, attempts: attempt };
        }

        lastIssues = extra;
        this.#log.append({
          runId,
          type: 'ValidationFailed',
          payload: { taskId, attempt, issues: [...lastIssues] },
        });
        continue;
      }

      lastIssues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
      this.#log.append({
        runId,
        type: 'ValidationFailed',
        payload: { taskId, attempt, issues: [...lastIssues] },
      });
    }

    // Exhausted, not silently dropped: the task is blocked and escalates to
    // the operator (NFR-1).
    return {
      status: 'blocked',
      reason: `output failed validation after ${String(this.#maxAttempts)} attempts`,
      attempts: this.#maxAttempts,
      lastIssues,
    };
  }

  #promptFor(prompt: string, issues: readonly string[]): string {
    if (issues.length === 0) {
      return prompt;
    }
    return [
      prompt,
      '',
      'Your previous response did not satisfy the required output schema:',
      ...issues.map((issue) => `- ${issue}`),
      '',
      'Return output that satisfies the schema.',
    ].join('\n');
  }

  #recordSession(
    runId: string,
    taskId: string,
    role: Role,
    result: SessionResult,
    gatedTools: ReadonlySet<string>,
  ): void {
    this.#log.append({
      runId,
      type: 'SessionUsage',
      payload: {
        taskId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
      },
    });

    for (const denial of result.denials) {
      // Denials the gate already recorded are not repeated. What is left comes
      // from a layer below canUseTool -- a deny rule or a PreToolUse hook --
      // and still belongs in the audit trail.
      if (gatedTools.has(denial.tool)) {
        continue;
      }
      this.#log.append({
        runId,
        type: 'ToolCallLogged',
        payload: {
          taskId,
          tool: denial.tool,
          decision: 'denied',
          detail: denial.reason,
          outputBlob: null,
        },
      });
    }

    // Record the limit that was actually in force, not a placeholder: this
    // event is the audit trail for why a task stopped.
    if (result.termination === 'budget_exceeded') {
      this.#log.append({
        runId,
        type: 'BudgetExceeded',
        payload: {
          taskId,
          kind: 'cost',
          limit: role.budgets.costUsd,
          observed: result.usage.costUsd,
        },
      });
    } else if (result.termination === 'max_turns') {
      this.#log.append({
        runId,
        type: 'BudgetExceeded',
        payload: {
          taskId,
          kind: 'steps',
          limit: role.budgets.steps,
          observed: result.turns,
        },
      });
    } else if (result.termination === 'wall_clock') {
      this.#log.append({
        runId,
        type: 'BudgetExceeded',
        payload: {
          taskId,
          kind: 'wallClock',
          limit: role.budgets.wallClockSeconds,
          observed: role.budgets.wallClockSeconds,
        },
      });
    }
  }
}
