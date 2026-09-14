---
id: mpgm-plan
version: 1
schema: plan
schemaVersion: 1
tracesTo:
  - PLN-1
  - PLN-2
  - PLN-3
producedBy:
  task: T2.2.7
  role: operator
  model: (hand-authored)
  runId: bootstrap
supersedes: null
egress: internal
data:
  summary: The remaining mpgm plan (P3-P5) as an executable task graph. Task
    traces cite REQUIREMENTS and DESIGN ids, which are not yet artifacts of this
    project — that migration is T3.1.8 — so they resolve against the documents
    rather than against the trace index for now.
  risks:
    - id: R5
      assumption: Worktree-parallel implementation with merge-gated CI works at useful
        throughput.
      validatedBy:
        - M3.1
    - id: R7
      assumption: Tool-boundary secret brokering (no secrets in session env) is
        implementable against the SDK.
      validatedBy:
        - M3.1
  phases:
    - id: P3
      title: Build Loop
      intent: Implement and Test phases, and the point at which mpgm begins executing
        its own plan.
      milestones:
        - id: M3.1
          title: Implement loop
          verification: mpgm implements, reviews and merges a real task of its own backlog
            end to end with green CI, with the task journey visible live on the
            scrum board.
          validatesRisk: R5
          tasks:
            - id: T3.1.1
              title: Worktree manager
              completionCriteria:
                - Parallel tasks touch the same repository without conflict
                  (test).
              dependsOn: []
              tracesTo:
                - ADR-5
                - IMP-1
            - id: T3.1.2a
              title: ci.checks contract and GitHub Actions integration
              completionCriteria:
                - A red CI run blocks the merge.
              dependsOn: []
              tracesTo:
                - IMP-2
                - SAF-5
            - id: T3.1.2b
              title: Repair loop with bounded retry and one tier escalation
              completionCriteria:
                - An induced CI failure is repaired within budget.
                - The tier-escalation retry is exercised.
                - Budget exhaustion escalates to the operator.
              dependsOn:
                - T3.1.2a
              tracesTo:
                - IMP-2
                - NFR-1
            - id: T3.1.3
              title: Review flow with an independent reviewer
              completionCriteria:
                - An authored change merges only after an independent review
                  event.
              dependsOn:
                - T3.1.1
                - T3.1.2a
              tracesTo:
                - IMP-3
            - id: T3.1.4
              title: Convention enforcement in the review rubric
              completionCriteria:
                - A planted deviation is flagged (test).
              dependsOn:
                - T3.1.3
              tracesTo:
                - IMP-4
                - CTX-1
            - id: T3.1.5
              title: Secret broker proxy
              completionCriteria:
                - A printenv-style leak test shows no secret in the transcript.
              dependsOn: []
              tracesTo:
                - ADR-6
                - SAF-2
            - id: T3.1.6
              title: Destructive-operation guard
              completionCriteria:
                - A destructive call without a prior dry run and confirmation
                  event is blocked (test).
              dependsOn: []
              tracesTo:
                - SAF-4
            - id: T3.1.7
              title: PM projector and pm.github contract
              completionCriteria:
                - A board is bootstrapped from the gated Plan.
                - A task state change is reflected on the board (test).
                - Re-bootstrapping converges without duplicates.
              dependsOn: []
              tracesTo:
                - PMG-1
                - PMG-2
                - PMG-4
            - id: T3.1.8
              title: Switchover to self-hosting
              completionCriteria:
                - mpgm dispatches and merges its first self-task.
              dependsOn:
                - T3.1.1
                - T3.1.2b
                - T3.1.3
                - T3.1.4
                - T3.1.5
                - T3.1.6
                - T3.1.7
              tracesTo:
                - IMP-1
                - AGT-6
            - id: T3.1.9
              title: Bootstrap attestation
              completionCriteria:
                - An attested task counts as done for scheduling.
                - An attested task is never reported as a session mpgm ran
                  (test).
              dependsOn:
                - T3.1.8
              tracesTo:
                - ORC-3
                - HIL-5
        - id: M3.2
          title: Test phase and dashboard
          verification: "A Test phase run over mpgm itself: a coverage report, one
            adversarially found defect round-tripped to a fix, and the sample
            service ready for P4."
          validatesRisk: null
          tasks:
            - id: T3.2.1
              title: test.nfr contract and runner
              completionCriteria:
                - The coverage report lists verified and unverified requirements.
              dependsOn: []
              tracesTo:
                - TST-2
                - TST-3
            - id: T3.2.2
              title: Adversarial test role
              completionCriteria:
                - A planted bug is caught by generated tests on the sample
                  project.
              dependsOn: []
              tracesTo:
                - TST-4
            - id: T3.2.3
              title: Flaky detection and quarantine ledger
              completionCriteria:
                - A flaky test is auto-quarantined.
                - Coverage drops accordingly rather than silently holding.
              dependsOn:
                - T3.2.1
              tracesTo:
                - TST-6
                - TST-2
            - id: T3.2.4
              title: Defect artifacts and routing
              completionCriteria:
                - A defect round-trips through fix and re-test.
              dependsOn: []
              tracesTo:
                - TST-5
                - ORC-1
            - id: T3.2.5a
              title: "Dashboard backend: read-only projection API"
              completionCriteria:
                - The API serves live run data (test).
              dependsOn: []
              tracesTo:
                - OBS-3
            - id: T3.2.5b
              title: Dashboard UI over the projection API
              completionCriteria:
                - The dashboard renders a live run.
              dependsOn:
                - T3.2.5a
              tracesTo:
                - OBS-3
            - id: T3.2.6
              title: Sample service as a deployable web service
              completionCriteria:
                - The service builds and its tests are green in its own
                  repository and CI.
              dependsOn: []
              tracesTo:
                - IMP-1
                - IMP-2
    - id: P4
      title: Delivery
      intent: Deploy pipeline and the observability projections over real runs.
      milestones:
        - id: M4.1
          title: Deploy pipeline
          verification: The sample service is deployed to staging and promoted; a second
            release with an induced fault auto-rolls back with the outcome
            recorded.
          validatesRisk: null
          tasks:
            - id: T4.1.1
              title: env.provision contract and IaC for test and staging
              completionCriteria:
                - An environment comes up and down from repository config alone.
              dependsOn: []
              tracesTo:
                - DEP-1
                - DEP-4
            - id: T4.1.2
              title: release.deliver contract and CD delegation
              completionCriteria:
                - A staged release with a tested rollback path on the sample
                  service.
              dependsOn:
                - T4.1.1
              tracesTo:
                - DEP-2
                - DEP-3
            - id: T4.1.3
              title: Health verification and promote/rollback decisions
              completionCriteria:
                - An induced regression auto-rolls back and the outcome is
                  recorded.
              dependsOn:
                - T4.1.2
              tracesTo:
                - DEP-2
                - DEP-5
            - id: T4.1.4a
              title: Approval gate on the release path
              completionCriteria:
                - A release delivered to an environment the project marks as
                  requiring approval is impossible without an approval event.
                - Which environments require approval is read from project
                  configuration, never from a hardcoded name.
              dependsOn:
                - T4.1.3
              tracesTo:
                - HIL-2
            - id: T4.1.4b
              title: Approval gate on the environment path, and declaring production
              completionCriteria:
                - Every env.provision operation that can change what a gated
                  environment serves is gated, bringing it down included.
                - production is declared, once nothing can reach it unapproved.
              dependsOn:
                - T4.1.4a
              tracesTo:
                - HIL-2
                - DEP-4
            - id: T4.1.4c
              title: Single-use confirmation for a state that can recur
              completionCriteria:
                - A confirmation of a no-image up, or of a down, given against
                  an environment reporting nothing is spent when that call
                  proceeds, so an identical later call asks for a fresh one.
                - Confirmations of a repository, environment and digest are
                  untouched, which is what a rollback firing in a different run
                  than its deliver depends on.
                - The change says whether a confirmation is spent on the gated
                  call being entered or on its returning, and why that choice
                  fails closed.
                - DESIGN section 9's acceptance of the recurring empty-state
                  identity is withdrawn in the same change.
              dependsOn:
                - T4.1.4b
              tracesTo:
                - HIL-2
                - DEP-2
            - id: T4.1.5
              title: The rollback verb
              completionCriteria:
                - An operator can roll back a declared environment from the CLI;
                  for an environment the project marks as requiring approval,
                  gated only when the digest was never confirmed for that
                  environment.
                - A rollback that reaches the environment is recorded in the
                  event log as having reached it, even when it then fails, and
                  that record exists before the provider is called — the way
                  every other side effect in this kernel is recorded
                  (EffectIntended, src/effect/journal.ts, DESIGN section 6) — so
                  a rollback killed mid-call is not lost.
                - Two rollbacks that fail with the identical error type, one
                  thrown before the environment is touched and one thrown after
                  it has been recreated on the restored digest, are recorded
                  differently (test).
                - "Every refusal this verb can reach before the environment is
                  touched is enumerated in the change and tested to leave no
                  record of a rollback: an environment the manifest does not
                  declare, an absent or unreadable repository, a malformed
                  target release, and a gate refusal. Each records the refusal
                  itself, so an operator who tried is in the log either way
                  (HIL-5). The automatic DEP-2 path, which records a
                  rollback-failed outcome for every throw, is unchanged."
                - A rollback whose provider returns with the environment not up
                  is reported to the operator as a failure and exits non-zero.
                - The failure message says whether the environment may already
                  be serving the restored digest, and what was recorded,
                  alongside the provider's own message (CONV-3).
              dependsOn:
                - T4.1.4b
              tracesTo:
                - DEP-2
                - HIL-5
            - id: T4.1.6
              title: Release outcome artifacts
              completionCriteria:
                - A deploy outcome is written as a versioned artifact and
                  survives the run that produced it.
              dependsOn:
                - T4.1.3
              tracesTo:
                - DEP-5
        - id: M4.2
          title: Observability projections
          verification: Spend and quality dashboards populated from real self-hosted runs;
            kernel overhead measured under 10% of run wall-clock; a
            clean-machine install reaches a gated Definition artifact within one
            hour, timed; a coverage run over this repository's own history names
            every commit whose trace claim it could not read, and names none.
          validatesRisk: null
          tasks:
            - id: T4.2.1
              title: Metrics projections per phase, role and run
              completionCriteria:
                - mpgm status --metrics reports cost, latency, retries and
                  success rates.
              dependsOn: []
              tracesTo:
                - OBS-2
                - NFR-3
            - id: T4.2.2a
              title: Gate rejection and rework rates, per run and in order
              completionCriteria:
                - "Two rejection rates, not one, because this kernel calls two
                  different things a gate: the phase gate an operator approves
                  or rejects (GateApproved, GateRejected, HIL-1) and the merge
                  gate that refuses a change (decideMerge,
                  src/implement/merge.ts, whose MergeRefusal names
                  checks-not-green, no-review, undeclared-deviation and the
                  rest). They are reported separately rather than summed: an
                  operator refusing a phase artifact and CI refusing a merge are
                  different failures with different remedies."
                - Each rate says what it divides by. The phase-gate rate divides
                  GateRejected by the gates that were decided (GateApproved plus
                  GateRejected), not by the gates presented — a gate still
                  waiting on an operator is not a rejection that has yet to
                  happen.
                - "The merge gate logs no refusal. decideMerge returns a
                  MergeDecision and nothing writes it to the log, so this rate
                  is reconstructed from what is written: ChecksReported,
                  ChangeReviewed, and BudgetExceeded for a task out of repair or
                  review rounds. The change says which events it reconstructed
                  from and which MergeRefusal cases it cannot see, rather than
                  implying the taxonomy is fully observable."
                - "The rework rate is not the retry count T4.2.1 already
                  reports. AggregateMetric.retries (src/state/metrics.ts) folds
                  validation retries, CI repair rounds and review rework rounds
                  into one figure. Rework here counts the review rounds that
                  sent a change back to its author: a ChangeReviewed with
                  approved false, and one with approved true whose
                  undeclaredDeviations is not empty — src/implement/loop.ts
                  dispatches a fresh session on both, and the second is the
                  round T4.2.4 spent twelve sessions and $29.52 on. Two tests: a
                  run holding a task repaired for CI and never reworked shows
                  retries and rework differ; a run holding an approving review
                  that carries an undeclared deviation shows the rework rate
                  counts it, so a rate reading approved alone fails."
                - Longitudinal means ordered, not merely three. The report gives
                  each rate per run in the order the log holds them, and a test
                  whose three runs carry deliberately different rates reads
                  three different figures — a report that averages them into
                  one, or that emits a constant, fails that test (CONV-6).
                - The surface is stated rather than assumed. mpgm status
                  --metrics with no --run already prints a metrics block for
                  every run (src/cli/commands.ts), in map-iteration order and
                  with no series across them; whatever this adds — a flag on
                  status or a verb of its own — says which it is and refuses the
                  arguments it cannot honour, the way every other verb does.
                - "The rates are computed from the log as it already stands:
                  this task adds no event, and nothing in src/implement keeps a
                  tally. OBS-4 is a report over history, and a counter kept
                  alongside the loop would be a second source of truth for what
                  the log already holds (ADR-2)."
              dependsOn:
                - T4.2.1
              tracesTo:
                - OBS-4
            - id: T4.2.2b
              title: The escaped-defect rate, over defects nothing has filed yet
              completionCriteria:
                - The rate is read from the Defect artifacts
                  (src/test/defect.ts) through the artifact store. The event
                  catalog has no defect event and this task adds none.
                - A defect is escaped when the ChangeMerged for the task its
                  route names precedes the TaskCompleted that filed the defect
                  artifact. TaskCompleted.artifactRefs and the event's own
                  timestamp are the only dating available, because a Defect
                  history entry carries none. A defect whose route names a task
                  that merged afterwards is the fix, not an escape — counting it
                  would make the rate climb with every defect closed.
                - "The rate divides escaped defects by the tasks that merged,
                  not by the defects filed. A defect still open carries no route
                  and so names no task: it is reported beside the rate as a
                  count no rate can attribute, so a run with five unrouted
                  defects does not read as a run with none."
                - The change says which run a defect belongs to — the run that
                  found it (producedBy.runId on the artifact) or the run that
                  merged the task its route names — since those differ and the
                  report is per run.
                - No run has filed a defect. Nothing outside the tests calls
                  fileDefect, so the rate over this repository's own log reads
                  as no defects filed and not as 0%; a report that cannot tell
                  those two apart fails (test). The test builds its defects
                  through the real transitions — fileDefect, routeDefect,
                  recordFix, retestDefect — never by hand-writing a Defect
                  literal, which can hold a shape the lifecycle never produces.
                - The figure joins the report T4.2.2a delivers rather than
                  arriving on a surface of its own.
              dependsOn:
                - T4.2.2a
              tracesTo:
                - OBS-4
                - TST-5
            - id: T4.2.3
              title: Progress output from a running verb
              completionCriteria:
                - A long-running verb reports each session as it starts and
                  finishes, on the terminal that started it, before the run
                  ends.
              dependsOn: []
              tracesTo:
                - OBS-3
                - NFR-2
            - id: T4.2.4
              title: An operator's control of a running task reaches it
              completionCriteria:
                - A redirection names the task it is aimed at, requeues it, and
                  a planted instruction in the note is demonstrably obeyed by
                  that task's next session.
                - Pause and kill likewise stop the implement loop, which reads
                  none of the three today.
              dependsOn: []
              tracesTo:
                - HIL-3
                - HIL-5
            - id: T4.2.5
              title: A trace claim a commit makes is read, or reported unread
              completionCriteria:
                - "The Traces trailer is read as a traces-to-kind link, which is
                  what the P1 bootstrap commits spell their claims with and what
                  the index does not read today. The set of keys counted as
                  verifying is unchanged: Verifies remains the only one, so
                  nothing this task adds can raise a coverage figure (test)."
                - A trailer value that is not id-shaped puts no node in the
                  graph — it is reported, never indexed; this history carries
                  values like DESIGN section 4.1 and PLAN M1.3 verification
                  alongside the ids. A value that is id-shaped only once
                  trailing punctuation is stripped resolves to that id and never
                  becomes a second node beside it (test).
                - An unrecognised trailer whose values are id-shaped is reported
                  by key and commit, so the next spelling somebody invents is
                  visible rather than discarded. One whose values are not —
                  Co-Authored-By, Signed-off-by — is not reported, and a commit
                  carrying only those produces no output (test).
                - "The tests stand on a repository the test builds, not on this
                  repository's own history: CI checks out at depth one, so a
                  test that counts commits here finds nothing dropped and passes
                  while the defect is live."
                - The keys the index reads are written down where a commit
                  author looks, not only in the module that reads them. The
                  vocabulary was invented around rather than followed because
                  nothing outside that module states it.
                - The change says which requirements move from untraced to
                  traced once these trailers are read. T3.2.1 delivered the
                  coverage report and was accepted against an index that
                  discarded them, so the report changes under a milestone
                  already signed off.
              dependsOn: []
              tracesTo:
                - ADR-4
                - TST-2
    - id: P5
      title: Maintain and Self-Improvement
      intent: "Close the lifecycle loop: signals in, incidents handled, roles
        improved."
      milestones:
        - id: M5.1
          title: Maintain integration
          verification: A synthetic alert becomes a prioritised work item; a simulated
            incident runs detect, operator-approved mitigation, remediation and
            postmortem; an injected CVE advisory yields a severity-prioritised
            upgrade task.
          validatesRisk: null
          tasks:
            - id: T5.1.1
              title: Signal ingestors and the triage role
              completionCriteria:
                - A synthetic alert becomes a prioritised task.
                - An operator-filed GitHub issue becomes a prioritised task.
              dependsOn: []
              tracesTo:
                - MNT-1
                - PMG-3
            - id: T5.1.2
              title: Incident state machine and postmortem playbook
              completionCriteria:
                - A simulated incident runs detect, approve, remediate,
                  postmortem.
              dependsOn:
                - T5.1.1
              tracesTo:
                - MNT-2
            - id: T5.1.3
              title: Dependency upgrade tasks with severity priority
              completionCriteria:
                - An injected CVE advisory yields a severity-prioritised upgrade
                  task.
              dependsOn:
                - T5.1.1
              tracesTo:
                - MNT-3
            - id: T5.1.4
              title: Drift audit tasks
              completionCriteria:
                - Planted drift is detected and a reconciliation task is raised.
              dependsOn: []
              tracesTo:
                - MNT-4
        - id: M5.2
          title: Evals and the improvement loop
          verification: The full eight-phase lifecycle runs on the sample project under
            mpgm, and mpgm's own backlog is maintained by mpgm; every
            REQUIREMENTS MUST maps to a passing verification or a filed defect.
          validatesRisk: null
          tasks:
            - id: T5.2.1a
              title: Eval harness core and the adoption gate
              completionCriteria:
                - A role change without a green eval is blocked.
                - The section 1 role freeze is lifted.
              dependsOn: []
              tracesTo:
                - AGT-6
            - id: T5.2.1b
              title: Per-role eval suites for every shipped role
              completionCriteria:
                - Every shipped role has a green baseline suite.
              dependsOn:
                - T5.2.1a
              tracesTo:
                - AGT-6
            - id: T5.2.2
              title: Feedback miner
              completionCriteria:
                - "One adopted refinement lands via the full loop: miner, diff,
                  review, eval, adopt."
              dependsOn:
                - T5.2.1a
              tracesTo:
                - AGT-7
            - id: T5.2.3
              title: Model routing table
              completionCriteria:
                - The routing table is honoured per task class (test).
              dependsOn: []
              tracesTo:
                - AGT-5
---

# mpgm-plan

## summary

The remaining mpgm plan (P3-P5) as an executable task graph. Task traces cite REQUIREMENTS and DESIGN ids, which are not yet artifacts of this project — that migration is T3.1.8 — so they resolve against the documents rather than against the trace index for now.

## risks

- {"id":"R5","assumption":"Worktree-parallel implementation with merge-gated CI works at useful throughput.","validatedBy":["M3.1"]}
- {"id":"R7","assumption":"Tool-boundary secret brokering (no secrets in session env) is implementable against the SDK.","validatedBy":["M3.1"]}

## phases

- {"id":"P3","title":"Build Loop","intent":"Implement and Test phases, and the point at which mpgm begins executing its own plan.","milestones":[{"id":"M3.1","title":"Implement loop","verification":"mpgm implements, reviews and merges a real task of its own backlog end to end with green CI, with the task journey visible live on the scrum board.","validatesRisk":"R5","tasks":[{"id":"T3.1.1","title":"Worktree manager","completionCriteria":["Parallel tasks touch the same repository without conflict (test)."],"dependsOn":[],"tracesTo":["ADR-5","IMP-1"]},{"id":"T3.1.2a","title":"ci.checks contract and GitHub Actions integration","completionCriteria":["A red CI run blocks the merge."],"dependsOn":[],"tracesTo":["IMP-2","SAF-5"]},{"id":"T3.1.2b","title":"Repair loop with bounded retry and one tier escalation","completionCriteria":["An induced CI failure is repaired within budget.","The tier-escalation retry is exercised.","Budget exhaustion escalates to the operator."],"dependsOn":["T3.1.2a"],"tracesTo":["IMP-2","NFR-1"]},{"id":"T3.1.3","title":"Review flow with an independent reviewer","completionCriteria":["An authored change merges only after an independent review event."],"dependsOn":["T3.1.1","T3.1.2a"],"tracesTo":["IMP-3"]},{"id":"T3.1.4","title":"Convention enforcement in the review rubric","completionCriteria":["A planted deviation is flagged (test)."],"dependsOn":["T3.1.3"],"tracesTo":["IMP-4","CTX-1"]},{"id":"T3.1.5","title":"Secret broker proxy","completionCriteria":["A printenv-style leak test shows no secret in the transcript."],"dependsOn":[],"tracesTo":["ADR-6","SAF-2"]},{"id":"T3.1.6","title":"Destructive-operation guard","completionCriteria":["A destructive call without a prior dry run and confirmation event is blocked (test)."],"dependsOn":[],"tracesTo":["SAF-4"]},{"id":"T3.1.7","title":"PM projector and pm.github contract","completionCriteria":["A board is bootstrapped from the gated Plan.","A task state change is reflected on the board (test).","Re-bootstrapping converges without duplicates."],"dependsOn":[],"tracesTo":["PMG-1","PMG-2","PMG-4"]},{"id":"T3.1.8","title":"Switchover to self-hosting","completionCriteria":["mpgm dispatches and merges its first self-task."],"dependsOn":["T3.1.1","T3.1.2b","T3.1.3","T3.1.4","T3.1.5","T3.1.6","T3.1.7"],"tracesTo":["IMP-1","AGT-6"]},{"id":"T3.1.9","title":"Bootstrap attestation","completionCriteria":["An attested task counts as done for scheduling.","An attested task is never reported as a session mpgm ran (test)."],"dependsOn":["T3.1.8"],"tracesTo":["ORC-3","HIL-5"]}]},{"id":"M3.2","title":"Test phase and dashboard","verification":"A Test phase run over mpgm itself: a coverage report, one adversarially found defect round-tripped to a fix, and the sample service ready for P4.","validatesRisk":null,"tasks":[{"id":"T3.2.1","title":"test.nfr contract and runner","completionCriteria":["The coverage report lists verified and unverified requirements."],"dependsOn":[],"tracesTo":["TST-2","TST-3"]},{"id":"T3.2.2","title":"Adversarial test role","completionCriteria":["A planted bug is caught by generated tests on the sample project."],"dependsOn":[],"tracesTo":["TST-4"]},{"id":"T3.2.3","title":"Flaky detection and quarantine ledger","completionCriteria":["A flaky test is auto-quarantined.","Coverage drops accordingly rather than silently holding."],"dependsOn":["T3.2.1"],"tracesTo":["TST-6","TST-2"]},{"id":"T3.2.4","title":"Defect artifacts and routing","completionCriteria":["A defect round-trips through fix and re-test."],"dependsOn":[],"tracesTo":["TST-5","ORC-1"]},{"id":"T3.2.5a","title":"Dashboard backend: read-only projection API","completionCriteria":["The API serves live run data (test)."],"dependsOn":[],"tracesTo":["OBS-3"]},{"id":"T3.2.5b","title":"Dashboard UI over the projection API","completionCriteria":["The dashboard renders a live run."],"dependsOn":["T3.2.5a"],"tracesTo":["OBS-3"]},{"id":"T3.2.6","title":"Sample service as a deployable web service","completionCriteria":["The service builds and its tests are green in its own repository and CI."],"dependsOn":[],"tracesTo":["IMP-1","IMP-2"]}]}]}
- {"id":"P4","title":"Delivery","intent":"Deploy pipeline and the observability projections over real runs.","milestones":[{"id":"M4.1","title":"Deploy pipeline","verification":"The sample service is deployed to staging and promoted; a second release with an induced fault auto-rolls back with the outcome recorded.","validatesRisk":null,"tasks":[{"id":"T4.1.1","title":"env.provision contract and IaC for test and staging","completionCriteria":["An environment comes up and down from repository config alone."],"dependsOn":[],"tracesTo":["DEP-1","DEP-4"]},{"id":"T4.1.2","title":"release.deliver contract and CD delegation","completionCriteria":["A staged release with a tested rollback path on the sample service."],"dependsOn":["T4.1.1"],"tracesTo":["DEP-2","DEP-3"]},{"id":"T4.1.3","title":"Health verification and promote/rollback decisions","completionCriteria":["An induced regression auto-rolls back and the outcome is recorded."],"dependsOn":["T4.1.2"],"tracesTo":["DEP-2","DEP-5"]},{"id":"T4.1.4a","title":"Approval gate on the release path","completionCriteria":["A release delivered to an environment the project marks as requiring approval is impossible without an approval event.","Which environments require approval is read from project configuration, never from a hardcoded name."],"dependsOn":["T4.1.3"],"tracesTo":["HIL-2"]},{"id":"T4.1.4b","title":"Approval gate on the environment path, and declaring production","completionCriteria":["Every env.provision operation that can change what a gated environment serves is gated, bringing it down included.","production is declared, once nothing can reach it unapproved."],"dependsOn":["T4.1.4a"],"tracesTo":["HIL-2","DEP-4"]},{"id":"T4.1.4c","title":"Single-use confirmation for a state that can recur","completionCriteria":["A confirmation of a no-image up, or of a down, given against an environment reporting nothing is spent when that call proceeds, so an identical later call asks for a fresh one.","Confirmations of a repository, environment and digest are untouched, which is what a rollback firing in a different run than its deliver depends on.","The change says whether a confirmation is spent on the gated call being entered or on its returning, and why that choice fails closed.","DESIGN section 9's acceptance of the recurring empty-state identity is withdrawn in the same change."],"dependsOn":["T4.1.4b"],"tracesTo":["HIL-2","DEP-2"]},{"id":"T4.1.5","title":"The rollback verb","completionCriteria":["An operator can roll back a declared environment from the CLI; for an environment the project marks as requiring approval, gated only when the digest was never confirmed for that environment.","A rollback that reaches the environment is recorded in the event log as having reached it, even when it then fails, and that record exists before the provider is called — the way every other side effect in this kernel is recorded (EffectIntended, src/effect/journal.ts, DESIGN section 6) — so a rollback killed mid-call is not lost.","Two rollbacks that fail with the identical error type, one thrown before the environment is touched and one thrown after it has been recreated on the restored digest, are recorded differently (test).","Every refusal this verb can reach before the environment is touched is enumerated in the change and tested to leave no record of a rollback: an environment the manifest does not declare, an absent or unreadable repository, a malformed target release, and a gate refusal. Each records the refusal itself, so an operator who tried is in the log either way (HIL-5). The automatic DEP-2 path, which records a rollback-failed outcome for every throw, is unchanged.","A rollback whose provider returns with the environment not up is reported to the operator as a failure and exits non-zero.","The failure message says whether the environment may already be serving the restored digest, and what was recorded, alongside the provider's own message (CONV-3)."],"dependsOn":["T4.1.4b"],"tracesTo":["DEP-2","HIL-5"]},{"id":"T4.1.6","title":"Release outcome artifacts","completionCriteria":["A deploy outcome is written as a versioned artifact and survives the run that produced it."],"dependsOn":["T4.1.3"],"tracesTo":["DEP-5"]}]},{"id":"M4.2","title":"Observability projections","verification":"Spend and quality dashboards populated from real self-hosted runs; kernel overhead measured under 10% of run wall-clock; a clean-machine install reaches a gated Definition artifact within one hour, timed; a coverage run over this repository's own history names every commit whose trace claim it could not read, and names none.","validatesRisk":null,"tasks":[{"id":"T4.2.1","title":"Metrics projections per phase, role and run","completionCriteria":["mpgm status --metrics reports cost, latency, retries and success rates."],"dependsOn":[],"tracesTo":["OBS-2","NFR-3"]},{"id":"T4.2.2a","title":"Gate rejection and rework rates, per run and in order","completionCriteria":["Two rejection rates, not one, because this kernel calls two different things a gate: the phase gate an operator approves or rejects (GateApproved, GateRejected, HIL-1) and the merge gate that refuses a change (decideMerge, src/implement/merge.ts, whose MergeRefusal names checks-not-green, no-review, undeclared-deviation and the rest). They are reported separately rather than summed: an operator refusing a phase artifact and CI refusing a merge are different failures with different remedies.","Each rate says what it divides by. The phase-gate rate divides GateRejected by the gates that were decided (GateApproved plus GateRejected), not by the gates presented — a gate still waiting on an operator is not a rejection that has yet to happen.","The merge gate logs no refusal. decideMerge returns a MergeDecision and nothing writes it to the log, so this rate is reconstructed from what is written: ChecksReported, ChangeReviewed, and BudgetExceeded for a task out of repair or review rounds. The change says which events it reconstructed from and which MergeRefusal cases it cannot see, rather than implying the taxonomy is fully observable.","The rework rate is not the retry count T4.2.1 already reports. AggregateMetric.retries (src/state/metrics.ts) folds validation retries, CI repair rounds and review rework rounds into one figure. Rework here counts the review rounds that sent a change back to its author: a ChangeReviewed with approved false, and one with approved true whose undeclaredDeviations is not empty — src/implement/loop.ts dispatches a fresh session on both, and the second is the round T4.2.4 spent twelve sessions and $29.52 on. Two tests: a run holding a task repaired for CI and never reworked shows retries and rework differ; a run holding an approving review that carries an undeclared deviation shows the rework rate counts it, so a rate reading approved alone fails.","Longitudinal means ordered, not merely three. The report gives each rate per run in the order the log holds them, and a test whose three runs carry deliberately different rates reads three different figures — a report that averages them into one, or that emits a constant, fails that test (CONV-6).","The surface is stated rather than assumed. mpgm status --metrics with no --run already prints a metrics block for every run (src/cli/commands.ts), in map-iteration order and with no series across them; whatever this adds — a flag on status or a verb of its own — says which it is and refuses the arguments it cannot honour, the way every other verb does.","The rates are computed from the log as it already stands: this task adds no event, and nothing in src/implement keeps a tally. OBS-4 is a report over history, and a counter kept alongside the loop would be a second source of truth for what the log already holds (ADR-2)."],"dependsOn":["T4.2.1"],"tracesTo":["OBS-4"]},{"id":"T4.2.2b","title":"The escaped-defect rate, over defects nothing has filed yet","completionCriteria":["The rate is read from the Defect artifacts (src/test/defect.ts) through the artifact store. The event catalog has no defect event and this task adds none.","A defect is escaped when the ChangeMerged for the task its route names precedes the TaskCompleted that filed the defect artifact. TaskCompleted.artifactRefs and the event's own timestamp are the only dating available, because a Defect history entry carries none. A defect whose route names a task that merged afterwards is the fix, not an escape — counting it would make the rate climb with every defect closed.","The rate divides escaped defects by the tasks that merged, not by the defects filed. A defect still open carries no route and so names no task: it is reported beside the rate as a count no rate can attribute, so a run with five unrouted defects does not read as a run with none.","The change says which run a defect belongs to — the run that found it (producedBy.runId on the artifact) or the run that merged the task its route names — since those differ and the report is per run.","No run has filed a defect. Nothing outside the tests calls fileDefect, so the rate over this repository's own log reads as no defects filed and not as 0%; a report that cannot tell those two apart fails (test). The test builds its defects through the real transitions — fileDefect, routeDefect, recordFix, retestDefect — never by hand-writing a Defect literal, which can hold a shape the lifecycle never produces.","The figure joins the report T4.2.2a delivers rather than arriving on a surface of its own."],"dependsOn":["T4.2.2a"],"tracesTo":["OBS-4","TST-5"]},{"id":"T4.2.3","title":"Progress output from a running verb","completionCriteria":["A long-running verb reports each session as it starts and finishes, on the terminal that started it, before the run ends."],"dependsOn":[],"tracesTo":["OBS-3","NFR-2"]},{"id":"T4.2.4","title":"An operator's control of a running task reaches it","completionCriteria":["A redirection names the task it is aimed at, requeues it, and a planted instruction in the note is demonstrably obeyed by that task's next session.","Pause and kill likewise stop the implement loop, which reads none of the three today."],"dependsOn":[],"tracesTo":["HIL-3","HIL-5"]},{"id":"T4.2.5","title":"A trace claim a commit makes is read, or reported unread","completionCriteria":["The Traces trailer is read as a traces-to-kind link, which is what the P1 bootstrap commits spell their claims with and what the index does not read today. The set of keys counted as verifying is unchanged: Verifies remains the only one, so nothing this task adds can raise a coverage figure (test).","A trailer value that is not id-shaped puts no node in the graph — it is reported, never indexed; this history carries values like DESIGN section 4.1 and PLAN M1.3 verification alongside the ids. A value that is id-shaped only once trailing punctuation is stripped resolves to that id and never becomes a second node beside it (test).","An unrecognised trailer whose values are id-shaped is reported by key and commit, so the next spelling somebody invents is visible rather than discarded. One whose values are not — Co-Authored-By, Signed-off-by — is not reported, and a commit carrying only those produces no output (test).","The tests stand on a repository the test builds, not on this repository's own history: CI checks out at depth one, so a test that counts commits here finds nothing dropped and passes while the defect is live.","The keys the index reads are written down where a commit author looks, not only in the module that reads them. The vocabulary was invented around rather than followed because nothing outside that module states it.","The change says which requirements move from untraced to traced once these trailers are read. T3.2.1 delivered the coverage report and was accepted against an index that discarded them, so the report changes under a milestone already signed off."],"dependsOn":[],"tracesTo":["ADR-4","TST-2"]}]}]}
- {"id":"P5","title":"Maintain and Self-Improvement","intent":"Close the lifecycle loop: signals in, incidents handled, roles improved.","milestones":[{"id":"M5.1","title":"Maintain integration","verification":"A synthetic alert becomes a prioritised work item; a simulated incident runs detect, operator-approved mitigation, remediation and postmortem; an injected CVE advisory yields a severity-prioritised upgrade task.","validatesRisk":null,"tasks":[{"id":"T5.1.1","title":"Signal ingestors and the triage role","completionCriteria":["A synthetic alert becomes a prioritised task.","An operator-filed GitHub issue becomes a prioritised task."],"dependsOn":[],"tracesTo":["MNT-1","PMG-3"]},{"id":"T5.1.2","title":"Incident state machine and postmortem playbook","completionCriteria":["A simulated incident runs detect, approve, remediate, postmortem."],"dependsOn":["T5.1.1"],"tracesTo":["MNT-2"]},{"id":"T5.1.3","title":"Dependency upgrade tasks with severity priority","completionCriteria":["An injected CVE advisory yields a severity-prioritised upgrade task."],"dependsOn":["T5.1.1"],"tracesTo":["MNT-3"]},{"id":"T5.1.4","title":"Drift audit tasks","completionCriteria":["Planted drift is detected and a reconciliation task is raised."],"dependsOn":[],"tracesTo":["MNT-4"]}]},{"id":"M5.2","title":"Evals and the improvement loop","verification":"The full eight-phase lifecycle runs on the sample project under mpgm, and mpgm's own backlog is maintained by mpgm; every REQUIREMENTS MUST maps to a passing verification or a filed defect.","validatesRisk":null,"tasks":[{"id":"T5.2.1a","title":"Eval harness core and the adoption gate","completionCriteria":["A role change without a green eval is blocked.","The section 1 role freeze is lifted."],"dependsOn":[],"tracesTo":["AGT-6"]},{"id":"T5.2.1b","title":"Per-role eval suites for every shipped role","completionCriteria":["Every shipped role has a green baseline suite."],"dependsOn":["T5.2.1a"],"tracesTo":["AGT-6"]},{"id":"T5.2.2","title":"Feedback miner","completionCriteria":["One adopted refinement lands via the full loop: miner, diff, review, eval, adopt."],"dependsOn":["T5.2.1a"],"tracesTo":["AGT-7"]},{"id":"T5.2.3","title":"Model routing table","completionCriteria":["The routing table is honoured per task class (test)."],"dependsOn":[],"tracesTo":["AGT-5"]}]}]}
