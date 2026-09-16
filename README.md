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
npm run check
```

`npm run check` runs the same pipeline as CI: format, lint, typecheck, build, test, a secret
scan, and the milestone verification demos in `scripts/demo/`. Four of those demos
(`demo:env`, `demo:release`, `demo:verify`, `demo:gate`) shell to a real Docker daemon and fail
without one — use `npm run check:fast` where no daemon is available, and see
[DEVELOPMENT-CLOUD.md](DEVELOPMENT-CLOUD.md) for what else that changes.

`mpgm` is not installed globally — `package.json` is `"private": true` — so invoke the built CLI
directly. This walks a project to its first gated artifact, the Definition phase (DEF-1):

```bash
node ./bin/mpgm.mjs chat definition --run r1 --brief "<a sentence on what you're building>"
node ./bin/mpgm.mjs run definition --run r1
node ./bin/mpgm.mjs approve definition-gate --run r1 --by <you> --tag
```

The first command is an interactive elicitation dialogue and is not optional:
[phases/definition.yaml](phases/definition.yaml) declares its output as a required input to the
phase, and `run definition` refuses to dispatch anything without it. The second drafts and
adversarially reviews a Definition artifact and presents a gate packet for your decision; the
third approves it, which tags it in git (immutable from there on). All three need model access —
`ANTHROPIC_API_KEY`, or a `claude` login on disk — and nothing else; the full credential list for
running the harness further than this (`gh`, `git push`, Docker) is in
[DEVELOPMENT-CLOUD.md](DEVELOPMENT-CLOUD.md). `npm run demo:definition` runs the same three steps
against a disposable sample project with scripted operator answers, if you want to see it before
running it on your own.

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
