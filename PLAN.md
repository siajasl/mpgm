# PLAN — mpgm Build Plan

**Status:** v0.4 — adds per-task model recommendations · **Owner:** macg@enthropic.io · **Last updated:** 2026-08-23
**Upstream:** [REQUIREMENTS.md](REQUIREMENTS.md) v0.4 · [DESIGN.md](DESIGN.md) v0.15. Structured per PLN-1: **plan phases → milestones → tasks**; each task is a single unit of work sized for one agent session, with completion criteria. Milestones carry verification demos (PLN-3), not time estimates. Task `traces` cite DESIGN sections/ADRs; requirement coverage flows through them (ART-2).

## 1. Bootstrap Note

mpgm cannot yet drive its own development. **P1 through M3.1 are executed by operator-driven Claude Code sessions** following this plan manually; **from T3.1.8 (end of M3.1) mpgm dogfoods** — the harness executes its own remaining plan, with gaps worked around manually and logged as defects. Self-hosting requires the kernel, playbooks, and the complete implement loop (worktrees + merge checks + review), which M3.1 itself delivers; plan-ingestion is de-risked earlier by T2.2.7 (R6). Until the eval harness lands (T5.2.1a), role definitions are **frozen** at switchover — any P3–P4 role change requires operator approval and a logged exemption, preserving AGT-6.

## 2. Risk Register (drives ordering, PLN-2)

| # | Assumption at risk | Validated by |
|---|---|---|
| R1 | Claude Agent SDK sessions can be driven programmatically with enforced structured outputs, budgets, and permission hooks | M1.2 |
| R2 | Event-sourced kernel over SQLite gives crash-safe resume and faithful replay of SDK interactions | M1.1, M1.3 |
| R3 | Context assembled purely from artifacts (no transcripts) yields agent output of gate-passing quality | M1.3, M2.1 |
| R4 | Gate-invalidation cascade over the trace index is tractable and correct | M2.2 |
| R5 | Worktree-parallel implementation with merge-gated CI works at useful throughput | M3.1 |
| R6 | The gated Plan artifact (this document, restructured) is ingestible as mpgm's own executable task graph | T2.2.7 |
| R7 | Tool-boundary secret brokering (no secrets in session env) is implementable against the SDK | T3.1.5 |

The walking skeleton (P1) attacks R1–R3 — the assumptions that, if false, invalidate the architecture. R6 and R7 are validated before they are load-bearing (switchover and self-hosted tool use respectively).

## 3. Plan Phases

**Model column** — recommended Claude model for the session implementing the task. **Opus 5** (`claude-opus-5`) where correctness, security boundaries, or judgment quality dominate — kernel semantics, policy/secret/gate enforcement, gate-critical playbook design; **Sonnet 5** (`claude-sonnet-5`) for well-specified build work. **Haiku 4.5** (`claude-haiku-4-5`) is deliberately absent: it is reserved for high-volume *runtime* roles (signal triage, board reconciliation) — via role-frontmatter defaults when those roles ship (T3.1.7, T5.1.1), then via the T5.2.3 routing table, whose initial contents derive from this column. The model is a dispatch-time session parameter (role default + per-task override, DESIGN §4.2); it never mutates a role definition, so the §1 role freeze and AGT-6 are unaffected. Recommendations are advisory, not gate criteria. Escalation: pre-switchover, a session floundering on Sonnet 5 is re-run once by the operator on Opus 5 before falling back to manual work; post-switchover the same one-step escalation is built into the repair loop (T3.1.2b). Revisit on model-generation changes.

### P1 — Walking Skeleton
*Kernel event loop + one role + one gated phase, end-to-end (steel thread).*

**M1.1 — Event-sourced kernel core** *(risk: R2)*
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T1.1.1 Repo scaffold: TypeScript/Node workspace, lint/type/test toolchain, CI stub on GitHub Actions | `main` green on push | ADR-1, §4.7 | Sonnet 5 |
| T1.1.2 Event log: append-only SQLite (WAL) store, versioned event types with upcasters, zod payload schemas, log-write redaction hook (SAF-6) | property tests: append/fold determinism; upcaster round-trip; redaction pattern applied at write | ADR-2, §5 | Opus 5 |
| T1.1.3 State fold + snapshots: pure reducer, snapshot every N events, resume from snapshot+tail | kill -9 mid-run resumes identically (test) | ADR-2, §6 | Opus 5 |
| T1.1.4 Blob store: content-addressed `.mpgm/blobs/`, hash refs from events | round-trip test, dedup verified | ADR-2 | Sonnet 5 |
| T1.1.5 Intent-before-effect: `EffectIntended` events, pending-intent resolution on resume | crash-between-intent-and-effect test | §6 | Opus 5 |

**Verification:** scripted crash/restart demo — a synthetic run (no LLM) killed at arbitrary points resumes with identical folded state; replay from log reproduces it byte-for-byte.

**M1.2 — Agent runtime minimal** *(risk: R1)*
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T1.2.1 Role loader: `roles/<name>.md` frontmatter → model, tools, budgets, output schema | invalid role file rejected with actionable error | §4.2, AGT-1 | Sonnet 5 |
| T1.2.2 Session runner: SDK session per task, structured-output tool, zod validation, bounded retry on validation failure | test role returns schema-valid output 10/10 runs | ADR-5, AGT-3 | Opus 5 |
| T1.2.3 Budget enforcement: token/cost/step via usage events + kernel wall-clock timer; termination on breach | hung-session test killed by timer | §4.1, AGT-4 | Sonnet 5 |
| T1.2.4 Policy hooks: per-role tool/path allowlists via `canUseTool`; denial events logged | out-of-policy tool call blocked + logged (test) | ADR-6, SAF-1 | Opus 5 |

**Verification:** live demo — a toy role executes a task with a deliberately hostile prompt attempting out-of-policy tool use; the call is blocked, budgets enforce, output validates, all visible in the event log.

**M1.3 — Definition phase end-to-end** *(risks: R2, R3)*
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T1.3.1 Phase playbook format: `phases/<name>.yaml` schema (task templates, gate criteria, artifact schemas) + loader | schema-validated load of definition playbook | §2, EXT-3 | Sonnet 5 |
| T1.3.2 Artifact store: frontmatter conventions, versioning, gate refusal-of-edit, successor versions, schema validation with migration on breaking change | gated artifact edit rejected; v+1 created; breaking-schema migration test | ADR-3, ART-1/3 | Opus 5 |
| T1.3.3 Context assembler v1: task spec + upstream artifacts + KB digest + egress filter (`egress:` labels enforced) | assembled context snapshot-tested; restricted file excluded (test) | §4.3, CTX-1/2, SAF-6 | Opus 5 |
| T1.3.4 Interactive mode: `mpgm chat definition` elicitation session; transcript → artifact; structured conclusions | operator dialogue produces Definition artifact | §4.2, DEF-1 | Sonnet 5 |
| T1.3.5 Gate manager v1: approval packet (options/trade-offs/recommendation), `mpgm approve`, decision events | gate blocks until approval; decision in log | §4.1, HIL-1/4/5 | Opus 5 |
| T1.3.6 CLI v1: `run, status, pause, resume, kill, redirect, approve, chat, replay` | each verb exercised in an e2e script; `replay` reproduces a run from the log | §4.4, HIL-3, ORC-3 | Sonnet 5 |

**Verification (skeleton complete):** full Definition phase run on a sample project — elicitation chat → analyst agent drafts Definition artifact → gate packet → operator approval → tagged artifact. Then `mpgm replay` reproduces the run from the log.

### P2 — Phase Breadth
*All pre-implementation phases runnable; traceability live.*

**M2.1 — Scope & Design phases** *(risk: R3)*
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T2.1.1 Pattern primitives: `fan-out/collect`, `pipeline`, `critic-of`, `panel` graph nodes + scheduler expansion | unit tests per primitive; parallel dispatch respects concurrency cap | §4.1, ORC-3/4 | Opus 5 |
| T2.1.2 Scope playbook: requirement derivation, conflict/duplicate/criteria-gap flagging, MoSCoW | sample project yields gated requirement set | §2, SCP-1..3 | Opus 5 |
| T2.1.3a Design playbook part 1: candidate generation (panel primitive), selection judging, ADR emission | ≥2 candidates judged; ADRs produced | §2/§4.1, DSG-1/2 | Opus 5 |
| T2.1.3b Design playbook part 2: critic-of review across the four DSG-3 lenses, findings tracked to resolution | planted design flaw caught; findings resolved or accepted at gate | §4.1, DSG-3 | Opus 5 |
| T2.1.4 Untrusted-content role profile: read-only research role for prior-art tasks | shell/write denied in research session (test) | §4.2, SAF-3, DEF-3 | Opus 5 |

**Verification:** sample project driven Definition → Scope → Design with gates; a planted requirement conflict and a planted design flaw are caught by the flagging and critic tasks respectively.

**M2.2 — Traceability & Plan phase** *(risk: R4)*
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T2.2.1 Trace index: frontmatter/commit-trailer link extraction → SQLite; incremental rebuild keyed on commit hash | full rebuild == incremental result (test) | ADR-4, ART-2 | Sonnet 5 |
| T2.2.2 Gate invalidation: `PhaseReopened` cascade over trace index; unaffected artifacts retain approval | invalidation scenario test matrix | §4.1, ORC-6 | Opus 5 |
| T2.2.3 Plan playbook: design → plan-phase/milestone/task decomposition, acyclicity + trace checks at gate | generated plan passes gate checks on sample project | PLN-1, §4.1 | Opus 5 |
| T2.2.4 Replan classifier: intra-milestone deltas autonomous+logged; larger deltas re-enter Plan gate | classifier decision table tested | §4.1, PLN-4 | Sonnet 5 |
| T2.2.5 `mpgm trace <id>` + coverage queries (requirement → verified-by) | trace query demo on sample project | §4.4, ADR-4, TST-2 | Sonnet 5 |
| T2.2.6 KB + context assembler v2: `kb/` conventions and update flow (CTX-4); prior-decision surfacing via trace index (CTX-3) | KB updated by a task; conflicting-decision surfaced in assembled context (test) | §4.3, CTX-3/4 | Sonnet 5 |
| T2.2.7 Plan-ingestion dry run: this PLAN restructured as a gated Plan artifact and loaded as an executable task graph *(R6)* | remaining P3–P5 tasks load, validate acyclic, schedule correctly (dry run, no dispatch) | §2, PLN-1 | Opus 5 |

**Verification:** reopen the sample project's Scope with a changed requirement — exactly the affected Design/Plan artifacts lose gate approval and are re-gated after revision.

### P3 — Build Loop *(self-hosting begins)*
*Implement + Test phases; mpgm executes its own remaining tasks.*

**M3.1 — Implement loop** *(risk: R5)*
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T3.1.1 Worktree manager: per-task isolated worktrees, branch naming, cleanup | parallel tasks touch same repo without conflict (test) | ADR-5, IMP-1 | Sonnet 5 |
| T3.1.2a `ci.checks` contract + GitHub Actions integration: merge blocked on build/lint/type/test/scan | red CI blocks merge | §4.7, IMP-2, SAF-5 | Opus 5 |
| T3.1.2b Repair loop: CI failure fed back to implementing agent with bounded retry budget; final retry escalates one model tier (§3 model column) | induced CI failure repaired within budget; tier-escalation retry exercised; exhaustion escalates to operator | §4.7, IMP-2, NFR-1 | Sonnet 5 |
| T3.1.3 Review flow: `critic-of` reviewer role independent of author; merge on approval | authored change merged only after independent review event | §4.1/§4.7, IMP-3 | Sonnet 5 |
| T3.1.4 Convention enforcement: KB conventions in implementer context; deviation flagging in review rubric | planted deviation flagged (test) | §4.3, IMP-4, CTX-1 | Sonnet 5 |
| T3.1.5 Secret broker proxy: tool-boundary credential injection + output redaction *(R7)* | `printenv`-style leak test shows no secret in transcript | ADR-6, SAF-2 | Opus 5 |
| T3.1.6 Destructive-op guard: destructive tools require dry-run support; kernel confirmation events before execution | destructive call without prior dry-run + confirmation event blocked (test) | §7, SAF-4 | Opus 5 |
| T3.1.7 PM projector + `pm.github` contract: Plan-artifact bootstrap (board, labels, milestones), event-driven task↔issue / milestone / PR-link sync, idempotent reconcile pass | board bootstrapped from gated Plan; task state change reflected on board (test); re-bootstrap converges without duplicates | §4.8, PMG-1/2/4 | Sonnet 5 |
| **T3.1.8 Switchover:** remaining PLAN tasks loaded as mpgm's own task graph (validated by T2.2.7); role definitions frozen per §1 | mpgm dispatches and merges its first self-task | §1 | Opus 5 |

**Verification (first Implement milestone):** mpgm implements, reviews, and merges a real task of its own backlog end-to-end with green CI, with the task's journey (issue → in-progress → PR → done) visible live on the scrum board. **Dashboard work starts now** — DESIGN §9's "ships at the first Implement milestone" is interpreted as started here, shipped in M3.2.

**M3.2 — Test phase & dashboard**
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T3.2.1 `test.nfr` contract + runner: NFR suites against SCP-1 thresholds; requirement-coverage report | coverage report lists verified/unverified requirements | §4.7, TST-2/3 | Sonnet 5 |
| T3.2.2 Adversarial test role: negative/boundary/property-based test generation | planted bug caught by generated tests on sample project | §4.2, TST-4 | Opus 5 |
| T3.2.3 Flaky detection + quarantine ledger; quarantined tests excluded from coverage | flaky test auto-quarantined; coverage drops accordingly | §4.7, TST-6 | Sonnet 5 |
| T3.2.4 Defect artifacts: filing, tracing to requirements, routing to Implement (or Design reopen) | defect round-trips through fix + re-test | ADR-3, TST-5, ORC-1 | Sonnet 5 |
| T3.2.5a Dashboard backend: read-only event-stream projection API (run state, approvals, spend, trace graph) | API serves live run data (test) | §4.4/§4.5, OBS-3 | Sonnet 5 |
| T3.2.5b Dashboard UI: panels over the projection API | dashboard renders a live run | §4.4, OBS-3 | Sonnet 5 |
| T3.2.6 Sample service: mpgm implements the P2 sample project as a minimal deployable web service (P4's deploy subject) | service builds, tests green in its own repo/CI | §1, IMP-1..5 | Sonnet 5 |

**Verification:** Test phase run over mpgm itself — coverage report, one adversarially-found defect round-tripped to fix; sample service ready for P4.

### P4 — Delivery
*Deploy + observability projections.*

**M4.1 — Deploy pipeline**
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T4.1.1 `env.provision` contract + IaC for test/staging envs | env up/down from repo config only | §4.7, DEP-1/4 | Sonnet 5 |
| T4.1.2 `release.deliver` contract: artifact assembly (version, changelog, rollback path), CD delegation | staged release with tested rollback on sample service | §4.7, DEP-2/3 | Sonnet 5 |
| T4.1.3 Health verification + promote/rollback decisions; release outcome artifacts | induced regression auto-rolls back; outcome recorded | §4.7, DEP-2/5 | Sonnet 5 |
| T4.1.4 Deploy gate: HIL-2 hard approval wiring; `mpgm rollback` verb | production deploy impossible without approval event | §4.4, HIL-2 | Opus 5 |

**Verification:** sample service (T3.2.6) deployed staging → (canary via CD tool) → promoted; a second release with an induced fault auto-rolls back with the outcome recorded per DEP-5 (full incident records arrive with T5.1.2).

**M4.2 — Observability projections**
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T4.2.1 Metrics projections: cost/latency/retry/success per phase/role/run | `mpgm status --metrics` + dashboard panels | §4.5, OBS-2 | Sonnet 5 |
| T4.2.2 Quality metrics: gate rejection, rework, escaped-defect rates | longitudinal report over ≥3 runs | §4.5, OBS-4 | Sonnet 5 |

**Verification:** spend and quality dashboards populated from real self-hosted runs; kernel overhead measured under 10% of run wall-clock (NFR-3); a clean-machine install reaches a gated Definition artifact within one hour, timed (NFR-6).

### P5 — Maintain & Self-Improvement
*Close the lifecycle loop.*

**M5.1 — Maintain integration**
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T5.1.1 Signal ingestors (`telemetry.signals`, `deps.advisories`, `pm.inbound` GitHub activity) + triage role → work items | synthetic alert and an operator-filed GitHub issue each become prioritized tasks | §4.9, MNT-1, PMG-3 | Sonnet 5 |
| T5.1.2 Incident state machine + postmortem playbook | simulated incident: detect → approve → remediate → postmortem artifact | §4.9, MNT-2 | Sonnet 5 |
| T5.1.3 Dependency upgrade tasks with severity priority | injected CVE advisory yields prioritized upgrade task | §4.9, MNT-3 | Sonnet 5 |
| T5.1.4 Drift audit tasks (code↔design, tests↔requirements, infra↔IaC) | planted drift detected and reconciliation task raised | §4.9, MNT-4 | Sonnet 5 |

**Verification:** a synthetic alert becomes a prioritized work item; a simulated incident runs detect → operator-approved mitigation → remediation via the normal loop → postmortem artifact; an injected CVE advisory yields a severity-prioritized upgrade task.

**M5.2 — Evals & improvement loop**
| Task | Completion criteria | Traces | Model |
|---|---|---|---|
| T5.2.1a Eval harness core: runner, shared `evals/lib/` graders, `mpgm eval` verb, adoption gate on green evals; role freeze (§1) lifted | role change without green eval blocked | §4.6, AGT-6 | Opus 5 |
| T5.2.1b Per-role eval suites for all shipped roles (golden artifacts + rubrics importing `evals/lib/`) | every shipped role has a green baseline suite | §4.6, §9, AGT-6 | Opus 5 |
| T5.2.2 Feedback miner: event-log signals → proposed role/KB diffs as reviewed changes | one adopted refinement lands via full loop (miner → diff → review → eval → adopt) | §4.2, AGT-7 | Sonnet 5 |
| T5.2.3 Model routing: task-class → model-tier override table | routing table honored per task class (test) | §4.2, AGT-5 | Sonnet 5 |

**Verification (v1 complete):** the full eight-phase lifecycle runs on the sample project under mpgm, and mpgm's own backlog is maintained by mpgm — every REQUIREMENTS MUST maps to a passing verification above or a filed defect.

## 4. Dependencies & Exit

Phase order is strict (P1→P2→P3→P4→P5); within milestones, tasks are ordered by their table position unless independent. **Plan gate exit (PLN gate):** operator approval of this document; graph acyclic; every task traces to DESIGN elements. Replanning follows PLN-4 via the T2.2.4 classifier once live — until then, plan changes are operator-approved document revisions.
