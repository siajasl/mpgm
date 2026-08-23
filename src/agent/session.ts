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

/** Why a session stopped. */
export type SessionTermination =
  'completed' | 'max_turns' | 'budget_exceeded' | 'wall_clock' | 'error';

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
  /** Enforced outside the model (ADR-6, SAF-1). */
  readonly canUseTool?: ToolGate;
  readonly signal?: AbortSignal;
}

/** Decision on a single tool call. */
export type ToolDecision =
  { readonly behavior: 'allow' } | { readonly behavior: 'deny'; readonly reason: string };

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
}

export interface AgentSessionProvider {
  run(request: SessionRequest): Promise<SessionResult>;
}
