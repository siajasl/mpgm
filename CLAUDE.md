# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

mpgm is an agentic harness driving the full SDLC via Claude Agent SDK sessions under a single operator. **Pre-code**: no toolchain exists until PLAN task T1.1.1 (TypeScript scaffold); current work is document editing.

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
- Side effects: `EffectIntended` event first; resume resolves pending intents via per-contract effect checks.
- Integrations only via MCP capability contracts (`ci.checks`, `pm.github`, …) in `contracts/`; the GitHub PM board is a derived, event-driven projection — inbound GitHub activity becomes triaged signals, never direct mutations.

## Bootstrap

P1–M3.1 run manually via operator-driven Claude Code sessions per PLAN.md; self-hosting from T3.1.8. Task completion criteria and milestone verification demos are the acceptance tests.
