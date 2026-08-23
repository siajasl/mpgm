# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

mpgm is an agentic harness driving the full SDLC via Claude Agent SDK sessions under a single operator. The TypeScript scaffold landed at PLAN T1.1.1; the kernel itself begins at T1.1.2.

## Commands

`npm run check` runs the whole CI pipeline locally — format, lint, typecheck, build, test, milestone demo — and is what `main` must pass. Individually: `npm run lint`, `npm run typecheck`, `npm test` (`npm run test:watch` while iterating, `npm run test:coverage` for coverage), `npm run build`, `npm run demo:crash`. A single test file: `npx vitest run src/path/to/file.test.ts`.

Build precedes test: crash fixtures run as subprocesses against `dist/`, because Node strips TS types but will not resolve a `.js` specifier to a `.ts` file. Milestone verification demos live in `scripts/demo/`. `demo:crash` (M1.1) and `demo:cli` (T1.3.6) are offline and run in CI; `demo:agent` (M1.2), `demo:definition` (M1.3), `demo:scope` (T2.1.2) and `demo:design` (T2.1.3) make real model calls, so they are operator-run and need credentials — it is deliberately not in CI, since a verification that silently skipped itself would be worse than none.

SDK wiring worth not relearning:
- Policy is enforced in a **`PreToolUse` hook**, not `canUseTool`. `canUseTool` only runs when the CLI decides a permission *prompt* is warranted, and read-only tools never prompt — so a `Read` executes ungated and unlogged. `PreToolUse` fires for every tool call.
- Pass a role's toolset as `tools` (restricts availability), never `allowedTools` (auto-approves, bypassing the callback).
- Strip `$schema` from `z.toJSONSchema` output; the CLI rejects the dialect URI.
- A result with `subtype: 'success'` can still carry `is_error` (an auth failure looks exactly like this).

`npm run probe:sdk` is the cheap live check for all of this — one minimal session per registered output schema, seconds and cents rather than a whole milestone demo. Run it first when a live demo fails in the SDK layer.

None of the above is reachable by offline tests — `demo:agent` is the only thing that exercises the real wiring, which is why it is a milestone gate rather than a convenience.

TypeScript is pinned to 6.0.3, not the 7.x line: typescript-eslint requires `<6.1.0`, and type-aware rules (`no-floating-promises` above all) matter more here than the native compiler. Revisit when typescript-eslint supports TS 7. Prettier deliberately ignores markdown — the foundation documents are hand-aligned and gated artifacts must not be mechanically reformatted.

## Documents

Strict authority chain — downstream never contradicts upstream:
**REQUIREMENTS.md** (what; stable IDs like `ORC-1`, RFC 2119) → **DESIGN.md** (how; ADR-1..7; elements cite requirement IDs) → **PLAN.md** (build order; phases → milestones → tasks `T1.1.1`, each with completion criteria + `traces`).

When changing them:
- Keep traceability intact; after renumbering, grep all three docs for stale refs (`§4.`, `T3.1.`).
- Bump the `**Status:** vX.Y` header on substantive change; update downstream `Upstream:` refs.
- Substantive revisions get an independent subagent critique (severity-ranked findings) folded in before sign-off.
- "Resolved Decisions" (REQUIREMENTS §8, DESIGN §9) are not reopened silently — only by deliberate operator-approved revision.
- One logical change per commit, short body explaining why.

## Architecture invariants (full detail in DESIGN.md)

- Kernel makes **no LLM calls**: pure event-sourced fold over one authoritative append-only SQLite log; agent work only in SDK sessions, one per task.
- Artifacts (versioned markdown + frontmatter in git) are the only interface between phases — never transcripts. Gate truth lives in the event log; git tags are derived markers.
- Trace links: frontmatter + commit trailers are source of truth; the SQLite index is derived, rebuildable.
- Policy enforced outside the model (`canUseTool` allowlists); secrets injected at tool boundary, never session env; redaction/egress filtering at log-write and context-assembly (ships in P1, not later).
- ORC-4 pattern nodes (`fan-out`, `pipeline`, `critic-of`, `panel`) are expanded into an ordinary task graph **at load time**, so nothing downstream of the loader knows a task came from a pattern. A panel's ballots are counted by the kernel and logged (`VoteTallied`); exactly one task writes each artifact.
- Side effects: `EffectIntended` event first; resume resolves pending intents via per-contract effect checks.
- Integrations only via MCP capability contracts (`ci.checks`, `pm.github`, …) in `contracts/`; the GitHub PM board is a derived, event-driven projection — inbound GitHub activity becomes triaged signals, never direct mutations.

## Bootstrap

P1–M3.1 run manually via operator-driven Claude Code sessions per PLAN.md; self-hosting from T3.1.8. Task completion criteria and milestone verification demos are the acceptance tests.
