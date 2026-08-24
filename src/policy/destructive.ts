import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';
import { z } from 'zod';
import type { ToolDecision, ToolGate } from '../agent/session.js';
import type { RunState } from '../state/kernel-state.js';

/**
 * The destructive-operation guard (SAF-4, DESIGN section 7).
 *
 * SAF-4 asks that destructive operations be dry-run capable and that the
 * reversible path be preferred. Two different mechanisms follow, because two
 * different things are being guarded:
 *
 * - **Declared destructive operations** — a contract operation that deletes,
 *   deploys, releases or overwrites. These must be exercised as a dry run
 *   first, and then confirmed, before the real call is allowed. The dry run is
 *   what makes the confirmation meaningful: an operator asked to approve an
 *   action nobody has simulated is being asked to approve a description.
 * - **Shell commands with no reversible form.** There is no dry run to demand,
 *   so they are refused outright. An agent needing one of these has
 *   misunderstood its job: the kernel integrates changes, and a worktree is
 *   not somewhere to be deleting things from.
 *
 * **This is a guard, not a sandbox.** Pattern matching on a shell string is
 * evadable by anyone trying, and the containment ADR-6 relies on is the OS
 * sandbox underneath. What this stops is the far commoner case: an agent
 * reaching for a destructive command in good faith, or steered into one by
 * content it read.
 */

export class DestructiveGuardError extends Error {}

export const destructiveOperationSchema = z.object({
  /** Tool-name glob, e.g. `mcp__deploy__*`. */
  tool: z.string().min(1),
  /**
   * The input field that puts the tool into dry-run mode.
   *
   * Required, and there is no way to declare a destructive operation without
   * one: SAF-4 says destructive operations must be dry-run capable, so a tool
   * that cannot simulate itself is one the harness declines to call rather
   * than one it calls carefully.
   */
  dryRunParam: z.string().min(1),
  description: z.string().default(''),
});

export type DestructiveOperation = z.infer<typeof destructiveOperationSchema>;
export type DestructiveOperationInput = z.input<typeof destructiveOperationSchema>;

export interface ShellDenial {
  readonly name: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

/**
 * Shell commands refused outright.
 *
 * Each is either irreversible or is the kernel's job rather than an agent's.
 * Deliberately short: a long list reads as thorough and is not, since the
 * evasions are trivial either way, and every entry that fires on innocent work
 * teaches agents to route around the guard.
 */
export const DEFAULT_SHELL_DENIALS: readonly ShellDenial[] = [
  {
    name: 'recursive-force-delete',
    // Two lookaheads over the flag run, so `rm -r -f` is caught as well as
    // `rm -rf`. `rm -f` alone is not recursive and is left alone.
    pattern: /\brm\s+(?=(?:-\w+\s+)*-\w*[rR])(?=(?:-\w+\s+)*-\w*f)/,
    reason: 'a recursive force delete has no dry run and no undo',
  },
  {
    name: 'git-push',
    pattern: /\bgit\s+push(?:\s|$)/,
    reason:
      'the kernel integrates changes: commit on your branch and let the merge gate run (IMP-1)',
  },
  {
    name: 'privilege-escalation',
    pattern: /(?:^|[;&|]\s*)sudo\s/,
    reason: 'nothing a task needs requires elevated privileges',
  },
  {
    name: 'raw-device-write',
    pattern: /\b(?:dd\s+if=|mkfs\b)/,
    reason: 'writing raw devices is not recoverable',
  },
  {
    name: 'pipe-to-shell',
    pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/,
    reason: 'executing a downloaded script runs code nobody reviewed',
  },
  {
    name: 'publish',
    pattern: /\b(?:npm\s+publish|docker\s+push)\b/,
    reason: 'publishing is a release decision, taken through the release contract',
  },
];

/**
 * A stable identity for one call.
 *
 * Everything except the dry-run flag goes into it, so changing any parameter
 * needs a fresh dry run. That is the point: a confirmation is for the call
 * that was simulated, not for the operation in general — a deploy approved
 * once would otherwise approve every later deploy.
 */
export function fingerprint(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  dryRunParam: string,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== dryRunParam)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return value;
  };

  return createHash('sha256')
    .update(`${tool}${JSON.stringify(canonical(input))}`)
    .digest('hex');
}

export interface DryRunRecord {
  readonly tool: string;
  readonly fingerprint: string;
}

export interface ConfirmationRequest extends DryRunRecord {
  readonly reason: string;
}

export interface DestructiveGuardOptions {
  readonly operations?: readonly DestructiveOperationInput[];
  /** Defaults to {@link DEFAULT_SHELL_DENIALS}. */
  readonly shell?: readonly ShellDenial[];
  /** Which tool carries a shell command, and in which field. */
  readonly shellTools?: Readonly<Record<string, string>>;
  /** Has this exact call already been simulated? Read from folded state. */
  readonly dryRunSeen: (print: string) => boolean;
  /** Has an operator confirmed this exact call? */
  readonly confirmed: (print: string) => boolean;
  /** A dry run was allowed; the kernel records it. */
  readonly onDryRun?: (record: DryRunRecord) => void;
  /** A real call was refused for want of confirmation; the operator is asked. */
  readonly onConfirmationRequired?: (request: ConfirmationRequest) => void;
}

const DEFAULT_SHELL_TOOLS: Readonly<Record<string, string>> = { Bash: 'command' };

export class DestructiveGuard {
  readonly #operations: readonly DestructiveOperation[];
  readonly #shell: readonly ShellDenial[];
  readonly #shellTools: Readonly<Record<string, string>>;
  readonly #options: DestructiveGuardOptions;

  constructor(options: DestructiveGuardOptions) {
    this.#operations = (options.operations ?? []).map((operation) =>
      destructiveOperationSchema.parse(operation),
    );
    this.#shell = options.shell ?? DEFAULT_SHELL_DENIALS;
    this.#shellTools = options.shellTools ?? DEFAULT_SHELL_TOOLS;
    this.#options = options;
  }

  operationFor(toolName: string): DestructiveOperation | undefined {
    return this.#operations.find((operation) => matchesGlob(toolName, operation.tool));
  }

  /** The shell denial a command trips, if any. */
  shellDenialFor(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): ShellDenial | undefined {
    const field = this.#shellTools[toolName];
    const command = field === undefined ? undefined : input[field];
    if (typeof command !== 'string') {
      return undefined;
    }
    return this.#shell.find((rule) => rule.pattern.test(command));
  }

  decide(toolName: string, input: Readonly<Record<string, unknown>>): ToolDecision {
    const shell = this.shellDenialFor(toolName, input);
    if (shell !== undefined) {
      return {
        behavior: 'deny',
        reason: `'${shell.name}' is refused: ${shell.reason} (SAF-4)`,
      };
    }

    const operation = this.operationFor(toolName);
    if (operation === undefined) {
      return { behavior: 'allow' };
    }

    const print = fingerprint(toolName, input, operation.dryRunParam);
    if (input[operation.dryRunParam] === true) {
      this.#options.onDryRun?.({ tool: toolName, fingerprint: print });
      return { behavior: 'allow' };
    }

    if (!this.#options.dryRunSeen(print)) {
      return {
        behavior: 'deny',
        reason:
          `'${toolName}' is destructive and has not been simulated. Call it with ` +
          `${operation.dryRunParam}: true first, exactly as you mean to call it for ` +
          `real — any change to the other parameters needs its own dry run (SAF-4).`,
      };
    }

    if (!this.#options.confirmed(print)) {
      const reason =
        `'${toolName}' has been simulated but not confirmed. The operator decides ` +
        `whether the simulated effect is the intended one (SAF-4, HIL-2).`;
      this.#options.onConfirmationRequired?.({
        tool: toolName,
        fingerprint: print,
        reason,
      });
      return { behavior: 'deny', reason };
    }

    return { behavior: 'allow' };
  }

  /**
   * Wrap a gate. Runs *before* the inner gate so that a destructive call is
   * reported as destructive rather than as whatever else is also wrong with
   * it — which is the thing an operator reading the log needs to see.
   */
  gate(inner: ToolGate): ToolGate {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolDecision> => {
      const decision = this.decide(toolName, input);
      return decision.behavior === 'deny' ? decision : inner(toolName, input);
    };
  }
}

/**
 * The two predicates a guard needs, read from folded state.
 *
 * Read through a callback rather than captured once: a dry run recorded during
 * the same session must be visible to the call that follows it, and a
 * confirmation may arrive from the operator console while the session waits.
 */
export function stateLedger(run: () => RunState | undefined): {
  dryRunSeen: (print: string) => boolean;
  confirmed: (print: string) => boolean;
} {
  return {
    dryRunSeen: (print) => run()?.destructiveCalls[print]?.dryRun === true,
    confirmed: (print) => {
      const call = run()?.destructiveCalls[print];
      // Both, not either: an operator cannot approve their way past the
      // simulation SAF-4 asks for.
      return call?.dryRun === true && call.confirmedBy !== null;
    },
  };
}
