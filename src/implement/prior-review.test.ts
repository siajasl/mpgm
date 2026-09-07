import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../event/envelope.js';
import { lastReviewOf, renderPriorReview, type PriorReview } from './prior-review.js';

// A full object name, because the tip is always a `rev-parse HEAD` answer and
// comparing two abbreviations would let different commits agree.
const TIP = 'abc123def4567890abc123def4567890abc123de';

function reviewed(overrides: Record<string, unknown> = {}, seq = 1): StoredEvent {
  return {
    seq,
    ts: '2026-09-06T00:00:00.000Z',
    runId: 'r',
    type: 'ChangeReviewed',
    schemaVersion: 1,
    payload: {
      taskId: 'T1',
      reviewTaskId: 'T1-review',
      reviewerRole: 'code-reviewer',
      ref: TIP,
      approved: false,
      summary: 'the env constraint is missing at the input boundary',
      findings: 3,
      deviations: ['CONV-5'],
      declaredDeviations: [],
      undeclaredDeviations: ['CONV-5'],
      ...overrides,
    },
  };
}

function other(seq: number): StoredEvent {
  return {
    seq,
    ts: '2026-09-06T00:00:00.000Z',
    runId: 'r',
    type: 'ToolCallLogged',
    schemaVersion: 1,
    payload: { taskId: 'T1', tool: 'Bash', decision: 'allowed' },
  };
}

describe('which review is still worth carrying', () => {
  it('takes the last one, when it is still about the branch tip', () => {
    const found = lastReviewOf(
      [reviewed({ summary: 'first' }, 1), other(2), reviewed({ summary: 'second' }, 3)],
      'T1',
      TIP,
    );

    expect(found?.summary).toBe('second');
    expect(found?.undeclared).toStrictEqual(['CONV-5']);
  });

  it('takes a review that recorded the commit in the short form a model wrote', () => {
    // The miss this exists to end: T4.1.6's blocking review recorded `ed8541d`
    // and the resuming run asked about the same commit in full, so the carry
    // said nothing on the one task it was built for.
    const found = lastReviewOf([reviewed({ ref: TIP.slice(0, 7) })], 'T1', TIP);

    expect(found?.summary).toContain('the env constraint is missing');
  });

  it('says nothing for a prefix too short to name a commit', () => {
    expect(lastReviewOf([reviewed({ ref: TIP.slice(0, 6) })], 'T1', TIP)).toBeUndefined();
  });

  it('says nothing when the tip has moved since', () => {
    // A rework landed after that review, so some of its points are answered
    // and there is no way to tell which from here. Sending an author to chase
    // what is already fixed is worse than sending it nothing.
    expect(
      lastReviewOf([reviewed()], 'T1', 'f00dcafe0000000000000000000000000000beef'),
    ).toBeUndefined();
  });

  it('does not reach past the last review to an older one that still matches', () => {
    // The newest review is the one nobody acted on. An older one about the
    // same ref is a round that was already answered.
    const found = lastReviewOf(
      [
        reviewed({ summary: 'older, same ref' }, 1),
        reviewed({ summary: 'newest', ref: 'moved-on' }, 2),
      ],
      'T1',
      TIP,
    );

    expect(found).toBeUndefined();
  });

  it('ignores reviews of other tasks', () => {
    expect(
      lastReviewOf([reviewed({ taskId: 'T2', summary: 'not ours' })], 'T1', TIP),
    ).toBeUndefined();
  });

  it('says nothing when no review has happened', () => {
    expect(lastReviewOf([other(1), other(2)], 'T1', TIP)).toBeUndefined();
    expect(lastReviewOf([], 'T1', TIP)).toBeUndefined();
  });

  it('tolerates an event recorded before undeclared deviations were stored', () => {
    // The log is append-only and older runs are still in it.
    const found = lastReviewOf(
      [reviewed({ undeclaredDeviations: undefined })],
      'T1',
      TIP,
    );

    expect(found?.undeclared).toStrictEqual([]);
  });
});

describe('what the resuming author is told', () => {
  const base: PriorReview = {
    reviewTaskId: 'T1-review-3',
    ref: TIP,
    approved: false,
    summary: 'the env constraint is missing at the input boundary',
    undeclared: ['CONV-5'],
  };
  const rendered = renderPriorReview(base);

  it('names the commit and says why the review still applies', () => {
    expect(rendered).toContain(TIP.slice(0, 12));
    expect(rendered).toMatch(/Nothing has been committed since/);
    expect(rendered).toContain('the env constraint is missing at the input boundary');
  });

  it('reports the verdict, either way', () => {
    expect(rendered).toContain('asked for changes');
    expect(renderPriorReview({ ...base, approved: true })).toContain(
      'approved the change',
    );
  });

  it('names the undeclared conventions, and both ways of answering them', () => {
    expect(rendered).toContain('CONV-5');
    expect(rendered).toMatch(/Declaring one is a legitimate answer/);
    expect(rendered).toMatch(/Doing\s+neither is what refuses the merge/);
  });

  it('says nothing about deviations when there were none', () => {
    const clean = renderPriorReview({ ...base, undeclared: [] });
    expect(clean).not.toContain('departed from');
    expect(clean).toContain('the env constraint is missing');
  });

  it('frames the review as evidence rather than as the task', () => {
    // A session told "do what the reviewer said" treats a minor observation as
    // a requirement, and the completion criteria stop being what it is judged
    // against.
    expect(rendered).toMatch(/evidence, not as your task/);
    expect(rendered).toMatch(/things it would merge\s+anyway/);
  });

  it('names no convention the caller did not give it', () => {
    const mentioned = new Set(rendered.match(/\bCONV-[0-9]+\b/g) ?? []);
    expect([...mentioned]).toStrictEqual(['CONV-5']);
  });
});
