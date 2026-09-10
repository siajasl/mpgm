/**
 * T4.1.4a/b verification — a release delivered to an environment this
 * project marks `approval: required` is impossible without an approval
 * event, and which environments those are is read from project
 * configuration, never a hardcoded name. Steps 1-7 are T4.1.4a's
 * `release.deliver` coverage; steps 8-9 are T4.1.4b's: `env.provision#up`/
 * `#down`, reached directly rather than through `release.deliver`, are
 * gated exactly the same way.
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
 * *different*, `docker`-shaped reason (an unresolvable image reference, or —
 * for steps 8-9, which never name an image at all — no failure at all) —
 * proof that control passed the gate rather than the script asserting on
 * the gate's own refusal twice.
 *
 * `staging` stands in for whatever environment a project marks
 * `approval: required`. `test` demonstrates the opposite case: a manifest
 * entry marked `approval: none` is never gated at all, no matter what it is
 * handed.
 *
 * Steps 1-7 never leave `staging` with anything actually running —
 * `release.deliver`'s digests are fake, so `docker compose up` fails to pull
 * an image and creates no container, meaning `status` reports nothing by the
 * time step 7 finishes (T4.1.4b review 6, finding 2). That left `down`'s own
 * gated branch — the one a review found this script had never exercised —
 * unreached on every run of this script, `demo:gate`'s only verification of
 * it having been a one-off manual test recorded out of band (commit
 * bedd342). Steps 8-9 close that: step 8 brings `staging` up on its compose
 * default (a real, healthy `nginx` container — no image named, so nothing
 * here can fail to pull), which is what gives step 9 an actual reported
 * state for a gated `down` to have something to protect and refuse.
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
  KERNEL_TASK,
  kernelRegistry,
  recreateOnDefaultDigest,
  releaseDeliverContract,
  teardownDigest,
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

function describeStatus(status) {
  return status.services.length === 0
    ? 'no services reported'
    : status.services.map((service) => `${service.name}:${service.state}`).join(', ');
}

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

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
      taskId: KERNEL_TASK,
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
      taskId: KERNEL_TASK,
      tool,
      fingerprint,
      by: 'macg',
      reason: 'approved for this demo',
    },
  });
}

// `gatedEnvs` is `gatedEnvironments` itself, not a set precomputed from
// `repo` — a function of the `repo` each call names, re-reading that repo's
// own manifest every time (DESIGN §9 decision 10; `deploy-gate.ts`'s own
// doc on `DeployGateOptions.gatedEnvs`), so a provider built once never
// judges a different repo's call by this repo's manifest.
const gate = { gatedEnvs: gatedEnvironments, ledger, onDryRunNeeded };

const registry = new CapabilityRegistry();
// The same `gate` object wires both providers (T4.1.4b): `env.provision`'s
// own `up`/`down` (`composeProvider`) and `release.deliver#deliver`/
// `#rollback` (`dockerReleaseProvider`, which delegates to this exact
// `envContract` underneath) share one fingerprint identity per
// `{repo, env, digest}` (decision 9/11), so a confirmation this script
// appends for one is visible to the other — the same ledger, reading the
// same on-disk log.
const envContract = registry.bind(envProvisionContract, composeProvider({ gate }));
const release = registry.bind(
  releaseDeliverContract,
  // Required at construction — there is no unwrapped
  // `dockerReleaseProvider(...)` this script, or any other caller in this
  // repository, could obtain (DESIGN §9 decision 10).
  dockerReleaseProvider({ envProvision: envContract, gate }),
);

/**
 * Tears `env` down, confirming the same gate a real operator would (T4.1.4b
 * review 4, finding 1): `down` is behind {@link gateProvisionRelease}
 * exactly like every other gated call once `status` reports anything
 * running, and a cleanup that swallowed that refusal would let a leftover
 * stack — from an earlier `demo:release`/`demo:verify`, or from containers a
 * partially-successful `up` in this run already created — sit up with
 * `restart: unless-stopped` while this script still prints a pass. Confirms
 * the exact reported state through the same `ledger`/`onDryRunNeeded`/
 * `operatorConfirms` this script already uses for `deliver`/`rollback`,
 * rather than calling `down` twice and hoping the second call happens to
 * pass — a refusal that is not the gate's is let through, not swallowed.
 */
async function teardown(env) {
  const status = await envContract.invoke('status', { repo, env });
  if (status.services.length === 0) {
    // Nothing reported: `down`'s own "nothing to protect" bypass
    // (`deploy-gate.ts`) means this reaches the provider ungated.
    await envContract.invoke('down', { repo, env });
    return;
  }
  const target = { repo, env, digest: teardownDigest(status.services) };
  const print = deployFingerprint(target);
  if (!ledger.dryRunSeen(print)) {
    onDryRunNeeded({ tool: 'deploy', fingerprint: print, target });
  }
  if (!ledger.confirmed(print)) {
    operatorConfirms(print, 'deploy');
  }
  await envContract.invoke('down', { repo, env });
}

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

  process.stdout.write(
    "\n8. env.provision#up with no image, against 'staging' (approval: required), is gated exactly like release.deliver\n",
  );
  const noImageUp1 = await refused(envContract.invoke('up', { repo, env: 'staging' }));
  check(
    'a no-image up is refused without a recorded dry run — first bring-up is as gated as a recreate (T4.1.4b review 2)',
    noImageUp1 !== undefined && noImageUp1.includes('has not been simulated'),
    noImageUp1,
  );
  const noImageUp2 = await refused(envContract.invoke('up', { repo, env: 'staging' }));
  check(
    'still refused once simulated but not yet confirmed',
    noImageUp2 !== undefined && noImageUp2.includes('simulated but not confirmed'),
    noImageUp2,
  );
  // Confirmed against the exact reported state this call would replace
  // (`recreateOnDefaultDigest`, T4.1.4b review 2) — `status` reports nothing
  // yet, so this is the first-bring-up identity, not a recreate.
  const beforeUp = await envContract.invoke('status', { repo, env: 'staging' });
  const upPrint = deployFingerprint({
    repo,
    env: 'staging',
    digest: recreateOnDefaultDigest(beforeUp.services),
  });
  operatorConfirms(upPrint, 'deploy');
  const confirmedUp = await refused(envContract.invoke('up', { repo, env: 'staging' }));
  check(
    'up now reaches the real provider on the compose default — no image named, so nothing here fails to pull',
    confirmedUp === undefined,
    confirmedUp ?? '(no error — up reported normally)',
  );

  process.stdout.write(
    "\n9. env.provision#down against the now-up 'staging' is refused until confirmed, then proceeds\n",
  );
  const downRefused = await refused(envContract.invoke('down', { repo, env: 'staging' }));
  check(
    "down is refused — 'staging' now reports a real service, which is something a gated down must protect",
    downRefused !== undefined && downRefused.includes('has not been simulated'),
    downRefused,
  );
  const beforeDown = await envContract.invoke('status', { repo, env: 'staging' });
  check(
    "down's refusal is over an environment status actually reports something running in",
    beforeDown.services.length > 0,
    describeStatus(beforeDown),
  );
  const downPrint = deployFingerprint({
    repo,
    env: 'staging',
    digest: teardownDigest(beforeDown.services),
  });
  operatorConfirms(downPrint, 'deploy');
  const confirmedDown = await refused(
    envContract.invoke('down', { repo, env: 'staging' }),
  );
  check(
    'down now reaches the real provider on the operator confirmation alone',
    confirmedDown === undefined,
    confirmedDown ?? '(no error — down reported normally)',
  );
  const afterDown = await envContract.invoke('status', { repo, env: 'staging' });
  check(
    "'staging' reports nothing once the confirmed down has actually run",
    afterDown.services.length === 0,
    describeStatus(afterDown),
  );
} finally {
  for (const env of ['staging', 'test']) {
    try {
      await teardown(env);
    } catch (cause) {
      // Surfaced, not swallowed (T4.1.4b review 4, finding 1): a refused or
      // failed teardown must not let this script still print a pass while a
      // stack is left running.
      const message = cause instanceof Error ? cause.message : String(cause);
      check(`cleanup: '${env}' torn down`, false, message);
    }
  }
  log.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.4a/b verification passed\n\n'
    : `\nT4.1.4a/b verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
