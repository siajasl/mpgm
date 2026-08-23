import type { BlobStore } from '../blob/store.js';
import type { EventInput } from '../event/envelope.js';

/**
 * A synthetic run with no LLM in it (PLAN M1.1 verification).
 *
 * Deterministic by construction: the same arguments always produce the same
 * event sequence, and blob references are content-derived, so a replayed run
 * yields identical refs without re-storing anything new. That determinism is
 * what makes "byte-for-byte" a checkable claim rather than a hopeful one.
 */
export function syntheticRun(
  runId: string,
  taskCount: number,
  blobs: BlobStore,
): EventInput[] {
  const events: EventInput[] = [
    {
      runId,
      type: 'RunStarted',
      payload: { project: 'synthetic', operator: 'demo' },
    },
  ];

  const phases = ['definition', 'scope', 'design'];

  for (let index = 0; index < taskCount; index += 1) {
    const taskId = `T${String(index)}`;
    const phase = phases[index % phases.length] ?? 'definition';

    if (index % 4 === 0) {
      events.push({ runId, type: 'PhaseEntered', payload: { phase } });
    }

    events.push({
      runId,
      type: 'TaskDispatched',
      payload: {
        taskId,
        role: index % 2 === 0 ? 'analyst' : 'implementer',
        model: index % 2 === 0 ? 'claude-sonnet-5' : 'claude-opus-5',
      },
    });

    events.push({
      runId,
      type: 'SessionUsage',
      payload: {
        taskId,
        inputTokens: 100 + index,
        outputTokens: 50 + index,
        costUsd: Number((0.01 * (index + 1)).toFixed(4)),
      },
    });

    // A tool output large enough to belong in the blob store rather than the log.
    const output = `tool output for ${taskId}\n`.repeat(50);
    events.push({
      runId,
      type: 'ToolCallLogged',
      payload: {
        taskId,
        tool: index % 3 === 0 ? 'Bash' : 'Read',
        decision: index % 7 === 0 ? 'denied' : 'allowed',
        detail: 'output offloaded to blob store',
        outputBlob: blobs.putText(output),
      },
    });

    if (index % 5 === 0) {
      events.push({
        runId,
        type: 'ValidationFailed',
        payload: { taskId, attempt: 1, issues: ['schema mismatch'] },
      });
    }

    // A side effect, recorded intent-first (DESIGN §6).
    const intentId = `intent-${taskId}`;
    events.push({
      runId,
      type: 'EffectIntended',
      payload: {
        intentId,
        taskId,
        contract: 'demo.effect',
        operation: 'publish',
        params: { taskId },
      },
    });
    events.push({
      runId,
      type: 'EffectCompleted',
      payload: { intentId, outcome: 'executed' },
    });

    events.push({
      runId,
      type: 'TaskCompleted',
      payload: {
        taskId,
        artifactRefs: [
          { path: `artifacts/${taskId}.md`, commit: `commit${String(index)}` },
        ],
      },
    });

    if (index % 4 === 3) {
      const gateId = `gate-${String(index)}`;
      events.push({
        runId,
        type: 'GatePresented',
        payload: { gateId, phase, artifactRefs: [] },
      });
      events.push({
        runId,
        type: 'GateApproved',
        payload: { gateId, by: 'demo-operator' },
      });
    }
  }

  return events;
}

/** Timestamp a demo event deterministically from its sequence number. */
export function demoTimestamp(seq: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString();
}
