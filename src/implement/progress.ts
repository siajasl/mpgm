/**
 * Progress output from the implement loop (OBS-3, NFR-2).
 *
 * `mpgm implement` runs one plan task through an implementing session, a
 * bounded repair loop, and a bounded review loop — 20 to 40 minutes end to
 * end — and until now printed nothing between dispatch and its final line.
 * An operator watching the terminal could not tell an implementing session
 * from a review, a rework round from a stall, or a run that had never
 * launched from one still in progress; a re-pasted terminal message was once
 * mistaken for a third failed run, and only `mpgm status` showing an unmoved
 * spend figure proved no session had executed.
 *
 * The event log already carries what is needed — `TaskDispatched` and
 * `SessionUsage` land as a run proceeds — but nothing surfaced them to the
 * terminal that started the run. This reports the same two facts (a session
 * starting, a session finishing) directly from the loop, on the terminal
 * that started it, as they happen rather than once the whole task has
 * settled.
 */

/** Which stage of the loop a session belongs to. */
export type SessionKind = 'implement' | 'repair' | 'review' | 'rework';

interface SessionIdentity {
  /** The event-log task id this session was dispatched under. */
  readonly taskId: string;
  readonly kind: SessionKind;
  readonly role: string;
  /**
   * 1-based. `implement` is always round 1; `repair`, `review` and `rework`
   * count the attempt or review round the session belongs to.
   */
  readonly round: number;
}

export interface SessionStarted extends SessionIdentity {
  readonly phase: 'start';
}

export interface SessionFinished extends SessionIdentity {
  readonly phase: 'finish';
  /** `'completed'`, or the reason the runner gave for stopping. */
  readonly outcome: string;
}

export type SessionProgress = SessionStarted | SessionFinished;

/** Reports one session starting or finishing. Called synchronously as it happens. */
export type ProgressReporter = (event: SessionProgress) => void;

/**
 * One terminal line per event.
 *
 * Named by task and kind rather than by role alone: `repair` and `rework`
 * both dispatch the implementer, and a role name alone would not say which
 * stage of the loop is running.
 */
export function renderProgress(event: SessionProgress): string {
  const round = event.round > 1 ? ` round ${String(event.round)}` : '';
  const label = `${event.taskId} — ${event.kind}${round} (${event.role})`;
  return event.phase === 'start'
    ? `${label} starting`
    : `${label} finished: ${event.outcome}`;
}
