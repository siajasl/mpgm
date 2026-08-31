// The implementer's own tests for `split.mjs`, and the reason TST-4 asks for
// a second, adversarial pass: every amount here divides evenly, so all of
// them pass against the planted defect. They are the tests of somebody
// checking that the code does what they meant it to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitEvenly } from './split.mjs';

test('splits a round amount between two', () => {
  assert.deepEqual(splitEvenly(1000, 2), [500, 500]);
});

test('splits a round amount between four', () => {
  assert.deepEqual(splitEvenly(400, 4), [100, 100, 100, 100]);
});

test('gives a single recipient the whole amount', () => {
  assert.deepEqual(splitEvenly(777, 1), [777]);
});

test('refuses a fractional amount', () => {
  assert.throws(() => splitEvenly(10.5, 2), TypeError);
});
