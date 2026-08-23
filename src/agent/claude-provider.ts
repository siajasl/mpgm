import { query } from '@anthropic-ai/claude-agent-sdk';
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
        allowedTools: [...request.allowedTools],
        maxTurns: request.maxTurns,
        maxBudgetUsd: request.maxBudgetUsd,
        outputFormat: { type: 'json_schema', schema: request.outputJsonSchema },
        // Nothing is inherited from the developer's own Claude Code settings:
        // a role's toolset is the whole of its permission (AGT-2).
        settingSources: [],
        abortController: controller,
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
        ? { behavior: 'allow' as const, updatedInput: input }
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
