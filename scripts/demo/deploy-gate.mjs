/**
 * T4.1.4a verification — a release delivered to an environment this project
 * marks `approval: required` is impossible without an approval event, and
 * which environments those are is read from project configuration, never a
 * hardcoded name.
 *
 * Against the real providers this repository ships
 * (`composeProvider`/`dockerReleaseProvider`), targeting this repository's
 * own `staging` environment (`deploy/environments/environments.yaml`,
 * `approval: required`) — not a mocked gate, and not a mocked ledger: the
 * confirmation state comes from a real, on-disk `EventLog`
 * (`kernelRegistry`/`fold`), the same storage shape a run uses (ADR-2). A
 * refusal is a gate refusal, distinguishable from a `docker`-shaped failure
 * by its message; once a `DestructiveOpConfirmed` event is actually on the
 * log, the same call reaches the real provider instead, and fails for a
 * *different*, `docker`-shaped reason (an unresolvable image reference) —
 * proof that control passed the gate rather than the script asserting on
 * the gate's own refusal twice.
 *
 * `staging` stands in for whatever environment a project marks
 * `approval: required` — this task needs no `production` declared to prove
 * the release path is gated (PLAN.md's split of T4.1.4 into T4.1.4a/b):
 * `env.provision`'s own operations, and declaring `production` once they
 * are gated too, are T4.1.4b's task, not this one. `test` demonstrates the
 * opposite case: a manifest entry marked `approval: none` is never gated at
 * all, no matter what it is handed.
 *
 * Requires a Docker daemon, the same as `demo:env`/`demo:release`/`demo:verify`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityRegistry,
  composeProvider,
  crossRunLedger,
  deployFingerprint,
  dockerReleaseProvider,
  envProvisionContract,
  EventLog,
  fold,
  gatedEnvironments,
  kernelRegistry,
  releaseDeliverContract,
} from '../../dist/index.js';

const failures = [];

function check(label, condition, detail = '') {
  process.stdout.write(
    `  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) {
    failures.push(label);
  }
}

async function refused(promise) {
  try {
    await promise;
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const gatedEnvs = gatedEnvironments(repo);

const scratch = mkdtempSync(join(tmpdir(), 'mpgm-deploy-gate-'));
const log = EventLog.open(join(scratch, 'events.db'), { registry: kernelRegistry() });
const RUN = 'r1';
log.append({
  runId: RUN,
  type: 'RunStarted',
  payload: { project: repo, operator: 'macg' },
});

// Cross-run, not scoped to `RUN` alone (`deploy-gate.ts`'s `crossRunLedger`,
// DESIGN §9 decision 11): a confirmation, once on the log, outlives the run
// that asked for it.
const ledger = crossRunLedger(() => fold(log.read()));

const onDryRunNeeded = (record) => {
  log.append({
    runId: RUN,
    type: 'DryRunRecorded',
    payload: {
      taskId: '',
      tool: record.tool,
      fingerprint: record.fingerprint,
      summary: `deploy ${record.target.env} -> ${record.target.label ?? record.target.digest.slice(0, 12)}`,
    },
  });
};

/** Exactly what `src/cli/commands.ts`'s `confirm` appends. */
function operatorConfirms(fingerprint, tool) {
  log.append({
    runId: RUN,
    type: 'DestructiveOpConfirmed',
    payload: {
      taskId: '',
      tool,
      fingerprint,
      by: 'macg',
      reason: 'approved for this demo',
    },
  });
}

const gate = { gatedEnvs, ledger, onDryRunNeeded };

const registry = new CapabilityRegistry();
const envContract = registry.bind(envProvisionContract, composeProvider());
const release = registry.bind(
  releaseDeliverContract,
  // Required at construction — there is no unwrapped
  // `dockerReleaseProvider(...)` this script, or any other caller in this
  // repository, could obtain (DESIGN §9 decision 10).
  dockerReleaseProvider({ envProvision: envContract, gate }),
);

const v1 = {
  version: '1.0.0',
  image: 'mpgm-deploy-gate-demo:1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  changelog:
    'A release this script never actually builds — only its digest matters to the gate.',
  rollbackTo: null,
};
const v1Print = deployFingerprint({
  repo,
  env: 'staging',
  digest: v1.digest,
  label: v1.version,
});

try {
  process.stdout.write(
    "\n1. release.deliver#deliver to 'staging' (approval: required) is refused without a recorded dry run\n",
  );
  const noDryRun = await refused(
    release.invoke('deliver', { repo, env: 'staging', release: v1 }),
  );
  check(
    'deliver is refused',
    noDryRun !== undefined && noDryRun.includes('has not been simulated'),
    noDryRun,
  );
  check(
    'the refusal names the fingerprint it just recorded as a dry run — a real event, not a description',
    noDryRun !== undefined &&
      noDryRun.includes(v1Print) &&
      noDryRun.includes('recorded it as a dry run'),
    noDryRun,
  );

  process.stdout.write('\n2. Still refused once simulated but not yet confirmed\n');
  const notConfirmed = await refused(
    release.invoke('deliver', { repo, env: 'staging', release: v1 }),
  );
  check(
    'deliver is refused pending confirmation',
    notConfirmed !== undefined && notConfirmed.includes('simulated but not confirmed'),
    notConfirmed,
  );

  process.stdout.write(
    "\n3. An operator's confirmation — a DestructiveOpConfirmed event, nothing else — is what makes deliver possible\n",
  );
  operatorConfirms(v1Print, 'deploy');
  const confirmedDeliver = await refused(
    release.invoke('deliver', { repo, env: 'staging', release: v1 }),
  );
  check(
    'deliver now reaches the real provider, not the gate — a docker-shaped failure, not a gate refusal',
    confirmedDeliver !== undefined &&
      !confirmedDeliver.includes('simulated') &&
      confirmedDeliver.includes('did not become healthy'),
    confirmedDeliver,
  );

  process.stdout.write(
    '\n4. A different digest for the same environment is a different approval question\n',
  );
  const v2 = { ...v1, version: '2.0.0', digest: `sha256:${'b'.repeat(64)}` };
  const noDryRun2 = await refused(
    release.invoke('deliver', { repo, env: 'staging', release: v2 }),
  );
  check(
    "an unconfirmed digest is refused even though staging was just confirmed for a different one — confirming v1 did not confirm 'staging' in general",
    noDryRun2 !== undefined && noDryRun2.includes('has not been simulated'),
    noDryRun2,
  );

  process.stdout.write(
    '\n5. release.deliver#rollback cannot smuggle in a release staging never had confirmed\n',
  );
  const v3 = { ...v1, version: '3.0.0', digest: `sha256:${'c'.repeat(64)}` };
  const rollbackUnconfirmed = await refused(
    release.invoke('rollback', { repo, env: 'staging', to: v3 }),
  );
  check(
    'rollback of an unconfirmed digest is refused exactly as deliver would refuse it — not a second, ungated door',
    rollbackUnconfirmed !== undefined &&
      rollbackUnconfirmed.includes('has not been simulated'),
    rollbackUnconfirmed,
  );

  process.stdout.write(
    '\n6. rollback restoring a release staging already had confirmed asks for nothing new (DESIGN §9 decision 11)\n',
  );
  const rollbackConfirmed = await refused(
    release.invoke('rollback', { repo, env: 'staging', to: v1 }),
  );
  check(
    "rollback reaches the real provider on deliver's earlier confirmation alone",
    rollbackConfirmed !== undefined &&
      !rollbackConfirmed.includes('simulated') &&
      rollbackConfirmed.includes('did not become healthy'),
    rollbackConfirmed,
  );

  process.stdout.write(
    '\n7. An environment the manifest marks approval: none is never gated at all\n',
  );
  const testDeliver = await refused(
    release.invoke('deliver', { repo, env: 'test', release: v1 }),
  );
  check(
    'test is reached with no dry run and no confirmation, even carrying a release',
    testDeliver === undefined || !testDeliver.includes('simulated'),
    testDeliver ?? '(no error — deliver reported normally)',
  );
} finally {
  await envContract.invoke('down', { repo, env: 'staging' }).catch(() => undefined);
  await envContract.invoke('down', { repo, env: 'test' }).catch(() => undefined);
  log.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.4a verification passed\n\n'
    : `\nT4.1.4a verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
