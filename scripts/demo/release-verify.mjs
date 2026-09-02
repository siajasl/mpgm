/**
 * T4.1.3 verification — an induced regression auto-rolls back, and the
 * outcome is recorded (DEP-2, DEP-5).
 *
 * `demo:release` (T4.1.2) proves a release *can* be delivered and rolled
 * back when something else decides to. This script proves the part T4.1.2
 * deliberately left undone: nothing here tells the harness which release is
 * bad — `release/verify.js` finds out for itself, from the same smoke
 * checks a real SLO would use, against a real `docker compose` stack the
 * same way `demo:release` is.
 *
 * The regression is real, not simulated: the second release is built and
 * delivered exactly like the first, but its image still serves the first
 * release's content — a packaging bug that leaves `env.provision` fully
 * healthy (the container runs fine) while the service itself is wrong,
 * which is exactly the gap DEP-5's smoke checks exist to catch that a
 * container healthcheck cannot.
 *
 * Requires a Docker daemon, the same as `demo:env` and `demo:release`.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CapabilityRegistry,
  composeProvider,
  dockerReleaseProvider,
  envProvisionContract,
  readOutcomes,
  recordOutcome,
  releaseDeliverContract,
  verifyRelease,
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

async function content() {
  const response = await fetch('http://localhost:8081/');
  return { ok: response.ok, text: await response.text() };
}

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const outcomesPath = join(repo, '.mpgm', 'demo', 'release-outcomes-test.jsonl');
rmSync(outcomesPath, { force: true });

const registry = new CapabilityRegistry();
const env = registry.bind(envProvisionContract, composeProvider());
const release = registry.bind(
  releaseDeliverContract,
  dockerReleaseProvider({ envProvision: env }),
);

const policy = { attempts: 8, intervalMs: 1000 };
const smokeCheck = (expectIncludes) => [
  { name: 'homepage', url: 'http://localhost:8081/', expectIncludes },
];

const rollbackTo = (to) => release.invoke('rollback', { repo, env: 'test', to });

try {
  process.stdout.write('\n1. Deliver a healthy first release\n');
  const v1 = await release.invoke('assemble', {
    repo,
    context: 'deploy/sample-service',
    image: 'mpgm-sample-service',
    version: '1.0.0',
    changelog: 'Initial release of the sample service.',
    buildArgs: { APP_VERSION: '1.0.0' },
    previous: null,
  });
  await release.invoke('deliver', { repo, env: 'test', release: v1 });

  const outcome1 = await verifyRelease(
    {
      env: 'test',
      release: { version: v1.version, digest: v1.digest },
      checks: smokeCheck('1.0.0'),
      previous: null,
      policy,
    },
    { rollback: rollbackTo },
  );
  recordOutcome(outcomesPath, outcome1);
  check(
    'the first release verifies healthy and promotes — nothing to roll back to yet',
    outcome1.decision === 'promoted',
    JSON.stringify(outcome1),
  );

  process.stdout.write(
    '\n2. Deliver a second release that never actually took effect (the induced regression)\n',
  );
  // Built and tagged as 2.0.0, but its content still says 1.0.0 — a real
  // packaging bug, not a flag this script flips. `env.provision` reports the
  // container running and healthy either way; only a content-level smoke
  // check can tell the difference.
  const v2 = await release.invoke('assemble', {
    repo,
    context: 'deploy/sample-service',
    image: 'mpgm-sample-service',
    version: '2.0.0',
    changelog: 'Second release of the sample service.',
    buildArgs: { APP_VERSION: '1.0.0' },
    previous: { version: v1.version, digest: v1.digest },
  });
  const delivered2 = await release.invoke('deliver', { repo, env: 'test', release: v2 });
  check(
    'env.provision reports the regressed release up — its container is fine',
    delivered2.up === true,
    JSON.stringify(delivered2),
  );

  const servedRegressed = await content();
  check(
    'the environment is serving the regression right now, before verification runs',
    servedRegressed.ok && servedRegressed.text.includes('1.0.0'),
    servedRegressed.text.slice(0, 80),
  );

  process.stdout.write(
    '\n3. Verify it — the smoke check fails, and the harness rolls back on its own\n',
  );
  const outcome2 = await verifyRelease(
    {
      env: 'test',
      release: { version: v2.version, digest: v2.digest },
      checks: smokeCheck('2.0.0'),
      previous: { artifact: v1, checks: smokeCheck('1.0.0') },
      policy,
    },
    { rollback: rollbackTo },
  );
  recordOutcome(outcomesPath, outcome2);

  check(
    'the harness decided to roll back — nobody told it to',
    outcome2.decision === 'rolled-back',
    JSON.stringify(outcome2),
  );
  check(
    'the outcome names the release actually restored',
    outcome2.rolledBackTo?.digest === v1.digest,
    JSON.stringify(outcome2.rolledBackTo),
  );
  check(
    'the failing smoke check is in the recorded outcome, not just implied',
    outcome2.checks.some((result) => !result.ok),
    JSON.stringify(outcome2.checks),
  );

  const servedAfterRollback = await content();
  check(
    'the environment is actually serving 1.0.0 again, not merely reported as such',
    servedAfterRollback.ok && servedAfterRollback.text.includes('1.0.0'),
    servedAfterRollback.text.slice(0, 80),
  );

  process.stdout.write('\n4. The outcome is recorded — durably, not just returned\n');
  const recorded = readOutcomes(outcomesPath);
  check('both verification runs are on disk, oldest first', recorded.length === 2);
  check(
    'the recorded rollback outcome matches what verifyRelease returned',
    JSON.stringify(recorded[1]) === JSON.stringify(outcome2),
  );
  // A second process reading the file back sees exactly what the raw JSON
  // says — proof this is a real file, not the in-memory object reused.
  const rawLines = readFileSync(outcomesPath, 'utf8').trim().split('\n');
  check('one JSON line per outcome', rawLines.length === 2);
} finally {
  await env.invoke('down', { repo, env: 'test' }).catch(() => undefined);
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.3 verification passed\n\n'
    : `\nT4.1.3 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
