import { describe, expect, it, vi } from 'vitest';
import type { ReleaseArtifact } from './deliver.js';
import {
  DEFAULT_HEALTH_POLICY,
  isHealthy,
  releaseOutcomeSchema,
  runSmokeChecks,
  smokeCheckSchema,
  verifyRelease,
  verifyReleaseInput,
  type Fetcher,
  type SmokeCheck,
} from './verify.js';

function noSleep(): Promise<void> {
  return Promise.resolve();
}

function response(status: number, body: string) {
  return { status, text: () => Promise.resolve(body) };
}

function check(overrides: Partial<SmokeCheck> = {}): SmokeCheck {
  return smokeCheckSchema.parse({
    name: 'homepage',
    url: 'http://localhost:8081/',
    expectIncludes: '2.0.0',
    ...overrides,
  });
}

function artifact(overrides: Partial<ReleaseArtifact> = {}): ReleaseArtifact {
  return {
    version: '1.0.0',
    image: 'mpgm-sample-service:1.0.0',
    digest: 'sha256:aaa',
    changelog: 'Initial release.',
    rollbackTo: null,
    ...overrides,
  };
}

describe('smokeCheckSchema', () => {
  it('rejects a check with nothing to assert about the response body', () => {
    expect(
      smokeCheckSchema.safeParse({
        name: 'homepage',
        url: 'http://localhost:8081/',
        expectIncludes: '',
      }).success,
    ).toBe(false);
  });

  it('defaults expectStatus to 200', () => {
    expect(check().expectStatus).toBe(200);
  });
});

describe('runSmokeChecks', () => {
  it('passes a check whose response matches on the first attempt', async () => {
    const fetcher: Fetcher = () => Promise.resolve(response(200, 'served 2.0.0 today'));
    const results = await runSmokeChecks([check()], DEFAULT_HEALTH_POLICY, {
      fetcher,
      sleep: noSleep,
    });
    expect(results).toEqual([{ name: 'homepage', ok: true, detail: '' }]);
  });

  it('retries a failing check and succeeds once the response turns healthy', async () => {
    let calls = 0;
    const fetcher: Fetcher = () => {
      calls += 1;
      return Promise.resolve(
        calls < 3 ? response(200, 'still 1.0.0') : response(200, 'now 2.0.0'),
      );
    };
    const results = await runSmokeChecks(
      [check()],
      { attempts: 5, intervalMs: 0 },
      { fetcher, sleep: noSleep },
    );
    expect(results).toEqual([{ name: 'homepage', ok: true, detail: '' }]);
    expect(calls).toBe(3);
  });

  it('exhausts its attempts and reports the last failure, not a thrown error', async () => {
    const fetcher: Fetcher = () => Promise.resolve(response(200, 'still 1.0.0'));
    const results = await runSmokeChecks(
      [check()],
      { attempts: 3, intervalMs: 0 },
      { fetcher, sleep: noSleep },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('2.0.0');
  });

  it('fails a check whose status code disagrees, even with the right body', async () => {
    const fetcher: Fetcher = () => Promise.resolve(response(500, 'now 2.0.0'));
    const results = await runSmokeChecks(
      [check()],
      { attempts: 1, intervalMs: 0 },
      { fetcher, sleep: noSleep },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('500');
  });

  it('reports a transport failure (thrown by the fetcher) as a failing result, not an unhandled rejection', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('ECONNREFUSED'));
    const results = await runSmokeChecks(
      [check()],
      { attempts: 1, intervalMs: 0 },
      { fetcher, sleep: noSleep },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('ECONNREFUSED');
  });

  it('carries the check URL and the underlying cause into detail — undici reports only "fetch failed" itself (CONV-3)', async () => {
    const transportError = new Error('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:8099'),
    });
    const fetcher: Fetcher = () => Promise.reject(transportError);
    const results = await runSmokeChecks(
      [check({ url: 'http://127.0.0.1:8099/' })],
      { attempts: 1, intervalMs: 0 },
      { fetcher, sleep: noSleep },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('http://127.0.0.1:8099/');
    expect(results[0]?.detail).toContain('fetch failed');
    expect(results[0]?.detail).toContain('connect ECONNREFUSED 127.0.0.1:8099');
  });

  it('names the timeout and the check URL when a check is aborted, not just "This operation was aborted" (CONV-3)', async () => {
    const fetcher: Fetcher = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const abortError = new Error('This operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    const results = await runSmokeChecks(
      [check({ url: 'http://127.0.0.1:8099/', timeoutMs: 5 })],
      { attempts: 1, intervalMs: 0 },
      { fetcher, sleep: noSleep },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('http://127.0.0.1:8099/');
    expect(results[0]?.detail).toContain('5ms');
  });
});

describe('isHealthy', () => {
  it('fails closed on an empty result set', () => {
    expect(isHealthy([])).toBe(false);
  });

  it('is true only when every check passed', () => {
    expect(
      isHealthy([
        { name: 'a', ok: true, detail: '' },
        { name: 'b', ok: true, detail: '' },
      ]),
    ).toBe(true);
    expect(
      isHealthy([
        { name: 'a', ok: true, detail: '' },
        { name: 'b', ok: false, detail: 'nope' },
      ]),
    ).toBe(false);
  });
});

describe('releaseOutcomeSchema', () => {
  function outcome(
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      env: 'test',
      release: { version: '2.0.0', digest: 'sha256:bbb' },
      decision: 'promoted',
      reason: 'all 1 smoke check(s) passed',
      checks: [{ name: 'homepage', ok: true, detail: '' }],
      rolledBackTo: null,
      verifiedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('accepts a self-consistent promoted outcome', () => {
    expect(releaseOutcomeSchema.safeParse(outcome()).success).toBe(true);
  });

  it('rejects an empty checks array — nothing verified backs no decision (CONV-4, CONV-5)', () => {
    expect(releaseOutcomeSchema.safeParse(outcome({ checks: [] })).success).toBe(false);
  });

  it("rejects decision: 'rolled-back' with rolledBackTo: null — a rollback that names nothing did not happen (CONV-5)", () => {
    expect(
      releaseOutcomeSchema.safeParse(
        outcome({ decision: 'rolled-back', rolledBackTo: null }),
      ).success,
    ).toBe(false);
  });

  it("rejects decision: 'promoted' with a non-null rolledBackTo — promotion and rollback cannot both be true (CONV-5)", () => {
    expect(
      releaseOutcomeSchema.safeParse(
        outcome({
          decision: 'promoted',
          rolledBackTo: { version: '1.0.0', digest: 'sha256:aaa' },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects decision: 'promoted' alongside a failing check — the outcome would contradict its own evidence (CONV-5)", () => {
    expect(
      releaseOutcomeSchema.safeParse(
        outcome({ checks: [{ name: 'homepage', ok: false, detail: 'boom' }] }),
      ).success,
    ).toBe(false);
  });

  it(
    'rejects an env that is not path-safe kebab-case — an outcome that ' +
      'outcome-log.ts#outcomeBasePath would refuse to file cannot be constructed ' +
      'in the first place (CONV-5)',
    () => {
      expect(
        releaseOutcomeSchema.safeParse(outcome({ env: '../../escaped' })).success,
      ).toBe(false);
      expect(releaseOutcomeSchema.safeParse(outcome({ env: 'Prod' })).success).toBe(
        false,
      );
      expect(releaseOutcomeSchema.safeParse(outcome({ env: 'test_1' })).success).toBe(
        false,
      );
    },
  );
});

describe('verifyReleaseInput', () => {
  it('rejects an empty checks array', () => {
    expect(
      verifyReleaseInput.safeParse({
        env: 'test',
        release: { version: '2.0.0', digest: 'sha256:bbb' },
        checks: [],
        previous: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an omitted previous — stated explicitly, not defaulted (CONV-5)', () => {
    expect(
      verifyReleaseInput.safeParse({
        env: 'test',
        release: { version: '2.0.0', digest: 'sha256:bbb' },
        checks: [check()],
      }).success,
    ).toBe(false);
  });
});

describe('verifyRelease', () => {
  const release = { version: '2.0.0', digest: 'sha256:bbb' };
  const previousArtifact = artifact();
  const previousChecks = [check({ name: 'homepage', expectIncludes: '1.0.0' })];

  it('promotes a release whose smoke checks all pass, and never calls rollback', async () => {
    const fetcher: Fetcher = () => Promise.resolve(response(200, 'now serving 2.0.0'));
    const rollback = vi.fn(() => Promise.resolve({}));
    const outcome = await verifyRelease(
      {
        env: 'test',
        release,
        checks: [check()],
        previous: { artifact: previousArtifact, checks: previousChecks },
        policy: { attempts: 1, intervalMs: 0 },
      },
      { fetcher, sleep: noSleep, now: () => '2026-01-01T00:00:00.000Z', rollback },
    );

    expect(outcome.decision).toBe('promoted');
    expect(outcome.rolledBackTo).toBeNull();
    expect(rollback).not.toHaveBeenCalled();
    expect(releaseOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("rolls back automatically when a release's smoke checks fail, and records it — the induced-regression case", async () => {
    // The service never stopped serving the old content — the induced
    // regression: a release that failed to actually take effect. The
    // candidate's check (expects '2.0.0') never passes; the previous
    // release's own check (expects '1.0.0') is satisfied by the very same
    // response once rollback is asked to confirm it.
    const fetcher: Fetcher = () => Promise.resolve(response(200, 'still serving 1.0.0'));
    const rollback = vi.fn(() => Promise.resolve({ up: true }));
    const outcome = await verifyRelease(
      {
        env: 'test',
        release,
        checks: [check()], // expects '2.0.0' — never satisfied below
        previous: { artifact: previousArtifact, checks: previousChecks }, // expects '1.0.0'
        policy: { attempts: 1, intervalMs: 0 },
      },
      { fetcher, sleep: noSleep, now: () => '2026-01-01T00:05:00.000Z', rollback },
    );

    expect(rollback).toHaveBeenCalledWith(previousArtifact);
    expect(outcome.decision).toBe('rolled-back');
    expect(outcome.rolledBackTo).toEqual({ version: '1.0.0', digest: 'sha256:aaa' });
    expect(outcome.checks.every((result) => !result.ok)).toBe(true);
    expect(releaseOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('reports rollback-unavailable rather than pretending to roll back a first release', async () => {
    const fetcher: Fetcher = () => Promise.resolve(response(200, 'broken'));
    const rollback = vi.fn(() => Promise.resolve({}));
    const outcome = await verifyRelease(
      {
        env: 'test',
        release,
        checks: [check()],
        previous: null,
        policy: { attempts: 1, intervalMs: 0 },
      },
      { fetcher, sleep: noSleep, rollback },
    );

    expect(rollback).not.toHaveBeenCalled();
    expect(outcome.decision).toBe('rollback-unavailable');
    expect(outcome.rolledBackTo).toBeNull();
  });

  it('reports rollback-failed rather than asserting rolled-back when the restored release is unhealthy too', async () => {
    const fetcher: Fetcher = () => Promise.resolve(response(500, 'still broken'));
    const rollback = vi.fn(() => Promise.resolve({ up: false }));
    const outcome = await verifyRelease(
      {
        env: 'test',
        release,
        checks: [check()],
        previous: { artifact: previousArtifact, checks: previousChecks },
        policy: { attempts: 1, intervalMs: 0 },
      },
      { fetcher, sleep: noSleep, rollback },
    );

    expect(rollback).toHaveBeenCalledWith(previousArtifact);
    expect(outcome.decision).toBe('rollback-failed');
    expect(outcome.rolledBackTo).toBeNull();
  });

  it('reports rollback-failed, with the underlying error, rather than throwing when rollback itself rejects', async () => {
    // The ordinary failure mode of a real release.deliver#rollback provider
    // (a docker/compose failure, or releaseStatusOutput's own superRefine
    // refusing an inconsistent 'up') is a thrown error. Nothing should
    // escape verifyRelease as an unhandled rejection here — the whole point
    // of 'rollback-failed' is to give this exact case a recorded outcome
    // (DEP-5), not let it vanish before one is produced.
    const fetcher: Fetcher = () => Promise.resolve(response(200, 'still serving 1.0.0'));
    const rollback = vi.fn(() =>
      Promise.reject(new Error('compose up: connection refused')),
    );
    const outcome = await verifyRelease(
      {
        env: 'test',
        release,
        checks: [check()],
        previous: { artifact: previousArtifact, checks: previousChecks },
        policy: { attempts: 1, intervalMs: 0 },
      },
      { fetcher, sleep: noSleep, rollback },
    );

    expect(rollback).toHaveBeenCalledWith(previousArtifact);
    expect(outcome.decision).toBe('rollback-failed');
    expect(outcome.rolledBackTo).toBeNull();
    expect(outcome.reason).toContain('compose up: connection refused');
    expect(releaseOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('re-verifies the previous release against the environment the rollback actually left behind, not before', async () => {
    // The candidate check (expects '2.0.0') is never satisfied by either
    // response below, so it fails regardless of ordering — that part alone
    // cannot tell a correct implementation from one that re-verifies too
    // early. The previous release's check (expects '1.0.0') is what pins
    // the ordering: it only passes once `rollback` has actually been
    // called. An implementation that ran `previous.checks` before calling
    // `rollback` (or against a stale response) would see the environment
    // still broken and report 'rollback-failed' instead.
    let rolledBack = false;
    const rollback = vi.fn(() => {
      rolledBack = true;
      return Promise.resolve({ up: true });
    });
    const fetcher: Fetcher = () =>
      Promise.resolve(
        rolledBack
          ? response(200, 'restored: now serving 1.0.0 again')
          : response(200, 'broken: serving neither version'),
      );
    const outcome = await verifyRelease(
      {
        env: 'test',
        release,
        checks: [check()], // expects '2.0.0'
        previous: { artifact: previousArtifact, checks: previousChecks }, // expects '1.0.0'
        policy: { attempts: 1, intervalMs: 0 },
      },
      { fetcher, sleep: noSleep, rollback },
    );

    expect(rollback).toHaveBeenCalledWith(previousArtifact);
    expect(outcome.decision).toBe('rolled-back');
    expect(outcome.rolledBackTo).toEqual({ version: '1.0.0', digest: 'sha256:aaa' });
  });
});
