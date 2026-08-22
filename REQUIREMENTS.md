# REQUIREMENTS — mpgm Agentic SDLC Harness

**Status:** v0.3 — reviewed draft incorporating operator feedback, awaiting sign-off · **Owner:** macg@enthropic.io · **Last updated:** 2026-08-23

## 1. Purpose

mpgm is an agentic harness that drives the full software development lifecycle (SDLC) of a complex greenfield system. It orchestrates LLM-backed agents through eight lifecycle phases — Definition, Scope, Design, Plan, Implement, Test, Deploy, Maintain — producing auditable artifacts at each phase while keeping a human engineer/architect in control of irreversible decisions.

This document defines *what* the harness must do. Architecture and technology choices are deferred to a separate DESIGN.md.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Harness** | The orchestration runtime: scheduling, state, context, tooling, and policy enforcement around agents. |
| **Agent** | An LLM-backed worker with a role, a toolset, and a bounded context, executing one task at a time. |
| **Phase** | One of the eight SDLC stages. Each phase consumes upstream artifacts and emits versioned artifacts. |
| **Artifact** | A durable, versioned output (requirement set, ADR, plan, code change, test report, release, incident record). |
| **Gate** | A checkpoint between phases where defined exit criteria are verified before work proceeds. |
| **Operator** | The human engineer/architect supervising the harness. |

Requirement keywords **MUST**, **SHOULD**, **MAY** follow RFC 2119. Requirements are numbered `<AREA>-<n>` for traceability.

## 3. Scope

**In scope:** phase orchestration, agent lifecycle management, artifact and state management, human-in-the-loop controls, tool/VCS/CI/CD integration, observability, and policy enforcement.

**Out of scope (v1):** training or fine-tuning models; hosting model inference; replacing the operator's judgment at gates; project management for non-software work; multi-tenant SaaS operation.

## 4. Core Harness Requirements

### Orchestration (ORC)

- **ORC-1** The harness MUST model the SDLC as a directed graph of phases with explicit entry/exit gates; linear flow is the default, but any phase MUST be re-enterable when a downstream phase invalidates upstream assumptions (e.g. a test failure reopening Design).
- **ORC-2** The harness MUST decompose phase work into discrete tasks with declared inputs, outputs, and completion criteria, and dispatch them to agents.
- **ORC-3** The harness MUST support parallel agent execution with bounded concurrency, and replay of any orchestration run by re-deriving state from logged model and tool outputs (event-sourced replay, no live re-execution).
- **ORC-4** The harness MUST support multi-agent patterns: fan-out/fan-in, pipeline, adversarial review (generator vs. critic), and judge panels for design selection.
- **ORC-5** All orchestration state MUST survive process restarts; an interrupted run MUST resume from its last durable checkpoint without repeating completed side-effectful steps.
- **ORC-6** Reopening a gated phase MUST produce a new artifact version and MUST invalidate the gate approvals of all downstream artifacts that trace to the changed content (per ART-2); unaffected downstream artifacts retain approval. Invalidated gates MUST be re-approved before affected work proceeds.

### Agents (AGT)

- **AGT-1** Agent roles (e.g. analyst, architect, planner, implementer, tester, release manager, SRE) MUST be defined declaratively — prompt, toolset, model, permissions — and be versioned alongside the project.
- **AGT-2** Each agent MUST run with the minimum toolset and permissions its role requires (least privilege).
- **AGT-3** Agents MUST return schema-validated outputs (prose artifacts are carried as payload fields within a structured envelope); results that fail validation MUST be rejected and retried.
- **AGT-4** The harness MUST bound each agent by budget (tokens/cost), wall-clock time, and step count, and terminate or escalate on breach.
- **AGT-5** The harness SHOULD route tasks to models by capability/cost tier, with per-task overrides.
- **AGT-6** Changes to agent role definitions (prompt, model, toolset) MUST pass a regression evaluation suite against benchmark tasks before adoption; the harness MUST record eval results with the role version (AGT-1).
- **AGT-7** Agents SHOULD be self-improving: the harness SHOULD aggregate feedback signals — gate rejections, review findings, operator corrections, escaped defects (OBS-4) — into proposed refinements of agent role definitions and the knowledge base. Every adopted refinement MUST pass AGT-6 evaluation; self-modification MUST NOT bypass it.

### Context & Knowledge (CTX)

- **CTX-1** The harness MUST maintain a project knowledge base — requirements, decisions, glossary, conventions, code map — and assemble task-scoped context for each agent rather than shipping full history.
- **CTX-2** Artifacts MUST be the interface between phases: an agent's context is built from versioned artifacts, not from prior agents' transcripts.
- **CTX-3** The harness MUST persist decisions with rationale (ADR-style) and surface relevant prior decisions to agents whose tasks may conflict with them.
- **CTX-4** The knowledge base MUST be incrementally updatable as the codebase and requirements evolve, and queryable by both agents and the operator.

### Human-in-the-Loop (HIL)

- **HIL-1** Every phase gate MUST require operator approval by default; the operator MAY mark specific gates auto-approved with defined criteria.
- **HIL-2** Irreversible or outward-facing actions (production deploys, data migrations, publishing, external communications) MUST always require explicit operator approval, regardless of gate settings.
- **HIL-3** The operator MUST be able to pause, redirect, roll back, or kill any run or agent at any time.
- **HIL-4** The harness MUST present decisions to the operator with options, trade-offs, and a recommendation — never a bare "proceed?".
- **HIL-5** All operator interventions MUST be recorded in the audit log.

### Artifacts & State (ART)

- **ART-1** Every artifact MUST be versioned, immutable once gated, attributable (which agent/model/prompt/human produced it), and traceable to the requirements it serves.
- **ART-2** The harness MUST maintain a bidirectional traceability graph: requirement ↔ design element ↔ plan item ↔ code change ↔ test ↔ release.
- **ART-3** Artifact schemas MUST be validated on write; breaking schema changes MUST be migrated, not silently ignored.
- **ART-4** All code artifacts MUST live in Git; the harness MUST NOT hold code state outside version control.

### Observability & Audit (OBS)

- **OBS-1** The harness MUST emit a structured event log covering every task, tool call, model call, gate decision, and error, sufficient for full run reconstruction.
- **OBS-2** The harness MUST track and report cost (tokens, spend), latency, and success/retry rates per phase, per agent role, and per run.
- **OBS-3** The operator MUST have a live view of current runs: what each agent is doing, what is blocked, and what awaits approval.
- **OBS-4** The harness SHOULD compute quality metrics over time (gate rejection rate, rework rate, escaped-defect rate) to measure its own effectiveness.

### Safety & Policy (SAF)

- **SAF-1** The harness MUST enforce a policy layer that constrains agent actions (allowed tools, file paths, network destinations, shell commands) independent of prompts; prompt-level instructions are not a control.
- **SAF-2** Secrets MUST never enter model context; the harness MUST broker credentials so agents reference them symbolically.
- **SAF-3** All content ingested from outside the project (web pages, third-party issues, dependency docs) MUST be treated as untrusted data; instructions embedded in it MUST NOT be executed.
- **SAF-4** Destructive operations MUST be dry-run capable and reversible where the underlying system permits; the harness MUST prefer reversible paths.
- **SAF-5** Agent-generated code MUST pass automated security scanning (static analysis, dependency audit, secret scanning) before every merge (enforced via IMP-2).
- **SAF-6** The project MUST declare a data-egress policy classifying what may be sent to which model providers; the harness MUST enforce it on context assembly, and personally identifiable or operator-restricted data MUST NOT enter third-party model calls without explicit policy allowance.

### Extensibility (EXT)

- **EXT-1** Tools MUST be pluggable behind a uniform interface (MCP or equivalent), so integrations (VCS, CI, issue tracker, cloud) can be added without core changes.
- **EXT-2** The harness MUST be model-agnostic: swapping or mixing model providers MUST NOT require workflow changes.
- **EXT-3** Phase definitions, gate criteria, and agent roles MUST be configurable per project without forking the harness.

## 5. Lifecycle Phase Requirements

Each phase lists its intent, mandatory capabilities, and gate (exit criteria). Gate approval follows HIL-1.

### 5.1 Definition (DEF)

Turn operator intent into a validated problem statement.

- **DEF-1** The harness MUST conduct a structured elicitation dialogue with the operator, producing: problem statement, goals, non-goals, stakeholders, constraints, assumptions, and success metrics.
- **DEF-2** Agents MUST challenge ambiguity and contradiction in stated intent and record resolutions.
- **DEF-3** The harness SHOULD research prior art and comparable systems and summarize findings with sources.
- **Gate:** operator-approved Product Definition artifact with measurable success criteria.

### 5.2 Scope (SCP)

Bound what will be built.

- **SCP-1** The harness MUST derive functional and non-functional requirements from the Definition, each testable and uniquely identified; non-functional requirements MUST carry quantified thresholds (these bind TST-3 and the Test gate).
- **SCP-2** The harness MUST produce an explicit out-of-scope list and a MoSCoW (or equivalent) prioritization.
- **SCP-3** The harness MUST flag requirements that conflict, duplicate, or lack acceptance criteria before the gate.
- **Gate:** operator-approved requirement set; every requirement testable, prioritized, and traceable to a Definition goal.

### 5.3 Design (DSG)

Decide how the system will be built.

- **DSG-1** The harness MUST generate candidate architectures (≥2 for significant decisions), evaluate them against the requirements and constraints, and record the choice as an ADR with trade-offs.
- **DSG-2** Design output MUST include: component decomposition, interface contracts (APIs, schemas, events), data model, technology selections, and cross-cutting concerns (authn/z, observability, failure modes).
- **DSG-3** The harness MUST run adversarial design review (independent critic agents) covering scalability, security, operability, and simplicity before the gate.
- **DSG-4** Every design element MUST trace to at least one requirement; unreferenced elements MUST be flagged as gold-plating.
- **Gate:** operator-approved design package with ADRs; all critic findings resolved or explicitly accepted.

### 5.4 Plan (PLN)

Sequence the build.

- **PLN-1** The plan MUST be a three-level hierarchy: **plan phases** group milestones, **milestones** group tasks, and each **task** is a single unit of work that demonstrably advances the system — sized for single-agent execution, with declared completion criteria and dependency ordering. (Plan phases are groupings within the Plan artifact, distinct from the SDLC phases of §5.)
- **PLN-2** The plan MUST identify the riskiest assumptions and front-load tasks that validate them (walking skeleton / steel thread first).
- **PLN-3** The plan MUST define per-milestone verification (what must demonstrably work) rather than time estimates alone.
- **PLN-4** The harness MUST replan incrementally when implementation invalidates plan assumptions, preserving completed work. Small, simple adjustments (reordering or splitting tasks within a milestone) MAY be applied autonomously and logged; complex or large adjustments (adding/removing milestones, restructuring plan phases, or touching design assumptions) MUST re-enter the Plan gate for operator approval.
- **Gate:** operator-approved plan; task graph acyclic, every task traceable to design elements.

### 5.5 Implement (IMP)

Build it.

- **IMP-1** Each implementation task MUST run in an isolated workspace (branch/worktree/sandbox) and integrate via reviewed merge; agents MUST NOT commit directly to the main branch.
- **IMP-2** Every change MUST pass automated checks — build, lint, type check, tests, security scan (SAF-5) — before merge; the harness MUST feed failures back to the implementing agent for repair with a bounded retry budget.
- **IMP-3** Every change MUST receive agent code review independent of its author agent; operator review is required where policy demands it.
- **IMP-4** Implementation MUST conform to project conventions (style, structure, commit format) defined in the knowledge base; deviations MUST be flagged, not silently introduced.
- **IMP-5** The harness MUST keep the main branch releasable at all times (trunk-based, feature-flagged where incomplete).
- **Gate (per milestone):** all milestone tasks merged, checks green, demo criteria from PLN-3 met.

### 5.6 Test (TST)

Prove it works.

- **TST-1** The harness MUST maintain a test pyramid — unit, integration, end-to-end — with tests authored alongside implementation, not deferred to this phase; the Test phase validates system-level behavior.
- **TST-2** The harness MUST verify every requirement's acceptance criteria and report requirement-level coverage (which requirements are verified, by which tests).
- **TST-3** The harness MUST run non-functional validation for every quantified NFR declared in the Scope artifact (SCP-1) — e.g. performance/load, security (SAST/DAST/dependency) — and SHOULD run resilience validation (fault injection) for availability NFRs.
- **TST-4** Test agents MUST be adversarial: generate negative cases, boundary cases, and property-based tests beyond the implementer's own tests.
- **TST-5** Defects MUST be filed as artifacts, traced to requirements, and routed back through Implement (or Design, per ORC-1) — never patched out-of-band.
- **TST-6** Flaky tests MUST be detected, quarantined, and tracked; a quarantined test MUST NOT silently satisfy TST-2 coverage.
- **Gate:** all Must-have requirements verified; no open critical/high defects; NFR results within thresholds set in Scope.

### 5.7 Deploy (DEP)

Ship it safely.

- **DEP-1** Deployment MUST be fully automated and repeatable from versioned configuration (IaC); no manual environment mutation.
- **DEP-2** The harness MUST verify releases in a pre-production environment before production, with automated health verification and automated rollback on regression; it SHOULD support progressive delivery (canary/percentage rollout).
- **DEP-3** Every release MUST have: immutable versioned artifacts, changelog, and a tested rollback path; it SHOULD carry provenance (SBOM / build attestation).
- **DEP-4** The harness MUST provision and manage the environments deployment and testing require (test, staging, production) from the same versioned configuration (IaC per DEP-1).
- **DEP-5** The harness MUST verify post-deploy success against defined SLOs/smoke checks and record the outcome as a release artifact.
- **Gate:** operator approval (HIL-2), then release healthy in production per DEP-5, or rolled back with an incident record.

### 5.8 Maintain (MNT)

Keep it healthy and evolving.

- **MNT-1** The harness MUST ingest the operational signal sources declared in project configuration (at minimum: alerts, error rates, SLO burn, dependency advisories) and convert them into triaged, prioritized work items.
- **MNT-2** For incidents, the harness MUST support detection → mitigation proposal → operator-approved remediation → blameless postmortem artifact, with fixes routed through the normal Implement/Test/Deploy path.
- **MNT-3** The harness MUST monitor dependency freshness and CVEs and raise upgrade tasks automatically; security patches MUST be prioritized by severity.
- **MNT-4** The harness SHOULD periodically audit for drift: code vs. documented design, tests vs. requirements, infrastructure vs. IaC — and raise reconciliation tasks.
- **MNT-5** Maintenance changes MUST flow through the same gates as new work; there is no side door.

## 6. Non-Functional Requirements (NFR)

- **NFR-1 Reliability:** No orchestration-state loss on crash (ORC-5); a failed model/tool call MUST retry with backoff and escalate on exhaustion, never silently drop a task.
- **NFR-2 Cost:** Per-run and per-phase budgets enforceable (AGT-4), with spend visible in near-real-time (OBS-2).
- **NFR-3 Performance:** Harness overhead (scheduling, context assembly, validation) MUST stay under 10% of total run wall-clock time; concurrency limits MUST be configuration, not architectural ceilings.
- **NFR-4 Security:** Least privilege throughout (AGT-2, SAF-1/2); full audit trail (OBS-1, HIL-5).
- **NFR-5 Portability:** Runs on a single developer machine and on shared/cloud infrastructure from the same configuration.
- **NFR-6 Usability:** A competent engineer SHOULD reach a first gated Definition artifact within one hour of install, without reading harness source.

## 7. Acceptance

Until the harness can run its own gates, this document is accepted by direct operator sign-off (recorded in the commit history); thereafter it is managed as a Scope artifact of the mpgm project itself. Changes after acceptance produce a new version (ART-1) with recorded rationale (CTX-3).

## 8. Resolved Decisions

1. **Substrate & models:** v1 builds on Claude Code and the Claude Agent SDK, targeting Anthropic Claude models. EXT-2 still applies: workflows, phase definitions, and artifacts remain provider-portable.
2. **Operator model:** single-operator v1; team collaboration (multiple approvers, role-based gates) deferred to v2.
3. **Autonomous replanning:** per PLN-4 — simple/small plan adjustments are autonomous and logged; complex or large adjustments require Plan gate re-entry.
