---
id: mpgm-design
version: 1
schema: design
schemaVersion: 1
tracesTo:
  - DSG-1
  - DSG-2
  - DSG-4
producedBy:
  task: T4.2.16
  role: implementer
  model: claude-sonnet-5
  runId: bootstrap
supersedes: null
egress: internal
data:
  chosen: most-operable
  summary: "mpgm's own design (DESIGN.md v0.35), derived from it the way T4.3.1's
    Scope was derived from REQUIREMENTS.md — so that ADR-1 through ADR-7, cited
    by three foundation documents and by this repository's own commit trailers
    and Plan tasks, resolve against this artifact rather than against prose. Ids
    are carried across unchanged: renumbering an ADR here would dangle every
    citation it was meant to resolve. Two gaps DESIGN.md itself carries are
    stated rather than papered over. First, `adrSchema.alternatives` demands at
    least one considered-and-rejected option per ADR (CONV-5), but DESIGN.md
    documents named alternatives only for ADR-1 (Python, Rust); ADR-2 through
    ADR-7 state a decision and a rationale with no alternative named, so each
    carries a single alternatives entry stating that fact, not an invented
    option — the same move Scope's own acceptanceCriteria makes for a
    requirement REQUIREMENTS.md never gave one. Second, DSG-2 requires a design
    to address authn/z as one cross-cutting concern; DESIGN.md addresses authz
    throughout §7 but nowhere separates out authentication, because v1 is
    single-operator and local-first (§1) and checks no identity beyond OS access
    to the machine running the CLI — the crossCutting authn entry below says
    this directly, so the concern is represented by its stated absence rather
    than a mechanism invented to occupy the slot. Third, `chosen` names one of
    DSG-1's three candidate-selection stances
    (simplest/most-operable/most-extensible), a category DESIGN.md predates: it
    was hand-authored before the fan-out/panel mechanism existed, the same
    bootstrap gap Scope's own summary already reports for REQUIREMENTS.md, so
    `most-operable` here is a retrospective reading of §1's stated priority
    order (auditability and operator control rank above local-first simplicity
    and substrate leverage), not a panel's recorded vote — no DSG-3
    adversarial-review artifact exists for it either, for the same reason.
    Fourth, `telemetry.signals` and `deps.advisories` are named as MCP
    capabilities in DESIGN §4.7/§4.9 but neither has a `contracts/*.md` file
    yet, so neither appears among `interfaces` below — declared once a contract
    exists, not invented here to fill the gap."
  components:
    - id: C-1
      name: Orchestration Kernel
      responsibility: "A deterministic state machine with no LLM calls: the phase
        graph (entry/exit gates, re-entry), the plan graph loaded from the gated
        Plan artifact, multi-agent pattern primitives (fan-out/collect,
        pipeline, critic-of, panel), per-run/phase/task budgets, the gate
        manager, and the replan policy (§4.1)."
      tracesTo:
        - ORC-1
        - ORC-2
        - ORC-3
        - ORC-4
        - ORC-5
        - ORC-6
        - HIL-1
        - HIL-2
        - HIL-3
        - HIL-4
        - HIL-5
        - AGT-4
    - id: C-2
      name: Agent Runtime
      responsibility: Role definitions and least-privilege declaration, the
        untrusted-content profile, session execution against the SDK query loop
        with schema-enforced structured output, model routing, interactive mode,
        and the improvement loop that mines the event log for
        role/knowledge-base proposals (§4.2).
      tracesTo:
        - AGT-1
        - AGT-2
        - AGT-3
        - AGT-4
        - AGT-5
        - AGT-6
        - AGT-7
    - id: C-3
      name: Context & Knowledge
      responsibility: The in-repo knowledge base (conventions, glossary, code map,
        decision log), convention numbering and enforcement, and the context
        assembler that builds each task prompt from the task spec, upstream
        artifacts, the KB digest and relevant prior decisions (§4.3).
      tracesTo:
        - CTX-1
        - CTX-2
        - CTX-3
        - CTX-4
    - id: C-4
      name: Operator Console
      responsibility: The `mpgm` CLI covering every HIL-3 verb — run, status, approve,
        pause/resume/kill, redirect, rollback, chat, reopen, confirm, implement,
        trace, replay, attest — and (deferred) a read-only local web dashboard
        rendering live run state, approvals, spend and the traceability graph
        (§4.4).
      tracesTo:
        - HIL-1
        - HIL-2
        - HIL-3
        - HIL-4
        - HIL-5
        - OBS-3
    - id: C-5
      name: Observability
      responsibility: "The event log as the telemetry source: a projection layer
        deriving per-phase/per-role cost, latency, retry and success metrics,
        and longitudinal quality metrics (gate rejection rate, rework rate,
        escaped defects) feeding the improvement loop (§4.5)."
      tracesTo:
        - OBS-1
        - OBS-2
        - OBS-3
        - OBS-4
    - id: C-6
      name: Eval Harness
      responsibility: A benchmark suite per role (golden artifacts plus graders —
        schema checks, rubric-grading by a judge agent, deterministic
        assertions), run by `mpgm eval` and recorded as artifacts; the gate
        manager blocks adoption of a role version without a green eval (§4.6).
      tracesTo:
        - AGT-6
    - id: C-7
      name: Delivery Integrations
      responsibility: Each delivery integration — CI, the implement loop, role freeze,
        the repair loop, reviewed merge, the test runner, environments and
        release — as an MCP capability contract the kernel supervises rather
        than reimplements (§4.7).
      tracesTo:
        - IMP-1
        - IMP-2
        - IMP-3
        - IMP-4
        - IMP-5
        - TST-1
        - TST-2
        - TST-3
        - TST-4
        - TST-5
        - TST-6
        - DEP-1
        - DEP-2
        - DEP-3
        - DEP-4
        - DEP-5
    - id: C-8
      name: Project-Management Sync
      responsibility: "The PM projector: a pure function of the gated Plan artifact
        and folded kernel state onto a GitHub board, milestones, labels and one
        issue per plan task, kept current as events commit and repaired by a
        non-destructive reconcile pass (§4.8)."
      tracesTo:
        - PMG-1
        - PMG-2
        - PMG-3
        - PMG-4
    - id: C-9
      name: Maintain Integration
      responsibility: Signal ingestion from alerting/telemetry and dependency
        advisories, an incident state machine, dependency-freshness upgrade
        tasks, and periodic drift audits diffing code, tests and infrastructure
        against their declared sources (§4.9).
      tracesTo:
        - MNT-1
        - MNT-2
        - MNT-3
        - MNT-4
        - MNT-5
  interfaces:
    - id: I-1
      name: ci.checks
      kind: api
      contract: Report the merge checks a CI provider has run for a ref; the decision
        of whether that is enough is the kernel's own (`mergeVerdict`), a pure
        function of the reported runs (`contracts/ci.checks.md`).
      tracesTo:
        - IMP-2
        - SAF-5
    - id: I-2
      name: env.provision
      kind: api
      contract: Bring one of this project's declared environments up or down from the
        IaC committed in the repository, and report whether it is up
        (`contracts/env.provision.md`).
      tracesTo:
        - DEP-1
        - DEP-4
    - id: I-3
      name: pm.github
      kind: api
      contract: Project the plan and the run onto GitHub — a board, milestones,
        labels, and one issue per plan task — and keep it current
        (`contracts/pm.github.md`).
      tracesTo:
        - PMG-1
        - PMG-2
        - PMG-3
        - PMG-4
    - id: I-4
      name: release.deliver
      kind: api
      contract: Assemble an immutable, versioned release artifact and hand it, or a
        prior one, to a declared environment via `env.provision`, delegating
        rollout mechanics rather than reimplementing them
        (`contracts/release.deliver.md`).
      tracesTo:
        - DEP-2
        - DEP-3
    - id: I-5
      name: test.nfr
      kind: api
      contract: Measure one quantified non-functional requirement against the
        threshold Scope declared for it (SCP-1), and report whether it held
        (`contracts/test.nfr.md`).
      tracesTo:
        - SCP-1
        - TST-1
        - TST-2
        - TST-3
        - TST-4
        - TST-5
        - TST-6
  dataModel:
    - id: D-1
      entity: Event log (append-only)
      fields:
        - RunStarted
        - PhaseEntered
        - TaskDispatched
        - SessionUsage
        - ToolCallLogged
        - TaskCompleted
        - ValidationFailed
        - VoteTallied
        - ChecksReported
        - GatePresented
        - GateApproved
        - GateRejected
        - PhaseReopened
        - GateInvalidated
        - BudgetExceeded
        - OperatorIntervened
      notes: "DESIGN §5 lists this set with a trailing ellipsis, so it is not
        exhaustive: every row is `{seq, ts, runId, type, payload,
        schemaVersion}`. `DeployConfirmationSpent` (§9 decision 14, T4.1.4c) is
        one addition made since §5 was written and is not repeated here, since
        keeping this list current with every event the catalog gains is
        `src/event/catalog.ts`'s job, not this artifact's."
    - id: D-2
      entity: Derived (rebuildable) tables
      fields:
        - runs
        - tasks
        - gates
        - budgets
        - trace_links
        - metrics
      notes: Rebuildable from the event log (§5); artifacts and roles live in git only
        (ADR-3) — these tables store references (path + commit hash), never
        artifact content. `KernelState.spentConfirmations` (§9 decision 14,
        T4.1.4c) is a later addition to this set, for the same reason D-1 does
        not chase every event the catalog gains.
  technologies:
    - id: T-1
      choice: TypeScript on Node.js
      why: Deepest available integration with the Claude Agent SDK, the Claude Code
        hook/plugin surface and MCP (ADR-1); zod gives runtime schema validation
        matching AGT-3.
      tracesTo:
        - AGT-3
        - NFR-3
    - id: T-2
      choice: SQLite (WAL mode) as the kernel event log store
      why: Crash-safe resume and event-sourced replay by construction, with no service
        dependency to run locally (ADR-2).
      tracesTo:
        - ORC-3
        - ORC-5
        - NFR-5
    - id: T-3
      choice: Git as the artifact and code store
      why: ART-4 already mandates git for code; extending it to all artifacts gives
        versioning, attribution and diff review for free (ADR-3).
      tracesTo:
        - ART-4
        - ART-1
    - id: T-4
      choice: MCP for every external integration
      why: A uniform policy interception point and provider swap without a workflow
        change (ADR-7).
      tracesTo:
        - EXT-1
        - EXT-2
        - EXT-3
  crossCutting:
    - id: X-1
      concern: authn
      approach: 'DESIGN.md declares no authentication mechanism of its own, and this
        is carried forward as that stated fact rather than a mechanism invented
        to fill the slot: mpgm runs single-operator and local-first (§1 goal 3,
        NFR-5), so identity today is whoever has OS-level access to the machine
        running the CLI, not a login or credential the harness itself checks. §8
        names multi-operator collaboration as a v2 revisit ("gate manager
        already isolates approval identity in events; add role-based approvers
        without kernel changes") without designing an authentication mechanism
        for it. DSG-2 asks that a design address authn/z; this entry is that
        address, and its content is the gap, not a claim that one exists.'
      tracesTo:
        - NFR-5
    - id: X-2
      concern: authz
      approach: "Least-privilege role toolsets (AGT-2) enforced outside the model via
        the SDK's canUseTool/hook interface: per-role allowlists of tools, file
        globs, network hosts and shell patterns, with every dimension defaulting
        to empty so a role reaches only what it names (ADR-6, §7)."
      tracesTo:
        - AGT-2
        - SAF-1
    - id: X-3
      concern: observability
      approach: The event log is the telemetry source; a projection layer derives
        per-phase/per-role cost, latency, retry and success metrics and
        longitudinal quality metrics (gate rejection rate, rework rate, escaped
        defects), with every tool call and approval an event (§4.5, §7).
      tracesTo:
        - OBS-1
        - OBS-2
        - OBS-3
        - OBS-4
    - id: X-4
      concern: failure-modes
      approach: Crash-safe resume via event-log fold plus intent-before-effect for
        side-effectful steps; retry-with-backoff on model/tool failure and
        escalation on exhaustion rather than a silently dropped task; worktree
        preservation and resume-with-context on session death (§6).
      tracesTo:
        - NFR-1
    - id: X-5
      concern: security
      approach: Secret brokering at the tool boundary with symbolic references and
        exact-value log redaction (SAF-2); untrusted external content handled by
        structurally constrained, read-only sessions (SAF-3); destructive tools
        requiring dry-run then confirmation, keyed by a fingerprint over every
        parameter but the dry-run flag (SAF-4); merge-blocking security scanning
        (SAF-5); egress classes at context assembly with an
        unlabelled-is-restricted default (SAF-6) (§7).
      tracesTo:
        - SAF-2
        - SAF-3
        - SAF-4
        - SAF-5
        - SAF-6
  adrs:
    - id: ADR-1
      title: TypeScript on Node as implementation language
      context: The kernel and CLI need a language whose ecosystem gives deep
        integration with the Claude Agent SDK, the Claude Code hook/plugin
        surface, and the MCP ecosystem, since goal 4 (substrate leverage, §1)
        rules out reimplementing the agent loop, tool handling, permissions or
        context management.
      decision: The kernel and CLI are TypeScript on Node. zod gives runtime schema
        validation matching AGT-3.
      alternatives:
        - option: Python
          whyNot: Stronger eval/data tooling, but evals (AGT-6) are driven through the
            SDK, not notebooks.
        - option: Rust
          whyNot: "Considered for the kernel's correctness profile — an append-only log
            with a pure fold suits Rust's type system well — but there is no
            Rust Agent SDK, so the deepest integration point (session lifecycle,
            canUseTool hooks, usage events) would require either reimplementing
            the agent loop, contradicting goal 4, or a Node sidecar putting an
            IPC seam through the policy boundary and doubling toolchains. Rust's
            headline gains buy little: the harness is I/O-bound around model
            calls, and the correctness properties that matter come from pure
            reducers plus property tests, achievable in TS. Self-hosting
            economics also favour TS: agent repair loops against CI iterate
            faster without Rust compile times."
      consequences:
        - Commits the kernel and CLI to the Node/TypeScript toolchain and its
          ecosystem for the lifetime of v1.
        - Rust remains the named candidate for a standalone kernel rewrite if
          eval sophistication outgrows the SDK harness or the kernel earns a
          rewrite (multi-operator, remote execution); the event log schema, not
          the language, is the durable contract that would carry across such a
          rewrite.
      tracesTo:
        - AGT-3
        - NFR-3
    - id: ADR-2
      title: Event-sourced kernel over SQLite
      context: The kernel needs crash-safe resume and replay without a live service
        dependency, on a design that optimises for local-first simplicity (§1
        goal 3).
      decision: All kernel state is an append-only event log in a local SQLite
        database (`.mpgm/state.db`, WAL mode) — the single authoritative log;
        in-memory state is a pure fold over events, and any file exports are
        derived backups, never a second write path. Large payloads are offloaded
        to content-addressed blobs under `.mpgm/blobs/` and referenced by hash,
        after SAF-6 redaction at write time. Snapshots every N events keep
        resume and replay fast.
      alternatives:
        - option: not documented
          whyNot: DESIGN.md's write-up for this decision states the decision, its "Why:"
            and (where present) its "Trade-off:", and names no alternative
            considered and rejected — unlike ADR-1, which names Python and Rust.
            Carried as the true fact of that gap rather than an invented option.
      consequences:
        - Crash-safe resume (ORC-5) and event-sourced replay (ORC-3) hold by
          construction rather than by a recovery procedure bolted on afterwards.
        - SQLite needs no service, satisfying NFR-5 (single-machine, no
          mandatory services).
        - Schema migrations for events need discipline — versioned event types
          and upcasters (CONV-7).
      tracesTo:
        - ORC-5
        - ORC-3
        - NFR-5
    - id: ADR-3
      title: Git as the artifact store
      context: ART-4 mandates git for code; every phase transition needs a versioned,
        reviewable interface, and a second store for non-code artifacts would be
        a second thing to keep consistent with the first.
      decision: Artifacts are markdown files with YAML frontmatter (id, version,
        schema, traces-to, produced-by) in `artifacts/`, committed to the
        project repo. Gate decisions live in the event log, which is
        authoritative (ORC-6 invalidation is an event, not a git operation); an
        annotated tag (`gate/<phase>/<version>`) is written as a derived,
        informational marker. Immutability (ART-1) is enforced by the kernel
        refusing edits to gated versions — changes create a successor version.
      alternatives:
        - option: not documented
          whyNot: DESIGN.md's write-up for this decision states the decision, its "Why:"
            and (where present) its "Trade-off:", and names no alternative
            considered and rejected — unlike ADR-1, which names Python and Rust.
            Carried as the true fact of that gap rather than an invented option.
      consequences:
        - Extending ART-4 to all artifacts gives versioning, attribution and
          diff review for free, and keeps the knowledge base greppable by
          agents.
        - No relational queries over artifacts — hence the derived index (ADR-4).
      tracesTo:
        - ART-4
        - ART-1
        - ORC-6
    - id: ADR-4
      title: Derived traceability index, source-of-truth in frontmatter
      context: Requirement, design, task, change, test and release links (ART-2) need
        to answer graph queries — gate invalidation (ORC-6) and coverage (TST-2)
        — that flat markdown files in git cannot answer on their own (ADR-3).
      decision: "Trace links are declared in artifact frontmatter and commit trailers;
        the kernel maintains a derived, rebuildable index in SQLite for queries.
        Every element a downstream artifact may cite carries an id, and the
        index reads an object with a string id as a declaration, so
        requirements, design components, interfaces, entities, technologies,
        cross-cutting concerns, ADRs and plan tasks all name themselves the same
        way. Prose is not a substitute: the index tells an id from a sentence by
        shape, so an element identified only by its name gives a downstream
        artifact no canonical form to cite and gives the index nothing it can
        report as dangling."
      alternatives:
        - option: not documented
          whyNot: DESIGN.md's write-up for this decision states the decision, its "Why:"
            and (where present) its "Trade-off:", and names no alternative
            considered and rejected — unlike ADR-1, which names Python and Rust.
            Carried as the true fact of that gap rather than an invented option.
      consequences:
        - No second source of truth; the index can always be rebuilt from git.
        - Index rebuild cost on large repos — mitigated by incremental updates
          keyed on commit hashes.
        - "An element identified only by its prose name (not an id) gives the
          index nothing to declare and nothing it can report as dangling —
          demonstrated when two Plan runs against one design cited `POST /loans`
          and `interface: POST /loans` for the same interface, neither of which
          the index could see."
      tracesTo:
        - ART-2
        - ORC-6
        - TST-2
    - id: ADR-5
      title: One SDK session per task, one git worktree per implementation task
      context: A task needs bounded, reproducible context (CTX-1/2) and parallelism
        (ORC-3) without one task session stepping on another.
      decision: Every task runs in a fresh Claude Agent SDK session with context
        assembled from artifacts; implementation tasks additionally get an
        isolated worktree and merge via reviewed PR (IMP-1/3).
      alternatives:
        - option: not documented
          whyNot: DESIGN.md's write-up for this decision states the decision, its "Why:"
            and (where present) its "Trade-off:", and names no alternative
            considered and rejected — unlike ADR-1, which names Python and Rust.
            Carried as the true fact of that gap rather than an invented option.
      consequences:
        - Bounded, reproducible context beats long-lived sessions.
        - Worktrees give parallelism without conflict.
        - Context re-assembly cost per task — mitigated by prompt caching and a
          compact knowledge-base digest.
      tracesTo:
        - CTX-1
        - CTX-2
        - IMP-1
        - IMP-3
        - ORC-3
    - id: ADR-6
      title: Policy enforcement via SDK permission hooks + OS sandbox
      context: Least-privilege enforcement (SAF-1) and secret brokering (SAF-2) need a
        control point outside the model, since prompt-level instruction is not a
        control.
      decision: "The policy engine implements the SDK's canUseTool / hook interface:
        per-role allowlists of tools, file globs, network hosts and shell
        patterns, declared in role files and evaluated outside the model.
        Secrets never enter context: agents reference credentials symbolically
        as `${secret:<name>}`, and the kernel's broker substitutes real values
        only at the tool boundary, inside the PreToolUse hook. Each secret
        declares the tools that may receive it; a reference in any other tool is
        denied. Data-egress classes (SAF-6) are enforced at context assembly,
        with unlabelled content treated as restricted by default."
      alternatives:
        - option: not documented
          whyNot: DESIGN.md's write-up for this decision states the decision, its "Why:"
            and (where present) its "Trade-off:", and names no alternative
            considered and rejected — unlike ADR-1, which names Python and Rust.
            Carried as the true fact of that gap rather than an invented option.
      consequences:
        - Hook-level enforcement trusts the SDK process boundary;
          defense-in-depth via sandboxed execution (Claude Code sandbox /
          containers) for shell tools.
        - What a policy withholds is always reported to the operator and stated
          in the prompt.
      tracesTo:
        - SAF-1
        - SAF-2
        - SAF-6
    - id: ADR-7
      title: MCP for all external integrations
      context: Git hosting, CI, scanners, IaC and telemetry each have their own
        provider landscape, and EXT-2/3 ask for provider swap without a workflow
        change.
      decision: Git hosting, CI, scanners, IaC, and telemetry are reached only through
        MCP servers; the kernel and roles reference tools by capability name,
        resolved per project.
      alternatives:
        - option: not documented
          whyNot: DESIGN.md's write-up for this decision states the decision, its "Why:"
            and (where present) its "Trade-off:", and names no alternative
            considered and rejected — unlike ADR-1, which names Python and Rust.
            Carried as the true fact of that gap rather than an invented option.
      consequences:
        - A uniform policy interception point across every external integration.
        - Provider swap without a workflow change.
      tracesTo:
        - EXT-1
        - EXT-2
        - EXT-3
---

# mpgm-design

## chosen

most-operable

## summary

mpgm's own design (DESIGN.md v0.35), derived from it the way T4.3.1's Scope was derived from REQUIREMENTS.md — so that ADR-1 through ADR-7, cited by three foundation documents and by this repository's own commit trailers and Plan tasks, resolve against this artifact rather than against prose. Ids are carried across unchanged: renumbering an ADR here would dangle every citation it was meant to resolve. Two gaps DESIGN.md itself carries are stated rather than papered over. First, `adrSchema.alternatives` demands at least one considered-and-rejected option per ADR (CONV-5), but DESIGN.md documents named alternatives only for ADR-1 (Python, Rust); ADR-2 through ADR-7 state a decision and a rationale with no alternative named, so each carries a single alternatives entry stating that fact, not an invented option — the same move Scope's own acceptanceCriteria makes for a requirement REQUIREMENTS.md never gave one. Second, DSG-2 requires a design to address authn/z as one cross-cutting concern; DESIGN.md addresses authz throughout §7 but nowhere separates out authentication, because v1 is single-operator and local-first (§1) and checks no identity beyond OS access to the machine running the CLI — the crossCutting authn entry below says this directly, so the concern is represented by its stated absence rather than a mechanism invented to occupy the slot. Third, `chosen` names one of DSG-1's three candidate-selection stances (simplest/most-operable/most-extensible), a category DESIGN.md predates: it was hand-authored before the fan-out/panel mechanism existed, the same bootstrap gap Scope's own summary already reports for REQUIREMENTS.md, so `most-operable` here is a retrospective reading of §1's stated priority order (auditability and operator control rank above local-first simplicity and substrate leverage), not a panel's recorded vote — no DSG-3 adversarial-review artifact exists for it either, for the same reason. Fourth, `telemetry.signals` and `deps.advisories` are named as MCP capabilities in DESIGN §4.7/§4.9 but neither has a `contracts/*.md` file yet, so neither appears among `interfaces` below — declared once a contract exists, not invented here to fill the gap.

## components

- {"id":"C-1","name":"Orchestration Kernel","responsibility":"A deterministic state machine with no LLM calls: the phase graph (entry/exit gates, re-entry), the plan graph loaded from the gated Plan artifact, multi-agent pattern primitives (fan-out/collect, pipeline, critic-of, panel), per-run/phase/task budgets, the gate manager, and the replan policy (§4.1).","tracesTo":["ORC-1","ORC-2","ORC-3","ORC-4","ORC-5","ORC-6","HIL-1","HIL-2","HIL-3","HIL-4","HIL-5","AGT-4"]}
- {"id":"C-2","name":"Agent Runtime","responsibility":"Role definitions and least-privilege declaration, the untrusted-content profile, session execution against the SDK query loop with schema-enforced structured output, model routing, interactive mode, and the improvement loop that mines the event log for role/knowledge-base proposals (§4.2).","tracesTo":["AGT-1","AGT-2","AGT-3","AGT-4","AGT-5","AGT-6","AGT-7"]}
- {"id":"C-3","name":"Context & Knowledge","responsibility":"The in-repo knowledge base (conventions, glossary, code map, decision log), convention numbering and enforcement, and the context assembler that builds each task prompt from the task spec, upstream artifacts, the KB digest and relevant prior decisions (§4.3).","tracesTo":["CTX-1","CTX-2","CTX-3","CTX-4"]}
- {"id":"C-4","name":"Operator Console","responsibility":"The `mpgm` CLI covering every HIL-3 verb — run, status, approve, pause/resume/kill, redirect, rollback, chat, reopen, confirm, implement, trace, replay, attest — and (deferred) a read-only local web dashboard rendering live run state, approvals, spend and the traceability graph (§4.4).","tracesTo":["HIL-1","HIL-2","HIL-3","HIL-4","HIL-5","OBS-3"]}
- {"id":"C-5","name":"Observability","responsibility":"The event log as the telemetry source: a projection layer deriving per-phase/per-role cost, latency, retry and success metrics, and longitudinal quality metrics (gate rejection rate, rework rate, escaped defects) feeding the improvement loop (§4.5).","tracesTo":["OBS-1","OBS-2","OBS-3","OBS-4"]}
- {"id":"C-6","name":"Eval Harness","responsibility":"A benchmark suite per role (golden artifacts plus graders — schema checks, rubric-grading by a judge agent, deterministic assertions), run by `mpgm eval` and recorded as artifacts; the gate manager blocks adoption of a role version without a green eval (§4.6).","tracesTo":["AGT-6"]}
- {"id":"C-7","name":"Delivery Integrations","responsibility":"Each delivery integration — CI, the implement loop, role freeze, the repair loop, reviewed merge, the test runner, environments and release — as an MCP capability contract the kernel supervises rather than reimplements (§4.7).","tracesTo":["IMP-1","IMP-2","IMP-3","IMP-4","IMP-5","TST-1","TST-2","TST-3","TST-4","TST-5","TST-6","DEP-1","DEP-2","DEP-3","DEP-4","DEP-5"]}
- {"id":"C-8","name":"Project-Management Sync","responsibility":"The PM projector: a pure function of the gated Plan artifact and folded kernel state onto a GitHub board, milestones, labels and one issue per plan task, kept current as events commit and repaired by a non-destructive reconcile pass (§4.8).","tracesTo":["PMG-1","PMG-2","PMG-3","PMG-4"]}
- {"id":"C-9","name":"Maintain Integration","responsibility":"Signal ingestion from alerting/telemetry and dependency advisories, an incident state machine, dependency-freshness upgrade tasks, and periodic drift audits diffing code, tests and infrastructure against their declared sources (§4.9).","tracesTo":["MNT-1","MNT-2","MNT-3","MNT-4","MNT-5"]}

## interfaces

- {"id":"I-1","name":"ci.checks","kind":"api","contract":"Report the merge checks a CI provider has run for a ref; the decision of whether that is enough is the kernel's own (`mergeVerdict`), a pure function of the reported runs (`contracts/ci.checks.md`).","tracesTo":["IMP-2","SAF-5"]}
- {"id":"I-2","name":"env.provision","kind":"api","contract":"Bring one of this project's declared environments up or down from the IaC committed in the repository, and report whether it is up (`contracts/env.provision.md`).","tracesTo":["DEP-1","DEP-4"]}
- {"id":"I-3","name":"pm.github","kind":"api","contract":"Project the plan and the run onto GitHub — a board, milestones, labels, and one issue per plan task — and keep it current (`contracts/pm.github.md`).","tracesTo":["PMG-1","PMG-2","PMG-3","PMG-4"]}
- {"id":"I-4","name":"release.deliver","kind":"api","contract":"Assemble an immutable, versioned release artifact and hand it, or a prior one, to a declared environment via `env.provision`, delegating rollout mechanics rather than reimplementing them (`contracts/release.deliver.md`).","tracesTo":["DEP-2","DEP-3"]}
- {"id":"I-5","name":"test.nfr","kind":"api","contract":"Measure one quantified non-functional requirement against the threshold Scope declared for it (SCP-1), and report whether it held (`contracts/test.nfr.md`).","tracesTo":["SCP-1","TST-1","TST-2","TST-3","TST-4","TST-5","TST-6"]}

## dataModel

- {"id":"D-1","entity":"Event log (append-only)","fields":["RunStarted","PhaseEntered","TaskDispatched","SessionUsage","ToolCallLogged","TaskCompleted","ValidationFailed","VoteTallied","ChecksReported","GatePresented","GateApproved","GateRejected","PhaseReopened","GateInvalidated","BudgetExceeded","OperatorIntervened"],"notes":"DESIGN §5 lists this set with a trailing ellipsis, so it is not exhaustive: every row is `{seq, ts, runId, type, payload, schemaVersion}`. `DeployConfirmationSpent` (§9 decision 14, T4.1.4c) is one addition made since §5 was written and is not repeated here, since keeping this list current with every event the catalog gains is `src/event/catalog.ts`'s job, not this artifact's."}
- {"id":"D-2","entity":"Derived (rebuildable) tables","fields":["runs","tasks","gates","budgets","trace_links","metrics"],"notes":"Rebuildable from the event log (§5); artifacts and roles live in git only (ADR-3) — these tables store references (path + commit hash), never artifact content. `KernelState.spentConfirmations` (§9 decision 14, T4.1.4c) is a later addition to this set, for the same reason D-1 does not chase every event the catalog gains."}

## technologies

- {"id":"T-1","choice":"TypeScript on Node.js","why":"Deepest available integration with the Claude Agent SDK, the Claude Code hook/plugin surface and MCP (ADR-1); zod gives runtime schema validation matching AGT-3.","tracesTo":["AGT-3","NFR-3"]}
- {"id":"T-2","choice":"SQLite (WAL mode) as the kernel event log store","why":"Crash-safe resume and event-sourced replay by construction, with no service dependency to run locally (ADR-2).","tracesTo":["ORC-3","ORC-5","NFR-5"]}
- {"id":"T-3","choice":"Git as the artifact and code store","why":"ART-4 already mandates git for code; extending it to all artifacts gives versioning, attribution and diff review for free (ADR-3).","tracesTo":["ART-4","ART-1"]}
- {"id":"T-4","choice":"MCP for every external integration","why":"A uniform policy interception point and provider swap without a workflow change (ADR-7).","tracesTo":["EXT-1","EXT-2","EXT-3"]}

## crossCutting

- {"id":"X-1","concern":"authn","approach":"DESIGN.md declares no authentication mechanism of its own, and this is carried forward as that stated fact rather than a mechanism invented to fill the slot: mpgm runs single-operator and local-first (§1 goal 3, NFR-5), so identity today is whoever has OS-level access to the machine running the CLI, not a login or credential the harness itself checks. §8 names multi-operator collaboration as a v2 revisit (\"gate manager already isolates approval identity in events; add role-based approvers without kernel changes\") without designing an authentication mechanism for it. DSG-2 asks that a design address authn/z; this entry is that address, and its content is the gap, not a claim that one exists.","tracesTo":["NFR-5"]}
- {"id":"X-2","concern":"authz","approach":"Least-privilege role toolsets (AGT-2) enforced outside the model via the SDK's canUseTool/hook interface: per-role allowlists of tools, file globs, network hosts and shell patterns, with every dimension defaulting to empty so a role reaches only what it names (ADR-6, §7).","tracesTo":["AGT-2","SAF-1"]}
- {"id":"X-3","concern":"observability","approach":"The event log is the telemetry source; a projection layer derives per-phase/per-role cost, latency, retry and success metrics and longitudinal quality metrics (gate rejection rate, rework rate, escaped defects), with every tool call and approval an event (§4.5, §7).","tracesTo":["OBS-1","OBS-2","OBS-3","OBS-4"]}
- {"id":"X-4","concern":"failure-modes","approach":"Crash-safe resume via event-log fold plus intent-before-effect for side-effectful steps; retry-with-backoff on model/tool failure and escalation on exhaustion rather than a silently dropped task; worktree preservation and resume-with-context on session death (§6).","tracesTo":["NFR-1"]}
- {"id":"X-5","concern":"security","approach":"Secret brokering at the tool boundary with symbolic references and exact-value log redaction (SAF-2); untrusted external content handled by structurally constrained, read-only sessions (SAF-3); destructive tools requiring dry-run then confirmation, keyed by a fingerprint over every parameter but the dry-run flag (SAF-4); merge-blocking security scanning (SAF-5); egress classes at context assembly with an unlabelled-is-restricted default (SAF-6) (§7).","tracesTo":["SAF-2","SAF-3","SAF-4","SAF-5","SAF-6"]}

## adrs

- {"id":"ADR-1","title":"TypeScript on Node as implementation language","context":"The kernel and CLI need a language whose ecosystem gives deep integration with the Claude Agent SDK, the Claude Code hook/plugin surface, and the MCP ecosystem, since goal 4 (substrate leverage, §1) rules out reimplementing the agent loop, tool handling, permissions or context management.","decision":"The kernel and CLI are TypeScript on Node. zod gives runtime schema validation matching AGT-3.","alternatives":[{"option":"Python","whyNot":"Stronger eval/data tooling, but evals (AGT-6) are driven through the SDK, not notebooks."},{"option":"Rust","whyNot":"Considered for the kernel's correctness profile — an append-only log with a pure fold suits Rust's type system well — but there is no Rust Agent SDK, so the deepest integration point (session lifecycle, canUseTool hooks, usage events) would require either reimplementing the agent loop, contradicting goal 4, or a Node sidecar putting an IPC seam through the policy boundary and doubling toolchains. Rust's headline gains buy little: the harness is I/O-bound around model calls, and the correctness properties that matter come from pure reducers plus property tests, achievable in TS. Self-hosting economics also favour TS: agent repair loops against CI iterate faster without Rust compile times."}],"consequences":["Commits the kernel and CLI to the Node/TypeScript toolchain and its ecosystem for the lifetime of v1.","Rust remains the named candidate for a standalone kernel rewrite if eval sophistication outgrows the SDK harness or the kernel earns a rewrite (multi-operator, remote execution); the event log schema, not the language, is the durable contract that would carry across such a rewrite."],"tracesTo":["AGT-3","NFR-3"]}
- {"id":"ADR-2","title":"Event-sourced kernel over SQLite","context":"The kernel needs crash-safe resume and replay without a live service dependency, on a design that optimises for local-first simplicity (§1 goal 3).","decision":"All kernel state is an append-only event log in a local SQLite database (`.mpgm/state.db`, WAL mode) — the single authoritative log; in-memory state is a pure fold over events, and any file exports are derived backups, never a second write path. Large payloads are offloaded to content-addressed blobs under `.mpgm/blobs/` and referenced by hash, after SAF-6 redaction at write time. Snapshots every N events keep resume and replay fast.","alternatives":[{"option":"not documented","whyNot":"DESIGN.md's write-up for this decision states the decision, its \"Why:\" and (where present) its \"Trade-off:\", and names no alternative considered and rejected — unlike ADR-1, which names Python and Rust. Carried as the true fact of that gap rather than an invented option."}],"consequences":["Crash-safe resume (ORC-5) and event-sourced replay (ORC-3) hold by construction rather than by a recovery procedure bolted on afterwards.","SQLite needs no service, satisfying NFR-5 (single-machine, no mandatory services).","Schema migrations for events need discipline — versioned event types and upcasters (CONV-7)."],"tracesTo":["ORC-5","ORC-3","NFR-5"]}
- {"id":"ADR-3","title":"Git as the artifact store","context":"ART-4 mandates git for code; every phase transition needs a versioned, reviewable interface, and a second store for non-code artifacts would be a second thing to keep consistent with the first.","decision":"Artifacts are markdown files with YAML frontmatter (id, version, schema, traces-to, produced-by) in `artifacts/`, committed to the project repo. Gate decisions live in the event log, which is authoritative (ORC-6 invalidation is an event, not a git operation); an annotated tag (`gate/<phase>/<version>`) is written as a derived, informational marker. Immutability (ART-1) is enforced by the kernel refusing edits to gated versions — changes create a successor version.","alternatives":[{"option":"not documented","whyNot":"DESIGN.md's write-up for this decision states the decision, its \"Why:\" and (where present) its \"Trade-off:\", and names no alternative considered and rejected — unlike ADR-1, which names Python and Rust. Carried as the true fact of that gap rather than an invented option."}],"consequences":["Extending ART-4 to all artifacts gives versioning, attribution and diff review for free, and keeps the knowledge base greppable by agents.","No relational queries over artifacts — hence the derived index (ADR-4)."],"tracesTo":["ART-4","ART-1","ORC-6"]}
- {"id":"ADR-4","title":"Derived traceability index, source-of-truth in frontmatter","context":"Requirement, design, task, change, test and release links (ART-2) need to answer graph queries — gate invalidation (ORC-6) and coverage (TST-2) — that flat markdown files in git cannot answer on their own (ADR-3).","decision":"Trace links are declared in artifact frontmatter and commit trailers; the kernel maintains a derived, rebuildable index in SQLite for queries. Every element a downstream artifact may cite carries an id, and the index reads an object with a string id as a declaration, so requirements, design components, interfaces, entities, technologies, cross-cutting concerns, ADRs and plan tasks all name themselves the same way. Prose is not a substitute: the index tells an id from a sentence by shape, so an element identified only by its name gives a downstream artifact no canonical form to cite and gives the index nothing it can report as dangling.","alternatives":[{"option":"not documented","whyNot":"DESIGN.md's write-up for this decision states the decision, its \"Why:\" and (where present) its \"Trade-off:\", and names no alternative considered and rejected — unlike ADR-1, which names Python and Rust. Carried as the true fact of that gap rather than an invented option."}],"consequences":["No second source of truth; the index can always be rebuilt from git.","Index rebuild cost on large repos — mitigated by incremental updates keyed on commit hashes.","An element identified only by its prose name (not an id) gives the index nothing to declare and nothing it can report as dangling — demonstrated when two Plan runs against one design cited `POST /loans` and `interface: POST /loans` for the same interface, neither of which the index could see."],"tracesTo":["ART-2","ORC-6","TST-2"]}
- {"id":"ADR-5","title":"One SDK session per task, one git worktree per implementation task","context":"A task needs bounded, reproducible context (CTX-1/2) and parallelism (ORC-3) without one task session stepping on another.","decision":"Every task runs in a fresh Claude Agent SDK session with context assembled from artifacts; implementation tasks additionally get an isolated worktree and merge via reviewed PR (IMP-1/3).","alternatives":[{"option":"not documented","whyNot":"DESIGN.md's write-up for this decision states the decision, its \"Why:\" and (where present) its \"Trade-off:\", and names no alternative considered and rejected — unlike ADR-1, which names Python and Rust. Carried as the true fact of that gap rather than an invented option."}],"consequences":["Bounded, reproducible context beats long-lived sessions.","Worktrees give parallelism without conflict.","Context re-assembly cost per task — mitigated by prompt caching and a compact knowledge-base digest."],"tracesTo":["CTX-1","CTX-2","IMP-1","IMP-3","ORC-3"]}
- {"id":"ADR-6","title":"Policy enforcement via SDK permission hooks + OS sandbox","context":"Least-privilege enforcement (SAF-1) and secret brokering (SAF-2) need a control point outside the model, since prompt-level instruction is not a control.","decision":"The policy engine implements the SDK's canUseTool / hook interface: per-role allowlists of tools, file globs, network hosts and shell patterns, declared in role files and evaluated outside the model. Secrets never enter context: agents reference credentials symbolically as `${secret:<name>}`, and the kernel's broker substitutes real values only at the tool boundary, inside the PreToolUse hook. Each secret declares the tools that may receive it; a reference in any other tool is denied. Data-egress classes (SAF-6) are enforced at context assembly, with unlabelled content treated as restricted by default.","alternatives":[{"option":"not documented","whyNot":"DESIGN.md's write-up for this decision states the decision, its \"Why:\" and (where present) its \"Trade-off:\", and names no alternative considered and rejected — unlike ADR-1, which names Python and Rust. Carried as the true fact of that gap rather than an invented option."}],"consequences":["Hook-level enforcement trusts the SDK process boundary; defense-in-depth via sandboxed execution (Claude Code sandbox / containers) for shell tools.","What a policy withholds is always reported to the operator and stated in the prompt."],"tracesTo":["SAF-1","SAF-2","SAF-6"]}
- {"id":"ADR-7","title":"MCP for all external integrations","context":"Git hosting, CI, scanners, IaC and telemetry each have their own provider landscape, and EXT-2/3 ask for provider swap without a workflow change.","decision":"Git hosting, CI, scanners, IaC, and telemetry are reached only through MCP servers; the kernel and roles reference tools by capability name, resolved per project.","alternatives":[{"option":"not documented","whyNot":"DESIGN.md's write-up for this decision states the decision, its \"Why:\" and (where present) its \"Trade-off:\", and names no alternative considered and rejected — unlike ADR-1, which names Python and Rust. Carried as the true fact of that gap rather than an invented option."}],"consequences":["A uniform policy interception point across every external integration.","Provider swap without a workflow change."],"tracesTo":["EXT-1","EXT-2","EXT-3"]}
