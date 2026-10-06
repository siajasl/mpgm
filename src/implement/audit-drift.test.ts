import { describe, expect, it } from 'vitest';
import {
  authoredReasons,
  classifyAudit,
  driftReasons,
  meetsSeverity,
  parseNpmAuditAdvisories,
  type Advisory,
} from './audit-drift.js';

function advisory(id: string, pkg: string, severity = 'high'): Advisory {
  return { id, package: pkg, severity, title: `${id} affects ${pkg}` };
}

describe('classifyAudit', () => {
  // T4.3.16 completion criterion, first case: a branch whose diff touches no
  // manifest, against a trunk already carrying a high-severity advisory. The
  // branch did not introduce it — it could not have, since it changed
  // nothing about dependencies — so it must not be refused as the advisory's
  // author. Fails against the unmodified code, because today's `npm audit
  // --audit-level=high` reports the same refusal regardless of who the
  // advisory is about.
  it('does not refuse a branch for an advisory the trunk already carries', () => {
    const sdkAdvisory = advisory('GHSA-6qxp-vccf-f47h', '@modelcontextprotocol/sdk');

    const classification = classifyAudit({
      manifestChanged: false,
      current: [sdkAdvisory],
      trunk: [sdkAdvisory],
    });

    expect(classification.blocked).toBe(false);
    expect(classification.authored).toEqual([]);
    expect(classification.drift).toEqual([sdkAdvisory]);
    expect(driftReasons(classification)).toEqual([
      'GHSA-6qxp-vccf-f47h (@modelcontextprotocol/sdk, high) is already on the trunk — this branch is not its author',
    ]);
  });

  // Second case: a branch that adds a dependency carrying a high-severity
  // advisory the trunk does not have. This is squarely the branch's own
  // finding and must be refused. Fails against the unmodified code for the
  // opposite reason from the first case: nothing distinguishes it from drift
  // either, so a test that only asserts a clean tree passes the audit would
  // never catch this regressing silently.
  it('refuses a branch for an advisory only its own diff introduced', () => {
    const newAdvisory = advisory('GHSA-aaaa-bbbb-cccc', 'left-pad');

    const classification = classifyAudit({
      manifestChanged: true,
      current: [newAdvisory],
      trunk: [],
    });

    expect(classification.blocked).toBe(true);
    expect(classification.authored).toEqual([newAdvisory]);
    expect(classification.drift).toEqual([]);
    expect(authoredReasons(classification)).toEqual([
      'GHSA-aaaa-bbbb-cccc (left-pad, high): GHSA-aaaa-bbbb-cccc affects left-pad',
    ]);
  });

  // A branch that touches the manifest gets no exemption at all, even for an
  // advisory the trunk also happens to carry: editing package.json or
  // package-lock.json is exactly the diff that can introduce a dependency
  // finding, so a branch cannot widen its own exemption by presenting an
  // advisory that is partly the trunk's as proof it owns none of it.
  it('grants no exemption once the branch has touched the manifest, even for a shared advisory', () => {
    const sdkAdvisory = advisory('GHSA-6qxp-vccf-f47h', '@modelcontextprotocol/sdk');

    const classification = classifyAudit({
      manifestChanged: true,
      current: [sdkAdvisory],
      trunk: [sdkAdvisory],
    });

    expect(classification.blocked).toBe(true);
    expect(classification.authored).toEqual([sdkAdvisory]);
    expect(classification.drift).toEqual([]);
  });

  // Mixed case: one advisory the branch inherited and one it introduced.
  // Blocking is decided per advisory, so the drift one does not quietly hide
  // behind the authored one, or vice versa.
  it('separates drift from authored advisories within the same audit', () => {
    const inherited = advisory('GHSA-old-old-old', 'hono');
    const introduced = advisory('GHSA-new-new-new', 'left-pad');

    const classification = classifyAudit({
      manifestChanged: false,
      current: [inherited, introduced],
      trunk: [inherited],
    });

    expect(classification.blocked).toBe(true);
    expect(classification.authored).toEqual([introduced]);
    expect(classification.drift).toEqual([inherited]);
  });

  it('summarizes a clean audit as owing nothing to either list', () => {
    const classification = classifyAudit({
      manifestChanged: false,
      current: [],
      trunk: [],
    });

    expect(classification.blocked).toBe(false);
    expect(classification.summary).toBe('no advisories at or above the floor');
  });
});

describe('meetsSeverity', () => {
  it('ranks severities on npm audit’s own scale', () => {
    expect(meetsSeverity('high', 'high')).toBe(true);
    expect(meetsSeverity('critical', 'high')).toBe(true);
    expect(meetsSeverity('moderate', 'high')).toBe(false);
  });

  it('fails closed on an unrecognised severity by always meeting the floor', () => {
    // CONV-4: an unfamiliar string ranks above every known severity, not
    // below it — the direction that could silently drop a real finding by
    // ranking it beneath the floor and filtering it out unseen. Whatever the
    // floor is, an advisory `npm audit` labelled with something this code
    // does not recognise still meets it and still blocks.
    expect(meetsSeverity('made-up', 'high')).toBe(true);
    expect(meetsSeverity('made-up', 'critical')).toBe(true);
    expect(meetsSeverity('made-up', 'info')).toBe(true);
  });
});

describe('parseNpmAuditAdvisories', () => {
  const report = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      '@modelcontextprotocol/sdk': {
        name: '@modelcontextprotocol/sdk',
        severity: 'high',
        via: [
          {
            source: 1234,
            name: '@modelcontextprotocol/sdk',
            title: 'DNS rebinding in MCP SDK',
            url: 'https://github.com/advisories/GHSA-6qxp-vccf-f47h',
            severity: 'high',
            range: '<1.2.0',
          },
          '@anthropic-ai/claude-agent-sdk',
        ],
      },
      qs: {
        name: 'qs',
        severity: 'moderate',
        via: [
          {
            source: 5678,
            name: 'qs',
            title: 'prototype pollution',
            url: 'https://github.com/advisories/GHSA-moderate-one',
            severity: 'moderate',
            range: '<6.5.3',
          },
        ],
      },
    },
    metadata: { vulnerabilities: { high: 1, moderate: 1, critical: 0, total: 2 } },
  });

  it('extracts one advisory per package at or above the floor, skipping dependency pointers', () => {
    const advisories = parseNpmAuditAdvisories(report, { minSeverity: 'high' });

    expect(advisories).toEqual([
      {
        id: 'GHSA-6qxp-vccf-f47h',
        package: '@modelcontextprotocol/sdk',
        severity: 'high',
        title: 'DNS rebinding in MCP SDK',
      },
    ]);
  });

  it('includes lower-severity advisories once the floor is lowered to admit them', () => {
    const advisories = parseNpmAuditAdvisories(report, { minSeverity: 'moderate' });

    expect(advisories.map((a) => a.package)).toEqual(['@modelcontextprotocol/sdk', 'qs']);
  });

  it('raises a detailed error on output that is not valid JSON, rather than reading it as a clean audit', () => {
    expect(() => parseNpmAuditAdvisories('not json')).toThrow(/could not parse/);
  });

  // [blocker] finding: `npm audit --json` prints this shape and exits
  // non-zero when the audit itself could not be run at all (registry
  // unreachable, proxy/auth failure, offline runner) — it carries no
  // `vulnerabilities` key. Reading that as "nothing found" is a clean pass
  // having examined nothing, which is exactly the "way to merge past a real
  // finding" T4.3.16 forbids. Fails against the code before this fix, which
  // found no `vulnerabilities` object, iterated zero entries, and returned
  // an empty advisory list indistinguishable from a genuinely clean audit.
  it('raises a detailed error on a report that could not be run, rather than reading it as clean', () => {
    const errorReport = JSON.stringify({
      message:
        'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed',
      error: { code: 'ENOTFOUND' },
    });

    expect(() => parseNpmAuditAdvisories(errorReport)).toThrow(
      /did not carry a 'vulnerabilities' list/,
    );
    expect(() => parseNpmAuditAdvisories(errorReport)).toThrow(/registry.npmjs.org/);
  });
});
