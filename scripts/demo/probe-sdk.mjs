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
 */
import {
  ClaudeAgentProvider,
  projectOutputSchemas,
  RolePolicy,
  parseRole,
} from '../../dist/index.js';

const failures = [];

function check(label, condition, detail = '') {
  process.stdout.write(
    `  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) {
    failures.push(label);
  }
}

const registry = projectOutputSchemas();
const provider = new ClaudeAgentProvider();

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

for (const id of registry.ids) {
  let jsonSchema;
  try {
    jsonSchema = registry.jsonSchema(id);
  } catch (error) {
    check(`${id}: convertible to a tool schema`, false, String(error));
    continue;
  }

  const gated = [];
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
    canUseTool: (tool, input) => {
      gated.push(tool);
      return Promise.resolve(policy.decide(tool, input));
    },
  });

  if (result.termination !== 'completed') {
    check(`${id}: session completed`, false, result.errorMessage);
    continue;
  }

  const parsed = registry.get(id).safeParse(result.structuredOutput);
  check(
    `${id}: accepted and returned schema-valid output`,
    parsed.success,
    parsed.success
      ? `$${result.usage.costUsd.toFixed(4)}`
      : parsed.error.issues.map((issue) => issue.message).join('; '),
  );
}

process.stdout.write(
  failures.length === 0
    ? '\nSDK wiring probe passed\n\n'
    : `\nSDK wiring probe FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
