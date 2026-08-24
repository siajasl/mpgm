import {
  approve,
  chat,
  intervene,
  reopen,
  replay,
  run,
  status,
  trace,
  type CliContext,
  type CommandResult,
} from './commands.js';

/**
 * Argument parsing for the operator console (DESIGN §4.4).
 *
 * Deliberately small: eleven verbs and a handful of flags. A CLI framework would
 * be more than this needs, and every dependency here is one the operator has
 * to trust.
 */

export const VERBS = [
  'run',
  'status',
  'pause',
  'resume',
  'kill',
  'redirect',
  'approve',
  'reopen',
  'chat',
  'trace',
  'replay',
] as const;

export type Verb = (typeof VERBS)[number];

export const USAGE = `mpgm — agentic SDLC harness

  mpgm run <phase> [--run <id>]        execute a phase and present its gate
  mpgm status [--run <id>]             folded state of a run
  mpgm pause --run <id>                stop dispatching new tasks
  mpgm resume --run <id>               resume a paused run
  mpgm kill --run <id>                 stop a run permanently
  mpgm redirect --run <id> --note <s>  record an operator redirection
  mpgm approve <gate> --run <id> --by <who> [--reject --reason <s>] [--tag]
  mpgm reopen <phase> --run <id> --reason <s> [--changed <id,id>] [--dry-run]
  mpgm chat <phase> [--run <id>] [--brief <s>]
  mpgm trace <id> | --coverage | --dangling
  mpgm replay [--run <id>]             re-derive state from the log alone
`;

interface ParsedArgs {
  readonly verb: string | undefined;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = 'true';
      } else {
        flags[name] = next;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }

  return { verb: positional[0], positional: positional.slice(1), flags };
}

export async function runCli(
  argv: readonly string[],
  context: CliContext,
): Promise<CommandResult> {
  const { verb, positional, flags } = parseArgs(argv);
  const runId = flags.run ?? 'run-1';

  const require = (what: string, value: string | undefined): string => {
    if (value === undefined || value === '') {
      throw new Error(`${String(verb)}: ${what} is required\n\n${USAGE}`);
    }
    return value;
  };

  switch (verb) {
    case 'run':
      return run(context, runId, require('a phase name', positional[0]));

    case 'status':
      return status(context, flags.run);

    case 'pause':
    case 'resume':
    case 'kill':
      return intervene(context, runId, verb);

    case 'redirect':
      return intervene(context, runId, 'redirect', require('--note', flags.note));

    case 'approve':
      return approve(
        context,
        runId,
        require('a gate id', positional[0]),
        require('--by', flags.by),
        flags.reject === 'true',
        flags.reason ?? '',
        flags.tag === 'true',
      );

    case 'reopen':
      return reopen(
        context,
        runId,
        require('a phase name', positional[0]),
        require('--reason', flags.reason),
        (flags.changed ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
        flags['dry-run'] === 'true',
      );

    case 'chat':
      return chat(
        context,
        runId,
        require('a phase name', positional[0]),
        flags.brief ?? '',
      );

    case 'trace':
      return trace(
        context,
        positional[0],
        flags.coverage === 'true'
          ? 'coverage'
          : flags.dangling === 'true'
            ? 'dangling'
            : 'node',
      );

    case 'replay':
      return replay(context, flags.run);

    case undefined:
    case 'help':
    case '--help':
      context.write(USAGE);
      return { ok: true, detail: 'usage' };

    default:
      context.write(`unknown verb '${verb}'\n\n${USAGE}`);
      return { ok: false, detail: 'unknown verb' };
  }
}
