import { describe, expect, it } from 'vitest';
import { schedule, SchedulerError, type StepOutcome } from './scheduler.js';

interface Step {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

const step = (id: string, ...dependsOn: string[]): Step => ({ id, dependsOn });

/**
 * A runner that reports what the scheduler actually did, rather than asking
 * the scheduler what it thinks it did. Peak concurrency is measured here, on
 * the outside, because a scheduler grading its own concurrency bound would
 * pass a test it was violating.
 */
function tracker(options: { delayMs?: number; block?: ReadonlySet<string> } = {}) {
  const started: string[] = [];
  const finished: string[] = [];
  let inFlight = 0;
  let peak = 0;

  const run = async (target: Step): Promise<StepOutcome<string>> => {
    started.push(target.id);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1));
    inFlight -= 1;
    finished.push(target.id);
    return options.block?.has(target.id) === true
      ? { status: 'blocked', reason: `${target.id} said no` }
      : { status: 'completed', value: target.id.toUpperCase() };
  };

  return {
    run,
    started,
    finished,
    get peak() {
      return peak;
    },
  };
}

describe('schedule', () => {
  it('runs a dependency chain in order', async () => {
    const track = tracker();
    const report = await schedule({
      steps: [step('c', 'b'), step('b', 'a'), step('a')],
      concurrency: 4,
      run: track.run,
    });

    expect(report.status).toBe('completed');
    expect(track.started).toStrictEqual(['a', 'b', 'c']);
    expect([...report.results]).toStrictEqual([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ]);
    // A chain cannot overlap, whatever the limit allows.
    expect(track.peak).toBe(1);
  });

  it('never exceeds the concurrency cap', async () => {
    for (const concurrency of [1, 2, 3, 7]) {
      const track = tracker({ delayMs: 5 });
      const steps = Array.from({ length: 12 }, (_, index) => step(`s${String(index)}`));

      const report = await schedule({ steps, concurrency, run: track.run });

      expect(report.status).toBe('completed');
      expect(track.finished).toHaveLength(12);
      expect(track.peak).toBeLessThanOrEqual(concurrency);
      // And it does use the room it is given, or the cap is untested.
      expect(track.peak).toBe(Math.min(concurrency, 12));
    }
  });

  it('runs independent steps together and joins them at a collector', async () => {
    const track = tracker({ delayMs: 5 });
    const report = await schedule({
      steps: [step('w1'), step('w2'), step('w3'), step('collect', 'w1', 'w2', 'w3')],
      concurrency: 3,
      run: track.run,
    });

    expect(report.status).toBe('completed');
    expect(track.peak).toBe(3);
    expect(track.started.at(-1)).toBe('collect');
  });

  it('dispatches ready steps in declaration order', async () => {
    const track = tracker();
    await schedule({
      steps: [step('zebra'), step('apple'), step('mango')],
      concurrency: 1,
      run: track.run,
    });

    // Declaration order, not alphabetical and not arrival order: which step
    // goes first is a property of the playbook, not of the runtime.
    expect(track.started).toStrictEqual(['zebra', 'apple', 'mango']);
  });
});

describe('schedule under failure', () => {
  it('stops dispatching new work once a step blocks', async () => {
    // Concurrency 1 so the block is known before anything else could start:
    // with a wider cap the scheduler may legitimately have dispatched an
    // independent step before the failure existed to react to.
    const track = tracker({ delayMs: 5, block: new Set(['b']) });
    const report = await schedule({
      steps: [step('a'), step('b'), step('c', 'b'), step('d'), step('e')],
      concurrency: 1,
      run: track.run,
    });

    expect(report.status).toBe('blocked');
    expect(report.blocked).toStrictEqual([{ id: 'b', reason: 'b said no' }]);
    // 'c' depended on the blocked step, so it could never run; 'd' and 'e'
    // could have, and deliberately did not — the phase is already going back
    // to the operator, so more sessions buy nothing.
    expect(report.skipped).toStrictEqual(['c', 'd', 'e']);
    expect(track.started).toStrictEqual(['a', 'b']);
  });

  it('lets steps already in flight finish', async () => {
    const track = tracker({ delayMs: 5, block: new Set(['a']) });
    const report = await schedule({
      steps: [step('a'), step('b'), step('c')],
      concurrency: 3,
      run: track.run,
    });

    expect(report.status).toBe('blocked');
    // All three were dispatched before the block was known. Abandoning the two
    // survivors would throw away work already paid for.
    expect(track.finished.sort()).toStrictEqual(['a', 'b', 'c']);
    expect([...report.results.keys()].sort()).toStrictEqual(['b', 'c']);
  });

  it('treats a throwing runner as a blocked step, not a hang', async () => {
    const report = await schedule({
      steps: [step('a'), step('b', 'a')],
      concurrency: 2,
      run: () => Promise.reject(new Error('provider exploded')),
    });

    expect(report.status).toBe('blocked');
    expect(report.blocked[0]?.reason).toMatch(/step runner threw: provider exploded/);
    expect(report.skipped).toStrictEqual(['b']);
  });

  it('stops when asked to, and says why', async () => {
    const track = tracker();
    let dispatched = 0;
    const report = await schedule({
      steps: [step('a'), step('b'), step('c')],
      concurrency: 1,
      run: track.run,
      shouldDispatch: () => {
        dispatched += 1;
        return dispatched > 2 ? { proceed: false, reason: 'paused' } : { proceed: true };
      },
    });

    expect(report.status).toBe('stopped');
    expect(report.stoppedReason).toBe('paused');
    expect(report.skipped).toStrictEqual(['c']);
    expect(track.finished).toStrictEqual(['a', 'b']);
  });
});

describe('schedule input validation', () => {
  const track = tracker();

  it('rejects a concurrency below one', async () => {
    await expect(
      schedule({ steps: [step('a')], concurrency: 0, run: track.run }),
    ).rejects.toThrow(SchedulerError);
  });

  it('rejects a dependency on a step that is not in the graph', async () => {
    await expect(
      schedule({ steps: [step('a', 'ghost')], concurrency: 1, run: track.run }),
    ).rejects.toThrow(/depends on 'ghost'/);
  });

  it('rejects duplicate step ids', async () => {
    await expect(
      schedule({ steps: [step('a'), step('a')], concurrency: 1, run: track.run }),
    ).rejects.toThrow(/duplicate ids/);
  });
});
