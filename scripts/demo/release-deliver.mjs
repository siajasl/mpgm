/**
 * T4.1.2 verification — a staged release with a *tested* rollback path.
 *
 * "Tested" is the word doing the work: a rollback path that is merely a
 * field on a release artifact proves nothing about whether rolling back
 * actually works. This script builds two real releases of the sample
 * service (`deploy/sample-service/`) with `docker build`, delivers the first
 * to the `test` environment, confirms the environment serves it, delivers
 * the second, confirms the content actually changed, rolls back to the
 * first, and confirms the content reverted — against a real `docker
 * compose` stack the same way `demo:env` (T4.1.1) is, not a mocked provider.
 *
 * Requires a Docker daemon. GitHub Actions' `ubuntu-latest` runners ship one
 * preinstalled, and so does this repository's own dev setup.
 */
import {
  CapabilityRegistry,
  composeProvider,
  dockerReleaseProvider,
  envProvisionContract,
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

async function content() {
  const response = await fetch('http://localhost:8081/');
  return { ok: response.ok, text: await response.text() };
}

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const registry = new CapabilityRegistry();
const env = registry.bind(envProvisionContract, composeProvider());
const release = registry.bind(
  releaseDeliverContract,
  dockerReleaseProvider({ envProvision: env }),
);

try {
  process.stdout.write('\n1. Assemble the first release from the sample service\n');
  const v1 = await release.invoke('assemble', {
    repo,
    context: 'deploy/sample-service',
    image: 'mpgm-sample-service',
    version: '1.0.0',
    changelog: 'Initial release of the sample service.',
    buildArgs: { APP_VERSION: '1.0.0' },
    previous: null,
  });
  check(
    'the artifact is immutable, versioned, and carries no rollback path yet',
    v1.version === '1.0.0' && v1.digest.startsWith('sha256:') && v1.rollbackTo === null,
    JSON.stringify(v1),
  );

  process.stdout.write('\n2. Deliver it to the test environment\n');
  const delivered1 = await release.invoke('deliver', { repo, env: 'test', release: v1 });
  check('the environment reports up', delivered1.up === true, JSON.stringify(delivered1));

  const served1 = await content();
  check(
    'the environment now serves release 1.0.0',
    served1.ok && served1.text.includes('1.0.0'),
    served1.text.slice(0, 80),
  );

  process.stdout.write(
    '\n3. Assemble a second release naming the first as its rollback path\n',
  );
  const v2 = await release.invoke('assemble', {
    repo,
    context: 'deploy/sample-service',
    image: 'mpgm-sample-service',
    version: '2.0.0',
    changelog: 'Second release of the sample service.',
    buildArgs: { APP_VERSION: '2.0.0' },
    previous: { version: v1.version, digest: v1.digest },
  });
  check(
    'the second release names the first as what it supersedes',
    JSON.stringify(v2.rollbackTo) ===
      JSON.stringify({ version: '1.0.0', digest: v1.digest }),
    JSON.stringify(v2.rollbackTo),
  );
  check('the two releases built different images', v2.digest !== v1.digest, v2.digest);

  process.stdout.write(
    '\n4. Deliver the second release — the environment actually changes\n',
  );
  const delivered2 = await release.invoke('deliver', { repo, env: 'test', release: v2 });
  check(
    'the environment still reports up',
    delivered2.up === true,
    JSON.stringify(delivered2),
  );

  const served2 = await content();
  check(
    'the environment now serves release 2.0.0, not 1.0.0',
    served2.ok && served2.text.includes('2.0.0') && !served2.text.includes('1.0.0'),
    served2.text.slice(0, 80),
  );

  process.stdout.write('\n5. Roll back — the tested rollback path\n');
  const rolledBack = await release.invoke('rollback', { repo, env: 'test', to: v1 });
  check(
    'rollback reports the environment up on release 1.0.0',
    rolledBack.up === true && rolledBack.release.digest === v1.digest,
    JSON.stringify(rolledBack),
  );

  const servedAfterRollback = await content();
  check(
    'the environment serves release 1.0.0 again after rollback, not 2.0.0',
    servedAfterRollback.ok &&
      servedAfterRollback.text.includes('1.0.0') &&
      !servedAfterRollback.text.includes('2.0.0'),
    servedAfterRollback.text.slice(0, 80),
  );

  process.stdout.write(
    '\n6. Reassembling with a warm build cache reuses the same digest\n',
  );
  // This is a warm-cache observation, not a reproducibility guarantee: it
  // shows only that `docker build` reused its own cached layers on *this*
  // machine, which is why `assemble` is safe to retry (`effects:
  // 'idempotent'`). A cold cache (a fresh runner, or one after a prune)
  // would rebuild this same tree and args to a *different* digest — see
  // `contracts/release.deliver.md` — so this step is not proof of the
  // stronger, false claim that an unchanged tree always reproduces its
  // digest.
  const v1Again = await release.invoke('assemble', {
    repo,
    context: 'deploy/sample-service',
    image: 'mpgm-sample-service',
    version: '1.0.0',
    changelog: 'Initial release of the sample service.',
    buildArgs: { APP_VERSION: '1.0.0' },
    previous: null,
  });
  check(
    'the same tree and build args reuse the same digest with a warm cache',
    v1Again.digest === v1.digest,
    `${v1.digest} vs ${v1Again.digest}`,
  );
} finally {
  // Best-effort teardown so a failing assertion above never leaves the
  // environment standing for the next run to trip over.
  await env.invoke('down', { repo, env: 'test' }).catch(() => undefined);
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.2 verification passed\n\n'
    : `\nT4.1.2 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
