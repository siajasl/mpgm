import {
  approve,
  approveRole,
  attest,
  chat,
  confirm,
  defect,
  implement,
  intervene,
  recordMerge,
  reopen,
  replay,
  rollback,
  run,
  serve,
  status,
  trace,
  type CliContext,
  type CommandResult,
} from './commands.js';
import { defectSeverities, type DefectSeverity } from '../test/defect.js';

/**
 * Argument parsing for the operator console (DESIGN §4.4).
 *
 * Deliberately small: nineteen verbs and a handful of flags. A CLI framework would
 * be more than this needs, and every dependency here is one the operator has
 * to trust.
 */

export const VERBS = [
  'run',
  'status',
  'serve',
  'pause',
  'resume',
  'kill',
  'redirect',
  'approve',
  'approve-role',
  'attest',
  'confirm',
  'implement',
  'record-merge',
  'reopen',
  'chat',
  'defect',
  'trace',
  'replay',
  'rollback',
] as const;

export type Verb = (typeof VERBS)[number];

export const USAGE = `mpgm — agentic SDLC harness

  mpgm run <phase> [--run <id>] [--repo <owner/name>] [--ref <ref>]
    [--test-project-dir <path>] [--defect-severity <critical|high|medium|low>]
                                        execute a phase and present its gate
    --repo/--ref are what an 'nfr' node's test.nfr measurements report against;
    --test-project-dir is where a 'suite' node runs its generated tests, and is
    never defaulted — the cases are agent-authored code (TST-4); --defect-severity
    is what a filed defect is given — neither producer carries one of its own (T4.3.4)
  mpgm status [--run <id>] [--metrics] [--rates]
    folded state of a run, with cost/tokens/latency/retry/success per phase, role and run and
    harness overhead against NFR-3's 10% threshold (context assembly only, merged over
    instrumented tasks; scheduling and validation not observed; non-API session time reported
    separately and excluded from the ratio) on --metrics, and phase-gate/merge-gate/rework/
    escaped-defect rates on --rates (OBS-4)
  mpgm serve [--port <n>]              live dashboard over that state, until ctrl-c
  mpgm pause --run <id>                stop dispatching new tasks
  mpgm resume --run <id>               resume a paused run
  mpgm kill --run <id>                 stop a run permanently
  mpgm redirect <task> --run <id> --note <s>  record an operator redirection, read by
    that task's next dispatched session
  mpgm approve <gate> --run <id> --by <who> [--reject --reason <s>] [--tag]
  mpgm confirm <fingerprint> --run <id> --by <who> [--reason <s>]
  mpgm attest <task> --by <who> --evidence <s> [--note <s>] [--run <id>]
  mpgm approve-role <role> --digest <d> --by <who> --reason <s> [--run <id>]
  mpgm implement <task> --repo <owner/name> [--into <path>] [--run <id>]
  mpgm record-merge <task> --commit <sha> --by <who> [--reason <s>] [--repo <path>]
    [--into <branch>] [--branch <b>] [--remote <name>] [--run <id>]
    record a merge an operator performed by hand (e.g. a pull request merged on GitHub)
    after the implement loop abandoned the task on a budget; verified against the
    repository before anything is recorded (T4.2.15)
  mpgm reopen <phase> --run <id> --reason <s> [--changed <id,id>] [--dry-run]
  mpgm chat <phase> [--run <id>] [--brief <s>]
  mpgm defect route <id> --to implement --task <t> --by <who> --reason <s>
  mpgm defect route <id> --to design --phase <p> [--changed <id,id>] --by <who> --reason <s>
  mpgm defect fix <id> --ref <sha|node> --summary <s> --by <who>
    route a filed defect back through Implement or Design, or record the fix that
    route produced (TST-5, ORC-1). The kernel files and re-tests defects; where one
    belongs is an operator call, made on the evidence this verb prints first. There
    is no 'verify': a defect closes when the suite that caught it passes again
  mpgm trace <id> | --coverage | --dangling
  mpgm replay [--run <id>]             re-derive state from the log alone
  mpgm rollback <env> --to-version <v> --to-image <img> --to-digest <sha256:...>
    --to-changelog <s> [--to-rollback-version <v> --to-rollback-digest <sha256:...>
    | --to-first-release] --by <who> [--repo <path>] [--reason <s>] [--run <id>]
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

  // `--repo` on `rollback` is optional — it falls back to `context.root` —
  // but an empty value given anyway (`--repo ""`) is not "not given"; it is
  // a path that would otherwise reach `loadDeclaredEnvironments('')` and,
  // once past that, the `repo: nonEmpty` event schema, surfacing as an
  // uncaught `EventValidationError` naming the schema rather than the flag
  // the operator typed (CONV-3). Caught here, the same way `require` catches
  // it for flags that have no default at all.
  const optional = (what: string, value: string | undefined): string | undefined => {
    if (value === '') {
      throw new Error(`${String(verb)}: ${what} must not be empty\n\n${USAGE}`);
    }
    return value;
  };

  switch (verb) {
    case 'run': {
      // Passed through only where given: `runPhase` blocks the step that
      // needed one rather than measuring a guessed repo or running generated
      // tests somewhere nobody named (T4.3.2).
      const repo = optional('--repo', flags.repo);
      const ref = optional('--ref', flags.ref);
      const testProjectDir = optional('--test-project-dir', flags['test-project-dir']);
      const defectSeverityFlag = optional('--defect-severity', flags['defect-severity']);
      if (
        defectSeverityFlag !== undefined &&
        !defectSeverities.includes(defectSeverityFlag as DefectSeverity)
      ) {
        throw new Error(
          `run: --defect-severity must be one of ${defectSeverities.join(', ')}, got ` +
            `'${defectSeverityFlag}'\n\n${USAGE}`,
        );
      }
      return run(context, runId, require('a phase name', positional[0]), {
        ...(repo === undefined ? {} : { repo }),
        ...(ref === undefined ? {} : { ref }),
        ...(testProjectDir === undefined ? {} : { testProjectDir }),
        ...(defectSeverityFlag === undefined
          ? {}
          : { defectSeverity: defectSeverityFlag as DefectSeverity }),
      });
    }

    case 'status':
      return status(context, flags.run, {
        metrics: flags.metrics === 'true',
        rates: flags.rates === 'true',
      });

    case 'serve':
      return serve(context, flags.port);

    case 'pause':
    case 'resume':
    case 'kill':
      return intervene(context, runId, verb);

    case 'redirect':
      return intervene(
        context,
        runId,
        'redirect',
        require('--note', flags.note),
        require('a task id', positional[0]),
      );

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

    case 'confirm':
      return confirm(
        context,
        runId,
        require('a call fingerprint', positional[0]),
        require('--by', flags.by),
        flags.reason ?? '',
      );

    case 'implement':
      return implement(
        context,
        runId,
        require('a task id', positional[0]),
        require('--repo', flags.repo),
        flags.into,
      );

    case 'record-merge':
      return recordMerge(
        context,
        runId,
        require('a task id', positional[0]),
        require('--commit', flags.commit),
        require('--by', flags.by),
        flags.reason ?? '',
        optional('--repo', flags.repo),
        flags.into ?? 'main',
        optional('--branch', flags.branch),
        optional('--remote', flags.remote),
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

    case 'defect': {
      const action = require("'route' or 'fix'", positional[0]);
      if (action !== 'route' && action !== 'fix') {
        throw new Error(`defect: expected 'route' or 'fix', got '${action}'\n\n${USAGE}`);
      }
      const to = optional('--to', flags.to);
      if (to !== undefined && to !== 'implement' && to !== 'design') {
        throw new Error(
          `defect route: --to must be 'implement' or 'design', got '${to}'\n\n${USAGE}`,
        );
      }
      return defect(context, action, require('a defect id', positional[1]), {
        by: require('--by', flags.by),
        ...(to === undefined ? {} : { to }),
        ...(flags.task === undefined ? {} : { taskId: flags.task }),
        ...(flags.phase === undefined ? {} : { phase: flags.phase }),
        changed: (flags.changed ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
        ...(flags.reason === undefined ? {} : { reason: flags.reason }),
        ...(flags.ref === undefined ? {} : { ref: flags.ref }),
        ...(flags.summary === undefined ? {} : { summary: flags.summary }),
      });
    }

    case 'chat':
      return chat(
        context,
        runId,
        require('a phase name', positional[0]),
        flags.brief ?? '',
      );

    case 'approve-role':
      return approveRole(
        context,
        runId,
        require('a role name', positional[0]),
        require('--digest', flags.digest),
        require('--by', flags.by),
        require('--reason', flags.reason),
      );

    case 'attest':
      return attest(
        context,
        runId,
        require('a task id', positional[0]),
        require('--by', flags.by),
        require('--evidence', flags.evidence),
        flags.note ?? '',
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

    case 'rollback': {
      const rollbackVersion = flags['to-rollback-version'];
      const rollbackDigest = flags['to-rollback-digest'];
      const firstRelease = flags['to-first-release'] === 'true';
      if (
        firstRelease &&
        (rollbackVersion !== undefined || rollbackDigest !== undefined)
      ) {
        throw new Error(
          `rollback: --to-first-release and --to-rollback-version/` +
            `--to-rollback-digest are mutually exclusive\n\n${USAGE}`,
        );
      }
      if (
        !firstRelease &&
        (rollbackVersion === undefined) !== (rollbackDigest === undefined)
      ) {
        throw new Error(
          `rollback: --to-rollback-version and --to-rollback-digest must be ` +
            `given together\n\n${USAGE}`,
        );
      }
      if (!firstRelease && rollbackVersion === undefined) {
        throw new Error(
          `rollback: state what --to-version rolls back to, with ` +
            `--to-rollback-version/--to-rollback-digest, or assert it is this ` +
            `environment's first release with --to-first-release\n\n${USAGE}`,
        );
      }
      const rollbackTo = firstRelease
        ? null
        : {
            version: require('--to-rollback-version', rollbackVersion),
            digest: require('--to-rollback-digest', rollbackDigest),
          };
      return rollback(
        context,
        runId,
        require('an environment name', positional[0]),
        optional('--repo', flags.repo) ?? context.root,
        {
          version: require('--to-version', flags['to-version']),
          image: require('--to-image', flags['to-image']),
          digest: require('--to-digest', flags['to-digest']),
          changelog: require('--to-changelog', flags['to-changelog']),
          rollbackTo,
        },
        require('--by', flags.by),
        flags.reason ?? '',
      );
    }

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
