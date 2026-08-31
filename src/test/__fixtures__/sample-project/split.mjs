// A sample project's money splitter, as an implementer would plausibly have
// written it. THE BUG IS PLANTED ON PURPOSE (T3.2.2) — do not fix it here.
// `split.fixed.mjs` is the same module with the fix, and the adversarial
// suite in `src/test/adversarial.test.ts` is expected to fail against this
// file and pass against that one. Fixing it here would leave a test that
// cannot fail, which is worse than no test at all (CONV-6).

/**
 * Split an amount of cents between `ways` recipients.
 *
 * Every recipient gets the same share, and the shares add up to the amount:
 * money is not created or destroyed by dividing it.
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

  // The planted defect: rounding each share independently loses or invents a
  // cent whenever the amount does not divide evenly. Every input the author's
  // own tests used divides evenly, so it never showed.
  const share = Math.round(totalCents / ways);
  return Array.from({ length: ways }, () => share);
}
