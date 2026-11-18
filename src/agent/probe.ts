import { RolePolicy } from '../policy/role-policy.js';
import type { Role } from '../role/definition.js';
import { requiredConcerns, type Design } from '../schemas.js';
import type { OutputSchemaRegistry } from './output-registry.js';
import type { AgentSessionProvider } from './session.js';

/**
 * `npm run probe:sdk` (T4.3.20) — one minimal session per registered output
 * schema, to check the SDK wiring CLAUDE.md lists without the cost of a whole
 * milestone demo.
 *
 * Pulled out of `scripts/demo/probe-sdk.mjs` so the branching — live call vs.
 * known exclusion — is reachable from an offline test with `ScriptedProvider`
 * standing in for the live one; the script itself only prints what this
 * returns and sets the exit code.
 */

/**
 * Where a `fail` outcome came from, so the script can label the cause
 * instead of guessing: a schema that will not convert to a JSON Schema at
 * all is not the same failure as a live session that never completed, which
 * is not the same failure as output that came back schema-invalid. Absent
 * for `ok` and `excluded`, where the status already says what happened.
 */
export type ProbeFailStage =
  | 'schema-conversion'
  | 'session'
  | 'output-validation'
  | 'exclusion-fixture'
  | 'unregistered-exclusion';

/** One schema's probe result. */
export interface ProbeOutcome {
  readonly id: string;
  readonly status: 'ok' | 'excluded' | 'fail';
  readonly detail: string;
  readonly stage?: ProbeFailStage;
}

/**
 * A schema the live round-trip is not asked to satisfy, checked instead by
 * parsing `fixture` against the schema directly. `reason` is what the
 * script's own output names it by — the point of excluding a schema is lost
 * if the exclusion is not visible next to the result it stands in for.
 */
export interface ProbeExclusion {
  readonly reason: string;
  readonly fixture: unknown;
}

export interface ProbeOptions {
  readonly registry: OutputSchemaRegistry;
  readonly provider: AgentSessionProvider;
  readonly role: Role;
  /** Keyed by output schema id. Defaults to no exclusions — every id gets a live call. */
  readonly exclusions?: Readonly<Record<string, ProbeExclusion>>;
}

/**
 * Smallest {@link Design} that satisfies DSG-2's refine over every concern
 * {@link requiredConcerns} names, built from that list rather than repeating
 * it so the two cannot drift apart. Exists only to be parsed against
 * `designSchema` in place of a live call — see
 * {@link designProbeExclusionReason} for why a live call is the wrong tool
 * here.
 */
export const designProbeFixture: Design = {
  chosen: 'simplest',
  summary: 'Probe fixture: the smallest design that satisfies DSG-2 (T4.3.20).',
  components: [
    {
      id: 'C-1',
      name: 'placeholder',
      responsibility: 'placeholder',
      tracesTo: ['probe'],
    },
  ],
  interfaces: [
    {
      id: 'I-1',
      name: 'placeholder',
      kind: 'api',
      contract: 'placeholder',
      tracesTo: ['probe'],
    },
  ],
  dataModel: [{ id: 'D-1', entity: 'placeholder', fields: ['field'], notes: '' }],
  technologies: [
    { id: 'T-1', choice: 'placeholder', why: 'placeholder', tracesTo: ['probe'] },
  ],
  crossCutting: requiredConcerns.map((concern, index) => ({
    id: `X-${String(index + 1)}`,
    concern,
    approach: 'placeholder',
    tracesTo: ['probe'],
  })),
  adrs: [
    {
      id: 'ADR-1',
      title: 'placeholder',
      context: 'placeholder',
      decision: 'placeholder',
      alternatives: [{ option: 'placeholder', whyNot: 'placeholder' }],
      consequences: ['placeholder'],
      tracesTo: ['probe'],
    },
  ],
};

/**
 * Why `design` is excluded from the live round-trip rather than fixed with a
 * better prompt (T4.3.20): DSG-2's refine demands an entry for every one of
 * {@link requiredConcerns}, plus at least one component, interface,
 * data-model entry, technology choice and ADR. A prompt detailed enough to
 * guarantee a minimal session supplies all of that is most of a design
 * brief — the full generation this probe exists to avoid paying for.
 *
 * Parsing {@link designProbeFixture} against the schema (see
 * {@link probeOutputSchemas}) proves nothing a live call would have: the
 * conversion to a JSON Schema this probe still runs for `design`, and the
 * fixture's shape, are both already asserted offline (`src/schemas.test.ts`,
 * `src/agent/probe.test.ts`). The two things only a live call shows — the
 * CLI accepting `designSchema`'s derived JSON Schema as a structured-output
 * tool schema, and a session actually returning design-schema-valid
 * output — are covered instead by `npm run demo:design` (T2.1.3), a real
 * session already listed in CLAUDE.md. Excluding `design` here does not
 * leave that leg uncovered; it moves the cost of covering it to the demo
 * that was already paying it.
 */
export const designProbeExclusionReason =
  "DSG-2's refine requires every cross-cutting concern it names " +
  `(${requiredConcerns.join(', ')}), plus at least one component, interface, ` +
  'data-model entry, technology choice and ADR. A minimal connectivity prompt ' +
  'has no reason to supply all of that, and a prompt detailed enough to ' +
  'guarantee it is most of a design brief — the full generation this probe ' +
  'exists to avoid paying for. Checked instead by parsing a fixture against ' +
  'the schema directly, with no live call spent on it; the live leg (the CLI ' +
  "accepting the schema, a session returning schema-valid output) is demo:design's " +
  'job, not a gap this leaves open.';

/** The exclusions `npm run probe:sdk` applies by default. */
export function defaultProbeExclusions(): Record<string, ProbeExclusion> {
  return { design: { reason: designProbeExclusionReason, fixture: designProbeFixture } };
}

/**
 * Probes every id {@link ProbeOptions.registry} declares: a live session for
 * most, a fixture parse for anything named in `exclusions`. Pure — it makes
 * the calls and parses the results, and returns what happened, so a test can
 * read the report without the script's `stdout` or exit code.
 */
export async function probeOutputSchemas(options: ProbeOptions): Promise<ProbeOutcome[]> {
  const { registry, provider, role, exclusions = {} } = options;
  const outcomes: ProbeOutcome[] = [];
  const registeredIds = new Set(registry.ids);

  // An exclusion keyed by an id the registry no longer has (e.g. a schema
  // renamed without updating `defaultProbeExclusions`) must not be silently
  // dropped — that would re-open the live round-trip for a schema the
  // exclusion was meant to cover, with nothing in the output saying so
  // (CONV-4: fail closed rather than pass on ambiguity).
  for (const excludedId of Object.keys(exclusions)) {
    if (!registeredIds.has(excludedId)) {
      outcomes.push({
        id: excludedId,
        status: 'fail',
        stage: 'unregistered-exclusion',
        detail:
          `exclusion names '${excludedId}', which is not a registered output schema id ` +
          `(registered: ${registry.ids.join(', ')}) — the schema it was meant to exclude ` +
          'may have been renamed; update the exclusion key',
      });
    }
  }

  for (const id of registry.ids) {
    let jsonSchema: Record<string, unknown>;
    try {
      jsonSchema = registry.jsonSchema(id);
    } catch (error) {
      outcomes.push({
        id,
        status: 'fail',
        stage: 'schema-conversion',
        detail: String(error),
      });
      continue;
    }

    const exclusion = exclusions[id];
    if (exclusion !== undefined) {
      const parsed = registry.get(id).safeParse(exclusion.fixture);
      outcomes.push(
        parsed.success
          ? { id, status: 'excluded', detail: exclusion.reason }
          : {
              id,
              status: 'fail',
              stage: 'exclusion-fixture',
              detail:
                'fixture for a known exclusion no longer satisfies the schema: ' +
                parsed.error.issues.map((issue) => issue.message).join('; '),
            },
      );
      continue;
    }

    const policy = new RolePolicy(role, { root: process.cwd() });
    const result = await provider.run({
      model: 'claude-sonnet-5',
      systemPrompt: 'You are a probe. Return the smallest valid result.',
      prompt:
        'Return a minimal result satisfying the schema. Invent placeholder values; ' +
        'this is a connectivity check, not a real task.',
      allowedTools: ['Read'],
      maxTurns: 2,
      maxBudgetUsd: 0.2,
      outputJsonSchema: jsonSchema,
      canUseTool: (tool, input) => Promise.resolve(policy.decide(tool, input)),
    });

    if (result.termination !== 'completed') {
      outcomes.push({
        id,
        status: 'fail',
        stage: 'session',
        detail: result.errorMessage,
      });
      continue;
    }

    const parsed = registry.get(id).safeParse(result.structuredOutput);
    outcomes.push(
      parsed.success
        ? { id, status: 'ok', detail: `$${result.usage.costUsd.toFixed(4)}` }
        : {
            id,
            status: 'fail',
            stage: 'output-validation',
            detail: parsed.error.issues.map((issue) => issue.message).join('; '),
          },
    );
  }

  return outcomes;
}
