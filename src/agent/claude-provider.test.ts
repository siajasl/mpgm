import { describe, expect, it } from 'vitest';
import { errorDetailOf, terminationFor } from './claude-provider.js';

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
