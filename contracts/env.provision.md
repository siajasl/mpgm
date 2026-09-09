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

This project declares `test`, `staging`, and — as of T4.1.4b — `production`.
`production` stayed undeclared through T4.1.1–T4.1.4a: DEP-4 asks the harness
to be *able* to provision production, but the hard approval gate that must
stand in front of *this contract's own* operations — `up` included, `down`
too, since tearing a gated environment down and bringing it back up on the
compose default is also a way to change what it serves — had not landed yet.
Declaring `production` before that gate existed would have left
`env.provision#up`/`#down`, reached directly and bypassing `release.deliver`
entirely, as a wholly ungated route to it; declaring it in the same commit as
the gate that closes that route is what makes the declaration honest (see
"The gate on `up`/`down`" below).

Each declared environment also marks `approval: required` or `approval: none`
(`src/env/compose-provider.ts`'s `environmentEntrySchema`, required per entry
— CONV-5, a manifest cannot decline to say which) — the single place HIL-2's
"which environments need an operator's approval" is answered from, read by
`gatedEnvironmentNames`/`gatedEnvironments` for `src/policy/deploy-gate.ts`'s
`gateProductionRelease` (`contracts/release.deliver.md`'s `deliver`/`rollback`,
T4.1.4a) *and* `gateProvisionRelease` (this contract's own `up`/`down`,
T4.1.4b). `staging` was marked `required` first, to prove the release-path
gate against a real environment before `production` existed at all;
`production` is marked `required` too, now that both gates stand in front of
it.

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
nothing, so no intent needs recording before it (DESIGN §6). `status` is never
gated, for the same reason.

## The gate on `up`/`down` (T4.1.4b)

`up` and `down` change what an environment serves, and this contract carries
no notion of "production" of its own — a manifest's `approval: required`
marker is what says an environment needs an operator's confirmation before
either can reach it (HIL-2). `release.deliver#deliver`/`#rollback`
(`contracts/release.deliver.md`, T4.1.4a) sit behind one such gate already,
but they delegate to `env.provision#up` underneath, and a caller reaching
`up` — or `down` — directly, bypassing `release.deliver` entirely, reached a
gated environment with no check at all until T4.1.4b. `gateProvisionRelease`
(`src/policy/deploy-gate.ts`) closes that; `src/env/compose-provider.ts`'s
`composeProvider` takes it as a required constructor option and always
returns the wrapped result, the same structural guarantee
`dockerReleaseProvider` gives `release.deliver` (DESIGN §9 decision 10) — no
code path in this repository binds this contract's reference provider
ungated.

Three cases, all scoped to environments a project marks `approval: required`
— every other environment passes through exactly as it did before this gate
existed:

- **`up` carrying an `image`.** Refused outright, before any fingerprint is
  computed, unless `image` is actually shaped like a digest — `'sha256:'`
  followed by its hex id, exactly what `docker build --iidfile` writes and
  what `release.digest` always is. `image` is documented above as an
  override of the compose default and carries no shape of its own; a review
  found the gate fingerprinting whatever it named regardless, tag included,
  which let one operator confirmation of `up {image: 'app:1.0.0'}` stand as a
  standing authorisation for every later `up` naming that same tag, however
  many times it had since been rebuilt to point at a different tree — a
  confirmation over a mutable name, not over the build an operator actually
  saw, and exactly the failure mode decision 9's "a digest cannot be made to
  name another build, which a tag can" reasoning exists to rule out. Once
  `image` is digest-shaped, checked under the identical `{repo, env, digest}`
  fingerprint `release.deliver#deliver` of the same digest would compute — a
  digest names one build, whichever contract asks to run it, so a
  confirmation given through either path satisfies both (DESIGN §9 decision
  9/11/14, CONV-4). The one caller in this repository that ever reaches a
  gated `up` with an `image` — `release.deliver`'s own `deliverTo` — always
  supplies `release.digest`, so nothing here regresses; a caller that wants a
  gated environment to run a tag goes through `release.deliver`'s gate on a
  real digest first, the same as every other path to one.
- **`up` with no `image`.** Gated unconditionally, whatever the wrapped
  provider's own `status` reports — even nothing at all. An earlier version
  of this gate asked `status` first and let the call through untouched when
  nothing was reported, reasoning that standing up infrastructure nothing is
  serving asks nothing of an operator; a review found that reachable, not
  theoretical — `production` was declared the same commit this gate landed
  in, and had never been stood up, so its only reachable state *was* exactly
  the untouched one, meaning a no-image `up` could stand it up on the compose
  default with no approval anywhere in the path, which is precisely the
  outward-facing production deploy HIL-2 says must always require one.
  `status` is still asked, not to decide whether to gate, but to fold what it
  reports into the fingerprint (see below) so a confirmation answers "may
  *this* reported state be replaced", first bring-up included, rather than
  "may a no-image `up` here ever proceed".
- **`down`.** `status` still decides whether there is anything here to
  protect in the first place: tearing down infrastructure nothing is serving
  genuinely changes nothing, so a `down` against an environment `status`
  reports no service in at all proceeds untouched. Any service reported, it
  is refused until an operator confirms tearing down *that exact reported
  state* — not a fingerprint fixed for "tear this `{repo, env}` down" in
  general, which a review found let one confirmed teardown stand as a
  standing authorisation to tear the same environment down again in every
  later run, whatever it happened to be serving by then. The two-call route
  a fixed-fingerprint `down` followed by an unconditionally-gated no-image
  `up` might otherwise seem to reopen — a confirmed `down` leaving the
  environment reporting nothing, for a no-image `up` to find — does not
  apply here either, because the `up` case above no longer trusts "nothing
  reported" to mean "safe to proceed" at all.

Both `up`'s and `down`'s gated fingerprints fold the wrapped provider's
currently-reported services into the identity (`recreateOnDefaultDigest`,
`teardownDigest`, `src/policy/deploy-gate.ts`) rather than using a sentinel
fixed for the act alone: a confirmation this way answers "may *this* state be
replaced or torn down", not "may this kind of call against this environment
ever proceed" — the distinction a review found missing, since a fixed
sentinel let one operator confirmation of a teardown or a recreate stand as a
permanent authorisation for every later one, however different what the
environment was actually serving by then. The refusal an operator confirms
against says this directly — "this confirmation covers only this exact
reported state" — rather than leaving it to be inferred from reading this
module (CONV-3).

One state is a declared exception to that per-state guarantee, not an
oversight: an environment reporting no services at all folds to the single
identity `'none'`, so a confirmation of a first bring-up found there is good
for any later no-image `up` this environment is found in the same empty
state for — after a later confirmed teardown, or after the containers are
removed by something outside this gate entirely — with no fresh approval.
This mirrors DESIGN §9 decision 11's own reasoning on the release path: a
digest naming one already-approved state may be re-approved for free, and
"nothing running" is one such state, not a different one each time it
recurs. The no-image `up` refusal says so directly whenever `status` reports
nothing, rather than leaving an operator to infer it from `servingIdentity`'s
source.

This is deliberately not the same question `up` in the output answers.
`envStatusOutput.up` (`environmentUp`) fails closed for a service still
`starting`, `unhealthy`, `exited`, or otherwise short of cleanly
`running`/healthy — the right default for "may this be trusted to serve
traffic", and the wrong one for "is there something here a gate must
protect": read that way, a confirmed release failing its healthcheck,
mid-`start_period`, or whose container exited, is indistinguishable from an
environment with nothing running in it at all, and both `down` and the
no-image `up` would reach the provider with no approval during exactly the
conditions a deploy ordinarily passes through. What decides "nothing to
protect" here is the presence of any reported service, never its health.

A provider with no `status` is refused outright for a gated environment,
fail closed (CONV-4): neither the no-image `up` case nor `down` can compute a
fingerprint over what is actually there, and `down` additionally cannot tell
"nothing to protect yet" from "this would replace a confirmed release",
without asking first — and every provider satisfying this contract already
implements `status` (see "Operations" above), so this asks nothing new of one
that does. `scripts/demo/deploy-gate.mjs` (`npm run demo:gate`) exercises the
`release.deliver` side of this against a real `docker compose`; the
`env.provision`-only cases above, including a service that is `starting`,
`unhealthy`, `exited` or `restarting` rather than cleanly up, are exercised
directly against a fake provider in `src/policy/deploy-gate.test.ts`
(`gateProvisionRelease`) and against the real `composeProvider` in
`src/env/compose-provider.test.ts`.

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
  manifest at `deploy/environments/environments.yaml`; always gated (T4.1.4b).
- [`src/policy/deploy-gate.ts`](../src/policy/deploy-gate.ts) —
  `gateProvisionRelease`, the HIL-2 gate on `up`/`down` described above
  (T4.1.4b).
- `scripts/demo/env-provision.mjs` — T4.1.1's own verification: brings the
  `test` environment up from the committed IaC alone, asserts it is reachable,
  and brings it back down. `test` marks `approval: none`, so this exercises
  the gate's pass-through case, not its refusal.
- `scripts/demo/deploy-gate.mjs` — T4.1.4a's own verification, against
  `release.deliver`; the fingerprint an `up` carrying an `image` shares with
  it is what lets a confirmation recorded there satisfy this contract's own
  `up` too.
