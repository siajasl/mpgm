# Running mpgm on a cloud-hosted Claude Code instance

**Status:** v0.1 — written against `main` at T4.2.6.
**Upstream:** [CLAUDE.md](CLAUDE.md), [DESIGN.md](DESIGN.md) §4.4/§6, [REQUIREMENTS.md](REQUIREMENTS.md) NFR-2/NFR-6, SAF-2.

This document is about hosting the harness, not about using it. It answers one question: what a
cloud-hosted box needs before `mpgm implement` can run a task end to end — worktree, sessions,
review, merge — and what silently degrades if it is missing.

mpgm is not a plugin inside a Claude Code session; it is a Node process that *starts its own*
Agent SDK sessions. Running it on a cloud Claude Code instance means running that process in the
instance's shell, and everything below follows from that.

## 1. What the box must have

| Requirement           | Why, and where it is read                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node >= 24**        | The authoritative event log is `node:sqlite`'s `DatabaseSync` ([src/database.ts](src/database.ts)), stable from Node 24. `package.json` pins `engines.node`; CI proves 24.x and 26.x. |
| **`npm ci`**          | Three runtime dependencies. The Agent SDK ships its own bundled CLI, so a separate `claude` install is **not** needed.                                                      |
| **`git`**             | One worktree per implementation task on branch `mpgm/<taskId>` ([src/implement/worktree.ts](src/implement/worktree.ts)), plus history reads for the trace index ([src/trace/git-history.ts](src/trace/git-history.ts)). |
| **`gh` on `PATH`**    | Not optional on the implement path. [src/implement/github-checks.ts](src/implement/github-checks.ts) shells `gh api` to open the pull request, find it again, and read its check runs. There is no JavaScript GitHub client anywhere in `src/`. |
| **`docker`**          | Only for the four deploy demos — see §5. Everything else runs without a daemon.                                                                                            |

The harness's own binary is not installed globally: invoke it as `node ./bin/mpgm.mjs <verb>`.

## 2. Credentials

Four distinct credentials, easily mistaken for two.

**Model access.** `ANTHROPIC_API_KEY`, or a `claude` login whose credentials are on disk. Every
nested session bills against whatever this resolves to — not against the host Claude Code
session that started the process.

**`gh` authentication.** `GH_TOKEN` / `GITHUB_TOKEN`, or `gh auth login`. Needs pull request
write and check-run read on the target repository.

**`git` push.** Separate from `gh`. The kernel — never an agent — publishes the branch with
`git push --force-with-lease origin <branch>` ([src/cli/commands.ts](src/cli/commands.ts)), so a
credential helper or a tokenised remote must be configured. Without it the push fails, no pull
request exists, and the loop waits out its grace period for checks nobody asked for.

**`git` identity.** `user.name` and `user.email`, or the loop's merge commit fails.

### The secret broker is not wired in yet

DESIGN's SAF-2 control — a session environment scrubbed of secrets, with values substituted into
a permitted tool call at the `PreToolUse` boundary — is implemented in
[src/secret/broker.ts](src/secret/broker.ts) and **has no production call site**. Neither
`SessionRunner` construction in [src/cli/commands.ts](src/cli/commands.ts) passes `secrets:`, so
`#secrets` is `undefined`, no `env` is handed to the SDK, and the spawned session inherits the
parent environment whole.

On a developer laptop that is a known gap. On a shared cloud box it is a deployment constraint:
**every environment variable in the instance is visible to model-authored tool calls**, including
`ANTHROPIC_API_KEY` and `GH_TOKEN`. Give the instance only the credentials mpgm itself needs, and
do not co-locate unrelated secrets in that environment until the broker is wired into both
runner sites.

## 3. Persistence — the one that actually bites

`.mpgm/state.db` is the single authoritative append-only log. Folded state, the resume path, the
trace index, every metric and rate, and the crash-restart property M1.1 demonstrates are all
derived from it and from nothing else.

An ephemeral sandbox discards it on teardown. The consequences are not degraded output, they are
a different system:

- a run interrupted mid-task cannot resume — pending effect intents are never resolved (DESIGN §6);
- `status --metrics` / `--rates` and the dashboard report on an empty history;
- `mpgm replay` re-derives state from a log that no longer exists.

So `.mpgm/` must sit on a persistent volume, or be synchronised to durable storage between runs.
The same applies to `.mpgm/worktrees/` while a task is in flight; those are cheap to recreate,
the log is not.

## 4. Network egress

- `api.anthropic.com` — the sessions.
- `github.com` / `api.github.com` — `gh`, and the branch push.
- `registry.npmjs.org` — install.

## 5. What will not run there

`npm run check` shells to a real Docker daemon for `demo:env`, `demo:release`, `demo:verify` and
`demo:gate`. They run `docker compose` and `docker build` against the committed IaC and the
sample service deliberately — a mocked provider would not show that an environment comes up from
repository config alone. Without a daemon those four fail.

Use `npm run check:fast` on an instance with no Docker (it is also 26s against 94s), and run the
full `check` where a daemon exists before anything merges.

The live demos — `demo:agent`, `demo:definition`, `demo:scope`, `demo:design`, `demo:plan` — make
real model calls and need model credentials rather than Docker. `npm run probe:sdk` is the cheap
live check that the SDK layer is wired correctly at all; run it first when a live demo fails.

## 6. Time, and the operator

An implement run takes 20–40 minutes across several sessions. Two consequences for a hosted
instance:

- the shell must tolerate a long-lived foreground process. Per-session progress lines land as
  they happen (T4.2.3), and `node ./bin/mpgm.mjs serve` is the richer surface — the dashboard
  now carries the run's own per-phase and per-role figures and quality rates (T4.2.6).
- **it is not unattended.** Phase gates (HIL-1) and the release and environment approval gates
  (T4.1.4a/b) wait for an operator event. A run reaches one and parks until someone issues
  `approve`, `confirm` or `attest`. Plan for a human on the other end, or for the run to stop.

## 7. Nested sessions are deliberately isolated

The provider sets `settingSources: []` ([src/agent/claude-provider.ts](src/agent/claude-provider.ts)):
the host Claude Code instance's settings, MCP servers and permissions are **not** inherited. A
role's declared toolset is the whole of its permission (AGT-2), enforced in a `PreToolUse` hook
rather than `canUseTool`.

This is the intended boundary, and it means the host instance's configuration tells you nothing
about what a task's sessions can do. Read `roles/` for that.

## 8. Minimum viable instance

```
Node >= 24, git, gh, npm
ANTHROPIC_API_KEY
GH_TOKEN                       # PR write + checks read
git credential helper or tokenised remote
git config user.name / user.email
persistent volume mounted at .mpgm/
egress: api.anthropic.com, github.com, registry.npmjs.org
optional: docker daemon, for the four deploy demos
```

Smoke test, in order — each step fails for a different reason, which is the point of running
them separately:

```bash
npm ci
npm run check:fast                       # no credentials, no daemon needed
npm run probe:sdk                        # model credentials reachable
gh auth status && gh api repos/:owner/:repo --silent   # gh authenticated, repo visible
node ./bin/mpgm.mjs status               # the log opens, and persists across a restart
node ./bin/mpgm.mjs implement <task> --repo <owner/name>
```
