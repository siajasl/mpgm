import type { Ballot, VoteRule } from '../playbook/definition.js';

/**
 * Panel vote counting (ORC-4).
 *
 * This is the whole reason a panel is a kernel primitive rather than a prompt:
 * the count is arithmetic over validated outputs, reproducible from the log
 * without re-running anything (ORC-3). A judge whose output does not carry a
 * readable ballot abstains — it is never read as assent, because the failure
 * mode of the opposite convention is a panel that carries because three of its
 * five members malfunctioned.
 */

export interface CastBallot {
  readonly judge: string;
  /** The value read from the judge's output, or null if it did not cast one. */
  readonly value: boolean | string | null;
  /** Why the ballot was spoiled, when it was. */
  readonly spoiled?: string;
}

export interface ApprovalTally {
  readonly type: 'approval';
  readonly rule: VoteRule;
  /** Whether the vote carried under its rule. Gate criteria read this. */
  readonly carried: boolean;
  readonly inFavour: number;
  readonly against: number;
  readonly abstained: number;
  readonly judges: number;
  readonly ballots: readonly CastBallot[];
  readonly summary: string;
}

export interface ChoiceTally {
  readonly type: 'choice';
  readonly rule: VoteRule;
  readonly carried: boolean;
  /** The winning option, or null when the vote tied or nobody voted. */
  readonly winner: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly tied: boolean;
  readonly abstained: number;
  readonly judges: number;
  readonly ballots: readonly CastBallot[];
  readonly summary: string;
}

export type Tally = ApprovalTally | ChoiceTally;

export class TallyError extends Error {}

function readField(output: unknown, field: string): unknown {
  return typeof output === 'object' && output !== null
    ? (output as Record<string, unknown>)[field]
    : undefined;
}

/**
 * Count a panel's ballots.
 *
 * `outputs` is judge id → that judge's validated session output, in the order
 * the judges were declared. The result is a pure function of it, so replaying
 * the log recomputes the same decision.
 */
export function tally(
  ballot: Ballot,
  rule: VoteRule,
  outputs: readonly (readonly [string, unknown])[],
): Tally {
  if (ballot.type === 'approval') {
    if (rule === 'plurality') {
      throw new TallyError(
        `vote rule 'plurality' cannot count an approval ballot: with two outcomes it ` +
          `is 'majority' under another name`,
      );
    }
    return countApproval(ballot.field, rule, outputs);
  }

  if (rule !== 'plurality') {
    throw new TallyError(
      `vote rule '${rule}' cannot count a choice ballot: a majority over more than ` +
        `two options is undefined. Use 'plurality'.`,
    );
  }
  return countChoice(ballot.field, ballot.options, outputs);
}

function countApproval(
  field: string,
  rule: VoteRule,
  outputs: readonly (readonly [string, unknown])[],
): ApprovalTally {
  const ballots: CastBallot[] = [];
  let inFavour = 0;
  let against = 0;
  let abstained = 0;

  for (const [judge, output] of outputs) {
    const value = readField(output, field);
    if (typeof value !== 'boolean') {
      abstained += 1;
      ballots.push({
        judge,
        value: null,
        spoiled: `no boolean '${field}' in this judge's output`,
      });
      continue;
    }
    if (value) {
      inFavour += 1;
    } else {
      against += 1;
    }
    ballots.push({ judge, value });
  }

  const judges = outputs.length;
  // Abstentions are counted in the denominator. One vote in favour and four
  // silences is not a majority of a five-judge panel, however it is phrased.
  const carried =
    rule === 'unanimous' ? judges > 0 && inFavour === judges : inFavour * 2 > judges;

  return {
    type: 'approval',
    rule,
    carried,
    inFavour,
    against,
    abstained,
    judges,
    ballots,
    summary:
      `${String(inFavour)}/${String(judges)} in favour ` +
      `(${String(against)} against, ${String(abstained)} abstained); ` +
      `${rule} rule ${carried ? 'carried' : 'did not carry'}`,
  };
}

function countChoice(
  field: string,
  options: readonly string[],
  outputs: readonly (readonly [string, unknown])[],
): ChoiceTally {
  const counts: Record<string, number> = {};
  for (const option of options) {
    counts[option] = 0;
  }

  const ballots: CastBallot[] = [];
  let abstained = 0;

  for (const [judge, output] of outputs) {
    const value = readField(output, field);
    if (typeof value !== 'string' || !(value in counts)) {
      abstained += 1;
      ballots.push({
        judge,
        value: null,
        spoiled:
          typeof value === 'string'
            ? `voted for '${value}', which is not one of: ${options.join(', ')}`
            : `no string '${field}' in this judge's output`,
      });
      continue;
    }
    counts[value] = (counts[value] ?? 0) + 1;
    ballots.push({ judge, value });
  }

  const best = Math.max(0, ...Object.values(counts));
  const leaders = options.filter((option) => counts[option] === best);
  // A tie is reported as a tie. Breaking it by declaration order would hand the
  // decision to whoever wrote the options list, which is not what was voted on.
  const tied = best === 0 || leaders.length > 1;
  const winner = tied ? null : (leaders[0] ?? null);

  return {
    type: 'choice',
    rule: 'plurality',
    carried: winner !== null,
    winner,
    counts,
    tied,
    abstained,
    judges: outputs.length,
    ballots,
    summary: tied
      ? best === 0
        ? `no valid ballots were cast (${String(abstained)} abstained)`
        : `tied on ${String(best)} vote(s) between: ${leaders.join(', ')}`
      : `'${String(winner)}' won with ${String(best)}/${String(outputs.length)} vote(s)`,
  };
}
