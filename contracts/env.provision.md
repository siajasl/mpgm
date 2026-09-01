# `env.provision`

**Purpose.** Bring one of this project's declared environments — test,
staging, production — up or down from the IaC committed in the repository,
and report whether it is up. Satisfies DEP-1 (deployment automated and
repeatable from versioned configuration; no manual environment mutation) and
DEP-4 (the harness provisions and manages test/staging/production from that
same configuration).

**Definition.** `envProvisionContract` in [`src/env/provision.ts`](../src/env/provision.ts).
**Reference provider.** Docker Compose, [`src/env/compose-provider.ts`](../src/env/compose-provider.ts)
— the deploy substrate DESIGN §9 decision 8 chose ahead of a hosted provider,
for the reasons stated there: an environment that comes up and down from
versioned configuration, testable offline, at no cost, holding no credential.
**IaC.** `deploy/environments/<env>/compose.yaml`, declared in
[`deploy/environments/environments.yaml`](../deploy/environments/environments.yaml).
Resolved from the `repo` on each call, the same shape as `ci.checks` and
`pm.github` — a provider takes no checkout of its own, so a caller naming one
repo can never be answered from another's IaC.

## What the contract does not do

It does not decide *what* is deployed. `up` takes an optional `image`; a
provider that receives none uses whatever the environment's own compose file
defaults to. Assembling an image reference from a built release — the version,
the changelog, the rollback path — is DEP-3 and T4.1.2's `release.deliver`,
the same way `test.nfr#run` takes its threshold from the caller rather than
reading Scope back for it.

It does not verify health beyond "is the environment up" (see below), decide
whether to promote or roll back, or run progressive delivery. Those are
T4.1.3/4. This contract answers one question — does the environment exist, in
the shape the repository says it should — for whichever caller needs the
answer: a release pipeline before it deploys, a `test.nfr` provider before it
points a load test somewhere, an operator's `mpgm status`.

## Declared environments

A project declares which environments exist and where each one's compose file
lives; the contract itself takes an environment name and says nothing about
which names are legal, the same way `ci.checks`' mapping of check names to
kinds is project configuration and not part of the contract (EXT-2/3). A
provider MUST refuse a name the project has not declared rather than guess
from a directory-naming convention — DEP-4 asks for environments the harness
provisions from configuration it was given, not ones it infers, and guessing
would provision infrastructure nothing wrote down.

This project declares `test` and `staging`. `production` is deliberately
undeclared: DEP-4 asks the harness to be *able* to provision production, but
the hard approval gate that must stand in front of it (DEP-2, HIL-2) is
T4.1.4's, not yet landed — an IaC file for an environment nothing can gate is
an environment a compose command could bring up unreviewed. Declaring it is a
one-line addition to the manifest once the gate exists to sit in front of it.

## Operations

### `up`

| | |
|---|---|
| Input | `{ repo, env, image? }` |
| Output | `{ env, up, services }` |
| Effects | `idempotent` |

Brings the declared environment up. Re-running with the same input converges
on the same running set rather than piling up containers — a provider MUST key
its stack by the environment's own declared identity (the compose project
name in the manifest), so a retry after a crash reconciles instead of starting
a second stack alongside the first. That is what makes the effect semantics
honestly `idempotent`, the same guarantee `pm.github#apply` gets from keying
every operation by something stable.

`image`, when given, overrides whatever image the environment's compose file
defaults to. Absent, the default runs — which is what lets the IaC alone
stand up a real environment before any release artifact exists to point it at
(this task's own completion criterion).

`services` is one entry per service the environment's compose file declares:
`{ name, state, health, containerId }`. `state` is one of `running`,
`restarting`, `paused`, `exited`, `dead`, `created`, or `unknown` for
anything a provider does not recognise; `health` is `healthy`, `unhealthy`,
`starting`, or `none` for a service with no healthcheck declared.

A provider MUST wait for every service to settle — running, and healthy where
a healthcheck exists — before returning, and MUST fail the call (not return a
partial success) if one does not. A caller that receives `up: true` needs it
to mean the environment is actually reachable, not that containers were
merely started; the alternative reports success on infrastructure that is not
there yet, which is worse than a slower, honest failure.

### `down`

| | |
|---|---|
| Input | `{ repo, env }` |
| Output | `{ env, up, services }` |
| Effects | `idempotent` |

Tears the environment down. Tearing down an environment that is already down
MUST succeed and report `up: false` with an empty `services` — it is not an
error, the same way `ci.checks#status` reports "nothing reported" rather than
failing when a ref has no runs yet.

`down` does not run on a failed `up`. An environment `up` left partially
standing is left there for whoever is debugging it to look at; the caller
decides whether to tear it down, the way a failed `git merge` is aborted back
to the prior state (`src/implement/merge.ts`) but a failed deploy is not
guessed at.

### `status`

| | |
|---|---|
| Input | `{ repo, env }` |
| Output | `{ env, up, services }` |
| Effects | `read-only` |

The same shape `up` and `down` report, without changing anything. Asking costs
nothing, so no intent needs recording before it (DESIGN §6).

## Failing closed

`up` in the output is computed the same way everywhere it is reported — by
`environmentUp` in `src/env/provision.ts`, not independently by each
operation — and it is true only when every reported service is `running` and
either `healthy` or has no healthcheck (`none`). A service the provider cannot
account for, one still `starting`, or an environment reporting no services at
all, all read as **not up**. The dangerous version of this component is the
one that reports an environment ready because it found nothing obviously
wrong; `starting` in particular is not "probably fine" — it is "ask again", so
it is refused exactly as `unhealthy` is.

This is not a promise a provider is trusted to keep: `envStatusOutput` itself
refuses any `up` that disagrees with `environmentUp(services)`, so a provider
reached over MCP cannot assert `up: true` past the boundary while reporting
empty or unhealthy `services` — the mismatch is something the output schema
cannot represent, not merely something a caller could check and forget to.
`composeProvider`'s own `ps` call passes `--all`, for the same reason: without
it, a stopped container disappears from `docker compose ps` entirely instead
of being reported as not running, which would let `environmentUp` see an
all-running set for an environment that is actually half down.

## Consumers

- [`src/env/provision.ts`](../src/env/provision.ts) — `envProvisionContract`
  and `environmentUp`, the pure decision every operation's output agrees with.
- [`src/env/compose-provider.ts`](../src/env/compose-provider.ts) —
  `composeProvider`, satisfying the contract against `docker compose` and the
  manifest at `deploy/environments/environments.yaml`.
- `scripts/demo/env-provision.mjs` — this task's own verification: brings the
  `test` environment up from the committed IaC alone, asserts it is reachable,
  and brings it back down.
