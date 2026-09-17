import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import type { Provider } from '../contract/capability.js';
import type { NfrRunInput, NfrRunOutput } from './nfr.js';

/**
 * `test.nfr` over measurement commands a project declares for itself
 * (`contracts/test.nfr.md`, TST-3, DESIGN §4.7).
 *
 * The whole provider is a translation, the same shape as
 * `../env/compose-provider.ts` and `../implement/github-checks.ts`: it runs
 * what the project says measures a requirement, reads the number that command
 * printed, and answers the one question the contract reserves to a provider —
 * did this measurement hold. Nothing here decides coverage; that is
 * `nfrCoverage` in `./nfr.ts`, and it is the same decision whichever provider
 * answered.
 *
 * Two things it deliberately does not do. It does not infer the command from
 * SCP-1's `measuredBy`: that field is prose a human wrote ("k6 load test"),
 * and turning prose into an argv is guessing. And it does not infer whether a
 * threshold is a ceiling or a floor — the contract says in as many words that
 * a latency threshold and a throughput threshold read the same number in
 * opposite directions and that the provider is the thing that knows which, so
 * `direction` is declared per measurement and has no default (CONV-5: a
 * manifest cannot decline to say which it means).
 */

export class NfrProviderError extends Error {}

const measurementSchema = z
  .object({
    /** The requirement id this measures — SCP-1's own id, e.g. `NFR-1`. */
    requirement: z.string().min(1),
    /**
     * The metric it measures, checked against the threshold the kernel sends.
     * Declared rather than assumed: a manifest entry that has drifted from
     * the requirement it names is measuring something else under the right
     * id, which is the ambiguity `NfrMismatchError` refuses at the other end
     * of the same call (CONV-4).
     */
    metric: z.string().min(1),
    /** Checked the same way and for the same reason: 900 ms is not 900 rps. */
    unit: z.string().min(1),
    /** Whether the threshold is a ceiling (`at-most`) or a floor (`at-least`). */
    direction: z.enum(['at-most', 'at-least']),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /**
     * What to cite as evidence — a report path, a dashboard link. Optional;
     * where it is absent the command line itself is cited, because
     * `nfrRunOutput.evidence` treats an unlinked verdict as worth less than a
     * linked one, never as a reason to withhold the verdict.
     */
    evidence: z.string().min(1).optional(),
  })
  .strict();

export type NfrMeasurement = z.infer<typeof measurementSchema>;

const manifestSchema = z.object({
  measurements: z.array(measurementSchema).min(1),
});

export const DEFAULT_NFR_MANIFEST_PATH = join('test', 'nfr.yaml');

/**
 * The measurements a project declares.
 *
 * Every error names the manifest path and what was wrong with it: an operator
 * whose Test phase blocked should not have to read this module to find out
 * what the file was supposed to contain (CONV-3).
 */
export function loadDeclaredMeasurements(
  root: string,
  manifestPath: string = DEFAULT_NFR_MANIFEST_PATH,
): readonly NfrMeasurement[] {
  const full = join(root, manifestPath);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (cause) {
    throw new NfrProviderError(
      `no NFR measurement manifest at '${manifestPath}' under '${root}': ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Declare one ` +
        `measurement per quantified requirement — ` +
        `'measurements: [{requirement, metric, unit, direction, command, args}]' ` +
        `— since a threshold nobody said how to run cannot be measured, and is ` +
        `reported unverified rather than assumed to hold (TST-3).`,
      { cause },
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    const where =
      cause instanceof YAMLParseError && cause.linePos !== undefined
        ? ` at line ${String(cause.linePos[0].line)}`
        : '';
    throw new NfrProviderError(
      `'${manifestPath}' is not valid YAML${where}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NfrProviderError(`'${manifestPath}' is malformed: ${parsed.error.message}`);
  }
  return parsed.data.measurements;
}

export interface CommandNfrProviderOptions {
  /** Project root the manifest is read from and the commands are run in. */
  readonly root: string;
  readonly manifestPath?: string;
  /** Wall-clock bound on one measurement. */
  readonly timeoutMs?: number;
}

const run = promisify(execFile);

/** Ten minutes: a load test is not a unit test, but it is not unbounded either. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * The number a measurement command reported: the last non-empty line of its
 * stdout, parsed as a number.
 *
 * The last line rather than the whole of stdout, because a real measurement
 * tool prints progress before its result; and refused rather than coerced,
 * because `Number('')` is 0 and a command that printed nothing would
 * otherwise measure as zero — which passes every `at-most` threshold there is
 * (CONV-4).
 */
function measurementFrom(
  requirementId: string,
  commandLine: string,
  stdout: string,
): number {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .at(-1);
  if (line === undefined) {
    throw new NfrProviderError(
      `measuring '${requirementId}' with '${commandLine}' printed nothing to ` +
        `stdout; the last non-empty line must be the measured value, and an ` +
        `empty reading is refused rather than read as zero (CONV-4)`,
    );
  }
  const measured = Number(line);
  if (!Number.isFinite(measured)) {
    throw new NfrProviderError(
      `measuring '${requirementId}' with '${commandLine}' printed '${line}' as its ` +
        `last stdout line, which is not a number; the command must print the ` +
        `measured value and nothing after it`,
    );
  }
  return measured;
}

/**
 * Bind `test.nfr` to the commands a project declares in its own manifest.
 *
 * This is what `mpgm run` binds, so an `nfr` playbook node reaches a real
 * measurement from the only entry point the kernel has — before T4.3.2 the
 * contract had a specification, a runner and no provider at all, which left
 * the NFR half of the Test phase with nothing to execute it.
 *
 * Every refusal throws rather than returning a failing measurement. A
 * requirement this provider cannot measure has *not* been measured and found
 * wanting: reporting `passed: false` for it would put a below-threshold row
 * in the coverage report for a threshold nothing ever ran, and reporting
 * `passed: true` is worse. Throwing blocks the step, which is how the kernel
 * already treats a capability it cannot reach (CONV-4), and `nfrCoverage`
 * reports a requirement nothing reported on as `not-run`.
 */
export function commandNfrProvider(options: CommandNfrProviderOptions): Provider {
  return {
    run: async (input: NfrRunInput): Promise<NfrRunOutput> => {
      const declared = loadDeclaredMeasurements(options.root, options.manifestPath);
      const measurement = declared.find(
        (entry) => entry.requirement === input.requirementId,
      );
      if (measurement === undefined) {
        throw new NfrProviderError(
          `'${options.manifestPath ?? DEFAULT_NFR_MANIFEST_PATH}' declares no ` +
            `measurement for requirement '${input.requirementId}'; it declares: ` +
            `${declared.map((entry) => entry.requirement).join(', ')}. A provider ` +
            `must not invent a measurement for a requirement it did not run ` +
            `(contracts/test.nfr.md).`,
        );
      }
      if (measurement.metric !== input.metric || measurement.unit !== input.unit) {
        throw new NfrProviderError(
          `'${input.requirementId}' is declared as ${measurement.metric} in ` +
            `${measurement.unit}, but the threshold to measure against is ` +
            `${input.metric} in ${input.unit}. Refusing to report one as the other: ` +
            `a manifest that has drifted from the requirement it names measures ` +
            `something else under the right id (CONV-4).`,
        );
      }

      const commandLine = [measurement.command, ...measurement.args].join(' ');
      let stdout: string;
      try {
        ({ stdout } = await run(measurement.command, [...measurement.args], {
          cwd: options.root,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          encoding: 'utf8',
        }));
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new NfrProviderError(
          `measuring '${input.requirementId}' with '${commandLine}' in ` +
            `'${options.root}' failed: ${detail}. A measurement that did not run is ` +
            `reported as unverified, never as a threshold that held.`,
          { cause },
        );
      }

      const measured = measurementFrom(input.requirementId, commandLine, stdout);
      return {
        requirementId: input.requirementId,
        metric: input.metric,
        measured,
        unit: input.unit,
        passed:
          measurement.direction === 'at-most'
            ? measured <= input.value
            : measured >= input.value,
        evidence: measurement.evidence ?? `${commandLine} (in ${options.root})`,
      };
    },
  };
}
