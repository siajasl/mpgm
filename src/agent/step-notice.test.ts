import { describe, expect, it } from 'vitest';
import { StepNotice, stepNoticeText, thresholdFor } from './step-notice.js';
import type { ToolDecision, ToolGate } from './session.js';

const allow: ToolGate = () => Promise.resolve({ behavior: 'allow' });

async function callTimes(gate: ToolGate, times: number): Promise<ToolDecision[]> {
  const decisions: ToolDecision[] = [];
  for (let index = 0; index < times; index += 1) {
    decisions.push(await gate('Bash', { command: 'ls' }));
  }
  return decisions;
}

describe('thresholdFor', () => {
  it('leaves a fifth of the budget to land the work in', () => {
    expect(thresholdFor(120)).toBe(96);
    expect(thresholdFor(90)).toBe(72);
  });

  it('still fires on a budget too small to have a fifth of', () => {
    // A role with 1 step gets the notice on its only call rather than never:
    // a threshold of 0 would arm before the session had done anything, and a
    // threshold rounded down to 0 would never be reached at all.
    expect(thresholdFor(1)).toBe(1);
    expect(thresholdFor(6)).toBe(5);
  });
});

describe('StepNotice', () => {
  it('says nothing while the session has room', async () => {
    const gate = new StepNotice(10).gate(allow);
    const decisions = await callTimes(gate, 7);
    expect(decisions.every((decision) => decision.notice === undefined)).toBe(true);
  });

  it('speaks on the call that reaches the threshold', async () => {
    const gate = new StepNotice(10).gate(allow);
    const decisions = await callTimes(gate, 8);
    expect(decisions.slice(0, 7).every((entry) => entry.notice === undefined)).toBe(true);
    // The count and the limit both appear, because a warning that does not say
    // how close is one a session cannot size its response to (CONV-3).
    expect(decisions[7]?.notice).toContain('8 tool calls');
    expect(decisions[7]?.notice).toContain('10 steps');
  });

  it('says it once, because repeating it spends the budget it is warning about', async () => {
    const gate = new StepNotice(10).gate(allow);
    const decisions = await callTimes(gate, 10);
    expect(decisions.filter((entry) => entry.notice !== undefined)).toHaveLength(1);
  });

  it('warns on a refusal without turning it into one', async () => {
    // The session that spends its budget being denied is the one that most
    // needs telling, and an advisory that could change a decision would be a
    // policy nobody would find in the policy.
    const deny: ToolGate = () =>
      Promise.resolve({ behavior: 'deny', reason: 'path refused' });
    const gate = new StepNotice(1).gate(deny);
    const decision = await gate('Write', { file_path: '/etc/passwd' });
    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' && decision.reason).toBe('path refused');
    expect(decision.notice).toBeDefined();
  });

  it('leaves a substituted input alone', async () => {
    // The broker sits underneath, so a notice attached above it must not drop
    // the credential the call below resolved (SAF-2).
    const brokered: ToolGate = () =>
      Promise.resolve({ behavior: 'allow', updatedInput: { command: 'curl -H token' } });
    const gate = new StepNotice(1).gate(brokered);
    const decision = await gate('Bash', { command: 'curl -H ${secret:token}' });
    expect(decision.behavior === 'allow' && decision.updatedInput).toEqual({
      command: 'curl -H token',
    });
    expect(decision.notice).toBeDefined();
  });

  it('counts per instance, so one session cannot spend another session budget', async () => {
    const first = new StepNotice(2).gate(allow);
    await callTimes(first, 2);
    const second = new StepNotice(2).gate(allow);
    const decisions = await callTimes(second, 1);
    expect(decisions[0]?.notice).toBeUndefined();
  });
});

describe('stepNoticeText', () => {
  it('says the session ends without a closing turn, not merely that it ends', () => {
    // A session told only "you are near the limit" has no reason to commit
    // now rather than at the end it expects to reach.
    const text = stepNoticeText(96, 120);
    expect(text).toContain('ends the session immediately');
    expect(text).toContain('commit');
    expect(text).toMatch(/nothing you return is recorded/);
  });
});
