import type { EffectState } from '../state/kernel-state.js';

/**
 * How a contract's effects behave when a step is interrupted (DESIGN §6).
 *
 * - `checkable`   — the contract can ask whether the effect landed. Safest.
 * - `idempotent`  — re-running is harmless, so retry without asking.
 * - `compensatable` — the effect can be undone; resume undoes then retries.
 * - `manual`      — none of the above; only an operator can say what happened.
 */
export type EffectSemantics = 'checkable' | 'idempotent' | 'compensatable' | 'manual';

/** Enough of an intent to decide what happened to it. */
export interface EffectIntent {
  readonly intentId: string;
  readonly taskId: string;
  readonly contract: string;
  readonly operation: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export function intentOf(effect: EffectState): EffectIntent {
  return {
    intentId: effect.intentId,
    taskId: effect.taskId,
    contract: effect.contract,
    operation: effect.operation,
    params: effect.params,
  };
}

export interface EffectContract {
  readonly contract: string;
  readonly operation: string;
  readonly semantics: EffectSemantics;
  /**
   * Did this effect land? Required when semantics is `checkable`. Returning
   * false must mean "definitely did not happen" — a check that guesses is
   * worse than no check, because the kernel will retry on the strength of it.
   */
  readonly check?: (intent: EffectIntent) => Promise<boolean>;
  /** Undo a possibly-partial effect. Required when semantics is `compensatable`. */
  readonly compensate?: (intent: EffectIntent) => Promise<void>;
}

function keyOf(contract: string, operation: string): string {
  return `${contract}#${operation}`;
}

export class EffectContractRegistry {
  readonly #contracts: ReadonlyMap<string, EffectContract>;

  constructor(contracts: readonly EffectContract[]) {
    const map = new Map<string, EffectContract>();
    for (const contract of contracts) {
      const key = keyOf(contract.contract, contract.operation);
      if (map.has(key)) {
        throw new Error(`duplicate effect contract '${key}'`);
      }
      if (contract.semantics === 'checkable' && contract.check === undefined) {
        throw new Error(`contract '${key}' is checkable but declares no check`);
      }
      if (contract.semantics === 'compensatable' && contract.compensate === undefined) {
        throw new Error(`contract '${key}' is compensatable but declares no compensate`);
      }
      map.set(key, contract);
    }
    this.#contracts = map;
  }

  find(contract: string, operation: string): EffectContract | undefined {
    return this.#contracts.get(keyOf(contract, operation));
  }
}
