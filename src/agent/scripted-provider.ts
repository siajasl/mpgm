import type { AgentSessionProvider, SessionRequest, SessionResult } from './session.js';

/**
 * A provider that replays scripted results.
 *
 * The kernel's job — validating, retrying, recording — is orchestration, and
 * orchestration is exactly what a live model call makes untestable: slow,
 * costly, and non-deterministic. This double makes the retry loop assertable;
 * the live path is exercised by the M1.2 demo instead.
 */
export class ScriptedProvider implements AgentSessionProvider {
  readonly #results: SessionResult[];
  readonly #requests: SessionRequest[] = [];

  constructor(results: readonly SessionResult[]) {
    this.#results = [...results];
  }

  /** Every request the runner made, in order. */
  get requests(): readonly SessionRequest[] {
    return this.#requests;
  }

  run(request: SessionRequest): Promise<SessionResult> {
    this.#requests.push(request);
    const next = this.#results.shift();
    if (next === undefined) {
      throw new Error('ScriptedProvider ran out of scripted results');
    }
    return Promise.resolve(next);
  }
}

/** A successful session returning `output`. */
export function scriptedSuccess(
  output: unknown,
  overrides: Partial<SessionResult> = {},
): SessionResult {
  return {
    termination: 'completed',
    structuredOutput: output,
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    turns: 1,
    denials: [],
    errorMessage: '',
    ...overrides,
  };
}
