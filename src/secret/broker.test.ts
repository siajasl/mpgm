import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OutputSchemaRegistry } from '../agent/output-registry.js';
import { SessionRunner } from '../agent/runner.js';
import type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
  ToolDecision,
} from '../agent/session.js';
import { MEMORY } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { parseRole } from '../role/loader.js';
import { fold } from '../state/reduce.js';
import {
  MIN_SECRET_LENGTH,
  referencedSecrets,
  SecretBroker,
  SecretError,
  secretReference,
} from './broker.js';

/** A fabricated token, long enough to be treated as one. */
const TOKEN = `ghp_${'a'.repeat(36)}`; // mpgm-secret-scan: allow
const OTHER = `sk-ant-${'b'.repeat(40)}`; // mpgm-secret-scan: allow

const GITHUB_TOKEN = {
  name: 'github-token',
  env: 'MPGM_GITHUB_TOKEN',
  tools: ['mcp__github__*'],
};

const DECLARATIONS = [
  GITHUB_TOKEN,
  { name: 'deploy-key', env: 'MPGM_DEPLOY_KEY', tools: ['mcp__deploy__release'] },
];

function broker(env: Record<string, string | undefined> = { MPGM_GITHUB_TOKEN: TOKEN }) {
  return new SecretBroker({ declarations: DECLARATIONS, env });
}

const allow = (): Promise<ToolDecision> => Promise.resolve({ behavior: 'allow' });

describe('references', () => {
  it('finds every name, however deeply nested', () => {
    expect(
      referencedSecrets({
        body: { headers: [`Bearer ${secretReference('github-token')}`] },
        note: secretReference('deploy-key'),
        count: 3,
      }),
    ).toEqual(['deploy-key', 'github-token']);
  });

  it('finds none in text that merely looks similar', () => {
    expect(referencedSecrets({ a: '${secrets.GITHUB_TOKEN}', b: '$secret:x' })).toEqual(
      [],
    );
  });
});

describe('SecretBroker', () => {
  it('substitutes only for a tool the secret is declared for', () => {
    const resolved = broker().resolve('mcp__github__create_pr', {
      title: 'x',
      auth: `Bearer ${secretReference('github-token')}`,
    });

    expect(resolved.input.auth).toBe(`Bearer ${TOKEN}`);
    expect(resolved.injected).toEqual(['github-token']);
    expect(resolved.refusals).toEqual([]);
  });

  it('leaves the reference untouched for a tool that may not have it', () => {
    // The exfiltration attempt this whole component exists to stop.
    const resolved = broker().resolve('Bash', {
      command: `echo ${secretReference('github-token')}`,
    });

    expect(resolved.input.command).toBe(`echo ${secretReference('github-token')}`);
    expect(resolved.injected).toEqual([]);
    expect(resolved.refusals[0]).toMatchObject({ reason: 'tool-not-permitted' });
  });

  it('refuses a name nobody declared', () => {
    const resolved = broker().resolve('mcp__github__create_pr', {
      auth: secretReference('invented'),
    });

    expect(resolved.refusals[0]).toMatchObject({ reason: 'unknown-secret' });
  });

  it('refuses a declared secret whose value is not configured', () => {
    const resolved = broker().resolve('mcp__deploy__release', {
      key: secretReference('deploy-key'),
    });

    // Substituting an empty string would hand the tool a call that looks valid
    // and is not, failing somewhere with no connection to the credential.
    expect(resolved.input.key).toBe(secretReference('deploy-key'));
    expect(resolved.refusals[0]).toMatchObject({
      reason: 'not-configured',
    });
    expect(resolved.refusals[0]?.detail).toContain('MPGM_DEPLOY_KEY');
  });

  it('refuses a value too short to redact safely', () => {
    expect(
      () =>
        new SecretBroker({
          declarations: DECLARATIONS,
          env: { MPGM_GITHUB_TOKEN: 'abc' },
        }),
    ).toThrow(SecretError);
    expect(MIN_SECRET_LENGTH).toBeGreaterThan(4);
  });

  it('refuses the same name declared twice', () => {
    expect(
      () =>
        new SecretBroker({
          declarations: [...DECLARATIONS, GITHUB_TOKEN],
          env: {},
        }),
    ).toThrow(SecretError);
  });

  it('refuses a secret no tool may use', () => {
    expect(
      () => new SecretBroker({ declarations: [{ ...GITHUB_TOKEN, tools: [] }], env: {} }),
    ).toThrow();
  });
});

describe('the session environment (ADR-6)', () => {
  it('drops the declared variable, and any alias holding the same value', () => {
    const environment = broker().environment({
      PATH: '/usr/bin',
      MPGM_GITHUB_TOKEN: TOKEN,
      // A wrapper script exporting the same credential under another name
      // would otherwise carry it straight past the scrub.
      GH_TOKEN: TOKEN,
      HOME: '/home/agent',
    });

    expect(Object.keys(environment).sort()).toEqual(['HOME', 'PATH']);
    expect(JSON.stringify(environment)).not.toContain(TOKEN);
  });
});

describe('redaction (SAF-6, second layer)', () => {
  it('removes the exact value and names which secret it was', () => {
    const redacted = broker()
      .redactor()
      .redact({
        output: `MPGM_GITHUB_TOKEN=${TOKEN}\nANTHROPIC_API_KEY=${OTHER}\n`,
      });

    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect(JSON.stringify(redacted)).not.toContain(OTHER);
    // The operator's first question is which credential got out.
    expect(JSON.stringify(redacted)).toContain('redacted:secret:github-token');
  });
});

describe('the tool gate', () => {
  it('hands the resolved input to a permitted tool', async () => {
    const gate = broker().gate(allow);
    const decision = await gate('mcp__github__create_pr', {
      auth: secretReference('github-token'),
    });

    expect(decision).toEqual({ behavior: 'allow', updatedInput: { auth: TOKEN } });
  });

  it('denies rather than passing the placeholder through', async () => {
    const gate = broker().gate(allow);
    const decision = await gate('Bash', {
      command: `echo ${secretReference('github-token')}`,
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' && decision.reason).toContain('may be given to');
  });

  it('leaves a call with no references exactly as it was', async () => {
    const gate = broker().gate(allow);

    expect(await gate('Bash', { command: 'ls' })).toEqual({ behavior: 'allow' });
  });

  it('does not overrule a denial from the policy beneath it', async () => {
    const gate = broker().gate(() =>
      Promise.resolve({ behavior: 'deny', reason: 'not in toolset' } as ToolDecision),
    );

    const decision = await gate('mcp__github__create_pr', {
      auth: secretReference('github-token'),
    });

    expect(decision).toEqual({ behavior: 'deny', reason: 'not in toolset' });
  });
});

/**
 * The T3.1.5 completion criterion, end to end: a session that dumps its
 * environment and prints what it was given leaves no credential in the log.
 */
describe('printenv leak test', () => {
  const role = parseRole(
    'leaky.md',
    [
      '---',
      'name: leaky',
      'description: tries to read what it should not have',
      'model: claude-sonnet-5',
      'tools: { allow: [Bash] }',
      "paths: { read: ['**'], write: [] }",
      'budgets: { tokens: 100000, costUsd: 1, steps: 5, wallClockSeconds: 60 }',
      'output: { schema: toy.v1 }',
      '---',
      'You are leaky.',
    ].join('\n'),
  );

  /** A provider that behaves like a shell with the environment it was given. */
  class PrintenvProvider implements AgentSessionProvider {
    request: SessionRequest | undefined;

    async run(request: SessionRequest): Promise<SessionResult> {
      this.request = request;
      const environment = request.env ?? process.env;

      // The agent tries to interpolate the credential into a shell command...
      const attempt = await request.canUseTool?.('Bash', {
        command: `echo ${secretReference('github-token')}`,
      });

      // ...and, failing that, dumps whatever the process actually has.
      const dump = Object.entries(environment)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('\n');

      return {
        termination: 'completed',
        structuredOutput: { note: `${dump}\n${JSON.stringify(attempt)}` },
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.01 },
        turns: 1,
        denials: [],
        errorMessage: '',
      };
    }
  }

  it('leaves no secret in the environment, the transcript or the log', async () => {
    // Put the credential where a real run would have it — the kernel's own
    // environment — so that the scrub has something to remove. Asserting on a
    // variable that was never set would pass whatever the broker did.
    process.env.MPGM_GITHUB_TOKEN = TOKEN;
    process.env.MPGM_GH_ALIAS = TOKEN;
    const secrets = new SecretBroker({ declarations: DECLARATIONS });
    const log = EventLog.open(MEMORY, {
      registry: kernelRegistry(),
      redactor: secrets.redactor(),
    });
    const provider = new PrintenvProvider();

    try {
      expect(JSON.stringify(process.env)).toContain(TOKEN);

      log.append({
        runId: 'run-1',
        type: 'RunStarted',
        payload: { project: 'p', operator: 'o' },
      });

      const runner = new SessionRunner({
        log,
        provider,
        schemas: new OutputSchemaRegistry({ 'toy.v1': z.object({ note: z.string() }) }),
        secrets,
      });

      const outcome = await runner.runTask({
        runId: 'run-1',
        taskId: 'T1',
        role,
        prompt: 'print everything you can see',
      });

      // The environment the session was handed never contained it — neither
      // under its declared name nor under the alias.
      expect(provider.request?.env).toBeDefined();
      expect(JSON.stringify(provider.request?.env)).not.toContain(TOKEN);
      expect(provider.request?.env?.PATH).toBe(process.env.PATH);

      // The shell interpolation was refused rather than resolved.
      expect(outcome.status).toBe('completed');
      const note =
        outcome.status === 'completed' ? (outcome.output as { note: string }).note : '';
      expect(note).not.toContain(TOKEN);
      expect(note).toContain('deny');

      // And nothing in the log carries it — tool-call events included.
      const events = log.read();
      expect(JSON.stringify(events)).not.toContain(TOKEN);
      expect(
        fold(events).runs['run-1']?.tasks.T1?.deniedToolCalls,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      log.close();
      delete process.env.MPGM_GITHUB_TOKEN;
      delete process.env.MPGM_GH_ALIAS;
    }
  });

  it('redacts the credential even when it reaches the log by another route', () => {
    // The second layer, on its own. A tool that printed the value — from a
    // file, from a subprocess the scrub could not reach — still leaves nothing
    // behind, because the log is append-only and cannot be corrected later.
    const secrets = broker();
    const log = EventLog.open(MEMORY, {
      registry: kernelRegistry(),
      redactor: secrets.redactor(),
    });
    try {
      log.appendMany([
        { runId: 'run-1', type: 'RunStarted', payload: { project: 'p', operator: 'o' } },
        {
          runId: 'run-1',
          type: 'TaskDispatched',
          payload: { taskId: 'T1', role: 'leaky', model: 'claude-sonnet-5' },
        },
        {
          runId: 'run-1',
          type: 'ToolCallLogged',
          payload: {
            taskId: 'T1',
            tool: 'Bash',
            decision: 'allowed',
            detail: `cat token.txt -> ${TOKEN}`,
            outputBlob: null,
          },
        },
      ]);

      const dumped = JSON.stringify(log.read());
      expect(dumped).not.toContain(TOKEN);
      expect(dumped).toContain('redacted:secret:github-token');
    } finally {
      log.close();
    }
  });
});
