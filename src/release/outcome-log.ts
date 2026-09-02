import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { releaseOutcomeSchema, type ReleaseOutcome } from './verify.js';

/**
 * Where DEP-5's "record the outcome" actually lands (DESIGN §4.7).
 *
 * One append-only file per environment, one JSON object per line — the same
 * "append, never rewrite" shape as the kernel's own event log (ADR-2), scaled
 * down to what this module needs: nothing here reads or replays the file as
 * kernel state, so it does not need that log's schema versioning or its
 * reducer. What it must keep is the property that makes "recorded" mean
 * something — every line is validated against {@link releaseOutcomeSchema}
 * before it is written, so a malformed outcome fails loudly at the point that
 * would have written it rather than landing silently and being discovered
 * only when something later tries to read it back (CONV-4).
 */

/** Appends one validated outcome to `path`, creating parent directories and
 * the file itself as needed. */
export function recordOutcome(path: string, outcome: ReleaseOutcome): ReleaseOutcome {
  const validated = releaseOutcomeSchema.parse(outcome);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(validated)}\n`, 'utf8');
  return validated;
}

/**
 * Every outcome recorded at `path`, oldest first. An absent file reads as no
 * outcomes yet, not an error — the same "nothing recorded yet" a fresh
 * environment legitimately starts from.
 */
export function readOutcomes(path: string): ReleaseOutcome[] {
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.map((line) => releaseOutcomeSchema.parse(JSON.parse(line) as unknown));
}
