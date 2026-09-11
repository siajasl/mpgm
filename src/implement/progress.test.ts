import { describe, expect, it } from 'vitest';
import { renderProgress, type SessionProgress } from './progress.js';

describe('one line per session, for a terminal (OBS-3, NFR-2)', () => {
  it('says a session is starting, named by task and kind', () => {
    const event: SessionProgress = {
      phase: 'start',
      taskId: 'T4.2.3',
      kind: 'implement',
      role: 'implementer',
      round: 1,
    };
    expect(renderProgress(event)).toBe('T4.2.3 — implement (implementer) starting');
  });

  it('says a session finished, and with what it reported', () => {
    const event: SessionProgress = {
      phase: 'finish',
      taskId: 'T4.2.3',
      kind: 'implement',
      role: 'implementer',
      round: 1,
      outcome: 'completed',
    };
    expect(renderProgress(event)).toBe(
      'T4.2.3 — implement (implementer) finished: completed',
    );
  });

  it('carries the blocked reason rather than only saying a session ended', () => {
    // An operator watching the terminal cannot tell a stall from a session
    // that blocked unless the reason is right there — the whole gap this
    // closes.
    const event: SessionProgress = {
      phase: 'finish',
      taskId: 'T4.2.3',
      kind: 'review',
      role: 'code-reviewer',
      round: 1,
      outcome: 'session terminated: max_turns',
    };
    expect(renderProgress(event)).toContain('finished: session terminated: max_turns');
  });

  it('distinguishes repair and rework from implement, though all three dispatch the same role', () => {
    // `repair` and `rework` both dispatch the implementer role, so the role
    // name alone cannot tell an operator which stage of the loop is running —
    // the kind has to.
    const repair: SessionProgress = {
      phase: 'start',
      taskId: 'T4.2.3',
      kind: 'repair',
      role: 'implementer',
      round: 1,
    };
    const rework: SessionProgress = {
      phase: 'start',
      taskId: 'T4.2.3',
      kind: 'rework',
      role: 'implementer',
      round: 1,
    };
    expect(renderProgress(repair)).toContain('repair');
    expect(renderProgress(rework)).toContain('rework');
    expect(renderProgress(repair)).not.toBe(renderProgress(rework));
  });

  it('names the round once it is more than the first', () => {
    const first: SessionProgress = {
      phase: 'start',
      taskId: 'T4.2.3',
      kind: 'review',
      role: 'code-reviewer',
      round: 1,
    };
    const second: SessionProgress = { ...first, round: 2 };
    expect(renderProgress(first)).not.toMatch(/round/);
    expect(renderProgress(second)).toContain('round 2');
  });
});
