import type { z } from 'zod';
import type { EffectSemantics } from '../effect/contract.js';

/**
 * MCP capability contracts (ADR-7, EXT-1, DESIGN §4.7).
 *
 * An integration is named by capability — `ci.checks`, `pm.github` — not by
 * vendor. The kernel calls the capability; a provider satisfies it. Two things
 * follow, and both are the point:
 *
 * - swapping GitHub Actions for another CI does not change a playbook, a role
 *   or a line of kernel code (EXT-2/3);
 * - every crossing of the boundary is validated in both directions, so a
 *   provider that returns something unexpected fails here rather than three
 *   layers downstream where the shape is assumed.
 *
 * The specification of each contract lives in `contracts/<name>.md`; this is
 * the machine-checkable half of the same thing.
 */

export class ContractError extends Error {}

/**
 * How an operation behaves when it is interrupted.
 *
 * `read-only` is separate from the {@link EffectSemantics} because it needs no
 * intent-before-effect bookkeeping at all (DESIGN §6): asking CI what it
 * thinks changes nothing, so a crash mid-question costs nothing but the
 * question.
 */
export type OperationEffects = EffectSemantics | 'read-only';

export interface OperationSpec<I = unknown, O = unknown> {
  readonly name: string;
  readonly summary: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly effects: OperationEffects;
}

export interface ContractSpec {
  /** Capability name, e.g. `ci.checks`. */
  readonly name: string;
  readonly summary: string;
  readonly operations: readonly OperationSpec[];
}

/** What a provider must supply: one handler per declared operation. */
export type Provider = Readonly<Record<string, (input: never) => Promise<unknown>>>;

/**
 * A contract bound to a provider.
 *
 * Construction is where a provider that does not implement the contract is
 * caught — at wiring time, not at the first call in the middle of a run.
 */
export class BoundContract {
  readonly #spec: ContractSpec;
  readonly #provider: Provider;
  readonly #operations: ReadonlyMap<string, OperationSpec>;

  constructor(spec: ContractSpec, provider: Provider) {
    const operations = new Map<string, OperationSpec>();
    for (const operation of spec.operations) {
      if (operations.has(operation.name)) {
        throw new ContractError(
          `contract '${spec.name}' declares '${operation.name}' twice`,
        );
      }
      if (typeof provider[operation.name] !== 'function') {
        throw new ContractError(
          `provider for '${spec.name}' does not implement '${operation.name}'`,
        );
      }
      operations.set(operation.name, operation);
    }
    this.#spec = spec;
    this.#provider = provider;
    this.#operations = operations;
  }

  get name(): string {
    return this.#spec.name;
  }

  operation(name: string): OperationSpec | undefined {
    return this.#operations.get(name);
  }

  /**
   * Call an operation, validating input on the way in and output on the way
   * back.
   *
   * Output validation is not ceremony: a provider is somebody else's process
   * reached over MCP, and the kernel decides whether to merge on what it says.
   */
  async invoke<O = unknown>(name: string, input: unknown): Promise<O> {
    const operation = this.#operations.get(name);
    if (operation === undefined) {
      throw new ContractError(`contract '${this.#spec.name}' has no operation '${name}'`);
    }
    const parsedInput = operation.input.safeParse(input);
    if (!parsedInput.success) {
      throw new ContractError(
        `${this.#spec.name}#${name}: input rejected — ${parsedInput.error.message}`,
      );
    }
    const handler = this.#provider[name];
    if (handler === undefined) {
      throw new ContractError(`provider for '${this.#spec.name}' lost '${name}'`);
    }
    const raw: unknown = await handler(parsedInput.data as never);
    const parsedOutput = operation.output.safeParse(raw);
    if (!parsedOutput.success) {
      throw new ContractError(
        `${this.#spec.name}#${name}: provider returned something the contract does not allow — ${parsedOutput.error.message}`,
      );
    }
    return parsedOutput.data as O;
  }
}

/** Capability name → bound contract, resolved per project (ADR-7). */
export class CapabilityRegistry {
  readonly #bound = new Map<string, BoundContract>();

  bind(spec: ContractSpec, provider: Provider): BoundContract {
    if (this.#bound.has(spec.name)) {
      throw new ContractError(`capability '${spec.name}' is already bound`);
    }
    const bound = new BoundContract(spec, provider);
    this.#bound.set(spec.name, bound);
    return bound;
  }

  /**
   * The provider for a capability.
   *
   * Throws rather than returning undefined: a caller reaching for `ci.checks`
   * on a project that has none must stop, not carry on as though the checks
   * had passed.
   */
  require(name: string): BoundContract {
    const bound = this.#bound.get(name);
    if (bound === undefined) {
      throw new ContractError(`no provider is bound for capability '${name}'`);
    }
    return bound;
  }

  has(name: string): boolean {
    return this.#bound.has(name);
  }

  names(): string[] {
    return [...this.#bound.keys()].sort();
  }
}
