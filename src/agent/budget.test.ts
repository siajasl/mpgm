import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { parseRole } from '../role/loader.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { BudgetLedger, runWithWallClock } from './budget.js';
import { OutputSchemaRegistry } from './output-registry.js';
import { SessionRunner } from './runner.js';
import { ScriptedProvider, scriptedSuccess } from './scripted-provider.js';
import type { AgentSessionProvider, SessionResult } from './session.js';

const budget = { tokens: 1000, costUsd: 1, steps: 10, wallClockSeconds: 60 };

function roleWith(overrides: Partial<typeof budget>, wallClockSeconds = 60) {
  const merged = { ...budget, ...overrides, wallClockSeconds };
  return parseRole(
    'toy.md',
    [
      '---',
      'name: toy',
      'description: budget fixture',
      'model: claude-sonnet-5',
      'tools: { allow: [Read] }',
      `budgets: { tokens: ${String(merged.tokens)}, costUsd: ${String(merged.costUsd)}, steps: ${String(merged.steps)}, wallClockSeconds: ${String(merged.wallClockSeconds)} }`,
      'output: { schema: toy.v1 }',
      '---',
      'You are a toy role.',
    ].join('\n'),
  );
}

const schemas = new OutputSchemaRegistry({ 'toy.v1': z.object({ ok: z.boolean() }) });
const good = { ok: true };
const bad = { ok: 'not a boolean' };

function harness(provider: AgentSessionProvider, now?: () => number) {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const projector = new Projector({
    log,
    snapshots: SnapshotStore.attach(db),
    interval: 50,
  });
  const runner = new SessionRunner({
    log,
    provider,
    schemas,
    ...(now === undefined ? {} : { now }),
  });
  log.append({
    runId: 'run-1',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });
  return { db, log, projector, runner };
}

describe('BudgetLedger', () => {
  it('reports no breach while under every bound', () => {
    const ledger = new BudgetLedger(budget, () => 0);
    ledger.record({ inputTokens: 100, outputTokens: 100, costUsd: 0.5 }, 3);

    expect(ledger.breach()).toBeNull();
    expect(ledger.remainingCostUsd).toBeCloseTo(0.5);
    expect(ledger.remainingSteps).toBe(7);
  });

  it('accumulates across sessions, because retries share one task budget', () => {
    const ledger = new BudgetLedger(budget, () => 0);
    ledger.record({ inputTokens: 0, outputTokens: 0, costUsd: 0.6 }, 1);
    expect(ledger.breach()).toBeNull();

    // Neither session alone exceeds $1; together they do.
    ledger.record({ inputTokens: 0, outputTokens: 0, costUsd: 0.6 }, 1);

    expect(ledger.breach()).toMatchObject({ kind: 'cost', limit: 1 });
  });

  it('detects a token breach', () => {
    const ledger = new BudgetLedger(budget, () => 0);
    ledger.record({ inputTokens: 600, outputTokens: 600, costUsd: 0 }, 1);

    expect(ledger.breach()).toMatchObject({ kind: 'tokens', observed: 1200 });
  });

  it('detects a step breach', () => {
    const ledger = new BudgetLedger(budget, () => 0);
    ledger.record({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, 11);

    expect(ledger.breach()).toMatchObject({ kind: 'steps', limit: 10 });
  });

  it('detects a wall-clock breach from the injected clock', () => {
    let clock = 0;
    const ledger = new BudgetLedger(budget, () => clock);
    clock = 61_000;

    expect(ledger.breach()).toMatchObject({ kind: 'wallClock', limit: 60 });
  });

  it('never reports negative remaining budget', () => {
    const ledger = new BudgetLedger(budget, () => 0);
    ledger.record({ inputTokens: 0, outputTokens: 0, costUsd: 5 }, 99);

    expect(ledger.remainingCostUsd).toBe(0);
    expect(ledger.remainingSteps).toBe(0);
  });
});

describe('runWithWallClock', () => {
  it('returns the session result when it finishes in time', async () => {
    const result = await runWithWallClock(
      () => Promise.resolve(scriptedSuccess(good)),
      5,
    );

    expect(result.termination).toBe('completed');
  });

  it('gives up on a session that never returns', async () => {
    const neverSettles = (): Promise<SessionResult> =>
      new Promise<SessionResult>(() => {
        // Deliberately never resolves.
      });
    const result = await runWithWallClock(neverSettles, 0.05);

    expect(result.termination).toBe('wall_clock');
    expect(result.errorMessage).toMatch(/wall-clock budget/);
  });

  it('signals abort to a session that is willing to listen', async () => {
    let aborted = false;

    await runWithWallClock(
      (signal) =>
        new Promise<SessionResult>(() => {
          // Never resolves even after aborting: the kernel must not depend on
          // the session cooperating.
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      0.05,
    );

    expect(aborted).toBe(true);
  });
});

/** A provider that hangs forever, whatever the signal says. */
class HungProvider implements AgentSessionProvider {
  run(): Promise<SessionResult> {
    return new Promise<SessionResult>(() => {
      // Never resolves and never honours the abort. This is the case the
      // kernel-side timer exists for.
    });
  }
}

describe('budget enforcement in the runner', () => {
  it('kills a hung session by the kernel timer', async () => {
    const role = roleWith({}, 0.05);
    const { db, log, projector, runner } = harness(new HungProvider());
    try {
      const outcome = await runner.runTask({
        runId: 'run-1',
        taskId: 'T1',
        role,
        prompt: 'hang please',
      });

      expect(outcome.status).toBe('blocked');
      expect(outcome.status === 'blocked' && outcome.reason).toMatch(/wall_clock/);

      const breach = log.read().find((event) => event.type === 'BudgetExceeded');
      expect((breach?.payload as { kind: string }).kind).toBe('wallClock');
      expect(projector.project().runs['run-1']?.tasks.T1?.status).toBe('blocked');
    } finally {
      db.close();
    }
  }, 10_000);

  it('blocks when retries collectively exhaust the cost budget', async () => {
    const role = roleWith({ costUsd: 1 });
    const expensive = scriptedSuccess(bad, {
      usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.7 },
    });
    const { db, log, runner } = harness(new ScriptedProvider([expensive, expensive]));
    try {
      const outcome = await runner.runTask({
        runId: 'run-1',
        taskId: 'T1',
        role,
        prompt: 'spend',
      });

      expect(outcome.status).toBe('blocked');
      expect(outcome.status === 'blocked' && outcome.reason).toMatch(
        /budget exceeded: cost/,
      );

      const breaches = log.read().filter((event) => event.type === 'BudgetExceeded');
      // Exactly one breach event: the termination path and the ledger path
      // must not both log the same stop.
      expect(breaches).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('offers each retry only the budget that is left', async () => {
    const role = roleWith({ costUsd: 1, steps: 10 });
    const provider = new ScriptedProvider([
      scriptedSuccess(bad, {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.3 },
        turns: 4,
      }),
      scriptedSuccess(good, {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
        turns: 1,
      }),
    ]);
    const { db, runner } = harness(provider);
    try {
      await runner.runTask({ runId: 'run-1', taskId: 'T1', role, prompt: 'go' });

      expect(provider.requests[0]?.maxBudgetUsd).toBeCloseTo(1);
      expect(provider.requests[0]?.maxTurns).toBe(10);
      expect(provider.requests[1]?.maxBudgetUsd).toBeCloseTo(0.7);
      expect(provider.requests[1]?.maxTurns).toBe(6);
    } finally {
      db.close();
    }
  });

  it('blocks on a wall-clock breach detected between attempts', async () => {
    const role = roleWith({}, 60);
    let clock = 0;
    const provider = new ScriptedProvider([scriptedSuccess(bad), scriptedSuccess(good)]);
    const { db, log, runner } = harness(provider, () => clock);
    try {
      // The first session returns, but by then the task has run out of time.
      const outcome = runner.runTask({
        runId: 'run-1',
        taskId: 'T1',
        role,
        prompt: 'slow',
      });
      clock = 61_000;
      const settled = await outcome;

      expect(settled.status).toBe('blocked');
      expect(
        (log.read().find((e) => e.type === 'BudgetExceeded')?.payload as { kind: string })
          .kind,
      ).toBe('wallClock');
    } finally {
      db.close();
    }
  });
});
