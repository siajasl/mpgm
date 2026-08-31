// The fixed sample module: `split.mjs` with the planted rounding defect
// repaired. Copied over `split.mjs` by the adversarial-suite test to show the
// same generated cases going green once the defect is gone — a suite that
// fails whatever the subject does has not caught anything (CONV-6).

/**
 * Split an amount of cents between `ways` recipients.
 *
 * Every recipient gets the same share to within one cent, and the shares add
 * up to the amount: the remainder is distributed rather than rounded away.
 */
export function splitEvenly(totalCents, ways) {
  if (!Number.isInteger(totalCents)) {
    throw new TypeError('totalCents must be an integer number of cents');
  }
  if (totalCents < 0) {
    throw new RangeError('totalCents must not be negative');
  }
  if (!Number.isInteger(ways) || ways < 1) {
    throw new RangeError('ways must be a positive integer');
  }

  const base = Math.floor(totalCents / ways);
  const remainder = totalCents - base * ways;
  return Array.from({ length: ways }, (_unused, index) =>
    index < remainder ? base + 1 : base,
  );
}
