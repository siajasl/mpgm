import type { EventLog } from '../event/store.js';
import type { Role } from '../role/definition.js';
import { BudgetLedger, runWithWallClock, type Now } from './budget.js';
import type { OutputSchemaRegistry } from './output-registry.js';
import type { AgentSessionProvider, SessionRequest, SessionResult } from './session.js';

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
}

export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;

export class SessionRunner {
  readonly #log: EventLog;
  readonly #provider: AgentSessionProvider;
  readonly #schemas: OutputSchemaRegistry;
  readonly #maxAttempts: number;
  readonly #now: Now | undefined;

  constructor(options: SessionRunnerOptions) {
    this.#log = options.log;
    this.#provider = options.provider;
    this.#schemas = options.schemas;
    this.#maxAttempts = options.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS;
    this.#now = options.now;

    if (this.#maxAttempts < 1) {
      throw new Error('maxValidationAttempts must be at least 1');
    }
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

    let lastIssues: readonly string[] = [];
    // One ledger per task: retries share the budget, because three sessions
    // that each stay under the limit can still blow through it together.
    const ledger =
      this.#now === undefined
        ? new BudgetLedger(role.budgets)
        : new BudgetLedger(role.budgets, this.#now);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
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
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };

      const result = await runWithWallClock(
        (signal) => this.#provider.run({ ...sessionRequest, signal }),
        ledger.remainingSeconds,
      );
      ledger.record(result.usage, result.turns);
      this.#recordSession(runId, taskId, role, result);

      if (result.termination !== 'completed') {
        return {
          status: 'blocked',
          reason: `session terminated: ${result.termination}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
          attempts: attempt,
          lastIssues,
        };
      }

      const breach = ledger.breach();
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
        return {
          status: 'blocked',
          reason: `budget exceeded: ${breach.kind} (limit ${String(breach.limit)}, used ${String(breach.observed)})`,
          attempts: attempt,
          lastIssues,
        };
      }

      const parsed = schema.safeParse(result.structuredOutput);
      if (parsed.success) {
        this.#log.append({
          runId,
          type: 'TaskCompleted',
          payload: { taskId, artifactRefs: [] },
        });
        return { status: 'completed', output: parsed.data, attempts: attempt };
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

  #recordSession(runId: string, taskId: string, role: Role, result: SessionResult): void {
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
