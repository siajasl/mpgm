import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
  SessionTermination,
  ToolDenial,
  ToolGate,
} from './session.js';

/**
 * Adapter over the Claude Agent SDK (ADR-5).
 *
 * Everything model-facing lives here. The kernel above it sees only
 * {@link SessionResult}, so the SDK's message protocol cannot leak into
 * orchestration logic or into the event log's shape.
 */
export class ClaudeAgentProvider implements AgentSessionProvider {
  async run(request: SessionRequest): Promise<SessionResult> {
    const controller = new AbortController();
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', () => {
        controller.abort();
      });
    }

    const session = query({
      prompt: request.prompt,
      options: {
        model: request.model,
        systemPrompt: request.systemPrompt,
        // `tools` restricts which tools exist; `allowedTools` would AUTO-APPROVE
        // them, short-circuiting canUseTool before the path policy is consulted
        // (the SDK warns about exactly this). Least privilege at the tool level
        // here, per-call path enforcement at the gate.
        tools: [...request.allowedTools],
        maxTurns: request.maxTurns,
        maxBudgetUsd: request.maxBudgetUsd,
        outputFormat: { type: 'json_schema', schema: request.outputJsonSchema },
        // Nothing is inherited from the developer's own Claude Code settings:
        // a role's toolset is the whole of its permission (AGT-2).
        settingSources: [],
        abortController: controller,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        // Replaces the subprocess environment entirely rather than merging, so
        // a secret the broker scrubbed cannot come back through inheritance.
        ...(request.env === undefined ? {} : { env: { ...request.env } }),
        // Enforcement lives in PreToolUse, not canUseTool. canUseTool is only
        // consulted when the CLI decides a permission *prompt* is warranted,
        // and read-only tools never prompt -- so a Read would execute, and be
        // logged nowhere, without the gate ever running. PreToolUse fires for
        // every tool call whatever the permission mode.
        ...gateHooks(request.canUseTool),
        // Kept as a second layer for the prompting path.
        ...gateOption(request.canUseTool),
      },
    });

    for await (const message of session) {
      if (message.type !== 'result') {
        continue;
      }

      const denials: ToolDenial[] = message.permission_denials.map((denial) => ({
        tool: denial.tool_name,
        reason: 'denied by policy',
      }));

      // A 'success' subtype can still carry is_error — an auth failure returns
      // exactly that, with zero usage and no output. Trusting the subtype alone
      // makes an infrastructure failure look like a model that ignored its
      // schema, and the retry loop then burns its whole budget on it.
      if (message.subtype === 'success' && message.is_error) {
        return {
          termination: 'error',
          structuredOutput: undefined,
          usage: usageOf(message.total_cost_usd, message.usage),
          turns: message.num_turns,
          denials,
          errorMessage: message.result,
        };
      }

      if (message.subtype !== 'success') {
        return {
          termination: terminationFor(message.subtype),
          structuredOutput: undefined,
          usage: usageOf(message.total_cost_usd, message.usage),
          turns: message.num_turns,
          denials,
          errorMessage: message.subtype,
        };
      }

      return {
        termination: 'completed',
        structuredOutput: message.structured_output,
        usage: usageOf(message.total_cost_usd, message.usage),
        turns: message.num_turns,
        denials,
        errorMessage: '',
      };
    }

    return {
      termination: 'error',
      structuredOutput: undefined,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      turns: 0,
      denials: [],
      errorMessage: 'session ended without a result message',
    };
  }
}

/**
 * Install the kernel's tool gate as a PreToolUse hook.
 *
 * This is the authoritative enforcement point: it runs before every tool
 * execution, including tools the CLI would otherwise auto-approve without
 * consulting `canUseTool`.
 */
function gateHooks(gate: ToolGate | undefined): {
  hooks?: { PreToolUse: { hooks: HookCallback[] }[] };
} {
  if (gate === undefined) {
    return {};
  }

  const callback = async (input: HookInput): Promise<HookJSONOutput> => {
    const preToolUse = input as PreToolUseHookInput;
    const toolInput =
      typeof preToolUse.tool_input === 'object' && preToolUse.tool_input !== null
        ? (preToolUse.tool_input as Record<string, unknown>)
        : {};

    const decision = await gate(preToolUse.tool_name, toolInput);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.behavior === 'allow' ? 'allow' : 'deny',
        ...(decision.behavior === 'deny'
          ? { permissionDecisionReason: decision.reason }
          : {}),
        // Where the secret broker's substitution lands (SAF-2). PreToolUse is
        // the authoritative enforcement point, so it has to be the injection
        // point too — a value substituted anywhere earlier would have been in
        // the model's context on the way there.
        ...(decision.behavior === 'allow' && decision.updatedInput !== undefined
          ? { updatedInput: decision.updatedInput }
          : {}),
      },
    };
  };

  return { hooks: { PreToolUse: [{ hooks: [callback] }] } };
}

/**
 * Translate the kernel's tool gate into the SDK's `canUseTool` shape. Kept
 * separate so the narrowing happens once, outside the options literal.
 */
function gateOption(gate: ToolGate | undefined): {
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  >;
} {
  if (gate === undefined) {
    return {};
  }
  return {
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      const decision = await gate(toolName, input);
      return decision.behavior === 'allow'
        ? { behavior: 'allow' as const, updatedInput: decision.updatedInput ?? input }
        : { behavior: 'deny' as const, message: decision.reason };
    },
  };
}

function terminationFor(subtype: string): SessionTermination {
  switch (subtype) {
    case 'error_max_turns':
      return 'max_turns';
    case 'error_max_budget_usd':
      return 'budget_exceeded';
    default:
      return 'error';
  }
}

function usageOf(
  costUsd: number,
  usage: { input_tokens?: number; output_tokens?: number },
) {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUsd,
  };
}
