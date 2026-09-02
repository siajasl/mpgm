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
});
