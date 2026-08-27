import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { loadRoleFile } from '../role/loader.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { OutputSchemaRegistry } from './output-registry.js';
import { ScriptedProvider, scriptedSuccess } from './scripted-provider.js';
import { abandonedOutputIssues, SessionRunner } from './runner.js';
import type { SessionResult } from './session.js';

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'role',
  '__fixtures__',
);
const role = loadRoleFile(join(fixtures, 'valid', 'analyst.md'));

const definitionSchema = z.object({
  summary: z.string().min(1),
  requirements: z.array(z.string()).min(1),
});

const schemas = new OutputSchemaRegistry({ [role.output.schema]: definitionSchema });

const validOutput = { summary: 'a summary', requirements: ['REQ-1'] };

function harness(results: readonly SessionResult[]) {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  const provider = new ScriptedProvider(results);
  const runner = new SessionRunner({ log, provider, schemas });

  log.append({
    runId: 'run-1',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });

  return { db, log, projector, provider, runner };
}

const task = { runId: 'run-1', taskId: 'T1', role, prompt: 'Define the project.' };

describe('SessionRunner', () => {
  it('returns schema-valid output on 10 consecutive runs', async () => {
    // The completion criterion. Each run is an independent runner and log.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { db, runner } = harness([scriptedSuccess(validOutput)]);
      try {
        const outcome = await runner.runTask(task);

        expect(outcome.status).toBe('completed');
        expect(outcome.status === 'completed' && outcome.output).toStrictEqual(
          validOutput,
        );
        expect(definitionSchema.safeParse(validOutput).success).toBe(true);
      } finally {
        db.close();
      }
    }
  });

  it('records dispatch, usage and completion in the log', async () => {
    const { db, log, projector, runner } = harness([scriptedSuccess(validOutput)]);
    try {
      await runner.runTask(task);

      expect(log.read().map((event) => event.type)).toStrictEqual([
        'RunStarted',
        'TaskDispatched',
        'SessionUsage',
        'TaskCompleted',
      ]);

      const state = projector.project().runs['run-1']?.tasks.T1;
      expect(state?.status).toBe('completed');
      expect(state?.role).toBe('analyst');
      expect(state?.usage.costUsd).toBeCloseTo(0.01);
    } finally {
      db.close();
    }
  });

  it('records the dispatch-time model override, not the role default', async () => {
    const { db, projector, provider, runner } = harness([scriptedSuccess(validOutput)]);
    try {
      await runner.runTask({ ...task, model: 'claude-opus-5' });

      expect(projector.project().runs['run-1']?.tasks.T1?.model).toBe('claude-opus-5');
      expect(provider.requests[0]?.model).toBe('claude-opus-5');
      // The role file is untouched by the override (AGT-5, DESIGN §4.2).
      expect(role.model).toBe('claude-sonnet-5');
    } finally {
      db.close();
    }
  });

  it('builds the session request from the role declaration', async () => {
    const { db, provider, runner } = harness([scriptedSuccess(validOutput)]);
    try {
      await runner.runTask(task);
      const request = provider.requests[0];

      expect(request?.allowedTools).toStrictEqual(['Read', 'Grep', 'Glob']);
      expect(request?.maxTurns).toBe(role.budgets.steps);
      expect(request?.maxBudgetUsd).toBe(role.budgets.costUsd);
      expect(request?.systemPrompt).toContain('You are the analyst');
      expect(request?.outputJsonSchema.type).toBe('object');
      // The session's cwd matches the root the path policy resolves against.
      expect(request?.cwd).toBe(process.cwd());
    } finally {
      db.close();
    }
  });
});

describe('validation and bounded retry', () => {
  it('retries after a schema violation and feeds the errors back', async () => {
    const { db, log, provider, runner } = harness([
      scriptedSuccess({ summary: 'missing requirements' }),
      scriptedSuccess(validOutput),
    ]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('completed');
      expect(outcome.attempts).toBe(2);

      // The retry prompt names the field that failed, so the agent has
      // something to act on rather than a bare "try again".
      expect(provider.requests[1]?.prompt).toContain('requirements');
      expect(provider.requests[1]?.prompt).toContain('did not satisfy');
      expect(log.read().map((event) => event.type)).toContain('ValidationFailed');
    } finally {
      db.close();
    }
  });

  it('retries a project rule the schema cannot express, and feeds it back', async () => {
    // The Design-phase regression: a convention id in `tracesTo`. The schema
    // is satisfied — it is a non-empty array of strings — so only a check that
    // knows which conventions are in force can catch it (DSG-4, IMP-4).
    const { db, log, provider, runner } = harness([
      scriptedSuccess({ summary: 'a summary', requirements: ['CONV-4'] }),
      scriptedSuccess(validOutput),
    ]);
    try {
      const outcome = await runner.runTask({
        ...task,
        validate: (output) =>
          (output as { requirements: string[] }).requirements
            .filter((id) => id === 'CONV-4')
            .map((id) => `'${id}' is a project convention, not a requirement`),
      });

      expect(outcome.status).toBe('completed');
      expect(outcome.attempts).toBe(2);
      expect(provider.requests[1]?.prompt).toContain('is a project convention');
      expect(log.read().map((event) => event.type)).toContain('ValidationFailed');
    } finally {
      db.close();
    }
  });

  it('does not report a task complete while a project rule is unmet', async () => {
    const { db, log, runner } = harness([
      scriptedSuccess(validOutput),
      scriptedSuccess(validOutput),
      scriptedSuccess(validOutput),
    ]);
    try {
      const outcome = await runner.runTask({
        ...task,
        validate: () => ['never satisfied'],
      });

      expect(outcome.status).toBe('blocked');
      // TaskCompleted must not have been written for an output the kernel
      // rejected: state would then say the task succeeded.
      expect(log.read().map((event) => event.type)).not.toContain('TaskCompleted');
    } finally {
      db.close();
    }
  });

  it('retries a session the CLI abandoned for failing its schema', async () => {
    // `error_max_structured_output_retries`: the CLI asked for structured
    // output, kept getting output that did not satisfy the schema, and gave
    // up. Those retries were all against one context; a fresh session is a
    // fresh sample, so this is a validation failure and retries like one.
    const { db, log, provider, runner } = harness([
      scriptedSuccess(undefined, {
        termination: 'invalid_output',
        errorMessage: 'error_max_structured_output_retries: unterminated JSON',
      }),
      scriptedSuccess(validOutput),
    ]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('completed');
      expect(outcome.attempts).toBe(2);
      // The detail the SDK reported reaches the agent, rather than the bare
      // subtype it cannot act on.
      expect(provider.requests[1]?.prompt).toContain('unterminated JSON');
      expect(log.read().map((event) => event.type)).toContain('ValidationFailed');
    } finally {
      db.close();
    }
  });

  it('blocks after the bounded retries when the schema is never satisfied', async () => {
    const abandoned = scriptedSuccess(undefined, {
      termination: 'invalid_output',
      errorMessage: 'error_max_structured_output_retries',
    });
    const { db, log, runner } = harness([abandoned, abandoned, abandoned]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('blocked');
      expect(outcome.attempts).toBe(3);
      expect(log.read().map((event) => event.type)).not.toContain('TaskCompleted');
      // Not recorded as a budget breach: nothing was exhausted, the output was
      // wrong, and an operator reading BudgetExceeded here would raise limits
      // that were never the problem.
      expect(log.read().map((event) => event.type)).not.toContain('BudgetExceeded');
    } finally {
      db.close();
    }
  });

  it('blocks rather than retrying forever', async () => {
    const bad = scriptedSuccess({ summary: '' });
    const { db, log, projector, runner } = harness([bad, bad, bad]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('blocked');
      expect(outcome.attempts).toBe(3);
      expect(outcome.status === 'blocked' && outcome.reason).toMatch(/after 3 attempts/);

      const failures = log.read().filter((event) => event.type === 'ValidationFailed');
      expect(failures).toHaveLength(3);
      // Blocked, never silently dropped (NFR-1).
      expect(projector.project().runs['run-1']?.tasks.T1?.validationFailures).toBe(3);
    } finally {
      db.close();
    }
  });

  it('honours a custom attempt budget', async () => {
    const bad = scriptedSuccess({ summary: '' });
    const db = openDatabase(MEMORY);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      log.append({
        runId: 'run-1',
        type: 'RunStarted',
        payload: { project: 'mpgm', operator: 'op' },
      });
      const runner = new SessionRunner({
        log,
        provider: new ScriptedProvider([bad]),
        schemas,
        maxValidationAttempts: 1,
      });

      expect((await runner.runTask(task)).attempts).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects a nonsensical attempt budget', () => {
    const db = openDatabase(MEMORY);
    try {
      const log = EventLog.attach(db, { registry: kernelRegistry() });
      expect(
        () =>
          new SessionRunner({
            log,
            provider: new ScriptedProvider([]),
            schemas,
            maxValidationAttempts: 0,
          }),
      ).toThrow(/at least 1/);
    } finally {
      db.close();
    }
  });
});

describe('non-completing sessions', () => {
  const cases = [
    ['budget_exceeded', 'cost'],
    ['max_turns', 'steps'],
    ['wall_clock', 'wallClock'],
  ] as const;

  for (const [termination, kind] of cases) {
    it(`blocks and records a ${kind} breach when the session ends with ${termination}`, async () => {
      const { db, log, projector, runner } = harness([
        scriptedSuccess(validOutput, { termination, structuredOutput: undefined }),
      ]);
      try {
        const outcome = await runner.runTask(task);

        expect(outcome.status).toBe('blocked');
        const breach = log.read().find((event) => event.type === 'BudgetExceeded');
        expect((breach?.payload as { kind: string }).kind).toBe(kind);
        // The limit recorded is the one that was actually in force.
        expect((breach?.payload as { limit: number }).limit).toBeGreaterThan(0);
        expect(projector.project().runs['run-1']?.tasks.T1?.status).toBe('blocked');
      } finally {
        db.close();
      }
    });
  }

  it('does not retry an error termination, which would only spend more', async () => {
    // The distinction the retry rests on: `invalid_output` is a fresh sample
    // worth taking, an `error` is a session that failed for a reason a second
    // attempt does not change.
    const { db, provider, runner } = harness([
      scriptedSuccess(undefined, {
        termination: 'error',
        errorMessage: 'error_during_execution: the process died',
      }),
    ]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('blocked');
      expect(outcome.attempts).toBe(1);
      expect(provider.requests).toHaveLength(1);
      if (outcome.status === 'blocked') {
        expect(outcome.reason).toContain('the process died');
      }
    } finally {
      db.close();
    }
  });

  it('logs every tool denial the session reported', async () => {
    const { db, log, projector, runner } = harness([
      scriptedSuccess(validOutput, {
        denials: [
          { tool: 'Bash', reason: 'not in role toolset' },
          { tool: 'Write', reason: 'not in role toolset' },
        ],
      }),
    ]);
    try {
      await runner.runTask(task);

      const denials = log.read().filter((event) => event.type === 'ToolCallLogged');
      expect(denials).toHaveLength(2);
      expect(projector.project().runs['run-1']?.tasks.T1?.deniedToolCalls).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('abandonedOutputIssues', () => {
  // The M1.2 demo failed with `Failed to provide valid structured output after
  // 5 attempts` and nothing about what was wrong with those five. The gate saw
  // every one of them go past, so the last is checked here rather than guessed
  // at (CONV-3).
  it('reports what was actually wrong with the output the CLI rejected', () => {
    const issues = abandonedOutputIssues(
      definitionSchema,
      { summary: 'a summary', requirements: [], note: 'the Read was refused' },
      'error_max_structured_output_retries',
    );

    expect(issues.join(' ')).toContain('requirements');
  });

  it('names a schema mismatch rather than blaming the model', () => {
    // Output the kernel accepts and the CLI refused is not a model that cannot
    // follow a schema: it is the JSON Schema sent to the CLI disagreeing with
    // the zod it came from, and retrying cannot fix it.
    const issues = abandonedOutputIssues(definitionSchema, validOutput, 'gave up');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('does not match the schema the kernel validates');
    expect(issues[0]).toContain('gave up');
  });

  it('falls back to what the SDK said when no attempt reached the gate', () => {
    expect(abandonedOutputIssues(definitionSchema, undefined, 'gave up')).toStrictEqual([
      'the session ended without output satisfying the schema (gave up)',
    ]);
  });
});

describe('a session that overran its budget but finished', () => {
  // A session cannot be terminated once it has ended, and the money is
  // already gone. Discarding output the session did produce loses the work as
  // well as the money, so a breach seen after the fact bounds what comes next
  // rather than voiding what came before.
  const overspend = () =>
    scriptedSuccess(validOutput, {
      usage: { inputTokens: 100, outputTokens: 50, costUsd: role.budgets.costUsd + 1 },
    });

  it('keeps the output it paid for, and records the overrun', async () => {
    const { db, log, projector, runner } = harness([overspend()]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('completed');
      const breach = log.read().find((event) => event.type === 'BudgetExceeded');
      expect((breach?.payload as { kind: string }).kind).toBe('cost');
      // Recorded and then completed, in that order: the task succeeded, and
      // the overrun is still on the record for whoever sizes the budget.
      expect(projector.project().runs['run-1']?.tasks.T1?.status).toBe('completed');
      expect(projector.project().runs['run-1']?.tasks.T1?.budgetBreaches).toBe(1);
    } finally {
      db.close();
    }
  });

  it('refuses the next attempt, so the overrun bounds what follows', async () => {
    // Same overspend, but the output does not validate. There is nothing to
    // keep, and nothing left to spend on another try.
    const { db, log, provider, runner } = harness([
      scriptedSuccess(
        { summary: '' },
        {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            costUsd: role.budgets.costUsd + 1,
          },
        },
      ),
      scriptedSuccess(validOutput),
    ]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('blocked');
      expect(provider.requests).toHaveLength(1);
      if (outcome.status === 'blocked') {
        expect(outcome.reason).toContain('budget exhausted');
      }
      // One event, not two: the breach is reported where it stopped the work.
      expect(log.read().filter((event) => event.type === 'BudgetExceeded')).toHaveLength(
        1,
      );
    } finally {
      db.close();
    }
  });

  it('does not call a completed session an overrun for reporting more turns than its step bound', async () => {
    // The Definition demo's misdiagnosis: a session that finished was thrown
    // away because the turn count it reported came back above the role's step
    // number. Those are different counts — the SDK enforced `maxTurns` and
    // let the session finish — so there was no overrun to report, and saying
    // there was cost the operator the work and sent them after the wrong bug.
    const { db, log, runner } = harness([
      scriptedSuccess(validOutput, { turns: role.budgets.steps + 7 }),
    ]);
    try {
      const outcome = await runner.runTask(task);

      expect(outcome.status).toBe('completed');
      expect(log.read().some((event) => event.type === 'BudgetExceeded')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('OutputSchemaRegistry', () => {
  it('derives the JSON Schema from the zod schema', () => {
    const json = schemas.jsonSchema(role.output.schema);

    expect(json.type).toBe('object');
    expect(Object.keys(json.properties as object)).toStrictEqual([
      'summary',
      'requirements',
    ]);
  });

  it('lists what is registered when asked for something else', () => {
    expect(() => schemas.get('nope')).toThrow(/Registered: schemas\/definition\.json/);
  });
});
