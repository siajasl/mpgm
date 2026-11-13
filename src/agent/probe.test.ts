import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toySummarySchema } from '../demo/schemas.js';
import { loadRoleFile } from '../role/loader.js';
import { designSchema, requiredConcerns } from '../schemas.js';
import { OutputSchemaRegistry } from './output-registry.js';
import {
  defaultProbeExclusions,
  designProbeExclusionReason,
  designProbeFixture,
  probeOutputSchemas,
} from './probe.js';
import { ScriptedProvider, scriptedSuccess } from './scripted-provider.js';
import type { SessionResult } from './session.js';

/**
 * T4.3.20 — `npm run probe:sdk` reported FAIL for `design` against a minimal
 * prompt, because DSG-2's refine demands every cross-cutting concern it
 * names and a minimal session has no reason to supply all of them. These
 * tests cover the fix offline: `probeOutputSchemas` is the loop
 * `scripts/demo/probe-sdk.mjs` runs, with the live provider swapped for a
 * `ScriptedProvider` so nothing here spends a real session or needs
 * credentials.
 */

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'role',
  '__fixtures__',
);
const role = loadRoleFile(join(fixtures, 'valid', 'analyst.md'));

const validToyOutput = { summary: 'placeholder', requirements: ['REQ-1'] };

describe('probeOutputSchemas (T4.3.20)', () => {
  it('reports no failure for a schema it covers, given a schema-valid session', async () => {
    const registry = new OutputSchemaRegistry({ toy: toySummarySchema });
    const provider = new ScriptedProvider([scriptedSuccess(validToyOutput)]);

    const outcomes = await probeOutputSchemas({ registry, provider, role });

    expect(outcomes).toEqual([{ id: 'toy', status: 'ok', detail: '$0.0100' }]);
  });

  it('reports a failure for a schema it covers, when the session returns invalid output', () => {
    // A test that only asserts the probe runs is the test this has always
    // passed (T4.3.20) — this one fails if `probeOutputSchemas` ever stops
    // noticing a bad response.
    const registry = new OutputSchemaRegistry({ toy: toySummarySchema });
    const provider = new ScriptedProvider([
      scriptedSuccess({ summary: 'placeholder', requirements: [] }),
    ]);

    return probeOutputSchemas({ registry, provider, role }).then((outcomes) => {
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.status).toBe('fail');
    });
  });

  it('reports a failure for a schema it covers, when the session never completes', async () => {
    const registry = new OutputSchemaRegistry({ toy: toySummarySchema });
    const failed: SessionResult = scriptedSuccess(null, {
      termination: 'error',
      errorMessage:
        'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
    const provider = new ScriptedProvider([failed]);

    const outcomes = await probeOutputSchemas({ registry, provider, role });

    expect(outcomes).toEqual([
      {
        id: 'toy',
        status: 'fail',
        detail:
          'Failed to authenticate: OAuth session expired and could not be refreshed',
      },
    ]);
  });

  it('fails a minimal session free to improvise, exactly as DSG-2 refuses an incomplete design', async () => {
    // Reproduces the standing bug this task fixes: without the exclusion, a
    // design missing a required concern is rejected, naming DSG-2.
    const registry = new OutputSchemaRegistry({ design: designSchema });
    const incomplete = {
      ...designProbeFixture,
      crossCutting: designProbeFixture.crossCutting.slice(0, 1),
    };
    const provider = new ScriptedProvider([scriptedSuccess(incomplete)]);

    const outcomes = await probeOutputSchemas({ registry, provider, role });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('fail');
    expect(outcomes[0]?.detail).toContain('DSG-2');
  });

  it('excludes design from the live round-trip, names the reason, and spends no request on it', async () => {
    const registry = new OutputSchemaRegistry({
      toy: toySummarySchema,
      design: designSchema,
    });
    // Exactly one scripted result: if the exclusion ever stopped being
    // honoured, 'design' (sorted before 'toy') would try to consume it,
    // 'toy' would find the provider exhausted, and this test would fail.
    const provider = new ScriptedProvider([scriptedSuccess(validToyOutput)]);

    const outcomes = await probeOutputSchemas({
      registry,
      provider,
      role,
      exclusions: defaultProbeExclusions(),
    });

    expect(outcomes).toEqual([
      { id: 'design', status: 'excluded', detail: designProbeExclusionReason },
      { id: 'toy', status: 'ok', detail: '$0.0100' },
    ]);
    expect(provider.requests).toHaveLength(1);
  });

  it('fails a known exclusion whose fixture no longer satisfies its own schema', async () => {
    // The exclusion proves the schema's content path is reachable, not that
    // it is skipped — a fixture that stops satisfying `designSchema` must
    // surface as a probe failure, not a silent pass.
    const registry = new OutputSchemaRegistry({ design: designSchema });
    const broken = { ...designProbeFixture, crossCutting: [] };
    const provider = new ScriptedProvider([]);

    const outcomes = await probeOutputSchemas({
      registry,
      provider,
      role,
      exclusions: { design: { reason: 'stale fixture', fixture: broken } },
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('fail');
    expect(outcomes[0]?.detail).toContain('known exclusion');
    expect(provider.requests).toHaveLength(0);
  });

  it("covers every cross-cutting concern DSG-2 names, so the fixture doesn't drift from it", () => {
    expect(designSchema.safeParse(designProbeFixture).success).toBe(true);
    for (const concern of requiredConcerns) {
      expect(
        designProbeFixture.crossCutting.some((entry) => entry.concern === concern),
      ).toBe(true);
    }
  });
});
