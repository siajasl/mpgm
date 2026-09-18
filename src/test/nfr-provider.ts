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
 * What it measures is the checkout at `root`, and it refuses to measure one
 * that is not at the `ref` it was asked about. `test.nfr#run` carries a repo
 * and a ref, `runPhase` blocks a whole phase rather than guess either, and
 * until that reached here the two travelled as labels: a `mpgm run test
 * --ref <sha>` from a working tree at any other commit would have measured
 * the working tree and filed the numbers as measurements of `<sha>`, with
 * nothing recording that anything disagreed. That is the same measured-X-
 * labelled-Y ambiguity this provider already refuses for a drifted
 * `metric`/`unit` and `runNfrSuite` refuses for a mislabelled requirement id,
 * so it is refused the same way (CONV-4): `git rev-parse HEAD` must be the
 * commit `ref` names, and a root that is not a git checkout at all is refused
 * rather than measured under a ref nothing can corroborate.
 *
 * The guarantee is at commit granularity, deliberately and not silently: a
 * modified working tree is *reported*, in `evidence`, rather than refused,
 * because a phase writes its own artifacts into the project root as it runs
 * and would otherwise block on its own output. Every result carries
 * `repo@<head sha>` in `evidence` for the same reason — the row says what was
 * measured, not only what it was asked about.
 *
 * Two further things it deliberately does not do. It does not infer the command from
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

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

/**
 * The commit the checkout at `root` is on, refused when `ref` does not name
 * it (CONV-4).
 *
 * `ref` is matched as the caller wrote it — a full sha, an abbreviation, a
 * branch or a tag all resolve through `git rev-parse`, because the kernel
 * takes `--ref` from an operator and an operator writes whichever of those
 * they have. What is *not* accepted is a ref this checkout cannot resolve at
 * all: that is either a ref from another repository or one this clone has
 * never fetched, and in both cases the commit about to be measured is not
 * the commit named.
 */
async function headCommitAt(root: string, ref: string): Promise<string> {
  let head: string;
  try {
    head = await git(root, ['rev-parse', 'HEAD']);
  } catch (cause) {
    throw new NfrProviderError(
      `cannot establish which commit '${root}' is at — 'git -C ${root} rev-parse ` +
        `HEAD' failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `This provider measures that checkout and reports the result against ` +
        `ref '${ref}', so a root whose commit cannot be read is refused rather ` +
        `than measured and labelled with a ref nothing can corroborate ` +
        `(CONV-4). Run the phase from a git checkout of the repository being ` +
        `measured.`,
      { cause },
    );
  }
  if (head === ref) {
    return head;
  }
  let resolved: string | undefined;
  try {
    resolved = await git(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
  } catch {
    resolved = undefined;
  }
  if (resolved === head) {
    return head;
  }
  throw new NfrProviderError(
    `refusing to measure '${root}': it is at commit ${head}` +
      (resolved === undefined
        ? `, and ref '${ref}' does not resolve in it at all`
        : `, and ref '${ref}' is commit ${resolved}`) +
      `. A measurement of one commit reported against another is a number ` +
      `nobody measured (CONV-4). Either check '${root}' out at '${ref}', or ` +
      `run with '--ref ${head}' — the ref is what the coverage report claims ` +
      `was measured, so it is corroborated here rather than taken on trust.`,
  );
}

/**
 * Whether the checkout has uncommitted changes — reported in `evidence`, not
 * refused. See the module doc: a phase writes artifacts into the root it is
 * running over, so refusing a dirty tree would block a phase on its own
 * output; saying so in the row is what keeps the disagreement visible.
 */
async function workingTreeModified(root: string): Promise<boolean> {
  try {
    return (await git(root, ['status', '--porcelain'])) !== '';
  } catch {
    // The commit was already established above; an unreadable status is not
    // grounds to discard a measurement, only to stop claiming the tree was
    // clean — which `undefined` here would, so it says modified.
    return true;
  }
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
 * already treats a capability it cannot reach (CONV-4) — a blocked step
 * writes no coverage artifact at all, which is the point: `nfrCoverage`'s
 * `not-run` row is what a *completed* run says about a requirement nothing
 * reported on, and it is not a softer landing this provider's refusals fall
 * into.
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

      // Before anything is run, not after: a measurement of the wrong commit
      // costs whatever the command costs and then has to be thrown away.
      const head = await headCommitAt(options.root, input.ref);
      const modified = await workingTreeModified(options.root);

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
        evidence: `${measurement.evidence ?? `${commandLine} (in ${options.root})`} — measured ${input.repo}@${head}${modified ? ', working tree modified' : ''}`,
      };
    },
  };
}
