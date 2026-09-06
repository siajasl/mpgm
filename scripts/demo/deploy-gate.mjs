/**
 * T4.1.4 verification — a production deploy is impossible without an
 * approval event, on every route that reaches a gated environment.
 *
 * Against the real providers this repository ships
 * (`composeProvider`/`dockerReleaseProvider`), targeting this repository's
 * own `production` environment (`deploy/environments/environments.yaml`,
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
 * `mpgm rollback` is not this script's caller: T4.1.4 split the CLI verb
 * out to T4.1.5, keeping only the gate itself (DESIGN §9 decision 10/14).
 * What this script drives instead is what `mpgm rollback` (or any other
 * future caller — an orchestrator effect, `mpgm deploy`) would ultimately
 * reach: `dockerReleaseProvider#deliver`/`#rollback` and
 * `composeProvider#up` directly, through the same `CapabilityRegistry`
 * every real caller binds them through. Confirming a fingerprint is done
 * exactly the way `mpgm confirm <fingerprint> --by <who>` does it
 * (`src/cli/commands.ts`'s `confirm`) — appending a `DestructiveOpConfirmed`
 * event for a fingerprint the ledger has already seen dry-run — just
 * without the CLI's argument parsing in front of it here.
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

// Cross-run, not scoped to `RUN` alone — the same reader `mpgm rollback`
// will use once T4.1.5 lands (`deploy-gate.ts`'s `crossRunLedger`,
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
const envContract = registry.bind(
  envProvisionContract,
  // Required at construction (T4.1.4 second rework) — there is no
  // unwrapped `composeProvider()` this script, or any other caller in this
  // repository, could obtain.
  composeProvider({ gate }),
);
const release = registry.bind(
  releaseDeliverContract,
  // Same requirement, same reason, for `release.deliver` (DESIGN §9
  // decision 10).
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
  env: 'production',
  digest: v1.digest,
  label: v1.version,
});

try {
  process.stdout.write(
    '\n1. release.deliver#deliver to production is refused without a recorded dry run\n',
  );
  const noDryRun = await refused(
    release.invoke('deliver', { repo, env: 'production', release: v1 }),
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
    release.invoke('deliver', { repo, env: 'production', release: v1 }),
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
    release.invoke('deliver', { repo, env: 'production', release: v1 }),
  );
  check(
    'deliver now reaches the real provider, not the gate — a docker-shaped failure, not a gate refusal',
    confirmedDeliver !== undefined &&
      !confirmedDeliver.includes('simulated') &&
      confirmedDeliver.includes('did not become healthy'),
    confirmedDeliver,
  );

  process.stdout.write(
    '\n4. The same confirmation covers env.provision#up directly — one door, not two (DESIGN §9 decision 14)\n',
  );
  const upSameDigest = await refused(
    envContract.invoke('up', { repo, env: 'production', image: v1.digest }),
  );
  check(
    'up for the exact digest deliver just confirmed is never asked to simulate or confirm again',
    upSameDigest !== undefined &&
      !upSameDigest.includes('simulated') &&
      upSameDigest.includes('did not become healthy'),
    upSameDigest,
  );

  process.stdout.write(
    '\n5. A different digest for the same environment is a different approval question\n',
  );
  const v2 = { ...v1, version: '2.0.0', digest: `sha256:${'b'.repeat(64)}` };
  const upDifferentDigest = await refused(
    envContract.invoke('up', { repo, env: 'production', image: v2.digest }),
  );
  check(
    "an unconfirmed digest is refused even though production was just confirmed for a different one — confirming v1 did not confirm 'production' in general",
    upDifferentDigest !== undefined &&
      upDifferentDigest.includes('has not been simulated'),
    upDifferentDigest,
  );

  process.stdout.write(
    '\n6. release.deliver#rollback cannot smuggle in a release production never had confirmed\n',
  );
  // A third digest, untouched by any step above — v2's own fingerprint was
  // already dry-run (though not confirmed) by step 5's `up` attempt, which
  // would make this assertion pass for the wrong reason (simulated-but-not-
  // confirmed rather than never-simulated-at-all). Both are refusals, but
  // this section is about the door being closed outright, not ajar.
  const v3 = { ...v1, version: '3.0.0', digest: `sha256:${'c'.repeat(64)}` };
  const rollbackUnconfirmed = await refused(
    release.invoke('rollback', { repo, env: 'production', to: v3 }),
  );
  check(
    'rollback of an unconfirmed digest is refused exactly as deliver would refuse it — not a second, ungated door',
    rollbackUnconfirmed !== undefined &&
      rollbackUnconfirmed.includes('has not been simulated'),
    rollbackUnconfirmed,
  );

  process.stdout.write(
    '\n7. rollback restoring a release production already had confirmed asks for nothing new (DESIGN §9 decision 11)\n',
  );
  const rollbackConfirmed = await refused(
    release.invoke('rollback', { repo, env: 'production', to: v1 }),
  );
  check(
    "rollback reaches the real provider on deliver's earlier confirmation alone",
    rollbackConfirmed !== undefined &&
      !rollbackConfirmed.includes('simulated') &&
      rollbackConfirmed.includes('did not become healthy'),
    rollbackConfirmed,
  );

  process.stdout.write(
    '\n8. An environment the manifest marks approval: none is never gated at all\n',
  );
  const stagingUp = await refused(
    envContract.invoke('up', { repo, env: 'staging', image: v1.digest }),
  );
  check(
    'staging is reached with no dry run and no confirmation, even carrying an image',
    stagingUp === undefined || !stagingUp.includes('simulated'),
    stagingUp ?? '(no error — up reported normally)',
  );
} finally {
  await envContract.invoke('down', { repo, env: 'production' }).catch(() => undefined);
  await envContract.invoke('down', { repo, env: 'staging' }).catch(() => undefined);
  log.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.4 verification passed\n\n'
    : `\nT4.1.4 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
