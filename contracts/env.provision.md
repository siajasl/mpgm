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

This project declares `test`, `staging` and `production`
(`deploy/environments/environments.yaml`). `env.provision` itself carries no
notion of "production" — `up`/`down`/`status` treat every declared name the
same, per DEP-4 — but each entry MUST also declare `approval: required` or
`approval: none` (required, not defaulted: CONV-5), which is how a project
says which of its own environments HIL-2's hard approval gate covers. This
project marks only `production` `approval: required`.

The gate DEP-2/HIL-2 ask for lives one layer up
(`src/policy/deploy-gate.ts`, T4.1.4/DESIGN §9 decision 10/14), applied at
every route an image can reach a gated environment through, not only one of
them: `release.deliver#deliver`/`#rollback` (`gateProductionRelease`) *and*
this contract's own `up`, when it carries an `image` (`gateProvisionRelease`)
— a caller reaching `up` for a gated environment with an image is refused
exactly as `release.deliver` would refuse it, unless an operator has
confirmed the exact `{repo, env, digest}` named. T4.1.4's first review found
the earlier version of this paragraph's reasoning false: "nothing stops an
operator running `docker compose up` by hand" is true of an operator's own
shell but was never a defence for a kernel capability a caller — the CLI, a
demo script, or a future orchestrator effect — can reach programmatically,
and nothing did refuse that call before this. `up` with no `image` is left
untouched by the gate regardless of `approval` — standing up the declared IaC
before any release exists to point it at is this contract's own reason to
exist, and gating it would gate infrastructure nobody is asking to deploy
anything onto.

T4.1.4's second review found two further gaps in that first fix, both closed
in the reference provider now: `gateProvisionRelease` was applied by exactly
one caller (an in-repository `mpgm rollback` verb this task had not yet been
split from — see "Scope" below) rather than built into the reference
provider itself, so three other committed callers
(`scripts/demo/env-provision.mjs`, `release-deliver.mjs`,
`release-verify.mjs`) bound `composeProvider()` raw — a caller could still
construct an ungated `up`, the identical shape the first review had already
ruled out for `release.deliver`. `composeProvider`
now takes its gate as a required constructor argument, exactly as
`dockerReleaseProvider` does, and always returns the `gateProvisionRelease`
-wrapped result — there is no unwrapped provider this contract's reference
implementation ever hands back. Second, "`up` with no `image` is left
untouched" was true of the gate's own logic but not of what actually reached
`docker compose`: the reference provider passed no explicit
`MPGM_SERVICE_IMAGE` at all on a no-image `up`, so an ambient value already
present in the *caller's own process environment* reached the child
unchanged, and this project's own compose files resolve
`${MPGM_SERVICE_IMAGE:-nginx:1.27-alpine}` — an unset-or-empty variable falls
back to the pinned default, but a *set* one, however it got set, overrides
it. An `up` with no `image` in its input MUST still resolve to the
environment's declared default, not to whatever the process happened to
have lying around; the reference provider now clears
`MPGM_SERVICE_IMAGE` explicitly on every no-image `up`, rather than leaving
its absence to be decided by inheritance (CONV-4).

**Scope.** T4.1.4 originally carried the gate, `mpgm rollback`, and release
outcome artifacts as one task; three sessions could not close it, and PLAN.md
split it: T4.1.4 keeps only the gate (this section), T4.1.5 takes the
`mpgm rollback` verb, T4.1.6 takes outcome artifacts. The `mpgm rollback`
caller the paragraph above found ungated no longer exists in this repository
— it was scope T4.1.4 never owned in the first place, and its own gating,
when T4.1.5 adds it, inherits the guarantee this section already makes:
`composeProvider`/`dockerReleaseProvider` return only gated providers,
whatever calls them. `scripts/demo/deploy-gate.mjs` (`npm run demo:gate`) is
this task's own real caller, verifying the gate directly against
`env.provision`/`release.deliver` rather than through a CLI verb.

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
(this task's own completion criterion). This project's own manifest declares
a `releaseOverride` compose file per environment, applied on top of the base
one only when `image` is given (`environments.yaml`,
`deploy/environments/*/compose.release.yaml`) — the reference provider's own
default service bind-mounts a placeholder page that would otherwise keep
serving itself over whatever a delivered image contains. That mapping is
project configuration, the same way which environment names are legal is
(EXT-2/3): the contract itself only ever asks for `image` to be honoured,
never for a particular way of arranging a compose file to honour it. See
`contracts/release.deliver.md` for the delivery this makes observable.

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
