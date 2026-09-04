/**
 * T4.1.3 verification — an induced regression auto-rolls back, and the
 * outcome is recorded (DEP-2, DEP-5). T4.1.6 verification — that recording
 * lands as a versioned artifact under `artifacts/deploy/`, not a JSONL line
 * under `.mpgm/`, so it survives past this process (DESIGN §9.12).
 *
 * `demo:release` (T4.1.2) proves a release *can* be delivered and rolled
 * back when something else decides to. This script proves the part T4.1.2
 * deliberately left undone: nothing here tells the harness which release is
 * bad — `release/verify.js` finds out for itself, from the same smoke
 * checks a real SLO would use, against a real `docker compose` stack the
 * same way `demo:release` is.
 *
 * The regression is real, not simulated: the second release is a genuinely
 * distinct image (a different `APP_VERSION` build arg, so a different
 * digest — never docker's build cache handing back v1's own image id) that
 * is tagged 2.0.0 but never actually serves 2.0.0 content, a real packaging
 * bug that leaves `env.provision` fully healthy (the container runs fine)
 * while the service itself is wrong — exactly the gap DEP-5's smoke checks
 * exist to catch that a container healthcheck cannot. Because v2 is a real,
 * distinct image, delivering it and rolling back from it are real state
 * changes on the environment, not no-ops the assertions below could not
 * tell from doing nothing.
 *
 * Requires a Docker daemon, the same as `demo:env` and `demo:release`.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ArtifactSchemaRegistry,
  ArtifactStore,
  CapabilityRegistry,
  composeProvider,
  defineArtifactSchema,
  dockerReleaseProvider,
  envProvisionContract,
  outcomeBasePath,
  readOutcomes,
  recordOutcome,
  releaseDeliverContract,
  releaseOutcomeSchema,
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

// Start clean: a previous local run of this script left its own versions
// behind (they are real, committable files now — see §4 below), and this
// run's assertions expect to see exactly the two it produces.
const deployDir = join(repo, 'artifacts', 'deploy');
if (existsSync(deployDir)) {
  for (const entry of readdirSync(deployDir)) {
    if (/^test\.v\d+\.md$/.test(entry)) {
      rmSync(join(deployDir, entry));
    }
  }
}

const outcomeArtifacts = new ArtifactStore({
  root: repo,
  schemas: new ArtifactSchemaRegistry([
    defineArtifactSchema('release-outcome', releaseOutcomeSchema),
  ]),
});
const producedBy = {
  task: 'demo-release-verify',
  role: 'harness',
  model: 'n/a',
  runId: 'demo-release-verify',
};

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
  const artifact1 = recordOutcome(outcomeArtifacts, {
    env: 'test',
    outcome: outcome1,
    producedBy,
  });
  check(
    'the first release verifies healthy and promotes — nothing to roll back to yet',
    outcome1.decision === 'promoted',
    JSON.stringify(outcome1),
  );

  process.stdout.write(
    '\n2. Deliver a second release that never actually took effect (the induced regression)\n',
  );
  // Tagged 2.0.0, but a real packaging bug — not a flag this script flips —
  // means the content baked in is 'regressed', not '2.0.0'. `APP_VERSION`
  // differs from v1's build arg (v1 used '1.0.0') on purpose: an unchanged
  // build arg would let docker's build cache hand back v1's own image id, so
  // v2 would never be a distinct image and rolling back to v1 would be a
  // no-op the environment could not tell from doing nothing (asserted below).
  // `env.provision` reports the container running and healthy either way;
  // only a content-level smoke check can tell the difference.
  const v2 = await release.invoke('assemble', {
    repo,
    context: 'deploy/sample-service',
    image: 'mpgm-sample-service',
    version: '2.0.0',
    changelog: 'Second release of the sample service.',
    buildArgs: { APP_VERSION: 'regressed' },
    previous: { version: v1.version, digest: v1.digest },
  });
  check(
    'v2 is a genuinely different image, not v1 handed back under a new tag',
    v2.digest !== v1.digest,
    `${v1.digest} vs ${v2.digest}`,
  );
  const delivered2 = await release.invoke('deliver', { repo, env: 'test', release: v2 });
  check(
    'env.provision reports the regressed release up — its container is fine',
    delivered2.up === true,
    JSON.stringify(delivered2),
  );

  const servedRegressed = await content();
  check(
    'the environment is serving the regression right now, before verification runs — not 1.0.0',
    servedRegressed.ok &&
      servedRegressed.text.includes('regressed') &&
      !servedRegressed.text.includes('1.0.0'),
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
  const artifact2 = recordOutcome(outcomeArtifacts, {
    env: 'test',
    outcome: outcome2,
    producedBy,
  });

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
    servedAfterRollback.ok &&
      servedAfterRollback.text.includes('1.0.0') &&
      !servedAfterRollback.text.includes('regressed'),
    servedAfterRollback.text.slice(0, 80),
  );

  process.stdout.write(
    '\n4. The outcome is recorded as a versioned artifact — durably, not just returned\n',
  );
  const recorded = readOutcomes(outcomeArtifacts, 'test');
  check('both verification runs are on disk, oldest first', recorded.length === 2);
  check(
    'the recorded rollback outcome matches what verifyRelease returned',
    JSON.stringify(recorded[1]) === JSON.stringify(outcome2),
  );
  // Each run got its own immutable version, under `artifacts/`, not `.mpgm/`
  // (which ADR-2 gitignores) — this is what "survives the run that produced
  // it" means (DESIGN §9.12): the file is still here after this process
  // exits, ready to be committed like any other artifact. Checked relative
  // to `repo`, not by substring on the absolute path — the checkout itself
  // can legitimately sit under a `.mpgm/worktrees/...` directory (as this
  // one does), which a bare `.includes('.mpgm')` would mistake for the
  // artifact living there.
  const relative1 = relative(repo, artifact1.path);
  const relative2 = relative(repo, artifact2.path);
  check(
    'each outcome landed under artifacts/deploy/, never under .mpgm/',
    existsSync(artifact1.path) &&
      existsSync(artifact2.path) &&
      relative1 === outcomeBasePath('test').replace('.md', '.v1.md') &&
      relative2 === outcomeBasePath('test').replace('.md', '.v2.md'),
    `${relative1} / ${relative2}`,
  );
  // A second process reading the file back sees exactly what the raw
  // frontmatter says — proof this is a real, self-describing file, not the
  // in-memory object reused.
  const raw = readFileSync(artifact2.path, 'utf8');
  check(
    'the file is versioned markdown with frontmatter, not a JSONL line',
    raw.startsWith('---\n') &&
      raw.includes('schema: release-outcome') &&
      raw.includes('version: 2'),
    raw.slice(0, 200),
  );
} finally {
  await env.invoke('down', { repo, env: 'test' }).catch(() => undefined);
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.3 verification passed\n\n'
    : `\nT4.1.3 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
