import { describe, expect, it } from 'vitest';
import { errorDetailOf, gateHooks, terminationFor } from './claude-provider.js';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { ToolDecision, ToolGate } from './session.js';

/**
 * The SDK's result subtypes, translated once.
 *
 * Everything above the provider reasons about `SessionTermination`, so this
 * map is the only place that knows what the CLI calls things — and the only
 * place a new subtype can be quietly swallowed into `error`.
 */
describe('terminationFor', () => {
  it('separates a schema the model never satisfied from a session that broke', () => {
    // The one that matters: an abandoned structured output retries, and an
    // error does not. Collapsing them would make the retry either too eager
    // or absent (AGT-3).
    expect(terminationFor('error_max_structured_output_retries')).toBe('invalid_output');
    expect(terminationFor('error_during_execution')).toBe('error');
  });

  it('maps the exhaustion subtypes onto the budgets they exhausted', () => {
    expect(terminationFor('error_max_turns')).toBe('max_turns');
    expect(terminationFor('error_max_budget_usd')).toBe('budget_exceeded');
  });

  it('treats a subtype it has never seen as an error', () => {
    // Fails closed: a subtype added by a later SDK is not silently treated as
    // a completed session.
    expect(terminationFor('error_something_new')).toBe('error');
  });
});

describe('errorDetailOf', () => {
  it('carries what the SDK reported, so the cause is readable off the log', () => {
    expect(
      errorDetailOf('error_max_structured_output_retries', ['field `summary`: required']),
    ).toBe('error_max_structured_output_retries: field `summary`: required');
  });

  it('joins several reported errors rather than picking one', () => {
    expect(errorDetailOf('error_during_execution', ['first', 'second'])).toBe(
      'error_during_execution: first; second',
    );
  });

  it('still says something when the SDK reported no detail', () => {
    expect(errorDetailOf('error_max_turns', [])).toBe('error_max_turns');
    expect(errorDetailOf('error_max_turns', ['', '  '])).toBe('error_max_turns');
  });
});

/**
 * The hook is the whole of the kernel's presence inside a running session: it
 * is where a call is refused, where a credential is substituted, and the only
 * place the kernel can say something the session did not ask for.
 */
describe('gateHooks', () => {
  const call = async (gate: ToolGate): Promise<Record<string, unknown>> => {
    const hooks = gateHooks(gate).hooks;
    const callback = hooks?.PreToolUse[0]?.hooks[0];
    if (callback === undefined) {
      throw new Error('gateHooks installed no PreToolUse callback');
    }
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'call_1',
    } as unknown as PreToolUseHookInput;
    const output = await callback(input, undefined, {
      signal: new AbortController().signal,
    });
    return (output as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
  };

  it('carries a notice to the model as additional context', async () => {
    // `permissionDecisionReason` would not do: the CLI surfaces it on a
    // refusal, so an advisory sent that way is invisible on the allow it
    // belongs to.
    const decision: ToolDecision = { behavior: 'allow', notice: 'nearly out of steps' };
    const output = await call(() => Promise.resolve(decision));
    expect(output.permissionDecision).toBe('allow');
    expect(output.additionalContext).toBe('nearly out of steps');
  });

  it('sends no additional context when the kernel has nothing to add', async () => {
    const output = await call(() => Promise.resolve({ behavior: 'allow' }));
    expect(output).not.toHaveProperty('additionalContext');
  });

  it('carries a notice on a refusal alongside the reason for it', async () => {
    const output = await call(() =>
      Promise.resolve({
        behavior: 'deny',
        reason: 'path refused',
        notice: 'nearly out of steps',
      }),
    );
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toBe('path refused');
    expect(output.additionalContext).toBe('nearly out of steps');
  });
});
