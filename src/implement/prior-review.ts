import type { StoredEvent } from '../event/envelope.js';
import { namesCommit } from './commit-ref.js';

/**
 * What the last run's reviewer said, carried into the run that resumes it.
 *
 * A killed or blocked run leaves its worktree behind and the next run picks it
 * up (DESIGN §6, ORC-5). The code survives; the review does not. `renderReview`
 * feeds findings to a rework session *within* a run, and nothing carries them
 * across one — so a resumed task starts its review from scratch and the first
 * round rediscovers what the last round already reported.
 *
 * T4.1.6's second run paid exactly that: its first review re-found a gap the
 * first run's final review had already named, and the round spent finding it
 * again was a round not spent fixing it.
 *
 * Only the *last* review is carried, and only when its ref is still the branch
 * tip. That guard is the whole safety property: if nothing has been committed
 * since the reviewer looked, every point it made still stands. If the tip has
 * moved, a rework already answered some of them and there is no way to tell
 * which from here — so this says nothing rather than sending an author to
 * chase what is already fixed.
 */

/**
 * The event log keeps a review's `summary` and its deviations as text, but
 * `findings` only as a count — so this carries the prose, which is where the
 * reviewers in practice put the specifics, and the deviations, which are
 * exactly what a resumed run needs in order to declare rather than rediscover.
 */
export interface PriorReview {
  readonly reviewTaskId: string;
  readonly ref: string;
  readonly approved: boolean;
  readonly summary: string;
  readonly undeclared: readonly string[];
}

interface ReviewPayload {
  readonly taskId: string;
  readonly reviewTaskId: string;
  readonly ref: string;
  readonly approved: boolean;
  readonly summary: string;
  readonly undeclaredDeviations?: readonly string[];
}

/**
 * The most recent review of `taskId` that is still about `tip`, if any.
 *
 * Scans backwards because the last review is the one whose findings nobody
 * acted on: the run blocked immediately after it.
 */
export function lastReviewOf(
  events: readonly StoredEvent[],
  taskId: string,
  tip: string,
): PriorReview | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'ChangeReviewed') {
      continue;
    }
    const payload = event.payload as ReviewPayload;
    if (payload.taskId !== taskId) {
      continue;
    }
    // The first one found going backwards is the last one recorded. If it is
    // about a different commit, a later rework answered it and this returns
    // nothing rather than guessing which parts survived.
    //
    // Compared by the commit named rather than by the string, because the log
    // holds refs a model typed and models abbreviate. This once compared
    // `ed8541d` against the same commit written out in full, found no match,
    // and told a resuming author nothing.
    return namesCommit(payload.ref, tip)
      ? {
          reviewTaskId: payload.reviewTaskId,
          ref: payload.ref,
          approved: payload.approved,
          summary: payload.summary,
          undeclared: payload.undeclaredDeviations ?? [],
        }
      : undefined;
  }
  return undefined;
}

/**
 * What a resuming author is told about the review it inherited.
 *
 * Framed as evidence rather than instruction. The reviewer was looking at this
 * exact commit and is not here to be argued with, but it is also not the task:
 * the completion criteria are, and a session told "do what the reviewer said"
 * would treat a minor observation as a requirement.
 */
export function renderPriorReview(prior: PriorReview): string {
  const lines = [
    `A reviewer has already looked at this branch, at the commit it is still on`,
    `(${prior.ref.slice(0, 12)}). Nothing has been committed since, so everything`,
    `it said still applies. It ${prior.approved ? 'approved the change' : 'asked for changes'}.`,
    '',
    'What it said:',
    '',
    prior.summary.trim(),
  ];

  if (prior.undeclared.length > 0) {
    lines.push(
      '',
      'It reported these conventions as departed from, and the change had not',
      'declared them:',
      ...prior.undeclared.map((entry) => `- ${entry}`),
      '',
      'Declaring one is a legitimate answer (IMP-4) and so is fixing it. Doing',
      'neither is what refuses the merge.',
    );
  }

  lines.push(
    '',
    'Read this as evidence, not as your task — the completion criteria above are',
    'that. A reviewer notices things worth knowing and things it would merge',
    'anyway, and it is not here to tell them apart for you. What it saves you is',
    'finding them a second time.',
  );

  return lines.join('\n');
}
