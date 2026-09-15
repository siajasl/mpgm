/**
 * The boundary between the kernel and the Claude Agent SDK (ADR-5).
 *
 * The kernel talks to this port, never to `query()` directly. That keeps the
 * orchestration logic — validation, retry, budget accounting, event emission —
 * testable without live model calls, and it is also where a future non-SDK
 * execution path would attach.
 */

export interface SessionUsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface ToolDenial {
  readonly tool: string;
  readonly reason: string;
}

/**
 * Why a session stopped.
 *
 * `invalid_output` is a validation failure, not a broken session: the CLI
 * asked for structured output, kept getting output that did not satisfy the
 * schema, and gave up. It is distinguished from `error` because the two want
 * opposite treatment — a fresh session is a fresh sample and may well satisfy
 * the schema, whereas retrying an exhausted budget or a crashed process only
 * spends more to reach the same place.
 */
export type SessionTermination =
  | 'completed'
  | 'invalid_output'
  | 'max_turns'
  | 'budget_exceeded'
  | 'wall_clock'
  | 'error';

export interface SessionRequest {
  readonly model: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  /** JSON Schema the session's final output must satisfy (AGT-3). */
  readonly outputJsonSchema: Record<string, unknown>;
  /**
   * Working directory for the session. Must be the same root the path policy
   * resolves against, or a relative path means one thing to the agent and
   * another to the gate.
   */
  readonly cwd?: string;
  /**
   * Environment for the session's own process, replacing rather than
   * extending the kernel's (SAF-2). This is where credentials stop being
   * reachable by a shell: the value the broker scrubbed is not in the
   * environment `printenv` would print. Omitted means "inherit", which is
   * only right for a run with no secrets to lose.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Enforced outside the model (ADR-6, SAF-1). */
  readonly canUseTool?: ToolGate;
  readonly signal?: AbortSignal;
}

/**
 * Decision on a single tool call.
 *
 * `updatedInput` is how the secret broker substitutes a credential at the tool
 * boundary (SAF-2, ADR-6): the model wrote a symbolic reference, and the value
 * appears only in the call the tool actually receives. Absent means "as
 * supplied" — the gate rewriting input it did not mean to touch is a worse
 * failure than one that cannot rewrite at all.
 *
 * `notice` is the other direction: something the kernel knows and the session
 * does not, delivered on the back of a call it was making anyway. It never
 * changes the decision — a notice on a denial is still a denial — because the
 * moment it could, an advisory would be a policy no reader would find in the
 * policy.
 */
export type ToolDecision =
  | {
      readonly behavior: 'allow';
      readonly updatedInput?: Record<string, unknown>;
      readonly notice?: string;
    }
  | { readonly behavior: 'deny'; readonly reason: string; readonly notice?: string };

export type ToolGate = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolDecision>;

export interface SessionResult {
  readonly termination: SessionTermination;
  /** The session's final structured output, unvalidated. */
  readonly structuredOutput: unknown;
  readonly usage: SessionUsageReport;
  readonly turns: number;
  readonly denials: readonly ToolDenial[];
  readonly errorMessage: string;
  /**
   * Wall-clock length of the whole CLI session, in milliseconds — the SDK's
   * own `duration_ms`. This is the wider of the two readings: it includes
   * everything the harness itself does inside the session (the PreToolUse
   * policy gate, secret substitution, the `ToolCallLogged` append on every
   * tool call), not only the time the model spent working. Null means the
   * session ended in a way that never produced a number to report — a
   * pre-T4.2.8 log being replayed, or a session torn down before any result
   * message arrived — and is deliberately distinct from `0`: an unmeasured
   * session must not read as one that took no time (T4.2.8).
   */
  readonly durationMs: number | null;
  /**
   * Time actually spent waiting on the model API, in milliseconds — the
   * SDK's own `duration_api_ms`. The narrower reading: `durationMs -
   * apiDurationMs` is the harness's own overhead for the session (T4.2.9,
   * NFR-3), and charging the whole session as model time would understate
   * exactly the figure that bounds. Null for the same "unmeasured, not
   * zero" reasons as {@link durationMs}, and also whenever the harness force-
   * ended a session before it could say how much of its time was spent in
   * the API (`runWithWallClock`'s timeout, `src/agent/budget.ts`).
   */
  readonly apiDurationMs: number | null;
}

export interface AgentSessionProvider {
  run(request: SessionRequest): Promise<SessionResult>;
}
