# DESIGN — mpgm Agentic SDLC Harness

**Status:** v0.7 — network policy and the untrusted-content role profile (§4.2) · **Owner:** macg@enthropic.io · **Last updated:** 2026-08-23
**Upstream:** [REQUIREMENTS.md](REQUIREMENTS.md) v0.4. Requirement IDs (`ORC-1`, `SAF-2`, …) are cited throughout; every component traces to at least one requirement (DSG-4).

## 1. Context & Goals

mpgm orchestrates Claude-backed agents through eight gated SDLC phases under a single operator. The design optimizes for, in order:

1. **Auditability** — every decision and action reconstructable (OBS-1, ART-1).
2. **Operator control** — gates and irreversible actions always in human hands (HIL-1/2).
3. **Local-first simplicity** — one machine, no mandatory services (NFR-5); scale out later.
4. **Substrate leverage** — build on Claude Code / Claude Agent SDK rather than reimplementing agent loops, tools, permissions, or context management (REQUIREMENTS §8, Decision 1).

Non-goals for v1: multi-operator collaboration, hosted/multi-tenant operation, non-Anthropic model integration (portable by design per EXT-2, not implemented).

## 2. Architecture Overview

mpgm is a **kernel + substrate** architecture: a thin, deterministic orchestration kernel owns state, gates, and policy; all LLM work is delegated to Claude Agent SDK sessions.

```
┌─────────────────────────── Operator ───────────────────────────┐
│                 CLI (mpgm) + status/approval UI                │
└───────────────┬───────────────────────────────┬────────────────┘
                │ commands, approvals           │ live view
┌───────────────▼───────────────────────────────▼────────────────┐
│                     Orchestration Kernel                       │
│  Phase graph · Scheduler · Gate manager · Budget enforcement   │
│            (event-sourced state machine, no LLM calls)         │
├──────────┬──────────────┬──────────────┬──────────────────────┤
│ Event Log│ Policy Engine│ Traceability │ Knowledge Base index  │
│ (SQLite) │ (hooks)      │ graph        │ (repo markdown+index) │
└────┬─────┴──────┬───────┴──────┬───────┴──────────┬───────────┘
     │            │              │                  │
┌────▼────────────▼──────────────▼──────────────────▼───────────┐
│                       Agent Runtime                           │
│   Claude Agent SDK sessions · role loader · schema validator  │
│   one session per task · isolated git worktree per task       │
├───────────────────────────────────────────────────────────────┤
│  Tools via MCP: git/GitHub · CI · scanners · IaC · telemetry  │
└───────────────────────────────────────────────────────────────┘
                │ artifacts (markdown + frontmatter)
        ┌───────▼────────┐
        │  Git repository │  ← single source of truth (ART-4)
        └────────────────┘
```

**Control flow:** the kernel pops ready tasks from the active task graph → assembles context from artifacts (CTX-2) → launches an SDK session with the role's toolset and policy → validates the structured result → appends events → advances the graph. Gates pause the graph until operator approval (HIL-1).

**Where task graphs come from (ORC-2):** each phase has a declarative **playbook** (`phases/<name>.yaml`) defining its task templates, agent patterns, gate exit criteria, and artifact schemas (EXT-3). Definition through Plan run on their playbook graphs; from Implement onward the gated Plan artifact (PLN-1) supplies the task graph, with the Implement/Test/Deploy/Maintain playbooks contributing their standing tasks (reviews, scans, release steps, triage).

## 3. Key Decisions (ADRs)

Each recorded here in brief; the ADR artifacts under `artifacts/adr/` are the authoritative versions.

### ADR-1 — TypeScript on Node as implementation language
The kernel and CLI are TypeScript. **Why:** the Claude Agent SDK, Claude Code hook/plugin surface, and the MCP ecosystem are TypeScript-first; zod gives runtime schema validation matching AGT-3. **Alternatives considered:** *Python* — stronger eval/data tooling; rejected since evals (AGT-6) are driven through the SDK, not notebooks. *Rust* — considered for the kernel's correctness profile (an append-only log with a pure fold suits Rust's type system well), but rejected for v1: there is no Rust Agent SDK, so the deepest integration point (session lifecycle, `canUseTool` hooks, usage events) would require either reimplementing the agent loop — contradicting goal 4 (substrate leverage) — or a Node sidecar, putting an IPC seam through the policy boundary and doubling toolchains. Rust's headline gains buy little here: the harness is I/O-bound around model calls (NFR-3 is trivially met in any mainstream language), and the correctness properties that matter (fold determinism, schema validity, gate invariants) come from pure reducers plus property tests, achievable in TS. Self-hosting economics also favor TS: agent repair loops against CI iterate faster without Rust compile times. **Revisit if:** eval sophistication outgrows the SDK harness, or the kernel earns a standalone rewrite (multi-operator, remote execution) — Rust is the named candidate for that rewrite; the event log schema, not the language, is the durable contract.

### ADR-2 — Event-sourced kernel over SQLite
All kernel state is an append-only event log in a local SQLite database (`.mpgm/state.db`, WAL mode) — the **single authoritative log**; in-memory state is a pure fold over events, and any file exports are derived backups, never a second write path. **Why:** satisfies crash-safe resume (ORC-5) and event-sourced replay (ORC-3) by construction; SQLite needs no service (NFR-5). Model/tool outputs are logged in full (after SAF-6 redaction at write time), with large payloads offloaded to content-addressed blobs under `.mpgm/blobs/` and referenced by hash, so replay re-derives state without live re-execution while the DB stays small. **Trade-off:** schema migrations for events need discipline (versioned event types, upcasters). Snapshots every N events keep resume and replay fast.

### ADR-3 — Git as the artifact store
Artifacts are markdown files with YAML frontmatter (id, version, schema, traces-to, produced-by) in `artifacts/`, committed to the project repo. Gate decisions live in the event log, which is authoritative (ORC-6 invalidation is an event, not a git operation); an annotated tag (`gate/<phase>/<version>`) is written as a derived, informational marker. Immutability (ART-1) is enforced by the kernel refusing edits to gated versions — changes create a successor version. **Why:** ART-4 mandates git for code; extending it to all artifacts gives versioning, attribution, and diff review for free, and keeps the knowledge base greppable by agents. **Trade-off:** no relational queries — hence the derived index (ADR-4).

### ADR-4 — Derived traceability index, source-of-truth in frontmatter
Trace links (requirement ↔ design ↔ task ↔ change ↔ test ↔ release, ART-2) are declared in artifact frontmatter and commit trailers; the kernel maintains a derived, rebuildable index in SQLite for queries (gate-invalidation per ORC-6, coverage per TST-2). **Why:** no second source of truth; the index can always be rebuilt from git. **Trade-off:** index rebuild cost on large repos — incremental updates keyed on commit hashes.

### ADR-5 — One SDK session per task, one git worktree per implementation task
Every task runs in a fresh Claude Agent SDK session with context assembled from artifacts (CTX-1/2); implementation tasks additionally get an isolated worktree and merge via reviewed PR (IMP-1/3). **Why:** bounded, reproducible context beats long-lived sessions; worktrees give parallelism (ORC-3) without conflict. **Trade-off:** context re-assembly cost per task — mitigated by prompt caching and a compact knowledge-base digest.

### ADR-6 — Policy enforcement via SDK permission hooks + OS sandbox
The policy engine implements the SDK's `canUseTool` / hook interface: per-role allowlists of tools, file globs, network hosts, and shell patterns, declared in role files and evaluated outside the model (SAF-1). Secrets never enter context (SAF-2): agents reference credentials symbolically, and the kernel's broker injects real values only at the MCP/tool-process boundary — a proxy resolves the reference at call time, so secrets never exist in the session's environment (where `printenv` would leak them) — with pattern-based redaction of tool output as a second layer. Data-egress classes (SAF-6) are enforced at context assembly — files labeled `egress: restricted` are excluded or summarized locally. **Trade-off:** hook-level enforcement trusts the SDK process boundary; defense-in-depth via sandboxed execution (Claude Code sandbox / containers) for shell tools.

### ADR-7 — MCP for all external integrations
Git hosting, CI, scanners, IaC, and telemetry are reached only through MCP servers (EXT-1); the kernel and roles reference tools by capability name, resolved per project. **Why:** uniform policy interception point, provider swap without workflow change (EXT-2/3).

## 4. Component Deep Dives

### 4.1 Orchestration Kernel (ORC-*, HIL-*, AGT-4)
A deterministic state machine, no LLM calls. Owns:
- **Phase graph:** the eight SDLC phases with entry/exit gates; re-entry per ORC-1 emits `PhaseReopened` and cascades gate invalidation through the trace index (ORC-6).
- **Plan graph:** plan phases → milestones → tasks (PLN-1) loaded from the gated Plan artifact; scheduler dispatches tasks whose dependencies are complete, up to the configured concurrency limit.
- **Pattern primitives (ORC-4):** the task-graph schema includes declarative multi-agent nodes — `fan-out{n}/collect`, `pipeline`, `critic-of <task>` (adversarial review), and `panel{n, vote}` (judge panels) — expanded by the kernel into ordinary tasks; DSG-3's critic panel and DSG-1's candidate-selection judging are playbook uses of these primitives. Expansion is a pure function of the playbook, so a replayed run reconstructs the same graph. Two consequences are load-time rules rather than run-time surprises: exactly one task writes each artifact (fan-out workers and panel judges therefore produce none — their collector or tally does), and a `critic-of` runs a different role from the one that produced its target, since a reviewer sharing the author's role shares its blind spots. A panel's ballots are **counted by the kernel**, not summarised by a further agent, and the count is logged (`VoteTallied`) because `TaskCompleted` does not carry task output; a `vote-carried` gate criterion reads it.
- **Budgets:** per-run/phase/task token, cost, and step budgets checked on every SDK usage event, plus independent kernel-side timers per session so wall-clock bounds fire even on a hung or silent session; breach → `BudgetExceeded` → terminate session, escalate (AGT-4, NFR-2).
- **Gate manager:** collects exit-criteria checks (automated + agent-produced), presents an approval packet (options, trade-offs, recommendation — HIL-4) to the CLI, records decisions (HIL-5). Auto-approval only where the operator has configured criteria (HIL-1).
- **Replan policy:** classifies plan deltas — intra-milestone task reorder/split = autonomous + logged; milestone/plan-phase/design-touching changes = Plan gate re-entry (PLN-4).

### 4.2 Agent Runtime (AGT-*)
- **Role definitions:** `roles/<name>.md` — YAML frontmatter (model, tools, path permissions, network allowlist, budgets, output schema ref) + system-prompt body; versioned in git (AGT-1), least-privilege by declaration (AGT-2). Every dimension defaults to empty, so a role reaches only what it names.
- **Untrusted-content profile (SAF-3):** roles that ingest external material (prior-art research, third-party issues, dependency docs) declare no shell, no writable path, and a hostname allowlist enforced on every fetch — plaintext destinations refused outright. The role's prompt states that fetched text is data rather than instruction, but the control is that an instruction planted in a page has nothing to act through: the tools it would need were never offered. A search returns content from hosts the allowlist never saw; the allowlist bounds what the agent may then go and *retrieve*, which is the step that turns a planted link into a request.
- **Execution:** wraps the SDK's query loop; final output is captured via a schema-enforced structured-output tool (zod). Validation failure → bounded retry with the validation error fed back (AGT-3).
- **Model routing (AGT-5):** the model is a **dispatch-time session parameter** resolved by the kernel per task: role-frontmatter default, overridden by the task-class → model-tier routing table (initially seeded from the PLAN §3 model column). Overrides never mutate role definitions, so routing changes are not role changes and do not trigger AGT-6 evals or violate a role freeze. The resolved model ID is recorded in the `TaskDispatched` event (§5) for replay and eval attribution.
- **Interactive mode (DEF-1, HIL-4):** `mpgm chat <phase|gate>` attaches the operator to a live SDK session — used for Definition elicitation dialogues and gate discussions; the transcript is captured as an artifact and its conclusions flow through normal structured outputs, so interactivity does not bypass validation or audit.
- **Untrusted-content sessions (SAF-3):** tasks that ingest external content (web pages, third-party issues, dependency docs) run structurally constrained — read-only toolset, no shell or write access — and their outputs are schema-validated summaries consumed as data by downstream tasks; content marking is applied too, but the toolset restriction is the control.
- **Improvement loop (AGT-7):** a maintenance-phase agent mines the event log for feedback signals and proposes role/knowledge-base diffs as ordinary reviewed changes; adoption requires a green eval run (AGT-6) executed by the eval harness (§4.6).

### 4.3 Context & Knowledge (CTX-*)
- **Knowledge base:** `kb/` in-repo — conventions, glossary, code map, decision log; updated by tasks whose outputs change it (CTX-4).
- **Context assembler:** builds each task's prompt from (a) the task spec, (b) upstream artifacts it traces to, (c) KB digest, (d) relevant prior decisions found via the trace index (CTX-3). Transcripts of other agents are never included (CTX-2). Egress filter applied last (SAF-6).

### 4.4 Operator Console (HIL-*, OBS-3)
`mpgm` CLI: `run`, `status`, `approve <gate>`, `pause|resume|kill <task|run>`, `redirect <task>` (revise a task's instructions/context and requeue), `rollback <release|artifact>`, `chat <phase|gate>` (§4.2), `trace <id>`, `replay <run>` — covering all HIL-3 verbs. A read-only local web dashboard — deferred to the first Implement milestone (§9) — renders live run state, pending approvals, spend, and the traceability graph from the event stream; until then `mpgm status` serves OBS-3. Interventions are events like any other (HIL-5).

### 4.5 Observability (OBS-*)
The event log **is** the telemetry source: a projection layer derives per-phase/per-role cost, latency, retry, and success metrics (OBS-2) and longitudinal quality metrics — gate rejection rate, rework rate, escaped defects (OBS-4) — which feed AGT-7. Export via an OTLP MCP tool is optional, not required (NFR-5).

### 4.6 Eval Harness (AGT-6)
`evals/` holds a benchmark suite per role (golden artifacts + graders — schema checks, rubric-grading by a judge agent, and where possible deterministic assertions); rubrics are per-role, importing common graders, schema checks, and judge prompts from a shared `evals/lib/` (§9). `mpgm eval <role>@<version>` runs the suite and records results as artifacts; the gate manager blocks adoption of a role version without a green eval.

### 4.7 Delivery Integrations (IMP-*, TST-*, DEP-*)
Each integration is an **MCP capability contract** — a named interface (inputs, outputs, effect semantics) specified in `contracts/` and satisfied by a pluggable server (EXT-1); the kernel supervises through contracts and never re-implements the underlying tooling.

- **CI (`ci.checks`):** merge checks (build/lint/type/test/scan — IMP-2, SAF-5) run in project CI — GitHub Actions for v1 (§9); the kernel treats CI results as an oracle.
- **Test runner (`test.nfr`):** executes the Test-phase suites — NFR validation (perf/load, DAST) against SCP-1 thresholds (TST-3) and requirement-coverage reporting (TST-2). A **quarantine ledger** tracks flaky tests (TST-6): quarantined tests are excluded from coverage claims and raised as maintenance tasks.
- **Environments (`env.provision`):** provisions test/staging/prod from in-repo IaC (DEP-1/4).
- **Release (`release.deliver`):** progressive delivery is delegated to existing CD tooling (e.g. Argo Rollouts or a cloud-native equivalent) behind this contract; mpgm supplies release artifacts (DEP-3), watches health signals, records outcomes (DEP-5), and issues promote/rollback decisions per policy (DEP-2) — it does not implement rollout mechanics.

### 4.8 Project-Management Sync (PMG-*)
An event-driven **PM projector** subscribes to the kernel event stream and maintains the GitHub projection through a `pm.github` capability contract (§4.7 pattern):

- **Mapping:** plan phases → Project board views/iterations; milestones → GitHub Milestones; tasks → Issues (board columns follow task state: backlog / ready / in-progress / in-review / blocked / done); labels encode phase, role, priority, and type (task/defect/incident/upgrade); PRs are linked to their task's issue via branch naming (worktree manager, §4.7) and `Closes #N` trailers.
- **Currency (PMG-2):** the projector consumes state-change events as they commit to the log — board updates ride the same event stream as the dashboard, so the board is exactly as current as the kernel.
- **Authority (PMG-3):** the projection is derived state; a reconcile pass (idempotent, diff-based) repairs any external edits on projector restart. Inbound GitHub activity arrives via the Maintain signal path (§4.9, `telemetry.signals` sibling `pm.inbound`) and becomes triaged work items — never direct kernel mutations.
- **Bootstrap (PMG-4):** on Plan gate approval, the projector creates the board, label taxonomy, and milestones from the gated Plan artifact, idempotently — re-running against an existing repo converges instead of duplicating.

### 4.9 Maintain Integration (MNT-*)
- **Signal ingestion (MNT-1):** ingestor tasks (standing playbook tasks on a schedule) poll declared sources via MCP — alerting/telemetry (`telemetry.signals`), dependency advisories (`deps.advisories`) — and a triage agent converts signals into prioritized work items entering the normal task graph.
- **Incidents (MNT-2):** an incident state machine in the kernel (detected → mitigation-proposed → operator-approved → remediating → resolved → postmortem) with each transition an event; mitigation and fixes flow through Implement/Test/Deploy (MNT-5), and the postmortem is a gated artifact.
- **Dependency freshness (MNT-3):** the advisories ingestor raises upgrade tasks with severity-based priority automatically.
- **Drift audits (MNT-4):** periodic playbook tasks diff code vs. design artifacts, tests vs. requirements (via the trace index), and live infrastructure vs. IaC, raising reconciliation tasks.

## 5. Data Model (kernel)

Event log (append-only): `RunStarted, PhaseEntered, TaskDispatched, SessionUsage, ToolCallLogged, TaskCompleted{artifactRefs}, ValidationFailed, VoteTallied{rule, carried, ballots}, GatePresented, GateApproved/Rejected{by}, PhaseReopened, GateInvalidated, BudgetExceeded, OperatorIntervened, ...` — each `{seq, ts, runId, type, payload, schemaVersion}`.

Derived (rebuildable) tables: `runs, tasks, gates, budgets, trace_links, metrics`. Artifacts and roles live in git only (ADR-3) — the DB stores references (path + commit hash), never artifact content; large session transcripts/tool outputs live as content-addressed blobs referenced from events (ADR-2).

## 6. Reliability & Failure Handling (NFR-1)

- Kernel crash → restart folds the event log (plus latest snapshot) and resumes. Side-effectful steps use intent-before-effect: an `EffectIntended` event is written first, and on resume each pending intent is resolved through the tool's contract — an effect-check (did the push/deploy/PR land?) where the contract defines one, otherwise operator confirmation — before re-execution; contracts declare whether their effects are idempotent, checkable, or compensatable.
- Model/tool call failure → exponential backoff retries within the task budget; exhaustion → task marked blocked, escalated to operator, never silently dropped.
- Session death mid-task → worktree preserved; task restarts in a fresh session with a "resume" context including prior partial output.
- Storage: the SQLite log (WAL mode) is the single write path (ADR-2); periodic checkpoint exports to `.mpgm/backups/` are derived copies for disaster recovery, and artifacts are safe in git regardless.

## 7. Security Summary (SAF-*, NFR-4)

Least-privilege role toolsets (AGT-2) enforced outside the model (ADR-6); secret brokering at the tool boundary with symbolic references (SAF-2, ADR-6); untrusted external content handled by structurally constrained sessions — read-only toolsets, validated data-only outputs (SAF-3, §4.2) — with content marking as reinforcement, not the control; destructive tools require dry-run support and kernel-level confirmation events (SAF-4); merge-blocking scanners (SAF-5); egress classes at context assembly and log-write redaction (SAF-6). Full audit: every tool call and approval is an event (OBS-1, HIL-5).

## 8. Build Plan Seed & Revisit Triggers

Walking skeleton first (PLN-2): kernel event loop + one role + one gated phase end-to-end (Definition), then breadth across phases, then depth (evals, dashboard, progressive delivery).

Revisit as the system grows:
- **Index scale:** SQLite trace index → dedicated graph store if link volume makes invalidation queries slow.
- **Parallelism:** single-machine worktrees → remote execution (cloud sessions) if implementation throughput binds.
- **Multi-operator (v2):** gate manager already isolates approval identity in events; add role-based approvers without kernel changes.
- **Provider portability:** agent runtime is the only SDK-coupled module; a second runtime implementation is the EXT-2 escape hatch.

## 9. Resolved Decisions

1. **Dashboard:** CLI-only for the walking skeleton; the web dashboard ships at the first Implement milestone.
2. **Eval rubrics:** per-role rubric suites, importing shared multi-role functionality (common graders, schema checks, judge prompts) from a shared eval library.
3. **CI substrate:** GitHub Actions, behind the `ci.checks` contract (§4.7).
