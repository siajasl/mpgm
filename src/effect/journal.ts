import { randomUUID } from 'node:crypto';
import type { EventLog } from '../event/store.js';
import type { EffectState, KernelState } from '../state/kernel-state.js';
import { pendingEffects } from '../state/reduce.js';
import { intentOf, type EffectContractRegistry, type EffectIntent } from './contract.js';

/**
 * What resume decided about an interrupted effect.
 *
 * `safe-to-retry` is a claim about the world, not about convenience: it means
 * the effect provably did not happen, or happening twice is harmless.
 */
export type Resolution = 'already-landed' | 'safe-to-retry' | 'needs-operator';

export interface ResolutionReport {
  readonly intentId: string;
  readonly resolution: Resolution;
  readonly detail: string;
}

export interface EffectRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly contract: string;
  readonly operation: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface EffectJournalOptions {
  readonly log: EventLog;
  readonly contracts: EffectContractRegistry;
  /** Injectable so tests get stable intent ids. */
  readonly newIntentId?: () => string;
}

/**
 * Writes intents before effects and resolves whatever was left pending by a
 * crash (DESIGN §6).
 */
export class EffectJournal {
  readonly #log: EventLog;
  readonly #contracts: EffectContractRegistry;
  readonly #newIntentId: () => string;

  constructor(options: EffectJournalOptions) {
    this.#log = options.log;
    this.#contracts = options.contracts;
    this.#newIntentId = options.newIntentId ?? ((): string => randomUUID());
  }

  /**
   * Record the intention, perform the effect, record the outcome.
   *
   * The ordering is the whole point: the `EffectIntended` event is durable
   * before `execute` is called, so a crash at any moment afterwards leaves a
   * pending intent rather than silence.
   */
  async perform<T>(
    request: EffectRequest,
    execute: (intent: EffectIntent) => Promise<T>,
  ): Promise<T> {
    const intentId = this.#newIntentId();
    const params = request.params ?? {};

    this.#log.append({
      runId: request.runId,
      type: 'EffectIntended',
      payload: {
        intentId,
        taskId: request.taskId,
        contract: request.contract,
        operation: request.operation,
        params,
      },
    });

    const intent: EffectIntent = {
      intentId,
      taskId: request.taskId,
      contract: request.contract,
      operation: request.operation,
      params,
    };

    let result: T;
    try {
      result = await execute(intent);
    } catch (cause) {
      this.#log.append({
        runId: request.runId,
        type: 'EffectFailed',
        payload: {
          intentId,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      });
      throw cause;
    }

    this.#log.append({
      runId: request.runId,
      type: 'EffectCompleted',
      payload: { intentId, outcome: 'executed' },
    });

    return result;
  }

  /** Effects whose intention is recorded but whose outcome is unknown. */
  pending(state: KernelState): EffectState[] {
    return pendingEffects(state);
  }

  /**
   * Decide the fate of every pending intent and record it.
   *
   * Anything the contract cannot answer confidently is escalated rather than
   * retried. Retrying an effect that already landed is the failure this whole
   * mechanism exists to prevent, so ambiguity resolves towards asking a human.
   */
  async resolvePending(state: KernelState): Promise<ResolutionReport[]> {
    const reports: ResolutionReport[] = [];

    for (const effect of this.pending(state)) {
      const report = await this.#resolveOne(effect);
      reports.push(report);

      const runId = this.#runIdFor(state, effect.intentId);
      if (report.resolution === 'already-landed') {
        this.#log.append({
          runId,
          type: 'EffectCompleted',
          payload: { intentId: effect.intentId, outcome: report.detail },
        });
      } else if (report.resolution === 'safe-to-retry') {
        this.#log.append({
          runId,
          type: 'EffectFailed',
          payload: { intentId: effect.intentId, reason: report.detail },
        });
      } else {
        this.#log.append({
          runId,
          type: 'EffectEscalated',
          payload: { intentId: effect.intentId, reason: report.detail },
        });
      }
    }

    return reports;
  }

  async #resolveOne(effect: EffectState): Promise<ResolutionReport> {
    const intentId = effect.intentId;
    const contract = this.#contracts.find(effect.contract, effect.operation);

    if (contract === undefined) {
      return {
        intentId,
        resolution: 'needs-operator',
        detail: `no contract registered for '${effect.contract}#${effect.operation}'`,
      };
    }

    switch (contract.semantics) {
      case 'checkable': {
        if (contract.check === undefined) {
          return {
            intentId,
            resolution: 'needs-operator',
            detail: 'checkable but no check',
          };
        }
        try {
          const landed = await contract.check(intentOf(effect));
          return landed
            ? { intentId, resolution: 'already-landed', detail: 'effect-check: landed' }
            : {
                intentId,
                resolution: 'safe-to-retry',
                detail: 'effect-check: did not land',
              };
        } catch (cause) {
          // A check that threw told us nothing. Guessing here would risk a
          // double deploy, so the operator decides.
          return {
            intentId,
            resolution: 'needs-operator',
            detail: `effect-check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
      }

      case 'idempotent':
        return {
          intentId,
          resolution: 'safe-to-retry',
          detail: 'idempotent: retry is harmless',
        };

      case 'compensatable': {
        if (contract.compensate === undefined) {
          return {
            intentId,
            resolution: 'needs-operator',
            detail: 'compensatable but no compensate',
          };
        }
        try {
          await contract.compensate(intentOf(effect));
          return {
            intentId,
            resolution: 'safe-to-retry',
            detail: 'compensated, retry is safe',
          };
        } catch (cause) {
          return {
            intentId,
            resolution: 'needs-operator',
            detail: `compensation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
      }

      case 'manual':
        return {
          intentId,
          resolution: 'needs-operator',
          detail: 'contract declares no way to tell whether the effect landed',
        };
    }
  }

  #runIdFor(state: KernelState, intentId: string): string {
    for (const [runId, run] of Object.entries(state.runs)) {
      if (run.effects[intentId] !== undefined) {
        return runId;
      }
    }
    throw new Error(`no run holds intent '${intentId}'`);
  }
}
