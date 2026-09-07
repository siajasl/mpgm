import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    /**
     * Wall time, on a machine doing other things.
     *
     * Vitest's five seconds is a budget for a test that computes. Most of this
     * suite does not: the worktree, merge, secret-scan, trace and crash-resume
     * tests spawn real `git` and real `node` subprocesses against real
     * temporary repositories, because that is the only way they can fail for
     * the reason they exist. A single `newRepo()` is five process spawns before
     * the test has done anything.
     *
     * Sixty-one files run in parallel and every one of them competes for the
     * same cores, so what a test costs is a fact about the machine rather than
     * about the code under test. Measured on an idle machine, under nothing
     * but the suite's own parallelism, the slowest test in `worktree.test.ts`
     * takes 28.9s and eleven others exceed five seconds. Two suites run at once
     * fail 21 tests in five files, every one of them a timeout and not one an
     * assertion — which is what an operator running the checks while an
     * implement run is going was hitting, three times diagnosed as a mystery.
     *
     * So the budget is set to what the suite actually costs. It bounds a hang,
     * which is all a timeout is for here; the assertions are the check. The
     * hooks get the same, because `afterEach` deletes those repositories and is
     * as subprocess-bound as the tests are.
     *
     * Thirty per-test values came out with it. Ten of them said twenty seconds
     * and were the reason two tests still timed out after this was raised: an
     * explicit budget below the default is a lower budget, not a safer one. The
     * rest said thirty and repeated this line in eighteen places. One remains,
     * in `worktree.test.ts`, and it is larger.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
