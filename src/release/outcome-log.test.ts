import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOutcomes, recordOutcome } from './outcome-log.js';
import type { ReleaseOutcome } from './verify.js';

const tempDirs: string[] = [];

function outcomePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-outcome-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'test.jsonl');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function outcome(overrides: Partial<ReleaseOutcome> = {}): ReleaseOutcome {
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

describe('recordOutcome / readOutcomes', () => {
  it('reads an absent log as no outcomes yet, not an error', () => {
    expect(readOutcomes(outcomePath())).toEqual([]);
  });

  it('creates parent directories and appends a validated outcome', () => {
    const path = outcomePath();
    recordOutcome(path, outcome());
    expect(readOutcomes(path)).toEqual([outcome()]);
  });

  it('appends rather than overwrites — every outcome stays, oldest first', () => {
    const path = outcomePath();
    recordOutcome(path, outcome({ release: { version: '1.0.0', digest: 'sha256:aaa' } }));
    recordOutcome(
      path,
      outcome({
        release: { version: '2.0.0', digest: 'sha256:bbb' },
        decision: 'rolled-back',
        reason: 'smoke checks failed; rolled back',
        rolledBackTo: { version: '1.0.0', digest: 'sha256:aaa' },
      }),
    );

    const recorded = readOutcomes(path);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.release.version).toBe('1.0.0');
    expect(recorded[1]?.decision).toBe('rolled-back');
  });

  it('refuses to record something releaseOutcomeSchema does not allow (fail closed)', () => {
    expect(() => recordOutcome(outcomePath(), outcome({ reason: '' }))).toThrow();
  });
});
