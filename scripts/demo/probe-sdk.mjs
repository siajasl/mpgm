/**
 * Live SDK wiring probe.
 *
 * Sends one minimal session per registered output schema, purely to check that
 * the wiring the offline tests cannot reach still holds: the schema is
 * accepted as a tool input schema, the structured output comes back, and the
 * tool gate is consulted.
 *
 * Exists because the SDK-facing failures found during M1.2 and M1.3 were each
 * diagnosed by running a whole milestone demo. This costs a few cents and a
 * few seconds instead.
 *
 * `design` is the one schema this does not round-trip live (T4.3.20): DSG-2's
 * refine demands a complete design (every cross-cutting concern it names,
 * plus a component, interface, data-model entry, technology choice and ADR),
 * and a prompt detailed enough to guarantee a minimal session supplies all of
 * that is most of a design brief — the full generation this probe exists to
 * avoid paying for. `defaultProbeExclusions()` names it and parses a fixture
 * against the schema instead, with no live call spent on it. That parse
 * proves nothing a live call would have — the JSON Schema conversion it
 * still runs and the fixture's shape are both already asserted offline
 * (`src/schemas.test.ts`, `src/agent/probe.test.ts`) — so the live leg (the
 * CLI accepting the derived schema, a session returning schema-valid
 * output) is covered by `npm run demo:design` (T2.1.3) instead, not left
 * uncovered. The branching logic itself lives in `src/agent/probe.ts`, where
 * it is covered by an offline test with `ScriptedProvider` standing in for
 * the live call.
 */
import {
  ClaudeAgentProvider,
  defaultProbeExclusions,
  probeOutputSchemas,
  projectOutputSchemas,
  parseRole,
} from '../../dist/index.js';

const registry = projectOutputSchemas();
const provider = new ClaudeAgentProvider();
const exclusions = defaultProbeExclusions();

const role = parseRole(
  'probe.md',
  [
    '---',
    'name: probe',
    'description: Minimal probe role.',
    'model: claude-sonnet-5',
    'tools: { allow: [Read] }',
    "paths: { read: ['artifacts/**'], write: [] }",
    'budgets: { tokens: 20000, costUsd: 0.2, steps: 3, wallClockSeconds: 90 }',
    'output: { schema: definition }',
    '---',
    'You are a probe. Answer with the minimum that satisfies the schema.',
  ].join('\n'),
);

process.stdout.write('\nSchema acceptance\n');

const outcomes = await probeOutputSchemas({
  registry,
  provider,
  role,
  exclusions,
});

const failVerbs = {
  'schema-conversion': 'could not be converted to a tool schema',
  session: 'session did not complete',
  'output-validation': 'did not return schema-valid output',
  'exclusion-fixture': 'fixture for this known exclusion no longer satisfies the schema',
  'unregistered-exclusion': 'exclusion names a schema id that is no longer registered',
};

for (const outcome of outcomes) {
  const label =
    outcome.status === 'ok' ? 'ok  ' : outcome.status === 'excluded' ? 'skip' : 'FAIL';
  const verb =
    outcome.status === 'excluded'
      ? 'known exclusion, covered by fixture instead of a live call'
      : outcome.status === 'ok'
        ? 'accepted and returned schema-valid output'
        : (failVerbs[outcome.stage] ?? 'failed');
  process.stdout.write(`  ${label}  ${outcome.id}: ${verb} — ${outcome.detail}\n`);
}

const failures = outcomes.filter((outcome) => outcome.status === 'fail');
const excluded = outcomes.filter((outcome) => outcome.status === 'excluded');

if (excluded.length > 0) {
  process.stdout.write(
    `\n${String(excluded.length)} schema(s) excluded from the live round-trip (named above), ` +
      'checked by fixture instead.\n',
  );
}

process.stdout.write(
  failures.length === 0
    ? '\nSDK wiring probe passed\n\n'
    : `\nSDK wiring probe FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
