/**
 * T4.1.1 verification — the `env.provision` contract against the real IaC.
 *
 * Offline and part of `npm run check`: `docker compose` needs no credential
 * and makes no model call, the same reasoning DESIGN §9 decision 8 gives for
 * choosing containers as the deploy substrate in the first place — testable
 * offline, at no cost, holding no credential. A verification of "an
 * environment comes up and down from repository config alone" that only
 * asserted a mocked provider would not actually show that; this one shells to
 * a real `docker compose` against the committed
 * `deploy/environments/test/compose.yaml`.
 *
 * Requires a Docker daemon. GitHub Actions' `ubuntu-latest` runners ship one
 * preinstalled, and so does this repository's own dev setup — nothing here
 * installs or configures it.
 */
import {
  CapabilityRegistry,
  composeProvider,
  envProvisionContract,
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

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const registry = new CapabilityRegistry();
const bound = registry.bind(envProvisionContract, composeProvider());

try {
  process.stdout.write('\n1. Up from the committed IaC alone\n');
  const up = await bound.invoke('up', { repo, env: 'test' });
  check('the environment reports up', up.up === true, JSON.stringify(up));
  check(
    'the placeholder service is running and healthy',
    up.services.length === 1 &&
      up.services[0].state === 'running' &&
      up.services[0].health === 'healthy',
    JSON.stringify(up.services),
  );

  process.stdout.write('\n2. Reachable over the network the compose file declared\n');
  try {
    const response = await fetch('http://localhost:8081/');
    const text = await response.text();
    check(
      'the test environment answers on its declared port',
      response.ok,
      String(response.status),
    );
    check(
      "it serves this environment's own content, not another one's",
      text.includes('test'),
      text.slice(0, 80),
    );
  } catch (cause) {
    check('the test environment answers on its declared port', false, String(cause));
  }

  process.stdout.write('\n3. status agrees with what up just reported\n');
  const status = await bound.invoke('status', { repo, env: 'test' });
  check(
    'status reports the same up as up did',
    status.up === true,
    JSON.stringify(status),
  );

  process.stdout.write('\n4. Repeating up converges rather than piling up containers\n');
  const upAgain = await bound.invoke('up', { repo, env: 'test' });
  check(
    'still exactly one service, not two',
    upAgain.services.length === 1,
    JSON.stringify(upAgain.services),
  );

  process.stdout.write('\n5. Down from the committed IaC alone\n');
  const down = await bound.invoke('down', { repo, env: 'test' });
  check('the environment reports not up', down.up === false, JSON.stringify(down));
  check(
    'nothing is left running',
    down.services.length === 0,
    JSON.stringify(down.services),
  );

  process.stdout.write('\n6. Down again is a no-op, not an error (idempotent)\n');
  const downAgain = await bound.invoke('down', { repo, env: 'test' });
  check(
    'a second down still reports not up, cleanly',
    downAgain.up === false && downAgain.services.length === 0,
    JSON.stringify(downAgain),
  );

  // `production` was this check's example environment through T4.1.1..3 —
  // deliberately undeclared until T4.1.4 landed the hard approval gate that
  // has to stand in front of it (`src/policy/deploy-gate.ts`). It is declared
  // now (`environments.yaml`), so the example moved to a name nothing ever
  // declares; the point being verified — an undeclared environment is
  // refused, not guessed at — is unchanged.
  process.stdout.write('\n7. An undeclared environment is refused, not guessed at\n');
  try {
    await bound.invoke('up', { repo, env: 'canary' });
    check(
      'an undeclared environment is refused',
      false,
      'the call resolved instead of throwing',
    );
  } catch (cause) {
    check(
      'an undeclared environment is refused',
      cause instanceof Error && /not declared/.test(cause.message),
      cause instanceof Error ? cause.message : String(cause),
    );
  }
} finally {
  // Best-effort teardown so a failing assertion above never leaves the
  // environment standing for the next run to trip over — the way every other
  // demo cleans up its own temp directory in a `finally`.
  await bound.invoke('down', { repo, env: 'test' }).catch(() => undefined);
}

process.stdout.write(
  failures.length === 0
    ? '\nT4.1.1 verification passed\n\n'
    : `\nT4.1.1 verification FAILED: ${String(failures.length)} check(s)\n\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
