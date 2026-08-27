import { describe, expect, it } from 'vitest';
import { canEscalate, escalateModel, MODEL_TIERS, tierOf } from '../agent/models.js';
import type { EventInput } from '../event/envelope.js';
import { awaitChecks, mergeVerdict, type CheckRun, type MergeVerdict } from './checks.js';
import { renderFeedback, repairUntilGreen, tail, type RepairRequest } from './repair.js';

const RUN = 'run-1';
const TASK = 'T3.1.2b';

function check(name: string, conclusion: CheckRun['conclusion']): CheckRun {
  return { name, status: 'completed', conclusion, url: '' };
}

const GREEN: CheckRun[] = [
  check('build', 'success'),
  check('lint', 'success'),
  check('typecheck', 'success'),
  check('test (node 24.x)', 'success'),
  check('scan', 'success'),
];

function withFailure(name: string): CheckRun[] {
  return GREEN.map((run) => (run.name === name ? check(name, 'failure') : run));
}

function verdictFor(ref: string, runs: readonly CheckRun[]): MergeVerdict {
  return mergeVerdict({ ref, runs });
}

describe('model tiers', () => {
  it('escalates one step and stops at the top', () => {
    expect(escalateModel('claude-haiku-4-5')).toBe('claude-sonnet-5');
    expect(escalateModel('claude-sonnet-5')).toBe('claude-opus-5');
    expect(escalateModel('claude-opus-5')).toBe('claude-opus-5');
    expect(canEscalate('claude-opus-5')).toBe(false);
  });

  it('matches dated release ids by prefix', () => {
    expect(tierOf('claude-haiku-4-5-20251001')).toBe(0);
    expect(escalateModel('claude-haiku-4-5-20251001')).toBe('claude-sonnet-5');
  });

  it('leaves a model it cannot rank alone', () => {
    // Guessing which way is up would re-run the task on something nobody chose.
    expect(escalateModel('some-other-model')).toBe('some-other-model');
    expect(canEscalate('some-other-model')).toBe(false);
    expect(MODEL_TIERS).toHaveLength(3);
  });
});

describe('repairUntilGreen', () => {
  it('returns immediately when the first verdict is already green', async () => {
    let repairs = 0;
    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      checks: (ref) => Promise.resolve(verdictFor(ref, GREEN)),
      repair: () => {
        repairs += 1;
        return Promise.resolve({ ref: 'never' });
      },
    });

    expect(report.status).toBe('green');
    expect(report.attempts).toHaveLength(0);
    expect(repairs).toBe(0);
  });

  // T3.1.2b completion criterion, first half: an induced CI failure is
  // repaired within the budget.
  it('repairs an induced failure within budget', async () => {
    const state = new Map<string, readonly CheckRun[]>([
      ['c0', withFailure('test (node 24.x)')],
    ]);
    const seen: RepairRequest[] = [];

    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      checks: (ref) => Promise.resolve(verdictFor(ref, state.get(ref) ?? [])),
      repair: (request) => {
        seen.push(request);
        // The agent fixes the test and pushes a new commit.
        state.set('c1', GREEN);
        return Promise.resolve({ ref: 'c1' });
      },
    });

    expect(report.status).toBe('green');
    expect(report.ref).toBe('c1');
    expect(report.attempts).toEqual([
      {
        attempt: 1,
        model: 'claude-sonnet-5',
        escalated: false,
        from: 'c0',
        to: 'c1',
        mergeable: true,
        summary: 'all required checks passed',
      },
    ]);
    expect(seen[0]?.feedback).toContain('test: failing (test (node 24.x))');
  });

  // Second half: the tier-escalation retry is exercised.
  it('runs only the final attempt one model tier up', async () => {
    const models: string[] = [];

    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      maxAttempts: 3,
      checks: (ref) =>
        Promise.resolve(verdictFor(ref, ref === 'fixed' ? GREEN : withFailure('build'))),
      repair: (request) => {
        models.push(request.model);
        // The stronger model is the one that gets it right.
        return Promise.resolve({
          ref: request.escalated ? 'fixed' : `c${String(request.attempt)}`,
        });
      },
    });

    expect(models).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-opus-5']);
    expect(report.status).toBe('green');
    expect(report.attempts.map((record) => record.escalated)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('records no escalation when the task already runs on the top tier', async () => {
    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-opus-5',
      maxAttempts: 2,
      checks: (ref) => Promise.resolve(verdictFor(ref, withFailure('lint'))),
      repair: (request) => Promise.resolve({ ref: `c${String(request.attempt)}` }),
    });

    expect(report.attempts.map((record) => record.model)).toEqual([
      'claude-opus-5',
      'claude-opus-5',
    ]);
    expect(report.attempts.every((record) => !record.escalated)).toBe(true);
  });

  // Third half: exhaustion escalates to the operator rather than merging or
  // giving up quietly (NFR-1).
  it('blocks the task and escalates when the budget runs out', async () => {
    const events: EventInput[] = [];

    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      maxAttempts: 2,
      checks: (ref) => Promise.resolve(verdictFor(ref, withFailure('scan'))),
      repair: (request) => Promise.resolve({ ref: `c${String(request.attempt)}` }),
      emit: (event) => {
        events.push(event);
      },
    });

    expect(report.status).toBe('exhausted');
    expect(report.reason).toContain('retry budget of 2 attempts exhausted');
    expect(report.attempts).toHaveLength(2);

    const budget = events.find((event) => event.type === 'BudgetExceeded');
    expect(budget?.payload).toEqual({
      taskId: TASK,
      kind: 'repairs',
      limit: 2,
      observed: 2,
    });
    // One verdict logged per look at CI: the first, and one per attempt.
    expect(events.filter((event) => event.type === 'ChecksReported')).toHaveLength(3);
  });

  it('does not spend an attempt on checks that are still running', async () => {
    let repairs = 0;
    const running: CheckRun[] = [
      ...GREEN.filter((run) => run.name !== 'build'),
      { name: 'build', status: 'in_progress', conclusion: null, url: '' },
    ];

    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      checks: (ref) => Promise.resolve(verdictFor(ref, running)),
      repair: () => {
        repairs += 1;
        return Promise.resolve({ ref: 'c1' });
      },
    });

    expect(report.status).toBe('unsettled');
    expect(repairs).toBe(0);
  });

  it('escalates at once when a required check never reported', async () => {
    let repairs = 0;

    const report = await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      // The workflow has no scan job: nothing an agent can fix from its
      // worktree, and three sessions would be spent finding that out.
      checks: (ref) =>
        Promise.resolve(
          verdictFor(
            ref,
            GREEN.filter((run) => run.name !== 'scan'),
          ),
        ),
      repair: () => {
        repairs += 1;
        return Promise.resolve({ ref: 'c1' });
      },
    });

    expect(report.status).toBe('unrepairable');
    expect(report.reason).toContain('scan');
    expect(report.reason).toContain('CI configuration');
    expect(repairs).toBe(0);
  });

  it('feeds the failing check logs back to the agent', async () => {
    const asked: string[] = [];
    let feedback = '';

    await repairUntilGreen({
      runId: RUN,
      taskId: TASK,
      ref: 'c0',
      model: 'claude-sonnet-5',
      maxAttempts: 1,
      logLines: 2,
      checks: (ref) => Promise.resolve(verdictFor(ref, withFailure('typecheck'))),
      logsFor: (checkName) => {
        asked.push(checkName);
        return Promise.resolve('line one\nline two\nline three\n');
      },
      repair: (request) => {
        feedback = request.feedback;
        return Promise.resolve({ ref: 'c1' });
      },
    });

    expect(asked).toEqual(['typecheck']);
    expect(feedback).toContain('--- typecheck (last 2 lines) ---');
    expect(feedback).toContain('line two\nline three');
    expect(feedback).not.toContain('line one');
  });
});

describe('renderFeedback', () => {
  it('tells the agent not to weaken the checks', () => {
    const feedback = renderFeedback({
      verdict: verdictFor('c0', withFailure('test (node 24.x)')),
      attempt: 1,
      attemptsRemaining: 2,
      logs: new Map(),
      logLines: 10,
    });

    expect(feedback).toContain('Do not delete, skip, weaken or exclude a test');
    expect(feedback).toContain('This is repair attempt 1; 2 remain after it.');
  });

  it('keeps the end of a log, where the failure is', () => {
    expect(tail('a\nb\nc\nd\n', 2)).toBe('c\nd');
    expect(tail('a\nb', 5)).toBe('a\nb');
  });
});

describe('awaitChecks', () => {
  it('waits until nothing is still running', async () => {
    const sequence: CheckRun[][] = [
      [],
      [{ name: 'build', status: 'in_progress', conclusion: null, url: '' }],
      GREEN,
    ];
    const slept: number[] = [];

    const settled = await awaitChecks({
      poll: () => Promise.resolve(verdictFor('c0', sequence.shift() ?? GREEN)),
      intervalMs: 5,
      now: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(settled.settled).toBe(true);
    expect(settled.polls).toBe(3);
    expect(slept).toEqual([5, 5]);
  });

  it('gives up rather than reporting an unfinished run as an answer', async () => {
    let clock = 0;

    const settled = await awaitChecks({
      poll: () =>
        Promise.resolve(
          verdictFor('c0', [
            { name: 'build', status: 'queued', conclusion: null, url: '' },
          ]),
        ),
      intervalMs: 10,
      timeoutMs: 25,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    expect(settled.settled).toBe(false);
    expect(settled.verdict.mergeable).toBe(false);
  });

  it('stops early when nothing is ever going to report', async () => {
    // The T3.2.1 run: the branch was pushed, but the workflow only triggers on
    // the trunk and on pull requests into it, so no check run existed for that
    // ref at all. Waiting the full timeout spends half an hour to learn what
    // the first minute knew.
    let clock = 0;
    let polls = 0;

    const settled = await awaitChecks({
      poll: () => {
        polls += 1;
        return Promise.resolve(verdictFor('c0', []));
      },
      intervalMs: 10,
      graceMs: 25,
      timeoutMs: 10_000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    expect(settled.outcome).toBe('no-checks');
    expect(settled.settled).toBe(false);
    // Gave up on the grace period, nowhere near the timeout.
    expect(clock).toBeLessThan(100);
    expect(polls).toBeLessThan(10);
  });

  it('distinguishes a slow start from a ref nothing watches', async () => {
    // A queued workflow has not reported a conclusion, but it has reported a
    // run — so this waits, where the case above does not.
    let clock = 0;

    const settled = await awaitChecks({
      poll: () =>
        Promise.resolve(
          verdictFor('c0', [
            { name: 'build', status: 'queued', conclusion: null, url: '' },
          ]),
        ),
      intervalMs: 10,
      graceMs: 5,
      timeoutMs: 40,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    expect(settled.outcome).toBe('timed-out');
  });

  it('does not mistake an empty report for a clean one', async () => {
    // Right after a push CI has created nothing yet; that is not "no failures".
    let polls = 0;
    const settled = await awaitChecks({
      poll: () => {
        polls += 1;
        return Promise.resolve(verdictFor('c0', polls < 3 ? [] : GREEN));
      },
      intervalMs: 1,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });

    expect(polls).toBe(3);
    expect(settled.settled).toBe(true);
  });
});
