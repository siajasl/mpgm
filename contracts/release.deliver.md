# `release.deliver`

**Purpose.** Assemble an immutable, versioned release artifact and hand it —
or a prior one — to a declared environment (`env.provision`, `contracts/
env.provision.md`), delegating rollout mechanics rather than reimplementing
them. Satisfies DEP-3 (every release carries an immutable versioned artifact,
a changelog, and a tested rollback path) and the delivery half of DEP-2 (a
release reaches a pre-production environment before production, and a
rollback path exists and works).

**Definition.** `releaseDeliverContract` in [`src/release/deliver.ts`](../src/release/deliver.ts).
**Reference provider.** `dockerReleaseProvider`, [`src/release/docker-provider.ts`](../src/release/docker-provider.ts)
— builds with `docker build` and delivers by calling the `env.provision`
contract's `up`, the same way `composeProvider` calls `docker compose`
underneath `env.provision`.
**Sample service.** [`deploy/sample-service/`](../deploy/sample-service/) — a
service whose served content changes with `APP_VERSION`, so a release and a
rollback are both observable rather than merely asserted (this task's own
completion criterion: a staged release with a *tested* rollback path).

## What the contract does not do

DESIGN §4.7 draws this line for the whole delivery integration, not just this
contract: "progressive delivery is delegated to existing CD tooling ... mpgm
supplies release artifacts, watches health signals, records outcomes, and
issues promote/rollback *decisions* per policy — it does not implement
rollout mechanics." `release.deliver` is the "supplies release artifacts" and
"hand it to whatever runs it" half of that sentence. It does not:

- **Decide whether to deliver or roll back.** That is DEP-2/DEP-5 policy —
  health verification, promote/rollback decisions, and outcome artifacts —
  [`src/release/verify.ts`](../src/release/verify.ts) (T4.1.3), not this
  contract. This contract executes a delivery or a rollback once something
  else (a playbook, an operator, `verifyRelease`) has decided which.
- **Run progressive delivery.** Canary or percentage rollout is DEP-2's SHOULD
  half. The reference provider delegates through `env.provision`, whose
  reference substrate is Docker Compose (DESIGN §9 decision 8) — an
  all-at-once swap, not a canary. Swapping the bound `env.provision` contract
  for one fronting Argo Rollouts or a cloud-native equivalent is what §8's
  "deploy substrate" revisit trigger describes, and nothing in this contract
  or its consumers would need to change for that swap (EXT-2/3).
- **Distribute the artifact anywhere.** DESIGN §9 decision 9: a release is a
  local image, pinned by the digest `docker build` produced, with no registry
  and therefore no credential to hold. It does not outlive the machine that
  built it — the same gap §8's "release distribution" revisit trigger names
  for the substrate as a whole, and it moves at the same time.

`assemble` and delivery to an environment `<repo>`'s manifest does not mark
`approval: required` are otherwise exactly as before — the approval gate below
is additive, not a change to what already worked.

## The deploy gate (DEP-2, HIL-2, T4.1.4a)

`deliver` and `rollback` are both refused for a *gated* environment unless an
operator has confirmed the exact call — `src/policy/deploy-gate.ts`'s
`gateProductionRelease`. Which environments are gated is never a name this
module or this contract hardcodes: `<repo>`'s own
`deploy/environments/environments.yaml` marks each declared environment
`approval: required` or `approval: none` (`contracts/env.provision.md`,
`env/compose-provider.ts`'s `gatedEnvironments`), and `gatedEnvs`
(`DeployGateOptions.gatedEnvs`) is a function of `repo`, resolved fresh on
every call rather than a set built once before the provider is constructed
— wiring `gatedEnvs: gatedEnvironments` directly is what every caller in
this repository does. That is deliberate, not incidental: `repo` arrives on
every `deliver`/`rollback` input, the same as it does on every
`env.provision` call, so a set fixed at construction would judge a call
naming a *different* repo by the manifest of whichever repo happened to
build the provider, rather than by that call's own project — this project
marks `staging` required, to demonstrate the gate without needing
`production` declared at all (PLAN.md splits "gate the release path" from
"gate the environment path, and declare production" along the
`release.deliver`/`env.provision` contract boundary; this is the first of
the two). HIL-2 asks
for explicit approval on an irreversible, outward-facing action *regardless
of gate settings*, which a phase gate cannot promise (HIL-1 lets one be
auto-approved) and which the `PreToolUse` destructive-tool guard
(`src/policy/destructive.ts`, SAF-4) never sees in the first place — a deploy
the kernel makes itself passes through no tool call, the same way a merge
does. The gate therefore reuses that guard's *shape* rather than its wiring:
a fingerprint over `{repo, env, digest}`, a dry run that records intent
without effect, and a confirmation keyed to that exact fingerprint — read
from the same `destructiveCalls` state SAF-4's guard already writes, so the
same `mpgm confirm <fingerprint> --by <who>` an operator uses for a
destructive tool call is what confirms a deploy. Identity is the digest
alone, not the release artifact that carries it (DESIGN §9 decision 9's
reasoning applied to what an approval actually covers): a `deliver` and the
`rollback` that later restores it are the same approval question, whatever
else (a changelog rewritten after the fact) differs. It is not read the same
way SAF-4 reads it, though: SAF-4's `stateLedger` is scoped to the one run a
tool call happened in, which is right for a call that lives inside a
session, but a deploy confirmation has to outlive the run that asked for it
— `deploy-gate.ts`'s `crossRunLedger` looks across every run for a match
instead, which is what makes the next paragraph's "asks nothing new of
HIL-2" literally true rather than true only until the confirming run ends.
`repo` in the fingerprint is `releaseDeliverInput`/`releaseRollbackInput`'s
`repo` — the checkout path a caller resolves the target project's manifest
from, an absolute filesystem path in every caller this repository ships
(the demos derive it from `import.meta.url`) — not a stable identity for
the project independent of where it happens to be checked out. A
confirmation is therefore scoped to the checkout it was given for: the same
project checked out twice, or worked from a `.mpgm/worktrees/<taskId>` tree
distinct from the checkout a dry run and confirmation were recorded
against, computes a different fingerprint and finds no confirmation there,
however identical `env` and `digest` are. That fails closed (CONV-4) rather
than silently, but it does mean a confirmation does not travel between
checkouts of the same project, which an operator relying on DEP-2's
automatic rollback firing from whatever checkout the kernel happens to act
from needs to know.

The gate is applied inside `dockerReleaseProvider`'s own construction, not
left for a caller to wrap on afterward: its `gate` option is required, so
there is no code path in this repository — not the CLI, not a demo script,
not a future orchestrator effect — that obtains an unguarded `deliver`/
`rollback` from the one concrete provider this contract has here
(`dockerReleaseProvider`; DESIGN §9 decision 10). That guarantee is about
this repository's only provider, not the contract itself: `Provider` is a
bare, untyped record and `CapabilityRegistry.bind` accepts any object
shaped to match, so nothing stops a *different* provider satisfying this
contract with no gate at all. A caller wires the gate's
`onDryRunNeeded` to append the `DryRunRecorded` event its own refusal names
— the gate has no separate dry-run mode to call first, so a refusal for want
of one *is* the simulation, and this records it the instant that happens.
The first call for a given `{repo, env, digest}` is therefore always
refused, but leaves that exact fingerprint confirmable; `mpgm confirm
<fingerprint> --by <who> --run <the run this call happened under>` and the
same call again then proceeds. `--run` is not optional in practice even
though the CLI accepts its absence: omitting it confirms against `run-1` by
default, which is silently wrong whenever the dry run that made this
fingerprint confirmable happened under a different run.
`scripts/demo/deploy-gate.mjs` (`npm run demo:gate`) is this task's own
verification, wiring `onDryRunNeeded` and confirming exactly the way
described above.

`rollback` is refused the same way *unless* the release it names was already
confirmed for this environment — restoring a release the environment already
ran asks nothing new of HIL-2 (DESIGN §9 decision 11: approval was given to
that exact digest earlier), but `rollback` naming a release that was never
confirmed would otherwise be a second, ungated door into it that `deliver`'s
own refusal never sees. That earlier approval is found by `crossRunLedger`
regardless of which run gave it, which is what lets DEP-2's automatic
rollback — invoked from whatever later run notices the regression, never
guaranteed to be the run that delivered and got the release confirmed in the
first place — proceed on that same earlier approval instead of stalling for
a fresh one.

**This was not the only route to a gated environment, and this task did not
close the other one — T4.1.4b did.** `deliver`/`rollback` hand the same
digest to `env.provision#up` underneath (`contracts/env.provision.md`), and a
caller reaching that operation directly — with an `image` override, bypassing
this contract entirely — was not gated by anything this task built.
`env.provision`'s own `gateProvisionRelease` (`src/policy/deploy-gate.ts`)
closes that: every `env.provision#up`/`#down` call that could change what a
gated environment serves is checked the same way, `down` included, since
tearing a gated environment down and bringing it back up on the compose
default is also a way to change what it serves. It shares this contract's
own fingerprint identity for the case that matters most — an `up` carrying an
`image` computes the identical `{repo, env, digest}` fingerprint a `deliver`
of the same digest would, so a confirmation given through either contract
satisfies both, and this contract's own `deliverTo` (which calls
`env.provision#up` with `release.digest` after this gate has already let the
call through) never gets asked to confirm the same digest twice. `production`
is declared in this project's own manifest as of T4.1.4b, only once this
second gate existed to stand in front of it (`deploy/environments/environments.yaml`,
DESIGN §9 decision 14).

## The release artifact (DEP-3)

```ts
{ version, image, digest, changelog, rollbackTo: { version, digest } | null }
```

`version` and `changelog` are required, non-empty strings — a release that
DEP-3 would call incomplete cannot be constructed as valid output at all, the
same "express the obligation as something that cannot be represented" move
`env.provision`'s `up`/`services` agreement makes (CONV-5). `digest` is the
immutable id a build produced; `image` is the human-readable repository/tag it
was built and tagged under, kept alongside the digest because a digest alone
is not something an operator reads at a glance. `rollbackTo` is the release
this one supersedes — a rollback *path* every release after the first carries
as a field, not a lookup performed only once something has already gone
wrong. It is `null` only for an environment's first release ever, because
there is nothing yet to name.

## Operations

### `assemble`

| | |
|---|---|
| Input | `{ repo, context, dockerfile?, image, version, changelog, buildArgs, previous }` |
| Output | the release artifact above |
| Effects | `idempotent` |

Builds `context` (a path relative to `repo`) with `docker build`, tagging
`image:version` and recording the digest the build produced. `dockerfile`
defaults to `<context>/Dockerfile`. `buildArgs` are passed through as
`--build-arg NAME=VALUE` — the contract does not know or care what a
Dockerfile's build args are called, the same boundary `env.provision`'s
`image` override draws around what actually runs (`contracts/
env.provision.md`).

`previous` is required — `null` for an environment's first release, the ref
being superseded otherwise — and has no default, so a caller cannot omit it
and land a release with no rollback path by accident; forgetting it is a
validation error, not a silent `rollbackTo: null`. It is copied straight into
the output's `rollbackTo` — see `nextRelease` in `src/release/deliver.ts`, the
one place every provider MUST build the artifact through, so a provider's own
idea of what came before can never diverge from what the caller actually
asked to supersede.

Rebuilding an unchanged tree under the same build args reuses the cached
image on the machine that built it — but only while that cache is warm. A
cold rebuild (a fresh runner, or a cache that has been pruned) produces a
*different* digest for the same tree and build args; `docker build` makes no
reproducibility promise across machines or cache states, and DESIGN §9
decision 9 does not claim one either — it says only that a digest names one
build of one tree. `effects: 'idempotent'` here is therefore the kernel's own
definition (`src/effect/contract.ts`: re-running is harmless, so retry
without asking), not digest equality: a resumed `assemble` either lands the
same artifact (warm cache) or mints a new one for the same version and
changelog (cold cache) — either is a safe outcome of retrying, which is what
the label actually promises.

### `deliver`

| | |
|---|---|
| Input | `{ repo, env, release }` |
| Output | `{ env, release: { version, digest }, up, services }` |
| Effects | `idempotent` |

Hands `release` to `env`, delegating to `env.provision#up` with `image` set
to `release.digest` — the reference provider's *only* opinion about rollout
mechanics is that `env.provision` has them, not what they are. `up` and
`services` are `env.provision`'s own report of whether the environment is
now actually reachable (`environmentUp`, reused rather than reinvented — see
"Failing closed" below).

### `rollback`

| | |
|---|---|
| Input | `{ repo, env, to }` |
| Output | `{ env, release: { version, digest }, up, services }` |
| Effects | `idempotent` |

Mechanically identical to `deliver` — the reference provider calls the same
`env.provision#up` with `to.digest` — but a distinct operation, the same way
`env.provision`'s `up` and `down` are distinct calls rather than one call with
a direction flag: what happened is worth being able to tell apart in the
event log even when the underlying mechanics did not need to differ. `to` is
a full release artifact, not a bare ref, so a rollback's own record carries
the changelog and rollback path of the release it restores, exactly as any
other delivery would.

A rollback is **tested**, not merely declared, when a caller can actually
observe the environment serving the restored release's content afterward —
`scripts/demo/release-deliver.mjs` is this contract's own proof: it delivers
two releases of the sample service in turn, confirms the environment's
content changes between them, rolls back to the first, and confirms the
content reverts.

## Failing closed

`up` is computed by `environmentUp` (`src/env/provision.ts`) from `services`,
the exact function `env.provision` itself uses — reused, not reimplemented,
because the reference provider has nothing else to know "up" from once it has
delegated delivery to `env.provision`. `releaseStatusOutput` refuses any `up`
that disagrees with `environmentUp(services)`, the same way `envStatusOutput`
does: a provider that delegates through a different CD tool still cannot
assert `up: true` past this boundary while reporting empty or unhealthy
`services`, because the mismatch is something the output schema cannot
represent (CONV-4, CONV-5).

## Consumers

- [`src/release/deliver.ts`](../src/release/deliver.ts) —
  `releaseDeliverContract`, `nextRelease` (the pure artifact constructor every
  provider's `assemble` MUST share), and the schemas above.
- [`src/release/docker-provider.ts`](../src/release/docker-provider.ts) —
  `dockerReleaseProvider`, satisfying the contract against `docker build` and
  a bound `env.provision` contract, and applying the deploy gate below at
  construction.
- [`src/policy/deploy-gate.ts`](../src/policy/deploy-gate.ts) —
  `gateProductionRelease`, `deployFingerprint`, `crossRunLedger`: the HIL-2
  approval gate this contract's `deliver`/`rollback` are wrapped in.
- `scripts/demo/release-deliver.mjs` — T4.1.2's own verification: two
  releases of the sample service delivered in turn, and a rollback to the
  first, all confirmed against what the environment actually serves.
- `scripts/demo/deploy-gate.mjs` — this task's own verification: a release to
  `staging` (`approval: required`) is refused unsimulated, refused simulated
  but unconfirmed, delivered once confirmed, and a rollback to it needs no
  fresh confirmation; a release to `test` (`approval: none`) is never gated.
- [`src/release/verify.ts`](../src/release/verify.ts) (T4.1.3) — health
  verification and promote/rollback decisions, calling this contract's
  `rollback` once its own smoke checks decide a delivered release is not
  what it should be.
