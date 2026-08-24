# PLAN SUMMARY — mpgm Build Plan

**Status:** v0.1 — phases and milestones only · **Owner:** macg@enthropic.io · **Last updated:** 2026-08-24
**Derived from:** [PLAN.md](PLAN.md) v0.4. This is a reading view, not an authority: it drops the task tables, completion criteria, trace columns and model recommendations. Where the two disagree, **PLAN.md is correct** and this document is stale.

## 1. Shape

Five plan phases, eleven milestones. Phase order is strict — P1 → P2 → P3 → P4 → P5. Each milestone ends in a **verification demo** (PLN-3): something that must demonstrably work, not a date.

| Phase | Milestones | Theme |
|---|---|---|
| P1 — Walking Skeleton | M1.1, M1.2, M1.3 | Kernel, one role, one gated phase, end to end |
| P2 — Phase Breadth | M2.1, M2.2 | Every pre-implementation phase runnable; traceability live |
| P3 — Build Loop | M3.1, M3.2 | Implement and Test phases; **self-hosting begins** |
| P4 — Delivery | M4.1, M4.2 | Deploy pipeline and observability projections |
| P5 — Maintain & Self-Improvement | M5.1, M5.2 | Signals, incidents, evals, the improvement loop |

## 2. Bootstrap

mpgm cannot yet drive its own development. **P1 through M3.1 are executed by operator-driven Claude Code sessions** following the plan manually. **From the end of M3.1 mpgm dogfoods** — the harness executes its own remaining plan, with gaps worked around manually and logged as defects.

Self-hosting needs the kernel, the playbooks and the complete implement loop, which M3.1 itself delivers. Plan ingestion is de-risked earlier, in M2.2. Until the eval harness lands in M5.2, role definitions are **frozen** at switchover: any P3–P4 role change needs operator approval and a logged exemption, preserving AGT-6.

## 3. Risk register (drives ordering, PLN-2)

| # | Assumption at risk | Validated by |
|---|---|---|
| R1 | Claude Agent SDK sessions can be driven programmatically with enforced structured outputs, budgets, and permission hooks | M1.2 |
| R2 | Event-sourced kernel over SQLite gives crash-safe resume and faithful replay of SDK interactions | M1.1, M1.3 |
| R3 | Context assembled purely from artifacts (no transcripts) yields agent output of gate-passing quality | M1.3, M2.1 |
| R4 | Gate-invalidation cascade over the trace index is tractable and correct | M2.2 |
| R5 | Worktree-parallel implementation with merge-gated CI works at useful throughput | M3.1 |
| R6 | The gated Plan artifact is ingestible as mpgm's own executable task graph | M2.2 |
| R7 | Tool-boundary secret brokering (no secrets in session env) is implementable against the SDK | M3.1 |

The walking skeleton attacks R1–R3 first — the assumptions that, if false, invalidate the architecture rather than merely inconveniencing it. R6 and R7 are settled before they become load-bearing, at switchover and at self-hosted tool use respectively.

## 4. Phases and milestones

### P1 — Walking Skeleton
*Kernel event loop, one role, one gated phase, end to end (steel thread).*

**M1.1 — Event-sourced kernel core** *(risk: R2)*
The append-only SQLite log with versioned event types and write-time redaction; the pure state fold with periodic snapshots; a content-addressed blob store; and intent-before-effect, so a crash between deciding to act and acting leaves evidence.
**Verification:** a scripted crash/restart demo — a synthetic run with no model calls, killed at arbitrary points, resumes with identical folded state, and replay from the log reproduces it byte for byte.

**M1.2 — Agent runtime minimal** *(risk: R1)*
Role definitions loaded from frontmatter; one SDK session per task with structured output and bounded retry on validation failure; token, cost, step and wall-clock budgets enforced by the kernel; per-role tool and path policy enforced outside the model, with every denial logged.
**Verification:** a live demo — a toy role runs a task under a deliberately hostile prompt attempting out-of-policy tool use. The call is blocked, the budgets hold, the output validates, and all of it is visible in the event log.

**M1.3 — Definition phase end-to-end** *(risks: R2, R3)*
The phase playbook format; the versioned artifact store with gate refusal-of-edit and schema migration; the context assembler with egress filtering; the interactive elicitation session; the gate manager and approval packets; and the operator CLI.
**Verification (skeleton complete):** a full Definition phase on a sample project — elicitation chat, analyst drafts the artifact, gate packet, operator approval, tagged artifact. Then replay reproduces the run from the log alone.

### P2 — Phase Breadth
*All pre-implementation phases runnable; traceability live.*

**M2.1 — Scope & Design phases** *(risk: R3)*
The ORC-4 pattern primitives — fan-out/collect, pipeline, critic-of, panel — expanded by the kernel into ordinary tasks, with bounded-concurrency scheduling. The Scope playbook derives testable, prioritised requirements and flags conflicts, duplicates and criteria gaps. The Design playbook generates competing candidates, judges them with a panel, records the decision as ADRs, and reviews the result adversarially across the four DSG-3 lenses. A read-only research profile handles untrusted external content.
**Verification:** a sample project driven Definition → Scope → Design with gates, where a **planted requirement conflict** and a **planted design flaw** are caught by the flagging and critic tasks respectively.

**M2.2 — Traceability & Plan phase** *(risks: R4, R6)*
The derived trace index over artifact frontmatter and commit trailers; the gate-invalidation cascade on reopen; the Plan playbook decomposing a design into plan phases, milestones and single-session tasks; the replan classifier that decides which plan changes are the kernel's and which are the operator's; trace and coverage queries; knowledge-base updates and prior-decision surfacing; and the plan-ingestion dry run that settles R6.
**Verification:** reopen the sample project's Scope with a changed requirement — exactly the affected Design and Plan artifacts lose gate approval, and the unaffected ones keep it, until the affected work is revised and re-gated.

### P3 — Build Loop *(self-hosting begins)*
*Implement and Test phases; mpgm executes its own remaining tasks.*

**M3.1 — Implement loop** *(risks: R5, R7)*
Per-task isolated git worktrees; a CI contract that blocks merges on red checks; a repair loop that feeds failures back to the implementing agent under a bounded budget, escalating one model tier on its final retry; independent review before merge; convention enforcement from the knowledge base; a secret broker that injects credentials at the tool boundary rather than into session environments; a destructive-operation guard requiring dry runs and confirmation events; the GitHub project-management projection; and finally **switchover**.
**Verification (first Implement milestone):** mpgm implements, reviews and merges a real task of its own backlog end to end with green CI, and the task's journey — issue, in progress, PR, done — is visible live on the scrum board. Dashboard work starts here and ships in M3.2.

**M3.2 — Test phase & dashboard**
Non-functional test suites run against the quantified thresholds the Scope artifact declared, with requirement-level coverage reporting; an adversarial test role generating negative, boundary and property-based tests; flaky-test detection and a quarantine ledger that does not silently satisfy coverage; defect artifacts that trace to requirements and route back to Implement or reopen Design; the read-only projection API and the dashboard over it; and the sample service that P4 deploys.
**Verification:** a Test phase run over mpgm itself — a coverage report and one adversarially found defect round-tripped through fix and re-test — with the sample service ready for P4.

### P4 — Delivery
*Deploy and observability projections.*

**M4.1 — Deploy pipeline**
Environment provisioning from repository config alone; a release contract covering artifact assembly, changelog and rollback path, with delegation to the CD tool; health verification driving promote and rollback decisions with recorded outcomes; and the hard human approval gate on production deploys.
**Verification:** the sample service deployed to staging and promoted; a second release with an induced fault auto-rolls back, with the outcome recorded. Full incident records arrive in M5.1.

**M4.2 — Observability projections**
Cost, latency, retry and success-rate projections per phase, role and run; and quality metrics — gate rejection, rework and escaped-defect rates — over multiple runs.
**Verification:** spend and quality dashboards populated from real self-hosted runs; kernel overhead measured under 10% of run wall-clock (NFR-3); and a clean-machine install reaching a gated Definition artifact within one hour, timed (NFR-6).

### P5 — Maintain & Self-Improvement
*Close the lifecycle loop.*

**M5.1 — Maintain integration**
Signal ingestion from telemetry, dependency advisories and inbound GitHub activity, triaged into work items; an incident state machine with a postmortem playbook; severity-prioritised dependency upgrades; and drift audits between code and design, tests and requirements, infrastructure and its declarations.
**Verification:** a synthetic alert becomes a prioritised work item; a simulated incident runs detect → operator-approved mitigation → remediation through the normal loop → postmortem artifact; and an injected CVE advisory yields a severity-prioritised upgrade task.

**M5.2 — Evals & improvement loop**
The eval harness and its adoption gate — after which the role freeze lifts and no role changes without a green eval; baseline suites for every shipped role; a feedback miner turning event-log signals into proposed role and knowledge-base diffs that go through review; and the task-class to model-tier routing table.
**Verification (v1 complete):** the full eight-phase lifecycle runs on the sample project under mpgm, and mpgm's own backlog is maintained by mpgm — with every REQUIREMENTS MUST mapping to a passing verification or a filed defect.

## 5. Exit

**Plan gate exit:** operator approval of PLAN.md; the task graph acyclic; every task tracing to DESIGN elements. Replanning follows PLN-4 through the classifier delivered in M2.2 — until that is live in anger, plan changes are operator-approved document revisions.

## 6. Where the build has got to

| Milestone | Built | Verification demo |
|---|---|---|
| M1.1 | complete | passing, offline, in CI |
| M1.2 | complete | passed (operator-run, live) |
| M1.3 | complete | passed (operator-run, live) — **re-run advised**: the phase gained a prior-art research task in M2.1 |
| M2.1 | complete | not yet reported run (operator-run, live) |
| M2.2 | complete | trace and plan-ingestion demos passing offline in CI; the reopen scenario is exercised offline but not yet on the sample project |
| M3.1 | next | — |
| M3.2 – M5.2 | not started | — |

"Built" means the milestone's tasks are implemented, reviewed and merged with the offline gates green. It does not mean the milestone's verification demo has been run: the live demos make real model calls, need credentials, and are run by the operator.
