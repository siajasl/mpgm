import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY, openDatabase } from '../database.js';
import { kernelRegistry } from '../event/catalog.js';
import { EventLog } from '../event/store.js';
import { Projector } from '../state/projector.js';
import { SnapshotStore } from '../state/snapshot-store.js';
import { EffectContractRegistry } from './contract.js';
import { EffectJournal } from './journal.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '__fixtures__', 'effect-crasher.mjs');
const builtPackage = join(here, '..', '..', 'dist', 'index.js');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpgm-effect-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function harness(contracts: EffectContractRegistry) {
  const db = openDatabase(MEMORY);
  const log = EventLog.attach(db, { registry: kernelRegistry() });
  const snapshots = SnapshotStore.attach(db);
  const projector = new Projector({ log, snapshots, interval: 50 });
  let counter = 0;
  const journal = new EffectJournal({
    log,
    contracts,
    newIntentId: () => `intent-${String((counter += 1))}`,
  });

  log.append({
    runId: 'run-1',
    type: 'RunStarted',
    payload: { project: 'mpgm', operator: 'op' },
  });
  log.append({
    runId: 'run-1',
    type: 'TaskDispatched',
    payload: { taskId: 'T1', role: 'implementer', model: 'claude-opus-5' },
  });

  return { db, log, projector, journal };
}

const request = {
  runId: 'run-1',
  taskId: 'T1',
  contract: 'demo',
  operation: 'act',
} as const;

describe('EffectJournal.perform', () => {
  it('records the intent before the effect runs', async () => {
    const contracts = new EffectContractRegistry([
      { contract: 'demo', operation: 'act', semantics: 'idempotent' },
    ]);
    const { db, log, journal } = harness(contracts);
    try {
      let typesAtEffectTime: string[] = [];

      await journal.perform(request, () => {
        typesAtEffectTime = log.read().map((event) => event.type);
        return Promise.resolve('done');
      });

      // The intent was already durable when the effect ran.
      expect(typesAtEffectTime).toContain('EffectIntended');
      expect(typesAtEffectTime).not.toContain('EffectCompleted');
      expect(log.read().map((event) => event.type)).toContain('EffectCompleted');
    } finally {
      db.close();
    }
  });

  it('records a failure and rethrows when the effect throws', async () => {
    const contracts = new EffectContractRegistry([
      { contract: 'demo', operation: 'act', semantics: 'idempotent' },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      await expect(
        journal.perform(request, () => Promise.reject(new Error('network down'))),
      ).rejects.toThrow('network down');

      const effect = projector.project().runs['run-1']?.effects['intent-1'];
      expect(effect?.status).toBe('failed');
      expect(effect?.detail).toBe('network down');
      expect(log.read().map((event) => event.type)).toContain('EffectFailed');
    } finally {
      db.close();
    }
  });

  it('leaves nothing pending after a completed effect', async () => {
    const contracts = new EffectContractRegistry([
      { contract: 'demo', operation: 'act', semantics: 'idempotent' },
    ]);
    const { db, projector, journal } = harness(contracts);
    try {
      await journal.perform(request, () => Promise.resolve(1));

      expect(journal.pending(projector.project())).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('EffectJournal.resolvePending', () => {
  /** Append a bare intent, as a crash would leave behind. */
  function orphanIntent(log: EventLog, contract: string, operation: string): void {
    log.append({
      runId: 'run-1',
      type: 'EffectIntended',
      payload: {
        intentId: 'orphan-1',
        taskId: 'T1',
        contract,
        operation,
        params: {},
      },
    });
  }

  it('treats a landed effect as complete rather than retrying it', async () => {
    const contracts = new EffectContractRegistry([
      {
        contract: 'demo',
        operation: 'act',
        semantics: 'checkable',
        check: () => Promise.resolve(true),
      },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      orphanIntent(log, 'demo', 'act');

      const [report] = await journal.resolvePending(projector.project());

      expect(report?.resolution).toBe('already-landed');
      expect(projector.project().runs['run-1']?.effects['orphan-1']?.status).toBe(
        'completed',
      );
    } finally {
      db.close();
    }
  });

  it('allows a retry when the check proves the effect did not land', async () => {
    const contracts = new EffectContractRegistry([
      {
        contract: 'demo',
        operation: 'act',
        semantics: 'checkable',
        check: () => Promise.resolve(false),
      },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      orphanIntent(log, 'demo', 'act');

      const [report] = await journal.resolvePending(projector.project());

      expect(report?.resolution).toBe('safe-to-retry');
      expect(projector.project().runs['run-1']?.effects['orphan-1']?.status).toBe(
        'failed',
      );
    } finally {
      db.close();
    }
  });

  it('escalates when the check itself fails', async () => {
    const contracts = new EffectContractRegistry([
      {
        contract: 'demo',
        operation: 'act',
        semantics: 'checkable',
        check: () => Promise.reject(new Error('api unreachable')),
      },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      orphanIntent(log, 'demo', 'act');

      const [report] = await journal.resolvePending(projector.project());

      // A check that threw told us nothing; guessing risks a double effect.
      expect(report?.resolution).toBe('needs-operator');
      expect(report?.detail).toContain('api unreachable');
      expect(projector.project().runs['run-1']?.effects['orphan-1']?.status).toBe(
        'escalated',
      );
    } finally {
      db.close();
    }
  });

  it('retries an idempotent effect without asking', async () => {
    const contracts = new EffectContractRegistry([
      { contract: 'demo', operation: 'act', semantics: 'idempotent' },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      orphanIntent(log, 'demo', 'act');

      const [report] = await journal.resolvePending(projector.project());

      expect(report?.resolution).toBe('safe-to-retry');
    } finally {
      db.close();
    }
  });

  it('compensates before allowing a retry', async () => {
    const compensated: string[] = [];
    const contracts = new EffectContractRegistry([
      {
        contract: 'demo',
        operation: 'act',
        semantics: 'compensatable',
        compensate: (intent) => {
          compensated.push(intent.intentId);
          return Promise.resolve();
        },
      },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      orphanIntent(log, 'demo', 'act');

      const [report] = await journal.resolvePending(projector.project());

      expect(compensated).toStrictEqual(['orphan-1']);
      expect(report?.resolution).toBe('safe-to-retry');
    } finally {
      db.close();
    }
  });

  it('escalates a manual contract and an unregistered one', async () => {
    const contracts = new EffectContractRegistry([
      { contract: 'demo', operation: 'act', semantics: 'manual' },
    ]);
    const { db, log, projector, journal } = harness(contracts);
    try {
      orphanIntent(log, 'demo', 'act');
      const [manual] = await journal.resolvePending(projector.project());
      expect(manual?.resolution).toBe('needs-operator');

      log.append({
        runId: 'run-1',
        type: 'EffectIntended',
        payload: {
          intentId: 'orphan-2',
          taskId: 'T1',
          contract: 'nobody',
          operation: 'knows',
          params: {},
        },
      });
      const reports = await journal.resolvePending(projector.project());

      expect(reports).toHaveLength(1);
      expect(reports[0]?.resolution).toBe('needs-operator');
      expect(reports[0]?.detail).toContain('no contract registered');
    } finally {
      db.close();
    }
  });

  it('is a no-op when nothing is pending', async () => {
    const contracts = new EffectContractRegistry([
      { contract: 'demo', operation: 'act', semantics: 'idempotent' },
    ]);
    const { db, projector, journal } = harness(contracts);
    try {
      expect(await journal.resolvePending(projector.project())).toStrictEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('EffectContractRegistry', () => {
  it('rejects a contract that cannot honour its own semantics', () => {
    expect(
      () =>
        new EffectContractRegistry([
          { contract: 'a', operation: 'b', semantics: 'checkable' },
        ]),
    ).toThrow(/checkable but declares no check/);

    expect(
      () =>
        new EffectContractRegistry([
          { contract: 'a', operation: 'b', semantics: 'compensatable' },
        ]),
    ).toThrow(/compensatable but declares no compensate/);
  });

  it('rejects duplicates', () => {
    const one = { contract: 'a', operation: 'b', semantics: 'idempotent' } as const;
    expect(() => new EffectContractRegistry([one, one])).toThrow(/duplicate/);
  });
});

describe('crash between intent and effect', () => {
  beforeAll(() => {
    if (!existsSync(builtPackage)) {
      throw new Error(
        `dist/index.js is missing — this fixture runs against the build. Run 'npm run build'.`,
      );
    }
  });

  /** Run the crasher until it reaches the crash window, then SIGKILL it. */
  async function crashInWindow(
    dbPath: string,
    markerPath: string,
    mode: 'before' | 'after',
  ): Promise<NodeJS.Signals | null> {
    const child = spawn(process.execPath, [fixture, dbPath, markerPath, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes('ready')) {
        child.kill('SIGKILL');
      }
    });

    return new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.on('exit', (_code, signal) => {
        resolve(signal);
      });
      child.on('error', reject);
    });
  }

  /** A contract that can tell whether the marker file was written. */
  function markerContracts(): EffectContractRegistry {
    return new EffectContractRegistry([
      {
        contract: 'demo.effect',
        operation: 'createMarker',
        semantics: 'checkable',
        check: (intent) => Promise.resolve(existsSync(String(intent.params.marker))),
      },
    ]);
  }

  for (const [mode, expected, expectedStatus] of [
    ['before', 'safe-to-retry', 'failed'],
    ['after', 'already-landed', 'completed'],
  ] as const) {
    it(`resolves an intent orphaned ${mode} the effect to ${expected}`, async () => {
      const dir = tempDir();
      const dbPath = join(dir, 'state.db');
      const markerPath = join(dir, 'marker.txt');

      const signal = await crashInWindow(dbPath, markerPath, mode);
      expect(signal).toBe('SIGKILL');

      // Restart: reopen the log, fold, and see what was left dangling.
      const db = openDatabase(dbPath);
      try {
        const log = EventLog.attach(db, { registry: kernelRegistry() });
        const projector = new Projector({
          log,
          snapshots: SnapshotStore.attach(db),
          interval: 50,
        });
        const journal = new EffectJournal({ log, contracts: markerContracts() });
        const state = projector.project();

        // The crash left exactly one intent whose outcome is unknown.
        const pending = journal.pending(state);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.intentId).toBe('intent-fixed-0001');

        const [report] = await journal.resolvePending(state);

        expect(report?.resolution).toBe(expected);
        expect(
          projector.project().runs['run-1']?.effects['intent-fixed-0001']?.status,
        ).toBe(expectedStatus);
        expect(journal.pending(projector.project())).toHaveLength(0);
      } finally {
        db.close();
      }
    }, 30_000);
  }
});
