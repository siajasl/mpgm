---
id: mpgm-scope
version: 1
schema: scope
schemaVersion: 1
tracesTo:
  - SCP-1
  - SCP-2
  - SCP-3
producedBy:
  task: T4.3.1
  role: implementer
  model: claude-sonnet-5
  runId: bootstrap
supersedes: null
egress: internal
data:
  summary: mpgm's own requirement set (REQUIREMENTS.md v0.4), derived mechanically
    so the 84 ids REQUIREMENTS.md already assigns carry across unchanged (ORC-1,
    TST-5, OBS-4 and every other id any commit trailer, ADR or artifact already
    cites resolve against this artifact rather than against prose).
    REQUIREMENTS.md names no separate Definition artifact for mpgm's own
    project, so each requirement's tracesTo cites the REQUIREMENTS.md section it
    was derived from rather than a Definition id, the same "resolves against the
    document, not the trace index" reading artifacts/plan/plan.v1.md already
    uses for ids that predate their own artifacts. Two requirements (NFR-3,
    NFR-6) state an actual quantified threshold and are carried as
    non-functional with it; the other four §6 entries (NFR-1, NFR-2, NFR-4,
    NFR-5) name a quality with no measurable value in the source text, and are
    carried as functional rather than fitted with an invented number — see each
    one's rationale. REQUIREMENTS.md assigns no acceptance criteria to any of
    its 84 bullets; the schema demands at least one per requirement (CONV-5), so
    every requirement here carries its own statement as its sole
    acceptanceCriteria entry — stated per requirement in its own rationale —
    pending a later Scope revision to derive genuine, independently-checkable
    criteria.
  requirements:
    - kind: functional
      id: ORC-1
      statement: The harness MUST model the SDLC as a directed graph of phases with
        explicit entry/exit gates; linear flow is the default, but any phase
        MUST be re-enterable when a downstream phase invalidates upstream
        assumptions (e.g. a test failure reopening Design).
      rationale: Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST model the SDLC as a directed graph of phases with
          explicit entry/exit gates; linear flow is the default, but any phase
          MUST be re-enterable when a downstream phase invalidates upstream
          assumptions (e.g. a test failure reopening Design).
      tracesTo:
        - REQUIREMENTS.md — Orchestration (ORC)
    - kind: functional
      id: ORC-2
      statement: The harness MUST decompose phase work into discrete tasks with
        declared inputs, outputs, and completion criteria, and dispatch them to
        agents.
      rationale: Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST decompose phase work into discrete tasks with
          declared inputs, outputs, and completion criteria, and dispatch them
          to agents.
      tracesTo:
        - REQUIREMENTS.md — Orchestration (ORC)
    - kind: functional
      id: ORC-3
      statement: The harness MUST support parallel agent execution with bounded
        concurrency, and replay of any orchestration run by re-deriving state
        from logged model and tool outputs (event-sourced replay, no live
        re-execution).
      rationale: Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST support parallel agent execution with bounded
          concurrency, and replay of any orchestration run by re-deriving state
          from logged model and tool outputs (event-sourced replay, no live
          re-execution).
      tracesTo:
        - REQUIREMENTS.md — Orchestration (ORC)
    - kind: functional
      id: ORC-4
      statement: "The harness MUST support multi-agent patterns: fan-out/fan-in,
        pipeline, adversarial review (generator vs. critic), and judge panels
        for design selection."
      rationale: Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The harness MUST support multi-agent patterns: fan-out/fan-in,
          pipeline, adversarial review (generator vs. critic), and judge panels
          for design selection."
      tracesTo:
        - REQUIREMENTS.md — Orchestration (ORC)
    - kind: functional
      id: ORC-5
      statement: All orchestration state MUST survive process restarts; an interrupted
        run MUST resume from its last durable checkpoint without repeating
        completed side-effectful steps.
      rationale: Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - All orchestration state MUST survive process restarts; an interrupted
          run MUST resume from its last durable checkpoint without repeating
          completed side-effectful steps.
      tracesTo:
        - REQUIREMENTS.md — Orchestration (ORC)
    - kind: functional
      id: ORC-6
      statement: Reopening a gated phase MUST produce a new artifact version and MUST
        invalidate the gate approvals of all downstream artifacts that trace to
        the changed content (per ART-2); unaffected downstream artifacts retain
        approval. Invalidated gates MUST be re-approved before affected work
        proceeds.
      rationale: Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Reopening a gated phase MUST produce a new artifact version and MUST
          invalidate the gate approvals of all downstream artifacts that trace
          to the changed content (per ART-2); unaffected downstream artifacts
          retain approval. Invalidated gates MUST be re-approved before affected
          work proceeds.
      tracesTo:
        - REQUIREMENTS.md — Orchestration (ORC)
    - kind: functional
      id: AGT-1
      statement: Agent roles (e.g. analyst, architect, planner, implementer, tester,
        release manager, SRE) MUST be defined declaratively — prompt, toolset,
        model, permissions — and be versioned alongside the project.
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Agent roles (e.g. analyst, architect, planner, implementer, tester,
          release manager, SRE) MUST be defined declaratively — prompt, toolset,
          model, permissions — and be versioned alongside the project.
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: AGT-2
      statement: Each agent MUST run with the minimum toolset and permissions its role
        requires (least privilege).
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Each agent MUST run with the minimum toolset and permissions its role
          requires (least privilege).
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: AGT-3
      statement: Agents MUST return schema-validated outputs (prose artifacts are
        carried as payload fields within a structured envelope); results that
        fail validation MUST be rejected and retried.
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Agents MUST return schema-validated outputs (prose artifacts are
          carried as payload fields within a structured envelope); results that
          fail validation MUST be rejected and retried.
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: AGT-4
      statement: The harness MUST bound each agent by budget (tokens/cost), wall-clock
        time, and step count, and terminate or escalate on breach.
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST bound each agent by budget (tokens/cost), wall-clock
          time, and step count, and terminate or escalate on breach.
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: AGT-5
      statement: The harness SHOULD route tasks to models by capability/cost tier,
        with per-task overrides.
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: should
      acceptanceCriteria:
        - The harness SHOULD route tasks to models by capability/cost tier, with
          per-task overrides.
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: AGT-6
      statement: Changes to agent role definitions (prompt, model, toolset) MUST pass
        a regression evaluation suite against benchmark tasks before adoption;
        the harness MUST record eval results with the role version (AGT-1).
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Changes to agent role definitions (prompt, model, toolset) MUST pass a
          regression evaluation suite against benchmark tasks before adoption;
          the harness MUST record eval results with the role version (AGT-1).
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: AGT-7
      statement: "Agents SHOULD be self-improving: the harness SHOULD aggregate
        feedback signals — gate rejections, review findings, operator
        corrections, escaped defects (OBS-4) — into proposed refinements of
        agent role definitions and the knowledge base. Every adopted refinement
        MUST pass AGT-6 evaluation; self-modification MUST NOT bypass it."
      rationale: Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns
        no acceptance criteria; its statement stands as its own criterion
        pending a later Scope revision.
      priority: should
      acceptanceCriteria:
        - "Agents SHOULD be self-improving: the harness SHOULD aggregate
          feedback signals — gate rejections, review findings, operator
          corrections, escaped defects (OBS-4) — into proposed refinements of
          agent role definitions and the knowledge base. Every adopted
          refinement MUST pass AGT-6 evaluation; self-modification MUST NOT
          bypass it."
      tracesTo:
        - REQUIREMENTS.md — Agents (AGT)
    - kind: functional
      id: CTX-1
      statement: The harness MUST maintain a project knowledge base — requirements,
        decisions, glossary, conventions, code map — and assemble task-scoped
        context for each agent rather than shipping full history.
      rationale: Carried from REQUIREMENTS.md — Context & Knowledge (CTX).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST maintain a project knowledge base — requirements,
          decisions, glossary, conventions, code map — and assemble task-scoped
          context for each agent rather than shipping full history.
      tracesTo:
        - REQUIREMENTS.md — Context & Knowledge (CTX)
    - kind: functional
      id: CTX-2
      statement: "Artifacts MUST be the interface between phases: an agent's context
        is built from versioned artifacts, not from prior agents' transcripts."
      rationale: Carried from REQUIREMENTS.md — Context & Knowledge (CTX).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "Artifacts MUST be the interface between phases: an agent's context is
          built from versioned artifacts, not from prior agents' transcripts."
      tracesTo:
        - REQUIREMENTS.md — Context & Knowledge (CTX)
    - kind: functional
      id: CTX-3
      statement: The harness MUST persist decisions with rationale (ADR-style) and
        surface relevant prior decisions to agents whose tasks may conflict with
        them.
      rationale: Carried from REQUIREMENTS.md — Context & Knowledge (CTX).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST persist decisions with rationale (ADR-style) and
          surface relevant prior decisions to agents whose tasks may conflict
          with them.
      tracesTo:
        - REQUIREMENTS.md — Context & Knowledge (CTX)
    - kind: functional
      id: CTX-4
      statement: The knowledge base MUST be incrementally updatable as the codebase
        and requirements evolve, and queryable by both agents and the operator.
      rationale: Carried from REQUIREMENTS.md — Context & Knowledge (CTX).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The knowledge base MUST be incrementally updatable as the codebase and
          requirements evolve, and queryable by both agents and the operator.
      tracesTo:
        - REQUIREMENTS.md — Context & Knowledge (CTX)
    - kind: functional
      id: HIL-1
      statement: Every phase gate MUST require operator approval by default; the
        operator MAY mark specific gates auto-approved with defined criteria.
      rationale: Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Every phase gate MUST require operator approval by default; the
          operator MAY mark specific gates auto-approved with defined criteria.
      tracesTo:
        - REQUIREMENTS.md — Human-in-the-Loop (HIL)
    - kind: functional
      id: HIL-2
      statement: Irreversible or outward-facing actions (production deploys, data
        migrations, publishing, external communications) MUST always require
        explicit operator approval, regardless of gate settings.
      rationale: Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Irreversible or outward-facing actions (production deploys, data
          migrations, publishing, external communications) MUST always require
          explicit operator approval, regardless of gate settings.
      tracesTo:
        - REQUIREMENTS.md — Human-in-the-Loop (HIL)
    - kind: functional
      id: HIL-3
      statement: The operator MUST be able to pause, redirect, roll back, or kill any
        run or agent at any time.
      rationale: Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The operator MUST be able to pause, redirect, roll back, or kill any
          run or agent at any time.
      tracesTo:
        - REQUIREMENTS.md — Human-in-the-Loop (HIL)
    - kind: functional
      id: HIL-4
      statement: The harness MUST present decisions to the operator with options,
        trade-offs, and a recommendation — never a bare "proceed?".
      rationale: Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST present decisions to the operator with options,
          trade-offs, and a recommendation — never a bare "proceed?".
      tracesTo:
        - REQUIREMENTS.md — Human-in-the-Loop (HIL)
    - kind: functional
      id: HIL-5
      statement: All operator interventions MUST be recorded in the audit log.
      rationale: Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - All operator interventions MUST be recorded in the audit log.
      tracesTo:
        - REQUIREMENTS.md — Human-in-the-Loop (HIL)
    - kind: functional
      id: ART-1
      statement: Every artifact MUST be versioned, immutable once gated, attributable
        (which agent/model/prompt/human produced it), and traceable to the
        requirements it serves.
      rationale: Carried from REQUIREMENTS.md — Artifacts & State (ART).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Every artifact MUST be versioned, immutable once gated, attributable
          (which agent/model/prompt/human produced it), and traceable to the
          requirements it serves.
      tracesTo:
        - REQUIREMENTS.md — Artifacts & State (ART)
    - kind: functional
      id: ART-2
      statement: "The harness MUST maintain a bidirectional traceability graph:
        requirement ↔ design element ↔ plan item ↔ code change ↔ test ↔
        release."
      rationale: Carried from REQUIREMENTS.md — Artifacts & State (ART).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The harness MUST maintain a bidirectional traceability graph:
          requirement ↔ design element ↔ plan item ↔ code change ↔ test ↔
          release."
      tracesTo:
        - REQUIREMENTS.md — Artifacts & State (ART)
    - kind: functional
      id: ART-3
      statement: Artifact schemas MUST be validated on write; breaking schema changes
        MUST be migrated, not silently ignored.
      rationale: Carried from REQUIREMENTS.md — Artifacts & State (ART).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Artifact schemas MUST be validated on write; breaking schema changes
          MUST be migrated, not silently ignored.
      tracesTo:
        - REQUIREMENTS.md — Artifacts & State (ART)
    - kind: functional
      id: ART-4
      statement: All code artifacts MUST live in Git; the harness MUST NOT hold code
        state outside version control.
      rationale: Carried from REQUIREMENTS.md — Artifacts & State (ART).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - All code artifacts MUST live in Git; the harness MUST NOT hold code
          state outside version control.
      tracesTo:
        - REQUIREMENTS.md — Artifacts & State (ART)
    - kind: functional
      id: OBS-1
      statement: The harness MUST emit a structured event log covering every task,
        tool call, model call, gate decision, and error, sufficient for full run
        reconstruction.
      rationale: Carried from REQUIREMENTS.md — Observability & Audit (OBS).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST emit a structured event log covering every task, tool
          call, model call, gate decision, and error, sufficient for full run
          reconstruction.
      tracesTo:
        - REQUIREMENTS.md — Observability & Audit (OBS)
    - kind: functional
      id: OBS-2
      statement: The harness MUST track and report cost (tokens, spend), latency, and
        success/retry rates per phase, per agent role, and per run.
      rationale: Carried from REQUIREMENTS.md — Observability & Audit (OBS).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST track and report cost (tokens, spend), latency, and
          success/retry rates per phase, per agent role, and per run.
      tracesTo:
        - REQUIREMENTS.md — Observability & Audit (OBS)
    - kind: functional
      id: OBS-3
      statement: "The operator MUST have a live view of current runs: what each agent
        is doing, what is blocked, and what awaits approval."
      rationale: Carried from REQUIREMENTS.md — Observability & Audit (OBS).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The operator MUST have a live view of current runs: what each agent
          is doing, what is blocked, and what awaits approval."
      tracesTo:
        - REQUIREMENTS.md — Observability & Audit (OBS)
    - kind: functional
      id: OBS-4
      statement: The harness SHOULD compute quality metrics over time (gate rejection
        rate, rework rate, escaped-defect rate) to measure its own
        effectiveness.
      rationale: Carried from REQUIREMENTS.md — Observability & Audit (OBS).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: should
      acceptanceCriteria:
        - The harness SHOULD compute quality metrics over time (gate rejection
          rate, rework rate, escaped-defect rate) to measure its own
          effectiveness.
      tracesTo:
        - REQUIREMENTS.md — Observability & Audit (OBS)
    - kind: functional
      id: PMG-1
      statement: "The harness MUST project its orchestration state onto the project's
        GitHub repository as native project-management structures: a scrum board
        (GitHub Projects), issues, milestones, labels, and pull requests —
        mapped from the plan hierarchy (plan phases/milestones/tasks, PLN-1) and
        the implement loop (IMP-1/3)."
      rationale: Carried from REQUIREMENTS.md — Project Management Integration (PMG).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The harness MUST project its orchestration state onto the project's
          GitHub repository as native project-management structures: a scrum
          board (GitHub Projects), issues, milestones, labels, and pull requests
          — mapped from the plan hierarchy (plan phases/milestones/tasks, PLN-1)
          and the implement loop (IMP-1/3)."
      tracesTo:
        - REQUIREMENTS.md — Project Management Integration (PMG)
    - kind: functional
      id: PMG-2
      statement: "The board MUST be kept up to date at all times: every task,
        milestone, gate, and PR state change MUST be reflected event-driven (on
        occurrence), not by periodic batch sync."
      rationale: Carried from REQUIREMENTS.md — Project Management Integration (PMG).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The board MUST be kept up to date at all times: every task,
          milestone, gate, and PR state change MUST be reflected event-driven
          (on occurrence), not by periodic batch sync."
      tracesTo:
        - REQUIREMENTS.md — Project Management Integration (PMG)
    - kind: functional
      id: PMG-3
      statement: "Kernel state is authoritative (single source of truth): the GitHub
        projection is derived and idempotently reconcilable. Inbound GitHub
        activity (operator- or collaborator-created issues, comments, card
        moves) MUST be ingested as signals and triaged into work items (per
        MNT-1), never applied as direct state mutations."
      rationale: Carried from REQUIREMENTS.md — Project Management Integration (PMG).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "Kernel state is authoritative (single source of truth): the GitHub
          projection is derived and idempotently reconcilable. Inbound GitHub
          activity (operator- or collaborator-created issues, comments, card
          moves) MUST be ingested as signals and triaged into work items (per
          MNT-1), never applied as direct state mutations."
      tracesTo:
        - REQUIREMENTS.md — Project Management Integration (PMG)
    - kind: functional
      id: PMG-4
      statement: For a greenfield project, the harness MUST bootstrap the PM
        structures (board, label taxonomy, milestones) idempotently from the
        gated Plan artifact — no manual GitHub setup.
      rationale: Carried from REQUIREMENTS.md — Project Management Integration (PMG).
        REQUIREMENTS.md assigns no acceptance criteria; its statement stands as
        its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - For a greenfield project, the harness MUST bootstrap the PM structures
          (board, label taxonomy, milestones) idempotently from the gated Plan
          artifact — no manual GitHub setup.
      tracesTo:
        - REQUIREMENTS.md — Project Management Integration (PMG)
    - kind: functional
      id: SAF-1
      statement: The harness MUST enforce a policy layer that constrains agent actions
        (allowed tools, file paths, network destinations, shell commands)
        independent of prompts; prompt-level instructions are not a control.
      rationale: Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST enforce a policy layer that constrains agent actions
          (allowed tools, file paths, network destinations, shell commands)
          independent of prompts; prompt-level instructions are not a control.
      tracesTo:
        - REQUIREMENTS.md — Safety & Policy (SAF)
    - kind: functional
      id: SAF-2
      statement: Secrets MUST never enter model context; the harness MUST broker
        credentials so agents reference them symbolically.
      rationale: Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Secrets MUST never enter model context; the harness MUST broker
          credentials so agents reference them symbolically.
      tracesTo:
        - REQUIREMENTS.md — Safety & Policy (SAF)
    - kind: functional
      id: SAF-3
      statement: All content ingested from outside the project (web pages, third-party
        issues, dependency docs) MUST be treated as untrusted data; instructions
        embedded in it MUST NOT be executed.
      rationale: Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - All content ingested from outside the project (web pages, third-party
          issues, dependency docs) MUST be treated as untrusted data;
          instructions embedded in it MUST NOT be executed.
      tracesTo:
        - REQUIREMENTS.md — Safety & Policy (SAF)
    - kind: functional
      id: SAF-4
      statement: Destructive operations MUST be dry-run capable and reversible where
        the underlying system permits; the harness MUST prefer reversible paths.
      rationale: Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Destructive operations MUST be dry-run capable and reversible where
          the underlying system permits; the harness MUST prefer reversible
          paths.
      tracesTo:
        - REQUIREMENTS.md — Safety & Policy (SAF)
    - kind: functional
      id: SAF-5
      statement: Agent-generated code MUST pass automated security scanning (static
        analysis, dependency audit, secret scanning) before every merge
        (enforced via IMP-2).
      rationale: Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Agent-generated code MUST pass automated security scanning (static
          analysis, dependency audit, secret scanning) before every merge
          (enforced via IMP-2).
      tracesTo:
        - REQUIREMENTS.md — Safety & Policy (SAF)
    - kind: functional
      id: SAF-6
      statement: The project MUST declare a data-egress policy classifying what may be
        sent to which model providers; the harness MUST enforce it on context
        assembly, and personally identifiable or operator-restricted data MUST
        NOT enter third-party model calls without explicit policy allowance.
      rationale: Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The project MUST declare a data-egress policy classifying what may be
          sent to which model providers; the harness MUST enforce it on context
          assembly, and personally identifiable or operator-restricted data MUST
          NOT enter third-party model calls without explicit policy allowance.
      tracesTo:
        - REQUIREMENTS.md — Safety & Policy (SAF)
    - kind: functional
      id: EXT-1
      statement: Tools MUST be pluggable behind a uniform interface (MCP or
        equivalent), so integrations (VCS, CI, issue tracker, cloud) can be
        added without core changes.
      rationale: Carried from REQUIREMENTS.md — Extensibility (EXT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Tools MUST be pluggable behind a uniform interface (MCP or
          equivalent), so integrations (VCS, CI, issue tracker, cloud) can be
          added without core changes.
      tracesTo:
        - REQUIREMENTS.md — Extensibility (EXT)
    - kind: functional
      id: EXT-2
      statement: "The harness MUST be model-agnostic: swapping or mixing model
        providers MUST NOT require workflow changes."
      rationale: Carried from REQUIREMENTS.md — Extensibility (EXT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The harness MUST be model-agnostic: swapping or mixing model
          providers MUST NOT require workflow changes."
      tracesTo:
        - REQUIREMENTS.md — Extensibility (EXT)
    - kind: functional
      id: EXT-3
      statement: Phase definitions, gate criteria, and agent roles MUST be
        configurable per project without forking the harness.
      rationale: Carried from REQUIREMENTS.md — Extensibility (EXT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Phase definitions, gate criteria, and agent roles MUST be configurable
          per project without forking the harness.
      tracesTo:
        - REQUIREMENTS.md — Extensibility (EXT)
    - kind: functional
      id: DEF-1
      statement: "The harness MUST conduct a structured elicitation dialogue with the
        operator, producing: problem statement, goals, non-goals, stakeholders,
        constraints, assumptions, and success metrics."
      rationale: Carried from REQUIREMENTS.md — 5.1 Definition (DEF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The harness MUST conduct a structured elicitation dialogue with the
          operator, producing: problem statement, goals, non-goals,
          stakeholders, constraints, assumptions, and success metrics."
      tracesTo:
        - REQUIREMENTS.md — 5.1 Definition (DEF)
    - kind: functional
      id: DEF-2
      statement: Agents MUST challenge ambiguity and contradiction in stated intent
        and record resolutions.
      rationale: Carried from REQUIREMENTS.md — 5.1 Definition (DEF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Agents MUST challenge ambiguity and contradiction in stated intent and
          record resolutions.
      tracesTo:
        - REQUIREMENTS.md — 5.1 Definition (DEF)
    - kind: functional
      id: DEF-3
      statement: The harness SHOULD research prior art and comparable systems and
        summarize findings with sources.
      rationale: Carried from REQUIREMENTS.md — 5.1 Definition (DEF). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: should
      acceptanceCriteria:
        - The harness SHOULD research prior art and comparable systems and
          summarize findings with sources.
      tracesTo:
        - REQUIREMENTS.md — 5.1 Definition (DEF)
    - kind: functional
      id: SCP-1
      statement: The harness MUST derive functional and non-functional requirements
        from the Definition, each testable and uniquely identified;
        non-functional requirements MUST carry quantified thresholds (these bind
        TST-3 and the Test gate).
      rationale: Carried from REQUIREMENTS.md — 5.2 Scope (SCP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST derive functional and non-functional requirements
          from the Definition, each testable and uniquely identified;
          non-functional requirements MUST carry quantified thresholds (these
          bind TST-3 and the Test gate).
      tracesTo:
        - REQUIREMENTS.md — 5.2 Scope (SCP)
    - kind: functional
      id: SCP-2
      statement: The harness MUST produce an explicit out-of-scope list and a MoSCoW
        (or equivalent) prioritization.
      rationale: Carried from REQUIREMENTS.md — 5.2 Scope (SCP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST produce an explicit out-of-scope list and a MoSCoW
          (or equivalent) prioritization.
      tracesTo:
        - REQUIREMENTS.md — 5.2 Scope (SCP)
    - kind: functional
      id: SCP-3
      statement: The harness MUST flag requirements that conflict, duplicate, or lack
        acceptance criteria before the gate.
      rationale: Carried from REQUIREMENTS.md — 5.2 Scope (SCP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST flag requirements that conflict, duplicate, or lack
          acceptance criteria before the gate.
      tracesTo:
        - REQUIREMENTS.md — 5.2 Scope (SCP)
    - kind: functional
      id: DSG-1
      statement: The harness MUST generate candidate architectures (≥2 for significant
        decisions), evaluate them against the requirements and constraints, and
        record the choice as an ADR with trade-offs.
      rationale: Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST generate candidate architectures (≥2 for significant
          decisions), evaluate them against the requirements and constraints,
          and record the choice as an ADR with trade-offs.
      tracesTo:
        - REQUIREMENTS.md — 5.3 Design (DSG)
    - kind: functional
      id: DSG-2
      statement: "Design output MUST include: component decomposition, interface
        contracts (APIs, schemas, events), data model, technology selections,
        and cross-cutting concerns (authn/z, observability, failure modes)."
      rationale: Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "Design output MUST include: component decomposition, interface
          contracts (APIs, schemas, events), data model, technology selections,
          and cross-cutting concerns (authn/z, observability, failure modes)."
      tracesTo:
        - REQUIREMENTS.md — 5.3 Design (DSG)
    - kind: functional
      id: DSG-3
      statement: The harness MUST run adversarial design review (independent critic
        agents) covering scalability, security, operability, and simplicity
        before the gate.
      rationale: Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST run adversarial design review (independent critic
          agents) covering scalability, security, operability, and simplicity
          before the gate.
      tracesTo:
        - REQUIREMENTS.md — 5.3 Design (DSG)
    - kind: functional
      id: DSG-4
      statement: Every design element MUST trace to at least one requirement;
        unreferenced elements MUST be flagged as gold-plating.
      rationale: Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Every design element MUST trace to at least one requirement;
          unreferenced elements MUST be flagged as gold-plating.
      tracesTo:
        - REQUIREMENTS.md — 5.3 Design (DSG)
    - kind: functional
      id: PLN-1
      statement: "The plan MUST be a three-level hierarchy: **plan phases** group
        milestones, **milestones** group tasks, and each **task** is a single
        unit of work that demonstrably advances the system — sized for
        single-agent execution, with declared completion criteria and dependency
        ordering. (Plan phases are groupings within the Plan artifact, distinct
        from the SDLC phases of §5.)"
      rationale: Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The plan MUST be a three-level hierarchy: **plan phases** group
          milestones, **milestones** group tasks, and each **task** is a single
          unit of work that demonstrably advances the system — sized for
          single-agent execution, with declared completion criteria and
          dependency ordering. (Plan phases are groupings within the Plan
          artifact, distinct from the SDLC phases of §5.)"
      tracesTo:
        - REQUIREMENTS.md — 5.4 Plan (PLN)
    - kind: functional
      id: PLN-2
      statement: The plan MUST identify the riskiest assumptions and front-load tasks
        that validate them (walking skeleton / steel thread first).
      rationale: Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The plan MUST identify the riskiest assumptions and front-load tasks
          that validate them (walking skeleton / steel thread first).
      tracesTo:
        - REQUIREMENTS.md — 5.4 Plan (PLN)
    - kind: functional
      id: PLN-3
      statement: The plan MUST define per-milestone verification (what must
        demonstrably work) rather than time estimates alone.
      rationale: Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The plan MUST define per-milestone verification (what must
          demonstrably work) rather than time estimates alone.
      tracesTo:
        - REQUIREMENTS.md — 5.4 Plan (PLN)
    - kind: functional
      id: PLN-4
      statement: The harness MUST replan incrementally when implementation invalidates
        plan assumptions, preserving completed work. Small, simple adjustments
        (reordering or splitting tasks within a milestone) MAY be applied
        autonomously and logged; complex or large adjustments (adding/removing
        milestones, restructuring plan phases, or touching design assumptions)
        MUST re-enter the Plan gate for operator approval.
      rationale: Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST replan incrementally when implementation invalidates
          plan assumptions, preserving completed work. Small, simple adjustments
          (reordering or splitting tasks within a milestone) MAY be applied
          autonomously and logged; complex or large adjustments (adding/removing
          milestones, restructuring plan phases, or touching design assumptions)
          MUST re-enter the Plan gate for operator approval.
      tracesTo:
        - REQUIREMENTS.md — 5.4 Plan (PLN)
    - kind: functional
      id: IMP-1
      statement: Each implementation task MUST run in an isolated workspace
        (branch/worktree/sandbox) and integrate via reviewed merge; agents MUST
        NOT commit directly to the main branch.
      rationale: Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Each implementation task MUST run in an isolated workspace
          (branch/worktree/sandbox) and integrate via reviewed merge; agents
          MUST NOT commit directly to the main branch.
      tracesTo:
        - REQUIREMENTS.md — 5.5 Implement (IMP)
    - kind: functional
      id: IMP-2
      statement: Every change MUST pass automated checks — build, lint, type check,
        tests, security scan (SAF-5) — before merge; the harness MUST feed
        failures back to the implementing agent for repair with a bounded retry
        budget.
      rationale: Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Every change MUST pass automated checks — build, lint, type check,
          tests, security scan (SAF-5) — before merge; the harness MUST feed
          failures back to the implementing agent for repair with a bounded
          retry budget.
      tracesTo:
        - REQUIREMENTS.md — 5.5 Implement (IMP)
    - kind: functional
      id: IMP-3
      statement: Every change MUST receive agent code review independent of its author
        agent; operator review is required where policy demands it.
      rationale: Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Every change MUST receive agent code review independent of its author
          agent; operator review is required where policy demands it.
      tracesTo:
        - REQUIREMENTS.md — 5.5 Implement (IMP)
    - kind: functional
      id: IMP-4
      statement: Implementation MUST conform to project conventions (style, structure,
        commit format) defined in the knowledge base; deviations MUST be
        flagged, not silently introduced.
      rationale: Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Implementation MUST conform to project conventions (style, structure,
          commit format) defined in the knowledge base; deviations MUST be
          flagged, not silently introduced.
      tracesTo:
        - REQUIREMENTS.md — 5.5 Implement (IMP)
    - kind: functional
      id: IMP-5
      statement: The harness MUST keep the main branch releasable at all times
        (trunk-based, feature-flagged where incomplete).
      rationale: Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST keep the main branch releasable at all times
          (trunk-based, feature-flagged where incomplete).
      tracesTo:
        - REQUIREMENTS.md — 5.5 Implement (IMP)
    - kind: functional
      id: TST-1
      statement: The harness MUST maintain a test pyramid — unit, integration,
        end-to-end — with tests authored alongside implementation, not deferred
        to this phase; the Test phase validates system-level behavior.
      rationale: Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST maintain a test pyramid — unit, integration,
          end-to-end — with tests authored alongside implementation, not
          deferred to this phase; the Test phase validates system-level
          behavior.
      tracesTo:
        - REQUIREMENTS.md — 5.6 Test (TST)
    - kind: functional
      id: TST-2
      statement: The harness MUST verify every requirement's acceptance criteria and
        report requirement-level coverage (which requirements are verified, by
        which tests).
      rationale: Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST verify every requirement's acceptance criteria and
          report requirement-level coverage (which requirements are verified, by
          which tests).
      tracesTo:
        - REQUIREMENTS.md — 5.6 Test (TST)
    - kind: functional
      id: TST-3
      statement: The harness MUST run non-functional validation for every quantified
        NFR declared in the Scope artifact (SCP-1) — e.g. performance/load,
        security (SAST/DAST/dependency) — and SHOULD run resilience validation
        (fault injection) for availability NFRs.
      rationale: Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST run non-functional validation for every quantified
          NFR declared in the Scope artifact (SCP-1) — e.g. performance/load,
          security (SAST/DAST/dependency) — and SHOULD run resilience validation
          (fault injection) for availability NFRs.
      tracesTo:
        - REQUIREMENTS.md — 5.6 Test (TST)
    - kind: functional
      id: TST-4
      statement: "Test agents MUST be adversarial: generate negative cases, boundary
        cases, and property-based tests beyond the implementer's own tests."
      rationale: Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "Test agents MUST be adversarial: generate negative cases, boundary
          cases, and property-based tests beyond the implementer's own tests."
      tracesTo:
        - REQUIREMENTS.md — 5.6 Test (TST)
    - kind: functional
      id: TST-5
      statement: Defects MUST be filed as artifacts, traced to requirements, and
        routed back through Implement (or Design, per ORC-1) — never patched
        out-of-band.
      rationale: Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Defects MUST be filed as artifacts, traced to requirements, and routed
          back through Implement (or Design, per ORC-1) — never patched
          out-of-band.
      tracesTo:
        - REQUIREMENTS.md — 5.6 Test (TST)
    - kind: functional
      id: TST-6
      statement: Flaky tests MUST be detected, quarantined, and tracked; a quarantined
        test MUST NOT silently satisfy TST-2 coverage.
      rationale: Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Flaky tests MUST be detected, quarantined, and tracked; a quarantined
          test MUST NOT silently satisfy TST-2 coverage.
      tracesTo:
        - REQUIREMENTS.md — 5.6 Test (TST)
    - kind: functional
      id: DEP-1
      statement: Deployment MUST be fully automated and repeatable from versioned
        configuration (IaC); no manual environment mutation.
      rationale: Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Deployment MUST be fully automated and repeatable from versioned
          configuration (IaC); no manual environment mutation.
      tracesTo:
        - REQUIREMENTS.md — 5.7 Deploy (DEP)
    - kind: functional
      id: DEP-2
      statement: The harness MUST verify releases in a pre-production environment
        before production, with automated health verification and automated
        rollback on regression; it SHOULD support progressive delivery
        (canary/percentage rollout).
      rationale: Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST verify releases in a pre-production environment
          before production, with automated health verification and automated
          rollback on regression; it SHOULD support progressive delivery
          (canary/percentage rollout).
      tracesTo:
        - REQUIREMENTS.md — 5.7 Deploy (DEP)
    - kind: functional
      id: DEP-3
      statement: "Every release MUST have: immutable versioned artifacts, changelog,
        and a tested rollback path; it SHOULD carry provenance (SBOM / build
        attestation)."
      rationale: Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "Every release MUST have: immutable versioned artifacts, changelog,
          and a tested rollback path; it SHOULD carry provenance (SBOM / build
          attestation)."
      tracesTo:
        - REQUIREMENTS.md — 5.7 Deploy (DEP)
    - kind: functional
      id: DEP-4
      statement: The harness MUST provision and manage the environments deployment and
        testing require (test, staging, production) from the same versioned
        configuration (IaC per DEP-1).
      rationale: Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST provision and manage the environments deployment and
          testing require (test, staging, production) from the same versioned
          configuration (IaC per DEP-1).
      tracesTo:
        - REQUIREMENTS.md — 5.7 Deploy (DEP)
    - kind: functional
      id: DEP-5
      statement: The harness MUST verify post-deploy success against defined
        SLOs/smoke checks and record the outcome as a release artifact.
      rationale: Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST verify post-deploy success against defined SLOs/smoke
          checks and record the outcome as a release artifact.
      tracesTo:
        - REQUIREMENTS.md — 5.7 Deploy (DEP)
    - kind: functional
      id: MNT-1
      statement: "The harness MUST ingest the operational signal sources declared in
        project configuration (at minimum: alerts, error rates, SLO burn,
        dependency advisories) and convert them into triaged, prioritized work
        items."
      rationale: Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - "The harness MUST ingest the operational signal sources declared in
          project configuration (at minimum: alerts, error rates, SLO burn,
          dependency advisories) and convert them into triaged, prioritized work
          items."
      tracesTo:
        - REQUIREMENTS.md — 5.8 Maintain (MNT)
    - kind: functional
      id: MNT-2
      statement: For incidents, the harness MUST support detection → mitigation
        proposal → operator-approved remediation → blameless postmortem
        artifact, with fixes routed through the normal Implement/Test/Deploy
        path.
      rationale: Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - For incidents, the harness MUST support detection → mitigation
          proposal → operator-approved remediation → blameless postmortem
          artifact, with fixes routed through the normal Implement/Test/Deploy
          path.
      tracesTo:
        - REQUIREMENTS.md — 5.8 Maintain (MNT)
    - kind: functional
      id: MNT-3
      statement: The harness MUST monitor dependency freshness and CVEs and raise
        upgrade tasks automatically; security patches MUST be prioritized by
        severity.
      rationale: Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - The harness MUST monitor dependency freshness and CVEs and raise
          upgrade tasks automatically; security patches MUST be prioritized by
          severity.
      tracesTo:
        - REQUIREMENTS.md — 5.8 Maintain (MNT)
    - kind: functional
      id: MNT-4
      statement: "The harness SHOULD periodically audit for drift: code vs. documented
        design, tests vs. requirements, infrastructure vs. IaC — and raise
        reconciliation tasks."
      rationale: Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: should
      acceptanceCriteria:
        - "The harness SHOULD periodically audit for drift: code vs. documented
          design, tests vs. requirements, infrastructure vs. IaC — and raise
          reconciliation tasks."
      tracesTo:
        - REQUIREMENTS.md — 5.8 Maintain (MNT)
    - kind: functional
      id: MNT-5
      statement: Maintenance changes MUST flow through the same gates as new work;
        there is no side door.
      rationale: Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Maintenance changes MUST flow through the same gates as new work;
          there is no side door.
      tracesTo:
        - REQUIREMENTS.md — 5.8 Maintain (MNT)
    - kind: functional
      id: NFR-1
      statement: No orchestration-state loss on crash (ORC-5); a failed model/tool
        call MUST retry with backoff and escalate on exhaustion, never silently
        drop a task.
      rationale: Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR).
        REQUIREMENTS.md states this quality but no measurable metric, value and
        unit for it; SCP-1's schema cannot represent a non-functional
        requirement without a quantified threshold, so this is carried as
        functional rather than with an invented number (a quantification gap for
        a later Scope revision to close, not this migration). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - No orchestration-state loss on crash (ORC-5); a failed model/tool call
          MUST retry with backoff and escalate on exhaustion, never silently
          drop a task.
      tracesTo:
        - REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)
    - kind: functional
      id: NFR-2
      statement: Per-run and per-phase budgets enforceable (AGT-4), with spend visible
        in near-real-time (OBS-2).
      rationale: Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR).
        REQUIREMENTS.md states this quality but no measurable metric, value and
        unit for it; SCP-1's schema cannot represent a non-functional
        requirement without a quantified threshold, so this is carried as
        functional rather than with an invented number (a quantification gap for
        a later Scope revision to close, not this migration). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Per-run and per-phase budgets enforceable (AGT-4), with spend visible
          in near-real-time (OBS-2).
      tracesTo:
        - REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)
    - kind: non-functional
      id: NFR-3
      statement: Harness overhead (scheduling, context assembly, validation) MUST stay
        under 10% of total run wall-clock time; concurrency limits MUST be
        configuration, not architectural ceilings.
      rationale: Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR).
        Its threshold (10%) is the number REQUIREMENTS.md itself states; SCP-1
        binds it to TST-3. REQUIREMENTS.md assigns no acceptance criteria; its
        statement stands as its own criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Harness overhead (scheduling, context assembly, validation) MUST stay
          under 10% of total run wall-clock time; concurrency limits MUST be
          configuration, not architectural ceilings.
      tracesTo:
        - REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)
      threshold:
        metric: harness overhead (scheduling, context assembly, validation) as a share
          of total run wall-clock time
        value: 10
        unit: "%"
        measuredBy: sum of scheduling, context-assembly and validation time divided by
          total run wall-clock time, over one run
    - kind: functional
      id: NFR-4
      statement: Least privilege throughout (AGT-2, SAF-1/2); full audit trail (OBS-1,
        HIL-5).
      rationale: Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR).
        REQUIREMENTS.md states this quality but no measurable metric, value and
        unit for it; SCP-1's schema cannot represent a non-functional
        requirement without a quantified threshold, so this is carried as
        functional rather than with an invented number (a quantification gap for
        a later Scope revision to close, not this migration). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Least privilege throughout (AGT-2, SAF-1/2); full audit trail (OBS-1,
          HIL-5).
      tracesTo:
        - REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)
    - kind: functional
      id: NFR-5
      statement: Runs on a single developer machine and on shared/cloud infrastructure
        from the same configuration.
      rationale: Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR).
        REQUIREMENTS.md states this quality but no measurable metric, value and
        unit for it; SCP-1's schema cannot represent a non-functional
        requirement without a quantified threshold, so this is carried as
        functional rather than with an invented number (a quantification gap for
        a later Scope revision to close, not this migration). REQUIREMENTS.md
        assigns no acceptance criteria; its statement stands as its own
        criterion pending a later Scope revision.
      priority: must
      acceptanceCriteria:
        - Runs on a single developer machine and on shared/cloud infrastructure
          from the same configuration.
      tracesTo:
        - REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)
    - kind: non-functional
      id: NFR-6
      statement: A competent engineer SHOULD reach a first gated Definition artifact
        within one hour of install, without reading harness source.
      rationale: Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR).
        Its threshold (1hour) is the number REQUIREMENTS.md itself states; SCP-1
        binds it to TST-3. REQUIREMENTS.md assigns no acceptance criteria; its
        statement stands as its own criterion pending a later Scope revision.
      priority: should
      acceptanceCriteria:
        - A competent engineer SHOULD reach a first gated Definition artifact
          within one hour of install, without reading harness source.
      tracesTo:
        - REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)
      threshold:
        metric: wall-clock time from install to a first gated Definition artifact
        value: 1
        unit: hour
        measuredBy: wall-clock time from a fresh install to the Definition gate being
          approved, by a competent engineer who has not read harness source
  outOfScope:
    - item: Training or fine-tuning models
      why: REQUIREMENTS.md §3 excludes it from v1 scope; the harness consumes hosted
        model APIs.
    - item: Hosting model inference
      why: REQUIREMENTS.md §3 excludes it from v1 scope; inference is via provider
        APIs (EXT-2).
    - item: Replacing the operator's judgment at gates
      why: REQUIREMENTS.md §3 excludes it; HIL-1..HIL-5 keep gate and irreversible
        decisions with the operator.
    - item: Project management for non-software work
      why: REQUIREMENTS.md §3 excludes it; PMG-1..PMG-4 project only the SDLC
        plan/implement loop onto GitHub.
    - item: Multi-tenant SaaS operation
      why: REQUIREMENTS.md §3 excludes it; §8 decision 2 fixes v1 to a single
        operator.
---

# mpgm-scope

## summary

mpgm's own requirement set (REQUIREMENTS.md v0.4), derived mechanically so the 84 ids REQUIREMENTS.md already assigns carry across unchanged (ORC-1, TST-5, OBS-4 and every other id any commit trailer, ADR or artifact already cites resolve against this artifact rather than against prose). REQUIREMENTS.md names no separate Definition artifact for mpgm's own project, so each requirement's tracesTo cites the REQUIREMENTS.md section it was derived from rather than a Definition id, the same "resolves against the document, not the trace index" reading artifacts/plan/plan.v1.md already uses for ids that predate their own artifacts. Two requirements (NFR-3, NFR-6) state an actual quantified threshold and are carried as non-functional with it; the other four §6 entries (NFR-1, NFR-2, NFR-4, NFR-5) name a quality with no measurable value in the source text, and are carried as functional rather than fitted with an invented number — see each one's rationale. REQUIREMENTS.md assigns no acceptance criteria to any of its 84 bullets; the schema demands at least one per requirement (CONV-5), so every requirement here carries its own statement as its sole acceptanceCriteria entry — stated per requirement in its own rationale — pending a later Scope revision to derive genuine, independently-checkable criteria.

## requirements

- {"kind":"functional","id":"ORC-1","statement":"The harness MUST model the SDLC as a directed graph of phases with explicit entry/exit gates; linear flow is the default, but any phase MUST be re-enterable when a downstream phase invalidates upstream assumptions (e.g. a test failure reopening Design).","rationale":"Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST model the SDLC as a directed graph of phases with explicit entry/exit gates; linear flow is the default, but any phase MUST be re-enterable when a downstream phase invalidates upstream assumptions (e.g. a test failure reopening Design)."],"tracesTo":["REQUIREMENTS.md — Orchestration (ORC)"]}
- {"kind":"functional","id":"ORC-2","statement":"The harness MUST decompose phase work into discrete tasks with declared inputs, outputs, and completion criteria, and dispatch them to agents.","rationale":"Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST decompose phase work into discrete tasks with declared inputs, outputs, and completion criteria, and dispatch them to agents."],"tracesTo":["REQUIREMENTS.md — Orchestration (ORC)"]}
- {"kind":"functional","id":"ORC-3","statement":"The harness MUST support parallel agent execution with bounded concurrency, and replay of any orchestration run by re-deriving state from logged model and tool outputs (event-sourced replay, no live re-execution).","rationale":"Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST support parallel agent execution with bounded concurrency, and replay of any orchestration run by re-deriving state from logged model and tool outputs (event-sourced replay, no live re-execution)."],"tracesTo":["REQUIREMENTS.md — Orchestration (ORC)"]}
- {"kind":"functional","id":"ORC-4","statement":"The harness MUST support multi-agent patterns: fan-out/fan-in, pipeline, adversarial review (generator vs. critic), and judge panels for design selection.","rationale":"Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST support multi-agent patterns: fan-out/fan-in, pipeline, adversarial review (generator vs. critic), and judge panels for design selection."],"tracesTo":["REQUIREMENTS.md — Orchestration (ORC)"]}
- {"kind":"functional","id":"ORC-5","statement":"All orchestration state MUST survive process restarts; an interrupted run MUST resume from its last durable checkpoint without repeating completed side-effectful steps.","rationale":"Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["All orchestration state MUST survive process restarts; an interrupted run MUST resume from its last durable checkpoint without repeating completed side-effectful steps."],"tracesTo":["REQUIREMENTS.md — Orchestration (ORC)"]}
- {"kind":"functional","id":"ORC-6","statement":"Reopening a gated phase MUST produce a new artifact version and MUST invalidate the gate approvals of all downstream artifacts that trace to the changed content (per ART-2); unaffected downstream artifacts retain approval. Invalidated gates MUST be re-approved before affected work proceeds.","rationale":"Carried from REQUIREMENTS.md — Orchestration (ORC). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Reopening a gated phase MUST produce a new artifact version and MUST invalidate the gate approvals of all downstream artifacts that trace to the changed content (per ART-2); unaffected downstream artifacts retain approval. Invalidated gates MUST be re-approved before affected work proceeds."],"tracesTo":["REQUIREMENTS.md — Orchestration (ORC)"]}
- {"kind":"functional","id":"AGT-1","statement":"Agent roles (e.g. analyst, architect, planner, implementer, tester, release manager, SRE) MUST be defined declaratively — prompt, toolset, model, permissions — and be versioned alongside the project.","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Agent roles (e.g. analyst, architect, planner, implementer, tester, release manager, SRE) MUST be defined declaratively — prompt, toolset, model, permissions — and be versioned alongside the project."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"AGT-2","statement":"Each agent MUST run with the minimum toolset and permissions its role requires (least privilege).","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Each agent MUST run with the minimum toolset and permissions its role requires (least privilege)."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"AGT-3","statement":"Agents MUST return schema-validated outputs (prose artifacts are carried as payload fields within a structured envelope); results that fail validation MUST be rejected and retried.","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Agents MUST return schema-validated outputs (prose artifacts are carried as payload fields within a structured envelope); results that fail validation MUST be rejected and retried."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"AGT-4","statement":"The harness MUST bound each agent by budget (tokens/cost), wall-clock time, and step count, and terminate or escalate on breach.","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST bound each agent by budget (tokens/cost), wall-clock time, and step count, and terminate or escalate on breach."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"AGT-5","statement":"The harness SHOULD route tasks to models by capability/cost tier, with per-task overrides.","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"should","acceptanceCriteria":["The harness SHOULD route tasks to models by capability/cost tier, with per-task overrides."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"AGT-6","statement":"Changes to agent role definitions (prompt, model, toolset) MUST pass a regression evaluation suite against benchmark tasks before adoption; the harness MUST record eval results with the role version (AGT-1).","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Changes to agent role definitions (prompt, model, toolset) MUST pass a regression evaluation suite against benchmark tasks before adoption; the harness MUST record eval results with the role version (AGT-1)."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"AGT-7","statement":"Agents SHOULD be self-improving: the harness SHOULD aggregate feedback signals — gate rejections, review findings, operator corrections, escaped defects (OBS-4) — into proposed refinements of agent role definitions and the knowledge base. Every adopted refinement MUST pass AGT-6 evaluation; self-modification MUST NOT bypass it.","rationale":"Carried from REQUIREMENTS.md — Agents (AGT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"should","acceptanceCriteria":["Agents SHOULD be self-improving: the harness SHOULD aggregate feedback signals — gate rejections, review findings, operator corrections, escaped defects (OBS-4) — into proposed refinements of agent role definitions and the knowledge base. Every adopted refinement MUST pass AGT-6 evaluation; self-modification MUST NOT bypass it."],"tracesTo":["REQUIREMENTS.md — Agents (AGT)"]}
- {"kind":"functional","id":"CTX-1","statement":"The harness MUST maintain a project knowledge base — requirements, decisions, glossary, conventions, code map — and assemble task-scoped context for each agent rather than shipping full history.","rationale":"Carried from REQUIREMENTS.md — Context & Knowledge (CTX). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST maintain a project knowledge base — requirements, decisions, glossary, conventions, code map — and assemble task-scoped context for each agent rather than shipping full history."],"tracesTo":["REQUIREMENTS.md — Context & Knowledge (CTX)"]}
- {"kind":"functional","id":"CTX-2","statement":"Artifacts MUST be the interface between phases: an agent's context is built from versioned artifacts, not from prior agents' transcripts.","rationale":"Carried from REQUIREMENTS.md — Context & Knowledge (CTX). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Artifacts MUST be the interface between phases: an agent's context is built from versioned artifacts, not from prior agents' transcripts."],"tracesTo":["REQUIREMENTS.md — Context & Knowledge (CTX)"]}
- {"kind":"functional","id":"CTX-3","statement":"The harness MUST persist decisions with rationale (ADR-style) and surface relevant prior decisions to agents whose tasks may conflict with them.","rationale":"Carried from REQUIREMENTS.md — Context & Knowledge (CTX). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST persist decisions with rationale (ADR-style) and surface relevant prior decisions to agents whose tasks may conflict with them."],"tracesTo":["REQUIREMENTS.md — Context & Knowledge (CTX)"]}
- {"kind":"functional","id":"CTX-4","statement":"The knowledge base MUST be incrementally updatable as the codebase and requirements evolve, and queryable by both agents and the operator.","rationale":"Carried from REQUIREMENTS.md — Context & Knowledge (CTX). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The knowledge base MUST be incrementally updatable as the codebase and requirements evolve, and queryable by both agents and the operator."],"tracesTo":["REQUIREMENTS.md — Context & Knowledge (CTX)"]}
- {"kind":"functional","id":"HIL-1","statement":"Every phase gate MUST require operator approval by default; the operator MAY mark specific gates auto-approved with defined criteria.","rationale":"Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Every phase gate MUST require operator approval by default; the operator MAY mark specific gates auto-approved with defined criteria."],"tracesTo":["REQUIREMENTS.md — Human-in-the-Loop (HIL)"]}
- {"kind":"functional","id":"HIL-2","statement":"Irreversible or outward-facing actions (production deploys, data migrations, publishing, external communications) MUST always require explicit operator approval, regardless of gate settings.","rationale":"Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Irreversible or outward-facing actions (production deploys, data migrations, publishing, external communications) MUST always require explicit operator approval, regardless of gate settings."],"tracesTo":["REQUIREMENTS.md — Human-in-the-Loop (HIL)"]}
- {"kind":"functional","id":"HIL-3","statement":"The operator MUST be able to pause, redirect, roll back, or kill any run or agent at any time.","rationale":"Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The operator MUST be able to pause, redirect, roll back, or kill any run or agent at any time."],"tracesTo":["REQUIREMENTS.md — Human-in-the-Loop (HIL)"]}
- {"kind":"functional","id":"HIL-4","statement":"The harness MUST present decisions to the operator with options, trade-offs, and a recommendation — never a bare \"proceed?\".","rationale":"Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST present decisions to the operator with options, trade-offs, and a recommendation — never a bare \"proceed?\"."],"tracesTo":["REQUIREMENTS.md — Human-in-the-Loop (HIL)"]}
- {"kind":"functional","id":"HIL-5","statement":"All operator interventions MUST be recorded in the audit log.","rationale":"Carried from REQUIREMENTS.md — Human-in-the-Loop (HIL). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["All operator interventions MUST be recorded in the audit log."],"tracesTo":["REQUIREMENTS.md — Human-in-the-Loop (HIL)"]}
- {"kind":"functional","id":"ART-1","statement":"Every artifact MUST be versioned, immutable once gated, attributable (which agent/model/prompt/human produced it), and traceable to the requirements it serves.","rationale":"Carried from REQUIREMENTS.md — Artifacts & State (ART). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Every artifact MUST be versioned, immutable once gated, attributable (which agent/model/prompt/human produced it), and traceable to the requirements it serves."],"tracesTo":["REQUIREMENTS.md — Artifacts & State (ART)"]}
- {"kind":"functional","id":"ART-2","statement":"The harness MUST maintain a bidirectional traceability graph: requirement ↔ design element ↔ plan item ↔ code change ↔ test ↔ release.","rationale":"Carried from REQUIREMENTS.md — Artifacts & State (ART). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST maintain a bidirectional traceability graph: requirement ↔ design element ↔ plan item ↔ code change ↔ test ↔ release."],"tracesTo":["REQUIREMENTS.md — Artifacts & State (ART)"]}
- {"kind":"functional","id":"ART-3","statement":"Artifact schemas MUST be validated on write; breaking schema changes MUST be migrated, not silently ignored.","rationale":"Carried from REQUIREMENTS.md — Artifacts & State (ART). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Artifact schemas MUST be validated on write; breaking schema changes MUST be migrated, not silently ignored."],"tracesTo":["REQUIREMENTS.md — Artifacts & State (ART)"]}
- {"kind":"functional","id":"ART-4","statement":"All code artifacts MUST live in Git; the harness MUST NOT hold code state outside version control.","rationale":"Carried from REQUIREMENTS.md — Artifacts & State (ART). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["All code artifacts MUST live in Git; the harness MUST NOT hold code state outside version control."],"tracesTo":["REQUIREMENTS.md — Artifacts & State (ART)"]}
- {"kind":"functional","id":"OBS-1","statement":"The harness MUST emit a structured event log covering every task, tool call, model call, gate decision, and error, sufficient for full run reconstruction.","rationale":"Carried from REQUIREMENTS.md — Observability & Audit (OBS). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST emit a structured event log covering every task, tool call, model call, gate decision, and error, sufficient for full run reconstruction."],"tracesTo":["REQUIREMENTS.md — Observability & Audit (OBS)"]}
- {"kind":"functional","id":"OBS-2","statement":"The harness MUST track and report cost (tokens, spend), latency, and success/retry rates per phase, per agent role, and per run.","rationale":"Carried from REQUIREMENTS.md — Observability & Audit (OBS). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST track and report cost (tokens, spend), latency, and success/retry rates per phase, per agent role, and per run."],"tracesTo":["REQUIREMENTS.md — Observability & Audit (OBS)"]}
- {"kind":"functional","id":"OBS-3","statement":"The operator MUST have a live view of current runs: what each agent is doing, what is blocked, and what awaits approval.","rationale":"Carried from REQUIREMENTS.md — Observability & Audit (OBS). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The operator MUST have a live view of current runs: what each agent is doing, what is blocked, and what awaits approval."],"tracesTo":["REQUIREMENTS.md — Observability & Audit (OBS)"]}
- {"kind":"functional","id":"OBS-4","statement":"The harness SHOULD compute quality metrics over time (gate rejection rate, rework rate, escaped-defect rate) to measure its own effectiveness.","rationale":"Carried from REQUIREMENTS.md — Observability & Audit (OBS). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"should","acceptanceCriteria":["The harness SHOULD compute quality metrics over time (gate rejection rate, rework rate, escaped-defect rate) to measure its own effectiveness."],"tracesTo":["REQUIREMENTS.md — Observability & Audit (OBS)"]}
- {"kind":"functional","id":"PMG-1","statement":"The harness MUST project its orchestration state onto the project's GitHub repository as native project-management structures: a scrum board (GitHub Projects), issues, milestones, labels, and pull requests — mapped from the plan hierarchy (plan phases/milestones/tasks, PLN-1) and the implement loop (IMP-1/3).","rationale":"Carried from REQUIREMENTS.md — Project Management Integration (PMG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST project its orchestration state onto the project's GitHub repository as native project-management structures: a scrum board (GitHub Projects), issues, milestones, labels, and pull requests — mapped from the plan hierarchy (plan phases/milestones/tasks, PLN-1) and the implement loop (IMP-1/3)."],"tracesTo":["REQUIREMENTS.md — Project Management Integration (PMG)"]}
- {"kind":"functional","id":"PMG-2","statement":"The board MUST be kept up to date at all times: every task, milestone, gate, and PR state change MUST be reflected event-driven (on occurrence), not by periodic batch sync.","rationale":"Carried from REQUIREMENTS.md — Project Management Integration (PMG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The board MUST be kept up to date at all times: every task, milestone, gate, and PR state change MUST be reflected event-driven (on occurrence), not by periodic batch sync."],"tracesTo":["REQUIREMENTS.md — Project Management Integration (PMG)"]}
- {"kind":"functional","id":"PMG-3","statement":"Kernel state is authoritative (single source of truth): the GitHub projection is derived and idempotently reconcilable. Inbound GitHub activity (operator- or collaborator-created issues, comments, card moves) MUST be ingested as signals and triaged into work items (per MNT-1), never applied as direct state mutations.","rationale":"Carried from REQUIREMENTS.md — Project Management Integration (PMG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Kernel state is authoritative (single source of truth): the GitHub projection is derived and idempotently reconcilable. Inbound GitHub activity (operator- or collaborator-created issues, comments, card moves) MUST be ingested as signals and triaged into work items (per MNT-1), never applied as direct state mutations."],"tracesTo":["REQUIREMENTS.md — Project Management Integration (PMG)"]}
- {"kind":"functional","id":"PMG-4","statement":"For a greenfield project, the harness MUST bootstrap the PM structures (board, label taxonomy, milestones) idempotently from the gated Plan artifact — no manual GitHub setup.","rationale":"Carried from REQUIREMENTS.md — Project Management Integration (PMG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["For a greenfield project, the harness MUST bootstrap the PM structures (board, label taxonomy, milestones) idempotently from the gated Plan artifact — no manual GitHub setup."],"tracesTo":["REQUIREMENTS.md — Project Management Integration (PMG)"]}
- {"kind":"functional","id":"SAF-1","statement":"The harness MUST enforce a policy layer that constrains agent actions (allowed tools, file paths, network destinations, shell commands) independent of prompts; prompt-level instructions are not a control.","rationale":"Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST enforce a policy layer that constrains agent actions (allowed tools, file paths, network destinations, shell commands) independent of prompts; prompt-level instructions are not a control."],"tracesTo":["REQUIREMENTS.md — Safety & Policy (SAF)"]}
- {"kind":"functional","id":"SAF-2","statement":"Secrets MUST never enter model context; the harness MUST broker credentials so agents reference them symbolically.","rationale":"Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Secrets MUST never enter model context; the harness MUST broker credentials so agents reference them symbolically."],"tracesTo":["REQUIREMENTS.md — Safety & Policy (SAF)"]}
- {"kind":"functional","id":"SAF-3","statement":"All content ingested from outside the project (web pages, third-party issues, dependency docs) MUST be treated as untrusted data; instructions embedded in it MUST NOT be executed.","rationale":"Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["All content ingested from outside the project (web pages, third-party issues, dependency docs) MUST be treated as untrusted data; instructions embedded in it MUST NOT be executed."],"tracesTo":["REQUIREMENTS.md — Safety & Policy (SAF)"]}
- {"kind":"functional","id":"SAF-4","statement":"Destructive operations MUST be dry-run capable and reversible where the underlying system permits; the harness MUST prefer reversible paths.","rationale":"Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Destructive operations MUST be dry-run capable and reversible where the underlying system permits; the harness MUST prefer reversible paths."],"tracesTo":["REQUIREMENTS.md — Safety & Policy (SAF)"]}
- {"kind":"functional","id":"SAF-5","statement":"Agent-generated code MUST pass automated security scanning (static analysis, dependency audit, secret scanning) before every merge (enforced via IMP-2).","rationale":"Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Agent-generated code MUST pass automated security scanning (static analysis, dependency audit, secret scanning) before every merge (enforced via IMP-2)."],"tracesTo":["REQUIREMENTS.md — Safety & Policy (SAF)"]}
- {"kind":"functional","id":"SAF-6","statement":"The project MUST declare a data-egress policy classifying what may be sent to which model providers; the harness MUST enforce it on context assembly, and personally identifiable or operator-restricted data MUST NOT enter third-party model calls without explicit policy allowance.","rationale":"Carried from REQUIREMENTS.md — Safety & Policy (SAF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The project MUST declare a data-egress policy classifying what may be sent to which model providers; the harness MUST enforce it on context assembly, and personally identifiable or operator-restricted data MUST NOT enter third-party model calls without explicit policy allowance."],"tracesTo":["REQUIREMENTS.md — Safety & Policy (SAF)"]}
- {"kind":"functional","id":"EXT-1","statement":"Tools MUST be pluggable behind a uniform interface (MCP or equivalent), so integrations (VCS, CI, issue tracker, cloud) can be added without core changes.","rationale":"Carried from REQUIREMENTS.md — Extensibility (EXT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Tools MUST be pluggable behind a uniform interface (MCP or equivalent), so integrations (VCS, CI, issue tracker, cloud) can be added without core changes."],"tracesTo":["REQUIREMENTS.md — Extensibility (EXT)"]}
- {"kind":"functional","id":"EXT-2","statement":"The harness MUST be model-agnostic: swapping or mixing model providers MUST NOT require workflow changes.","rationale":"Carried from REQUIREMENTS.md — Extensibility (EXT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST be model-agnostic: swapping or mixing model providers MUST NOT require workflow changes."],"tracesTo":["REQUIREMENTS.md — Extensibility (EXT)"]}
- {"kind":"functional","id":"EXT-3","statement":"Phase definitions, gate criteria, and agent roles MUST be configurable per project without forking the harness.","rationale":"Carried from REQUIREMENTS.md — Extensibility (EXT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Phase definitions, gate criteria, and agent roles MUST be configurable per project without forking the harness."],"tracesTo":["REQUIREMENTS.md — Extensibility (EXT)"]}
- {"kind":"functional","id":"DEF-1","statement":"The harness MUST conduct a structured elicitation dialogue with the operator, producing: problem statement, goals, non-goals, stakeholders, constraints, assumptions, and success metrics.","rationale":"Carried from REQUIREMENTS.md — 5.1 Definition (DEF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST conduct a structured elicitation dialogue with the operator, producing: problem statement, goals, non-goals, stakeholders, constraints, assumptions, and success metrics."],"tracesTo":["REQUIREMENTS.md — 5.1 Definition (DEF)"]}
- {"kind":"functional","id":"DEF-2","statement":"Agents MUST challenge ambiguity and contradiction in stated intent and record resolutions.","rationale":"Carried from REQUIREMENTS.md — 5.1 Definition (DEF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Agents MUST challenge ambiguity and contradiction in stated intent and record resolutions."],"tracesTo":["REQUIREMENTS.md — 5.1 Definition (DEF)"]}
- {"kind":"functional","id":"DEF-3","statement":"The harness SHOULD research prior art and comparable systems and summarize findings with sources.","rationale":"Carried from REQUIREMENTS.md — 5.1 Definition (DEF). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"should","acceptanceCriteria":["The harness SHOULD research prior art and comparable systems and summarize findings with sources."],"tracesTo":["REQUIREMENTS.md — 5.1 Definition (DEF)"]}
- {"kind":"functional","id":"SCP-1","statement":"The harness MUST derive functional and non-functional requirements from the Definition, each testable and uniquely identified; non-functional requirements MUST carry quantified thresholds (these bind TST-3 and the Test gate).","rationale":"Carried from REQUIREMENTS.md — 5.2 Scope (SCP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST derive functional and non-functional requirements from the Definition, each testable and uniquely identified; non-functional requirements MUST carry quantified thresholds (these bind TST-3 and the Test gate)."],"tracesTo":["REQUIREMENTS.md — 5.2 Scope (SCP)"]}
- {"kind":"functional","id":"SCP-2","statement":"The harness MUST produce an explicit out-of-scope list and a MoSCoW (or equivalent) prioritization.","rationale":"Carried from REQUIREMENTS.md — 5.2 Scope (SCP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST produce an explicit out-of-scope list and a MoSCoW (or equivalent) prioritization."],"tracesTo":["REQUIREMENTS.md — 5.2 Scope (SCP)"]}
- {"kind":"functional","id":"SCP-3","statement":"The harness MUST flag requirements that conflict, duplicate, or lack acceptance criteria before the gate.","rationale":"Carried from REQUIREMENTS.md — 5.2 Scope (SCP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST flag requirements that conflict, duplicate, or lack acceptance criteria before the gate."],"tracesTo":["REQUIREMENTS.md — 5.2 Scope (SCP)"]}
- {"kind":"functional","id":"DSG-1","statement":"The harness MUST generate candidate architectures (≥2 for significant decisions), evaluate them against the requirements and constraints, and record the choice as an ADR with trade-offs.","rationale":"Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST generate candidate architectures (≥2 for significant decisions), evaluate them against the requirements and constraints, and record the choice as an ADR with trade-offs."],"tracesTo":["REQUIREMENTS.md — 5.3 Design (DSG)"]}
- {"kind":"functional","id":"DSG-2","statement":"Design output MUST include: component decomposition, interface contracts (APIs, schemas, events), data model, technology selections, and cross-cutting concerns (authn/z, observability, failure modes).","rationale":"Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Design output MUST include: component decomposition, interface contracts (APIs, schemas, events), data model, technology selections, and cross-cutting concerns (authn/z, observability, failure modes)."],"tracesTo":["REQUIREMENTS.md — 5.3 Design (DSG)"]}
- {"kind":"functional","id":"DSG-3","statement":"The harness MUST run adversarial design review (independent critic agents) covering scalability, security, operability, and simplicity before the gate.","rationale":"Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST run adversarial design review (independent critic agents) covering scalability, security, operability, and simplicity before the gate."],"tracesTo":["REQUIREMENTS.md — 5.3 Design (DSG)"]}
- {"kind":"functional","id":"DSG-4","statement":"Every design element MUST trace to at least one requirement; unreferenced elements MUST be flagged as gold-plating.","rationale":"Carried from REQUIREMENTS.md — 5.3 Design (DSG). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Every design element MUST trace to at least one requirement; unreferenced elements MUST be flagged as gold-plating."],"tracesTo":["REQUIREMENTS.md — 5.3 Design (DSG)"]}
- {"kind":"functional","id":"PLN-1","statement":"The plan MUST be a three-level hierarchy: **plan phases** group milestones, **milestones** group tasks, and each **task** is a single unit of work that demonstrably advances the system — sized for single-agent execution, with declared completion criteria and dependency ordering. (Plan phases are groupings within the Plan artifact, distinct from the SDLC phases of §5.)","rationale":"Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The plan MUST be a three-level hierarchy: **plan phases** group milestones, **milestones** group tasks, and each **task** is a single unit of work that demonstrably advances the system — sized for single-agent execution, with declared completion criteria and dependency ordering. (Plan phases are groupings within the Plan artifact, distinct from the SDLC phases of §5.)"],"tracesTo":["REQUIREMENTS.md — 5.4 Plan (PLN)"]}
- {"kind":"functional","id":"PLN-2","statement":"The plan MUST identify the riskiest assumptions and front-load tasks that validate them (walking skeleton / steel thread first).","rationale":"Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The plan MUST identify the riskiest assumptions and front-load tasks that validate them (walking skeleton / steel thread first)."],"tracesTo":["REQUIREMENTS.md — 5.4 Plan (PLN)"]}
- {"kind":"functional","id":"PLN-3","statement":"The plan MUST define per-milestone verification (what must demonstrably work) rather than time estimates alone.","rationale":"Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The plan MUST define per-milestone verification (what must demonstrably work) rather than time estimates alone."],"tracesTo":["REQUIREMENTS.md — 5.4 Plan (PLN)"]}
- {"kind":"functional","id":"PLN-4","statement":"The harness MUST replan incrementally when implementation invalidates plan assumptions, preserving completed work. Small, simple adjustments (reordering or splitting tasks within a milestone) MAY be applied autonomously and logged; complex or large adjustments (adding/removing milestones, restructuring plan phases, or touching design assumptions) MUST re-enter the Plan gate for operator approval.","rationale":"Carried from REQUIREMENTS.md — 5.4 Plan (PLN). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST replan incrementally when implementation invalidates plan assumptions, preserving completed work. Small, simple adjustments (reordering or splitting tasks within a milestone) MAY be applied autonomously and logged; complex or large adjustments (adding/removing milestones, restructuring plan phases, or touching design assumptions) MUST re-enter the Plan gate for operator approval."],"tracesTo":["REQUIREMENTS.md — 5.4 Plan (PLN)"]}
- {"kind":"functional","id":"IMP-1","statement":"Each implementation task MUST run in an isolated workspace (branch/worktree/sandbox) and integrate via reviewed merge; agents MUST NOT commit directly to the main branch.","rationale":"Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Each implementation task MUST run in an isolated workspace (branch/worktree/sandbox) and integrate via reviewed merge; agents MUST NOT commit directly to the main branch."],"tracesTo":["REQUIREMENTS.md — 5.5 Implement (IMP)"]}
- {"kind":"functional","id":"IMP-2","statement":"Every change MUST pass automated checks — build, lint, type check, tests, security scan (SAF-5) — before merge; the harness MUST feed failures back to the implementing agent for repair with a bounded retry budget.","rationale":"Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Every change MUST pass automated checks — build, lint, type check, tests, security scan (SAF-5) — before merge; the harness MUST feed failures back to the implementing agent for repair with a bounded retry budget."],"tracesTo":["REQUIREMENTS.md — 5.5 Implement (IMP)"]}
- {"kind":"functional","id":"IMP-3","statement":"Every change MUST receive agent code review independent of its author agent; operator review is required where policy demands it.","rationale":"Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Every change MUST receive agent code review independent of its author agent; operator review is required where policy demands it."],"tracesTo":["REQUIREMENTS.md — 5.5 Implement (IMP)"]}
- {"kind":"functional","id":"IMP-4","statement":"Implementation MUST conform to project conventions (style, structure, commit format) defined in the knowledge base; deviations MUST be flagged, not silently introduced.","rationale":"Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Implementation MUST conform to project conventions (style, structure, commit format) defined in the knowledge base; deviations MUST be flagged, not silently introduced."],"tracesTo":["REQUIREMENTS.md — 5.5 Implement (IMP)"]}
- {"kind":"functional","id":"IMP-5","statement":"The harness MUST keep the main branch releasable at all times (trunk-based, feature-flagged where incomplete).","rationale":"Carried from REQUIREMENTS.md — 5.5 Implement (IMP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST keep the main branch releasable at all times (trunk-based, feature-flagged where incomplete)."],"tracesTo":["REQUIREMENTS.md — 5.5 Implement (IMP)"]}
- {"kind":"functional","id":"TST-1","statement":"The harness MUST maintain a test pyramid — unit, integration, end-to-end — with tests authored alongside implementation, not deferred to this phase; the Test phase validates system-level behavior.","rationale":"Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST maintain a test pyramid — unit, integration, end-to-end — with tests authored alongside implementation, not deferred to this phase; the Test phase validates system-level behavior."],"tracesTo":["REQUIREMENTS.md — 5.6 Test (TST)"]}
- {"kind":"functional","id":"TST-2","statement":"The harness MUST verify every requirement's acceptance criteria and report requirement-level coverage (which requirements are verified, by which tests).","rationale":"Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST verify every requirement's acceptance criteria and report requirement-level coverage (which requirements are verified, by which tests)."],"tracesTo":["REQUIREMENTS.md — 5.6 Test (TST)"]}
- {"kind":"functional","id":"TST-3","statement":"The harness MUST run non-functional validation for every quantified NFR declared in the Scope artifact (SCP-1) — e.g. performance/load, security (SAST/DAST/dependency) — and SHOULD run resilience validation (fault injection) for availability NFRs.","rationale":"Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST run non-functional validation for every quantified NFR declared in the Scope artifact (SCP-1) — e.g. performance/load, security (SAST/DAST/dependency) — and SHOULD run resilience validation (fault injection) for availability NFRs."],"tracesTo":["REQUIREMENTS.md — 5.6 Test (TST)"]}
- {"kind":"functional","id":"TST-4","statement":"Test agents MUST be adversarial: generate negative cases, boundary cases, and property-based tests beyond the implementer's own tests.","rationale":"Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Test agents MUST be adversarial: generate negative cases, boundary cases, and property-based tests beyond the implementer's own tests."],"tracesTo":["REQUIREMENTS.md — 5.6 Test (TST)"]}
- {"kind":"functional","id":"TST-5","statement":"Defects MUST be filed as artifacts, traced to requirements, and routed back through Implement (or Design, per ORC-1) — never patched out-of-band.","rationale":"Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Defects MUST be filed as artifacts, traced to requirements, and routed back through Implement (or Design, per ORC-1) — never patched out-of-band."],"tracesTo":["REQUIREMENTS.md — 5.6 Test (TST)"]}
- {"kind":"functional","id":"TST-6","statement":"Flaky tests MUST be detected, quarantined, and tracked; a quarantined test MUST NOT silently satisfy TST-2 coverage.","rationale":"Carried from REQUIREMENTS.md — 5.6 Test (TST). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Flaky tests MUST be detected, quarantined, and tracked; a quarantined test MUST NOT silently satisfy TST-2 coverage."],"tracesTo":["REQUIREMENTS.md — 5.6 Test (TST)"]}
- {"kind":"functional","id":"DEP-1","statement":"Deployment MUST be fully automated and repeatable from versioned configuration (IaC); no manual environment mutation.","rationale":"Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Deployment MUST be fully automated and repeatable from versioned configuration (IaC); no manual environment mutation."],"tracesTo":["REQUIREMENTS.md — 5.7 Deploy (DEP)"]}
- {"kind":"functional","id":"DEP-2","statement":"The harness MUST verify releases in a pre-production environment before production, with automated health verification and automated rollback on regression; it SHOULD support progressive delivery (canary/percentage rollout).","rationale":"Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST verify releases in a pre-production environment before production, with automated health verification and automated rollback on regression; it SHOULD support progressive delivery (canary/percentage rollout)."],"tracesTo":["REQUIREMENTS.md — 5.7 Deploy (DEP)"]}
- {"kind":"functional","id":"DEP-3","statement":"Every release MUST have: immutable versioned artifacts, changelog, and a tested rollback path; it SHOULD carry provenance (SBOM / build attestation).","rationale":"Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Every release MUST have: immutable versioned artifacts, changelog, and a tested rollback path; it SHOULD carry provenance (SBOM / build attestation)."],"tracesTo":["REQUIREMENTS.md — 5.7 Deploy (DEP)"]}
- {"kind":"functional","id":"DEP-4","statement":"The harness MUST provision and manage the environments deployment and testing require (test, staging, production) from the same versioned configuration (IaC per DEP-1).","rationale":"Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST provision and manage the environments deployment and testing require (test, staging, production) from the same versioned configuration (IaC per DEP-1)."],"tracesTo":["REQUIREMENTS.md — 5.7 Deploy (DEP)"]}
- {"kind":"functional","id":"DEP-5","statement":"The harness MUST verify post-deploy success against defined SLOs/smoke checks and record the outcome as a release artifact.","rationale":"Carried from REQUIREMENTS.md — 5.7 Deploy (DEP). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST verify post-deploy success against defined SLOs/smoke checks and record the outcome as a release artifact."],"tracesTo":["REQUIREMENTS.md — 5.7 Deploy (DEP)"]}
- {"kind":"functional","id":"MNT-1","statement":"The harness MUST ingest the operational signal sources declared in project configuration (at minimum: alerts, error rates, SLO burn, dependency advisories) and convert them into triaged, prioritized work items.","rationale":"Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST ingest the operational signal sources declared in project configuration (at minimum: alerts, error rates, SLO burn, dependency advisories) and convert them into triaged, prioritized work items."],"tracesTo":["REQUIREMENTS.md — 5.8 Maintain (MNT)"]}
- {"kind":"functional","id":"MNT-2","statement":"For incidents, the harness MUST support detection → mitigation proposal → operator-approved remediation → blameless postmortem artifact, with fixes routed through the normal Implement/Test/Deploy path.","rationale":"Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["For incidents, the harness MUST support detection → mitigation proposal → operator-approved remediation → blameless postmortem artifact, with fixes routed through the normal Implement/Test/Deploy path."],"tracesTo":["REQUIREMENTS.md — 5.8 Maintain (MNT)"]}
- {"kind":"functional","id":"MNT-3","statement":"The harness MUST monitor dependency freshness and CVEs and raise upgrade tasks automatically; security patches MUST be prioritized by severity.","rationale":"Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["The harness MUST monitor dependency freshness and CVEs and raise upgrade tasks automatically; security patches MUST be prioritized by severity."],"tracesTo":["REQUIREMENTS.md — 5.8 Maintain (MNT)"]}
- {"kind":"functional","id":"MNT-4","statement":"The harness SHOULD periodically audit for drift: code vs. documented design, tests vs. requirements, infrastructure vs. IaC — and raise reconciliation tasks.","rationale":"Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"should","acceptanceCriteria":["The harness SHOULD periodically audit for drift: code vs. documented design, tests vs. requirements, infrastructure vs. IaC — and raise reconciliation tasks."],"tracesTo":["REQUIREMENTS.md — 5.8 Maintain (MNT)"]}
- {"kind":"functional","id":"MNT-5","statement":"Maintenance changes MUST flow through the same gates as new work; there is no side door.","rationale":"Carried from REQUIREMENTS.md — 5.8 Maintain (MNT). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Maintenance changes MUST flow through the same gates as new work; there is no side door."],"tracesTo":["REQUIREMENTS.md — 5.8 Maintain (MNT)"]}
- {"kind":"functional","id":"NFR-1","statement":"No orchestration-state loss on crash (ORC-5); a failed model/tool call MUST retry with backoff and escalate on exhaustion, never silently drop a task.","rationale":"Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR). REQUIREMENTS.md states this quality but no measurable metric, value and unit for it; SCP-1's schema cannot represent a non-functional requirement without a quantified threshold, so this is carried as functional rather than with an invented number (a quantification gap for a later Scope revision to close, not this migration). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["No orchestration-state loss on crash (ORC-5); a failed model/tool call MUST retry with backoff and escalate on exhaustion, never silently drop a task."],"tracesTo":["REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)"]}
- {"kind":"functional","id":"NFR-2","statement":"Per-run and per-phase budgets enforceable (AGT-4), with spend visible in near-real-time (OBS-2).","rationale":"Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR). REQUIREMENTS.md states this quality but no measurable metric, value and unit for it; SCP-1's schema cannot represent a non-functional requirement without a quantified threshold, so this is carried as functional rather than with an invented number (a quantification gap for a later Scope revision to close, not this migration). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Per-run and per-phase budgets enforceable (AGT-4), with spend visible in near-real-time (OBS-2)."],"tracesTo":["REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)"]}
- {"kind":"non-functional","id":"NFR-3","statement":"Harness overhead (scheduling, context assembly, validation) MUST stay under 10% of total run wall-clock time; concurrency limits MUST be configuration, not architectural ceilings.","rationale":"Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR). Its threshold (10%) is the number REQUIREMENTS.md itself states; SCP-1 binds it to TST-3. REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Harness overhead (scheduling, context assembly, validation) MUST stay under 10% of total run wall-clock time; concurrency limits MUST be configuration, not architectural ceilings."],"tracesTo":["REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)"],"threshold":{"metric":"harness overhead (scheduling, context assembly, validation) as a share of total run wall-clock time","value":10,"unit":"%","measuredBy":"sum of scheduling, context-assembly and validation time divided by total run wall-clock time, over one run"}}
- {"kind":"functional","id":"NFR-4","statement":"Least privilege throughout (AGT-2, SAF-1/2); full audit trail (OBS-1, HIL-5).","rationale":"Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR). REQUIREMENTS.md states this quality but no measurable metric, value and unit for it; SCP-1's schema cannot represent a non-functional requirement without a quantified threshold, so this is carried as functional rather than with an invented number (a quantification gap for a later Scope revision to close, not this migration). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Least privilege throughout (AGT-2, SAF-1/2); full audit trail (OBS-1, HIL-5)."],"tracesTo":["REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)"]}
- {"kind":"functional","id":"NFR-5","statement":"Runs on a single developer machine and on shared/cloud infrastructure from the same configuration.","rationale":"Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR). REQUIREMENTS.md states this quality but no measurable metric, value and unit for it; SCP-1's schema cannot represent a non-functional requirement without a quantified threshold, so this is carried as functional rather than with an invented number (a quantification gap for a later Scope revision to close, not this migration). REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"must","acceptanceCriteria":["Runs on a single developer machine and on shared/cloud infrastructure from the same configuration."],"tracesTo":["REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)"]}
- {"kind":"non-functional","id":"NFR-6","statement":"A competent engineer SHOULD reach a first gated Definition artifact within one hour of install, without reading harness source.","rationale":"Carried from REQUIREMENTS.md — 6. Non-Functional Requirements (NFR). Its threshold (1hour) is the number REQUIREMENTS.md itself states; SCP-1 binds it to TST-3. REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.","priority":"should","acceptanceCriteria":["A competent engineer SHOULD reach a first gated Definition artifact within one hour of install, without reading harness source."],"tracesTo":["REQUIREMENTS.md — 6. Non-Functional Requirements (NFR)"],"threshold":{"metric":"wall-clock time from install to a first gated Definition artifact","value":1,"unit":"hour","measuredBy":"wall-clock time from a fresh install to the Definition gate being approved, by a competent engineer who has not read harness source"}}

## outOfScope

- {"item":"Training or fine-tuning models","why":"REQUIREMENTS.md §3 excludes it from v1 scope; the harness consumes hosted model APIs."}
- {"item":"Hosting model inference","why":"REQUIREMENTS.md §3 excludes it from v1 scope; inference is via provider APIs (EXT-2)."}
- {"item":"Replacing the operator's judgment at gates","why":"REQUIREMENTS.md §3 excludes it; HIL-1..HIL-5 keep gate and irreversible decisions with the operator."}
- {"item":"Project management for non-software work","why":"REQUIREMENTS.md §3 excludes it; PMG-1..PMG-4 project only the SDLC plan/implement loop onto GitHub."}
- {"item":"Multi-tenant SaaS operation","why":"REQUIREMENTS.md §3 excludes it; §8 decision 2 fixes v1 to a single operator."}
