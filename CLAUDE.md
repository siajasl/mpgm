# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

mpgm is an **agentic harness framework**: an orchestration system that drives the full SDLC (Definition → Scope → Design → Plan → Implement → Test → Deploy → Maintain) of a software project using Claude-backed agents under a single human operator, built on Claude Code / the Claude Agent SDK.

The project is currently **pre-code**: the repository contains the three foundation documents, and implementation starts at PLAN.md task T1.1.1 (TypeScript/Node workspace scaffold). There is no build/lint/test toolchain yet — it arrives with that task. Until then, the only workflow is editing the documents and committing.

## Document authority chain

The three documents form a strict upstream→downstream chain. **Read them before making changes; never contradict an upstream document from a downstream one.**

1. **REQUIREMENTS.md** — what the harness must do. Requirements have stable IDs (`ORC-1`, `SAF-6`, `PMG-2`, …) using RFC 2119 keywords. Section 4 is cross-cutting areas; section 5 is per-SDLC-phase requirements with gates.
2. **DESIGN.md** — how: a thin deterministic event-sourced kernel (TypeScript, SQLite, no LLM calls) orchestrating one SDK session per task; git as artifact store; MCP capability contracts for all integrations. Key choices are ADR-1..7 in §3. Every design element cites requirement IDs.
3. **PLAN.md** — build order: plan phases P1–P5 → milestones (M1.1, …) → tasks (T1.1.1, …), each task with completion criteria and a `traces` column citing DESIGN sections/ADRs and requirement IDs. The risk register (§2) drives the ordering.

## Conventions for changing the documents

- **Traceability is load-bearing.** New requirements get a stable area-prefixed ID; new design elements cite the requirement IDs they satisfy; new plan tasks cite design sections. When renumbering sections or task IDs, grep all three documents for stale cross-references (`grep -n '§4\.' *.md`, task IDs like `T3\.1\.`).
- **Version discipline.** Each document has a `**Status:** vX.Y — <what changed>` header line; bump it on any substantive change, and update the downstream documents' `Upstream:` version references when an upstream doc changes.
- **Adversarial review before sign-off.** Substantive document revisions are reviewed by an independent subagent critique (prioritized findings with severity), findings are folded in, and the status line records "reviewed". This mirrors the harness's own DSG-3 requirement.
- **Resolved decisions stay resolved.** Both REQUIREMENTS §8 and DESIGN §9 are "Resolved Decisions" sections (substrate = Claude Agent SDK/TypeScript, single operator, GitHub Actions CI, CLI-first with dashboard at first Implement milestone, per-role eval rubrics). Don't reopen them silently — a change there is a deliberate, operator-approved revision.
- Commits so far are one logical change each, with a short body explaining the why.

## Architecture essentials (for when implementation starts)

These are the invariants future code must respect (full detail in DESIGN.md):

- **The kernel makes no LLM calls.** All agent work happens in Claude Agent SDK sessions; the kernel is a pure, replayable event-sourced state machine (fold over an append-only SQLite log, `.mpgm/state.db`, WAL mode — the single authoritative log).
- **Artifacts are the interface between phases** — versioned markdown + YAML frontmatter in git; agents never see other agents' transcripts. Gate decisions live in the event log (git tags are derived markers only).
- **Trace links live in artifact frontmatter and commit trailers**; the SQLite trace index is derived and always rebuildable.
- **Policy is enforced outside the model** (SDK `canUseTool` hooks, per-role allowlists). Secrets are injected at the tool boundary, never into session environments. Redaction and egress filtering happen at log-write and context-assembly time — these ship in the P1 skeleton, not later.
- **Effects follow intent-before-effect**: an `EffectIntended` event precedes any side effect, and resume resolves pending intents via per-contract effect checks.
- **External integrations only via MCP capability contracts** (`ci.checks`, `pm.github`, `env.provision`, `release.deliver`, `test.nfr`, …) specified in `contracts/`.
- **GitHub PM board is a derived projection** of kernel state, updated event-driven; inbound GitHub activity becomes triaged signals, never direct state mutations.

## Bootstrap status

PLAN §1: P1 through M3.1 are executed manually by operator-driven Claude Code sessions following PLAN.md; mpgm self-hosts from T3.1.8. When implementing plan tasks by hand, honor the task's completion criteria and the milestone verification demo — they are the acceptance tests.
