# mpgm

Agentic harness driving the full SDLC via Claude Agent SDK sessions under a single operator.

A deterministic orchestration kernel — event-sourced over an append-only SQLite log, making no
LLM calls itself — schedules work into one Agent SDK session per task, enforces policy and
budgets outside the model, and pauses at operator gates. Versioned markdown artifacts in git are
the only interface between lifecycle phases.

**Status:** self-hosting. The document chain is settled — [REQUIREMENTS](REQUIREMENTS.md) →
[DESIGN](DESIGN.md) → [PLAN](PLAN.md) — and from PLAN task T3.1.8 mpgm runs its own remaining
plan through `mpgm implement` rather than by operator-driven sessions.

## Quick start

Requires Node >= 24.

```bash
npm install
npm run build
```

`npm run build` is the step the invocation below actually depends on — `bin/mpgm.mjs` imports
from `dist/`, which does not exist until this runs. `npm run check` (below) builds too, but it
also runs the full CI pipeline — lint, typecheck, test, a secret scan, nine demos — so it is not
a step on the path to a gated artifact, only what to run before contributing.

`mpgm` is not installed globally — `package.json` is `"private": true` — so invoke the built CLI
directly, **from this checkout's root**: `chat` and `run` read `phases/`, `roles/` and `kb/` from
the current working directory, and there is no scaffold command yet that copies them into a
project of your own — run them anywhere else and `RoleRegistry` throws an uncaught
`RoleLoadError` with a stack trace, not a clean message. This walks the checkout itself to its
first gated artifact, the Definition phase (DEF-1):

```bash
node ./bin/mpgm.mjs chat definition --run r1 --brief "<a sentence on what you're building>"
node ./bin/mpgm.mjs run definition --run r1
node ./bin/mpgm.mjs approve definition-gate --run r1 --by <you>
```

The first command is an interactive elicitation dialogue and is not optional:
[phases/definition.yaml](phases/definition.yaml) declares its output as a required input to the
phase, and `run definition` refuses to dispatch anything without it — that dialogue is the
unbounded term inside NFR-6's one-hour bound. The second surveys prior art, drafts a
Definition artifact, challenges it with an independent reviewer role, and presents a gate packet
for your decision — three sessions, which is where most of the elapsed time below goes; the first two need model
access — `ANTHROPIC_API_KEY`, or a `claude` login on disk — and nothing else. The third only
records your decision — gate truth lives in the event log (ADR-3), and it makes no model call.
The walk is complete once it returns; do not add `--tag` here. That flag exists to write a derived
git marker for the decision, but `tagGate` (`src/git/tag.ts`) does so by running `git add --all
artifacts` and `git commit` **in the checkout you were just told to run these commands from**,
leaving an extra commit (and an annotated tag, `gate/definition/v1`) on whatever branch is
checked out — not something to do by default in a checkout you may intend to contribute from. If
you do want the marker, know what it costs and how to undo it: `git tag -d gate/definition/v1 &&
git reset HEAD~1`, which drops the commit and leaves the artifacts it captured on disk. Do not
reach for `reset --hard` here: that discards the walk's own artifacts along with anything else
uncommitted in the checkout. Keep `--run r1` on every command: the gate packet's own "Approve with:
mpgm approve definition-gate --by <you>" hint omits it, and copying that literally targets the
CLI's default run (`run-1`) instead of the one you started, failing with `no such run: run-1` —
friction inside the hour NFR-6 bounds, reported here rather than worked around. The full
credential list for running the harness further than this (`gh`, `git push`, Docker) is in
[DEVELOPMENT-CLOUD.md](DEVELOPMENT-CLOUD.md). `npm run demo:definition` runs the same three verbs
against a disposable sample project with scripted operator answers — it does pass `--tag`, which
is safe there and not here, because the workspace it commits into is a temporary directory it
made — and prints its own elapsed
time for the walk — a scripted operator's time, not a substitute for timing yourself (T4.2.10,
NFR-6) — if you want to see it before running it on your own.

`npm run check` runs the same pipeline as CI: format, lint, typecheck, build, test, a secret
scan, and nine of the milestone verification demos in `scripts/demo/` — every one that needs no
model credentials. It excludes `demo:definition`, `demo:scope`, `demo:design`, `demo:plan`,
`demo:agent`, `demo:test-phase` and `probe:sdk`, which drive real chat sessions like the one above and need
`ANTHROPIC_API_KEY`; run those yourself. Four of the nine `check` runs (`demo:env`,
`demo:release`, `demo:verify`, `demo:gate`) shell to a real Docker daemon and fail without one —
use `npm run check:fast` where no daemon is available, and see
[DEVELOPMENT-CLOUD.md](DEVELOPMENT-CLOUD.md) for what else that changes.

## Development

| Command | Purpose |
| --- | --- |
| `npm run check` | Full CI pipeline locally |
| `npm test` | Test suite (`test:watch`, `test:coverage`) |
| `npm run lint` | ESLint, type-aware |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Emit `dist/` |

Running the harness on a hosted box rather than a laptop — required binaries, the four
credentials, what a non-persistent `.mpgm/` costs, and what the absence of a Docker daemon
rules out — is [DEVELOPMENT-CLOUD.md](DEVELOPMENT-CLOUD.md).

## License

CC0 1.0 Universal — see [LICENSE](LICENSE).
