/**
 * mpgm's own remaining plan (P3-P5), as the data behind its Plan artifact.
 *
 * R6 asks whether this document is ingestible as mpgm's own executable task
 * graph. This is that document's P3-P5 tables restructured into the PLN-1
 * hierarchy; `scripts/plan-artifact.mjs` writes it out as the artifact, and
 * `demo:ingest` loads the artifact and schedules it without dispatching.
 *
 * P1 and P2 are complete and deliberately absent: what T3.1.8 loads is the
 * remaining work, and a graph containing finished tasks would schedule them.
 *
 * Keep in step with PLAN.md section 3. The ingest demo fails if a P3-P5 task
 * id appears in one and not the other, which is the only drift a machine can
 * catch — the wording is on whoever edits them.
 */

export const MPGM_PLAN = {
  summary:
    'The remaining mpgm plan (P3-P5) as an executable task graph. Task traces ' +
    'cite REQUIREMENTS and DESIGN ids, which are not yet artifacts of this ' +
    'project — that migration is T3.1.8 — so they resolve against the ' +
    'documents rather than against the trace index for now.',
  risks: [
    {
      id: 'R5',
      assumption:
        'Worktree-parallel implementation with merge-gated CI works at useful throughput.',
      validatedBy: ['M3.1'],
    },
    {
      id: 'R7',
      assumption:
        'Tool-boundary secret brokering (no secrets in session env) is implementable against the SDK.',
      validatedBy: ['M3.1'],
    },
  ],
  phases: [
    {
      id: 'P3',
      title: 'Build Loop',
      intent:
        'Implement and Test phases, and the point at which mpgm begins executing its own plan.',
      milestones: [
        {
          id: 'M3.1',
          title: 'Implement loop',
          verification:
            'mpgm implements, reviews and merges a real task of its own backlog end to ' +
            'end with green CI, with the task journey visible live on the scrum board.',
          validatesRisk: 'R5',
          tasks: [
            {
              id: 'T3.1.1',
              title: 'Worktree manager',
              completionCriteria: [
                'Parallel tasks touch the same repository without conflict (test).',
              ],
              dependsOn: [],
              tracesTo: ['ADR-5', 'IMP-1'],
            },
            {
              id: 'T3.1.2a',
              title: 'ci.checks contract and GitHub Actions integration',
              completionCriteria: ['A red CI run blocks the merge.'],
              dependsOn: [],
              tracesTo: ['IMP-2', 'SAF-5'],
            },
            {
              id: 'T3.1.2b',
              title: 'Repair loop with bounded retry and one tier escalation',
              completionCriteria: [
                'An induced CI failure is repaired within budget.',
                'The tier-escalation retry is exercised.',
                'Budget exhaustion escalates to the operator.',
              ],
              dependsOn: ['T3.1.2a'],
              tracesTo: ['IMP-2', 'NFR-1'],
            },
            {
              id: 'T3.1.3',
              title: 'Review flow with an independent reviewer',
              completionCriteria: [
                'An authored change merges only after an independent review event.',
              ],
              dependsOn: ['T3.1.1', 'T3.1.2a'],
              tracesTo: ['IMP-3'],
            },
            {
              id: 'T3.1.4',
              title: 'Convention enforcement in the review rubric',
              completionCriteria: ['A planted deviation is flagged (test).'],
              dependsOn: ['T3.1.3'],
              tracesTo: ['IMP-4', 'CTX-1'],
            },
            {
              id: 'T3.1.5',
              title: 'Secret broker proxy',
              completionCriteria: [
                'A printenv-style leak test shows no secret in the transcript.',
              ],
              dependsOn: [],
              tracesTo: ['ADR-6', 'SAF-2'],
            },
            {
              id: 'T3.1.6',
              title: 'Destructive-operation guard',
              completionCriteria: [
                'A destructive call without a prior dry run and confirmation event is blocked (test).',
              ],
              dependsOn: [],
              tracesTo: ['SAF-4'],
            },
            {
              id: 'T3.1.7',
              title: 'PM projector and pm.github contract',
              completionCriteria: [
                'A board is bootstrapped from the gated Plan.',
                'A task state change is reflected on the board (test).',
                'Re-bootstrapping converges without duplicates.',
              ],
              dependsOn: [],
              tracesTo: ['PMG-1', 'PMG-2', 'PMG-4'],
            },
            {
              id: 'T3.1.8',
              title: 'Switchover to self-hosting',
              completionCriteria: ['mpgm dispatches and merges its first self-task.'],
              dependsOn: [
                'T3.1.1',
                'T3.1.2b',
                'T3.1.3',
                'T3.1.4',
                'T3.1.5',
                'T3.1.6',
                'T3.1.7',
              ],
              tracesTo: ['IMP-1', 'AGT-6'],
            },
            {
              id: 'T3.1.9',
              title: 'Bootstrap attestation',
              completionCriteria: [
                'An attested task counts as done for scheduling.',
                'An attested task is never reported as a session mpgm ran (test).',
              ],
              dependsOn: ['T3.1.8'],
              tracesTo: ['ORC-3', 'HIL-5'],
            },
          ],
        },
        {
          id: 'M3.2',
          title: 'Test phase and dashboard',
          verification:
            'A Test phase run over mpgm itself: a coverage report, one adversarially ' +
            'found defect round-tripped to a fix, and the sample service ready for P4.',
          validatesRisk: null,
          tasks: [
            {
              id: 'T3.2.1',
              title: 'test.nfr contract and runner',
              completionCriteria: [
                'The coverage report lists verified and unverified requirements.',
              ],
              dependsOn: [],
              tracesTo: ['TST-2', 'TST-3'],
            },
            {
              id: 'T3.2.2',
              title: 'Adversarial test role',
              completionCriteria: [
                'A planted bug is caught by generated tests on the sample project.',
              ],
              dependsOn: [],
              tracesTo: ['TST-4'],
            },
            {
              id: 'T3.2.3',
              title: 'Flaky detection and quarantine ledger',
              completionCriteria: [
                'A flaky test is auto-quarantined.',
                'Coverage drops accordingly rather than silently holding.',
              ],
              dependsOn: ['T3.2.1'],
              tracesTo: ['TST-6', 'TST-2'],
            },
            {
              id: 'T3.2.4',
              title: 'Defect artifacts and routing',
              completionCriteria: ['A defect round-trips through fix and re-test.'],
              dependsOn: [],
              tracesTo: ['TST-5', 'ORC-1'],
            },
            {
              id: 'T3.2.5a',
              title: 'Dashboard backend: read-only projection API',
              completionCriteria: ['The API serves live run data (test).'],
              dependsOn: [],
              tracesTo: ['OBS-3'],
            },
            {
              id: 'T3.2.5b',
              title: 'Dashboard UI over the projection API',
              completionCriteria: ['The dashboard renders a live run.'],
              dependsOn: ['T3.2.5a'],
              tracesTo: ['OBS-3'],
            },
            {
              id: 'T3.2.6',
              title: 'Sample service as a deployable web service',
              completionCriteria: [
                'The service builds and its tests are green in its own repository and CI.',
              ],
              dependsOn: [],
              tracesTo: ['IMP-1', 'IMP-2'],
            },
          ],
        },
      ],
    },
    {
      id: 'P4',
      title: 'Delivery',
      intent: 'Deploy pipeline and the observability projections over real runs.',
      milestones: [
        {
          id: 'M4.1',
          title: 'Deploy pipeline',
          verification:
            'The sample service is deployed to staging and promoted; a second release ' +
            'with an induced fault auto-rolls back with the outcome recorded.',
          validatesRisk: null,
          tasks: [
            {
              id: 'T4.1.1',
              title: 'env.provision contract and IaC for test and staging',
              completionCriteria: [
                'An environment comes up and down from repository config alone.',
              ],
              dependsOn: [],
              tracesTo: ['DEP-1', 'DEP-4'],
            },
            {
              id: 'T4.1.2',
              title: 'release.deliver contract and CD delegation',
              completionCriteria: [
                'A staged release with a tested rollback path on the sample service.',
              ],
              dependsOn: ['T4.1.1'],
              tracesTo: ['DEP-2', 'DEP-3'],
            },
            {
              id: 'T4.1.3',
              title: 'Health verification and promote/rollback decisions',
              completionCriteria: [
                'An induced regression auto-rolls back and the outcome is recorded.',
              ],
              dependsOn: ['T4.1.2'],
              tracesTo: ['DEP-2', 'DEP-5'],
            },
            {
              id: 'T4.1.4a',
              title: 'Approval gate on the release path',
              completionCriteria: [
                'A release delivered to an environment the project marks as ' +
                  'requiring approval is impossible without an approval event.',
                'Which environments require approval is read from project ' +
                  'configuration, never from a hardcoded name.',
              ],
              dependsOn: ['T4.1.3'],
              tracesTo: ['HIL-2'],
            },
            {
              id: 'T4.1.4b',
              title: 'Approval gate on the environment path, and declaring production',
              completionCriteria: [
                'Every env.provision operation that can change what a gated ' +
                  'environment serves is gated, bringing it down included.',
                'production is declared, once nothing can reach it unapproved.',
              ],
              dependsOn: ['T4.1.4a'],
              tracesTo: ['HIL-2', 'DEP-4'],
            },
            {
              id: 'T4.1.4c',
              title: 'Single-use confirmation for a state that can recur',
              completionCriteria: [
                'A confirmation of a no-image up, or of a down, given against ' +
                  'an environment reporting nothing is spent when that call ' +
                  'proceeds, so an identical later call asks for a fresh one.',
                'Confirmations of a repository, environment and digest are ' +
                  'untouched, which is what a rollback firing in a different ' +
                  'run than its deliver depends on.',
                'The change says whether a confirmation is spent on the gated ' +
                  'call being entered or on its returning, and why that choice ' +
                  'fails closed.',
                "DESIGN section 9's acceptance of the recurring empty-state " +
                  'identity is withdrawn in the same change.',
              ],
              dependsOn: ['T4.1.4b'],
              tracesTo: ['HIL-2', 'DEP-2'],
            },
            {
              id: 'T4.1.5',
              title: 'The rollback verb',
              completionCriteria: [
                'An operator can roll back a declared environment from the CLI; ' +
                  'for an environment the project marks as requiring approval, ' +
                  'gated only when the digest was never confirmed for that ' +
                  'environment.',
                'A rollback that reaches the environment is recorded in the event ' +
                  'log as having reached it, even when it then fails, and that ' +
                  'record exists before the provider is called — the way every ' +
                  'other side effect in this kernel is recorded (EffectIntended, ' +
                  'src/effect/journal.ts, DESIGN section 6) — so a rollback ' +
                  'killed mid-call is not lost.',
                'Two rollbacks that fail with the identical error type, one ' +
                  'thrown before the environment is touched and one thrown after ' +
                  'it has been recreated on the restored digest, are recorded ' +
                  'differently (test).',
                'Every refusal this verb can reach before the environment is ' +
                  'touched is enumerated in the change and tested to leave no ' +
                  'record of a rollback: an environment the manifest does not ' +
                  'declare, an absent or unreadable repository, a malformed ' +
                  'target release, and a gate refusal. Each records the refusal ' +
                  'itself, so an operator who tried is in the log either way ' +
                  '(HIL-5). The automatic DEP-2 path, which records a ' +
                  'rollback-failed outcome for every throw, is unchanged.',
                'A rollback whose provider returns with the environment not up ' +
                  'is reported to the operator as a failure and exits non-zero.',
                'The failure message says whether the environment may already be ' +
                  'serving the restored digest, and what was recorded, alongside ' +
                  "the provider's own message (CONV-3).",
              ],
              dependsOn: ['T4.1.4b'],
              tracesTo: ['DEP-2', 'HIL-5'],
            },
            {
              id: 'T4.1.6',
              title: 'Release outcome artifacts',
              completionCriteria: [
                'A deploy outcome is written as a versioned artifact and ' +
                  'survives the run that produced it.',
              ],
              dependsOn: ['T4.1.3'],
              tracesTo: ['DEP-5'],
            },
          ],
        },
        {
          id: 'M4.2',
          title: 'Observability projections',
          verification:
            'Spend and quality dashboards populated from real self-hosted runs; kernel ' +
            'overhead measured under 10% of run wall-clock; a clean-machine install ' +
            'reaches a gated Definition artifact within one hour, timed; a redirection ' +
            'issued while a task is in flight changes what its next session is told; a ' +
            "coverage run over this repository's own history names every commit whose " +
            'trace claim it could not read, and names none.',
          validatesRisk: null,
          tasks: [
            {
              id: 'T4.2.1',
              title: 'Metrics projections per phase, role and run',
              completionCriteria: [
                'mpgm status --metrics reports cost, latency, retries and success rates.',
              ],
              dependsOn: [],
              tracesTo: ['OBS-2', 'NFR-3'],
            },
            {
              id: 'T4.2.2a',
              title: 'Gate rejection and rework rates, per run and in order',
              completionCriteria: [
                'Two rejection rates, not one, because this kernel calls two ' +
                  'different things a gate: the phase gate an operator ' +
                  'approves or rejects (GateApproved, GateRejected, HIL-1) ' +
                  'and the merge gate that refuses a change (decideMerge, ' +
                  'src/implement/merge.ts, whose MergeRefusal names ' +
                  'checks-not-green, no-review, undeclared-deviation and the ' +
                  'rest). They are reported separately rather than summed: an ' +
                  'operator refusing a phase artifact and CI refusing a merge ' +
                  'are different failures with different remedies.',
                'Each rate says what it divides by. The phase-gate rate ' +
                  'divides GateRejected by the gates that were decided ' +
                  '(GateApproved plus GateRejected), not by the gates ' +
                  'presented — a gate still waiting on an operator is not a ' +
                  'rejection that has yet to happen.',
                'The merge gate logs no refusal. decideMerge returns a ' +
                  'MergeDecision and nothing writes it to the log, so this ' +
                  'rate is reconstructed from what is written: ' +
                  'ChecksReported, ChangeReviewed, and BudgetExceeded for a ' +
                  'task out of repair or review rounds. The change says which ' +
                  'events it reconstructed from and which MergeRefusal cases ' +
                  'it cannot see, rather than implying the taxonomy is fully ' +
                  'observable.',
                'The rework rate is not the retry count T4.2.1 already ' +
                  'reports. AggregateMetric.retries (src/state/metrics.ts) ' +
                  'folds validation retries, CI repair rounds and review ' +
                  'rework rounds into one figure. Rework here counts the ' +
                  'review rounds that sent a change back to its author: a ' +
                  'ChangeReviewed with approved false, and one with approved ' +
                  'true whose undeclaredDeviations is not empty — ' +
                  'src/implement/loop.ts dispatches a fresh session on both, ' +
                  'and the second is the round T4.2.4 spent twelve sessions ' +
                  'and $29.52 on. Two tests: a run holding a task repaired ' +
                  'for CI and never reworked shows retries and rework differ; ' +
                  'a run holding an approving review that carries an ' +
                  'undeclared deviation shows the rework rate counts it, so a ' +
                  'rate reading approved alone fails.',
                'Longitudinal means ordered, not merely three. The report ' +
                  'gives each rate per run in the order the log holds them, ' +
                  'and a test whose three runs carry deliberately different ' +
                  'rates reads three different figures — a report that ' +
                  'averages them into one, or that emits a constant, fails ' +
                  'that test (CONV-6).',
                'The surface is stated rather than assumed. mpgm status ' +
                  '--metrics with no --run already prints a metrics block for ' +
                  'every run (src/cli/commands.ts), in map-iteration order ' +
                  'and with no series across them; whatever this adds — a ' +
                  'flag on status or a verb of its own — says which it is and ' +
                  'refuses the arguments it cannot honour, the way every ' +
                  'other verb does.',
                'The rates are computed from the log as it already stands: ' +
                  'this task adds no event, and nothing in src/implement ' +
                  'keeps a tally. OBS-4 is a report over history, and a ' +
                  'counter kept alongside the loop would be a second source ' +
                  'of truth for what the log already holds (ADR-2).',
              ],
              dependsOn: ['T4.2.1'],
              tracesTo: ['OBS-4'],
            },
            {
              id: 'T4.2.2b',
              title: 'The escaped-defect rate, over defects nothing has filed yet',
              completionCriteria: [
                'The rate is read from the Defect artifacts ' +
                  '(src/test/defect.ts) through the artifact store. The event ' +
                  'catalog has no defect event and this task adds none.',
                'A defect is escaped when the ChangeMerged for the task its ' +
                  'route names precedes the TaskCompleted that filed the ' +
                  'defect artifact. TaskCompleted.artifactRefs and the ' +
                  "event's own timestamp are the only dating available, " +
                  'because a Defect history entry carries none. A defect ' +
                  'whose route names a task that merged afterwards is the ' +
                  'fix, not an escape — counting it would make the rate climb ' +
                  'with every defect closed.',
                'The rate divides escaped defects by the tasks that merged, ' +
                  'not by the defects filed. A defect still open carries no ' +
                  'route and so names no task: it is reported beside the rate ' +
                  'as a count no rate can attribute, so a run with five ' +
                  'unrouted defects does not read as a run with none.',
                'The change says which run a defect belongs to — the run that ' +
                  'found it (producedBy.runId on the artifact) or the run ' +
                  'that merged the task its route names — since those differ ' +
                  'and the report is per run.',
                'No run has filed a defect. Nothing outside the tests calls ' +
                  "fileDefect, so the rate over this repository's own log " +
                  'reads as no defects filed and not as 0%; a report that ' +
                  'cannot tell those two apart fails (test). The test builds ' +
                  'its defects through the real transitions — fileDefect, ' +
                  'routeDefect, recordFix, retestDefect — never by ' +
                  'hand-writing a Defect literal, which can hold a shape the ' +
                  'lifecycle never produces.',
                'The figure joins the report T4.2.2a delivers rather than ' +
                  'arriving on a surface of its own.',
              ],
              dependsOn: ['T4.2.2a'],
              tracesTo: ['OBS-4', 'TST-5'],
            },
            {
              id: 'T4.2.3',
              title: 'Progress output from a running verb',
              completionCriteria: [
                'A long-running verb reports each session as it starts and ' +
                  'finishes, on the terminal that started it, before the run ends.',
              ],
              dependsOn: [],
              tracesTo: ['OBS-3', 'NFR-2'],
            },
            {
              id: 'T4.2.4',
              title: "An operator's control of a running task reaches it",
              completionCriteria: [
                'A redirection names the task it is aimed at, requeues it, and ' +
                  'a planted instruction in the note is demonstrably obeyed by ' +
                  "that task's next session.",
                'Pause and kill likewise stop the implement loop, which reads ' +
                  'none of the three today.',
              ],
              dependsOn: [],
              tracesTo: ['HIL-3', 'HIL-5'],
            },
            {
              id: 'T4.2.5',
              title: 'A trace claim a commit makes is read, or reported unread',
              completionCriteria: [
                'The Traces trailer is read as a traces-to-kind link, which is ' +
                  'what the P1 bootstrap commits spell their claims with and ' +
                  'what the index does not read today. The set of keys counted ' +
                  'as verifying is unchanged: Verifies remains the only one, ' +
                  'so nothing this task adds can raise a coverage figure ' +
                  '(test).',
                'A trailer value that is not id-shaped puts no node in the ' +
                  'graph — it is reported, never indexed; this history carries ' +
                  'values like DESIGN section 4.1 and PLAN M1.3 verification ' +
                  'alongside the ids. A value that is id-shaped only once ' +
                  'trailing punctuation is stripped resolves to that id and ' +
                  'never becomes a second node beside it (test).',
                'An unrecognised trailer whose values are id-shaped is ' +
                  'reported by key and commit, so the next spelling somebody ' +
                  'invents is visible rather than discarded. One whose values ' +
                  'are not — Co-Authored-By, Signed-off-by — is not reported, ' +
                  'and a commit carrying only those produces no output (test).',
                'The tests stand on a repository the test builds, not on this ' +
                  "repository's own history: CI checks out at depth one, so a " +
                  'test that counts commits here finds nothing dropped and ' +
                  'passes while the defect is live.',
                'The keys the index reads are written down where a commit ' +
                  'author looks, not only in the module that reads them. The ' +
                  'vocabulary was invented around rather than followed because ' +
                  'nothing outside that module states it.',
                'The change says which requirements move from untraced to ' +
                  'traced once these trailers are read. T3.2.1 delivered the ' +
                  'coverage report and was accepted against an index that ' +
                  'discarded them, so the report changes under a milestone ' +
                  'already signed off.',
              ],
              dependsOn: [],
              tracesTo: ['ADR-4', 'TST-2'],
            },
            {
              id: 'T4.2.6',
              title: "The dashboard carries the run's own figures",
              completionCriteria: [
                'The run page carries the per-phase and per-role breakdown, ' +
                  'latency, retries, success rate and the quality rates — the ' +
                  'figures T3.2.5a and T3.2.5b did not deliver. Run-level ' +
                  'spend already ' +
                  'renders (src/dashboard/render.ts) and is not what is ' +
                  'missing. M4.2 is verified on spend and quality dashboards ' +
                  'populated from real runs, and computeRunMetrics ' +
                  '(src/state/metrics.ts) is reached today only from ' +
                  'src/cli/commands.ts.',
                "The figures come from the run's events and the artifact " +
                  'store, not from its folded state. runProjection ' +
                  '(src/dashboard/projection.ts) takes a RunState, which ' +
                  'carries run-level spend correctly but folds away which ' +
                  'phase was current at dispatch and how long a task took.',
                'The per-task spend the page shows today is wrong, and this ' +
                  "change corrects it. reduce.ts resets a task's usage to " +
                  'zero on every TaskDispatched, so the column in ' +
                  'src/dashboard/render.ts reports a repaired or reworked ' +
                  "task's last session alone. That column reads the figure " +
                  'computeRunMetrics computes, or the panel is a second wrong ' +
                  'answer standing beside a right one.',
                'A figure with nothing to say renders as having nothing to ' +
                  'say. computeRunMetrics already returns null rather than 0 ' +
                  'for successRate and avgLatencyMs, for exactly this reason; ' +
                  'a panel printing 0% for a run where no task has finished ' +
                  'reports total failure (test).',
                'The test asserts the figures the page shows, not the ' +
                  'headings above them. A panel that renders its labels and ' +
                  'no data satisfies any test that only looks for the ' +
                  'section, which is how a promised panel can appear to ' +
                  'exist (CONV-6).',
                'DashboardServer (src/dashboard/server.ts) takes a projector ' +
                  'and a trace index today; the event log and artifact store ' +
                  'these figures need are plumbed through serve ' +
                  '(src/cli/commands.ts), which already holds the root and ' +
                  'the schemas.',
              ],
              dependsOn: ['T4.2.2b'],
              tracesTo: ['OBS-2', 'OBS-3'],
            },
            {
              id: 'T4.2.7',
              title: 'A completed task names the artifacts it produced',
              completionCriteria: [
                'TaskCompleted carries artifactRefs naming the artifacts the ' +
                  'task produced, in place of the artifactRefs: [] ' +
                  'SessionRunner emits unconditionally today ' +
                  '(src/agent/runner.ts, its one append site). Nothing ' +
                  'downstream changes to read them: artifactRefSchema is ' +
                  'already in the catalog (src/event/catalog.ts), reduce.ts ' +
                  'already folds the field onto task state, and mpgm elicit ' +
                  '(src/cli/commands.ts) already populates it. ' +
                  'src/demo/workload.ts emits a populated TaskCompleted too, ' +
                  'but it is a fixture generator rather than the task path. ' +
                  'This is a producer gap on the task path alone.',
                'The change says where the refs come from without breaking ' +
                  'the implement loop. SessionRunner appends TaskCompleted ' +
                  'inside runTask and holds no artifact store, and runTask ' +
                  'has two production callers: src/phase/runner.ts, which ' +
                  'writes the artifact only after runTask has returned, so ' +
                  'the artifact does not exist when the event is written ' +
                  'today; and src/implement/loop.ts, which has no artifact ' +
                  'store and no declared output at all. Moving the append ' +
                  'into the phase runner would leave every implement, review ' +
                  'and rework session with no TaskCompleted — reduce.ts never ' +
                  'marks those tasks completed and completedTasks ' +
                  '(src/plan/apply.ts) empties, which stops self-hosting. A ' +
                  'test covers an implement-loop session as well as a phase ' +
                  'session and fails if either stops completing.',
                'The test drives a real phase run and asserts the refs ' +
                  'against the artifacts the store holds afterwards, by id, ' +
                  'path and version. A test asserting only that artifactRefs ' +
                  'is non-empty passes on one hard-coded ref, which is the ' +
                  'shape of a criterion satisfied by a no-op (CONV-6).',
                'src/state/escaped-defect-rate.ts is corrected. Its doc says ' +
                  'TaskCompleted.artifactRefs and the event timestamp are the ' +
                  'only dating available for when a defect was filed, and ' +
                  "T4.2.2b's criterion above says the same — that is the " +
                  'statement being corrected, not a second opinion standing ' +
                  'beside it. Artifact producedBy.task names the task that ' +
                  'wrote that version, so the fallback dating is the ' +
                  'lowest-version Defect record — the version fileDefect ' +
                  "wrote — and that task's TaskCompleted timestamp. Not the " +
                  'latest version: the module reduces to latestPerId before ' +
                  'it counts anything, and for a routed or verified defect ' +
                  "the latest provenance is routeDefect's or retestDefect's " +
                  'task, whose completion falls after the merge and would ' +
                  'flip a fix into an escape — the defect commit 0f5d0cf ' +
                  'already fixed once from the artifactRefs side.',
                'That fallback is tested on a defect handed in at all four ' +
                  'lifecycle versions, not one. A single-version fixture ' +
                  'cannot tell the lowest-version provenance from the latest, ' +
                  'so it passes with the misdating live (CONV-6). The test ' +
                  'asserts that a fix landing — the named task merging after ' +
                  'the defect was filed — still reads as not escaped when ' +
                  'artifactRefs is empty and only the fallback is available.',
                'undated keeps a case some input can still reach, and the ' +
                  'change names it. A task still running is not it: the phase ' +
                  'runner writes the artifact only after the session ' +
                  'completed, so the artifact strictly post-dates the event. ' +
                  'The production case is the panel tally — src/playbook/' +
                  'graph.ts gives a tally step the produces of the node it ' +
                  'closes, src/phase/runner.ts writes that artifact, and a ' +
                  'tally emits VoteTallied and never TaskCompleted because it ' +
                  'runs no session. A tally-produced artifact is datable by ' +
                  'neither route, and that is what undated reports.',
                'This task files no defect and does not make the rate ' +
                  'non-zero. phases/ holds definition, scope, design and plan ' +
                  'playbooks and no test playbook, and fileDefect has no call ' +
                  'site outside the export list in src/index.ts, so nothing ' +
                  'yet writes a Defect artifact. Nothing reads ' +
                  'TaskState.artifactRefs either — every production reader of ' +
                  'artifactRefs today is on GateState. The refs are for ' +
                  'OBS-1 run reconstruction; the rate still reads as no ' +
                  'defects filed rather than 0%, and the change says so ' +
                  'rather than reporting something it has made measurable in ' +
                  'principle only.',
              ],
              dependsOn: ['T4.2.2b'],
              tracesTo: ['OBS-1', 'OBS-4'],
            },
            {
              id: 'T4.2.8',
              title: "A session's own duration is recorded",
              completionCriteria: [
                'The log records how long a session took. Nothing does ' +
                  'today: SessionResult (src/agent/session.ts) carries ' +
                  'termination, structured output, usage, turns, denials and ' +
                  'an error message and no duration, and ' +
                  'src/agent/claude-provider.ts maps only total_cost_usd, ' +
                  'usage, num_turns and permission_denials off the SDK ' +
                  'result. Without this there is no overhead figure to ' +
                  'compute (T4.2.9), only task span, which is what ' +
                  'metrics.ts already reports as latency.',
                'The SDK reports more than one duration and the change says ' +
                  'which it took and why. duration_ms is the whole CLI ' +
                  "session, and this harness's own work runs inside it — the " +
                  'PreToolUse policy gate, secret substitution, and the ' +
                  'ToolCallLogged append the gate makes on every tool call, ' +
                  "which is most of the events in this repository's log. " +
                  'Subtracting the whole session as model time would charge ' +
                  "the harness's in-session cost to the model and understate " +
                  'exactly the figure NFR-3 bounds. The API time is the ' +
                  'narrower reading; recording both is the option that lets ' +
                  'T4.2.9 report the difference rather than pick blind.',
                'CONV-7 is followed as written, not paraphrased: add a field, ' +
                  'bump the registered version, and carry older payloads ' +
                  'forward with an upcaster (kb/conventions.md). ' +
                  'EventRegistry.validate throws when a required field is ' +
                  'absent at v1, so an added required field without the bump ' +
                  'breaks replay of every run already on disk. The precedent ' +
                  'in this repository is operatorIntervened v1 to v2 with ' +
                  'upcastOperatorIntervenedV1 (src/event/catalog.ts). A run ' +
                  'from before this task must replay, and must read as ' +
                  'unmeasured rather than as a session that took no time.',
                'Every construction site of a SessionResult is covered, not ' +
                  'just the live provider. runWithWallClock (src/agent/' +
                  'budget.ts) builds a synthetic result when a wall-clock ' +
                  'budget trips, and the scripted provider builds them for ' +
                  'tests; a duration that is present on one path and absent ' +
                  'on the others produces a figure that silently changes ' +
                  'meaning with how the session ended.',
                'A test replays a log written before the field existed and ' +
                  'one written after, and the two fold without error to ' +
                  'different readings. A test that only checks the new field ' +
                  'round-trips passes while the upcaster is missing (CONV-6).',
              ],
              dependsOn: [],
              tracesTo: ['OBS-1', 'NFR-3'],
            },
            {
              id: 'T4.2.9',
              title: 'Harness overhead, against a denominator that means something',
              completionCriteria: [
                'The numerator is stated as a formula before anything is ' +
                  'reported. NFR-3 bounds scheduling, context assembly and ' +
                  'validation; the change says which spans it subtracts from ' +
                  'which, names any of the three it cannot see, and does not ' +
                  'report a single figure that implies all three. Context ' +
                  'assembly is measurable at both its call sites — ' +
                  'assembleContext in src/phase/runner.ts and again in ' +
                  'src/implement/loop.ts, which is the path every mpgm ' +
                  'implement uses — and both are outside runTask, so neither ' +
                  'falls inside the span a session duration covers.',
                'The denominator is not the raw span of a run, and the change ' +
                  'says what it used instead. A run id defaults to run-1 ' +
                  '(src/cli/main.ts) and every verb appends RunStarted only ' +
                  'if the run does not already exist, so one run accumulates ' +
                  'across weeks of separate CLI invocations: this ' +
                  "repository's own log holds a single run of 11,735 events " +
                  'spanning 27 August to 15 September 2026, almost all of ' +
                  'which is the operator not being at the keyboard. ' +
                  'RunState.startedAt to the last event would put nineteen ' +
                  'days under the division and report overhead near 100%, ' +
                  'which measures operator absence and not the harness.',
                'Summing task spans is not the alternative. Over that same ' +
                  'log the first TaskDispatched to TaskCompleted spans sum to ' +
                  'more than twice the run span, because runPhase schedules ' +
                  'to a concurrency of four and because separate CLI ' +
                  'invocations overlap within one run id. A numerator built ' +
                  'that way goes negative. The change states its idle rule ' +
                  'and shows the figure moving when that rule changes.',
                'T4.2.1 already claims NFR-3 and does not measure it. Its ' +
                  'tracesTo carries NFR-3 while its criterion reads that mpgm ' +
                  'status --metrics reports cost, latency, retries and ' +
                  'success rates — latency is task span, not overhead. The ' +
                  'change says so, so the trace index does not show NFR-3 ' +
                  'covered twice with one of them false.',
                'Two runs at deliberately different ratios read different ' +
                  'figures, and a run whose sessions carry no recorded ' +
                  'duration reads as unmeasured rather than 0% — the null ' +
                  'discipline computeRunMetrics holds for successRate and ' +
                  'avgLatencyMs and computeGateRates holds for a gate nobody ' +
                  'decided. A constant, or a figure whose two sides come from ' +
                  'the same span, passes a test that only checks a number ' +
                  'came back (CONV-6).',
                'The measured figure is reported against the 10% threshold ' +
                  'over a real self-hosted run, and DESIGN ADR-1 is cited ' +
                  'either way. That is the only place DESIGN mentions NFR-3, ' +
                  'and it asserts the harness is I/O-bound around model calls ' +
                  'and that NFR-3 is trivially met — a measurement over the ' +
                  'threshold would contradict a stated ADR rationale, which ' +
                  'is a finding and not an implementation detail.',
              ],
              dependsOn: ['T4.2.8', 'T4.2.6'],
              tracesTo: ['NFR-3', 'OBS-2'],
            },
            {
              id: 'T4.2.10',
              title: 'A first gated Definition artifact, from a clean install and timed',
              completionCriteria: [
                'The elapsed time from a fresh clone to an approved ' +
                  'Definition gate is measured and reported. NFR-6 is a ' +
                  'threshold — within one hour — so improving the path ' +
                  'without timing a real walk of it verifies nothing, and an ' +
                  'estimate is not a measurement.',
                'The walk includes the step that makes the phase runnable at ' +
                  'all. phases/definition.yaml declares ' +
                  'definition-elicitation at optional false, produced by mpgm ' +
                  'chat definition before the phase runs, and src/phase/' +
                  'runner.ts returns blocked with a missing required input ' +
                  'before dispatching anything without it. That interactive ' +
                  'dialogue is the unbounded term inside the hour NFR-6 ' +
                  'bounds, and a quick start that omits it documents a second ' +
                  'command that blocks.',
                'The path is written where a newcomer looks. README.md is 36 ' +
                  'lines, its quick start is npm install and npm run check, ' +
                  'and it names no mpgm verb, no credentials and no phase; ' +
                  'its status line still says the kernel begins at T1.1.2, ' +
                  'wrong since self-hosting began at T3.1.8; and its account ' +
                  'of npm run check omits the secret scan and the milestone ' +
                  'demos, four of which need Docker. DESIGN section 4.4 does ' +
                  'enumerate the verbs, so they are not undocumented — but a ' +
                  'design document is not a quick start, and mpgm is not on ' +
                  'PATH: package.json is private and the invocation is node ' +
                  './bin/mpgm.mjs.',
                'What is new here is the timing and the documentation, and ' +
                  'the change says so rather than rebuilding M1.3. ' +
                  'scripts/demo/definition-phase.mjs already creates a clean ' +
                  'workspace, runs chat definition then run definition, ' +
                  'asserts the gate was presented and not auto-approved, ' +
                  'approves it and replays. Its operator answers are ' +
                  'scripted, so timing it measures a scripted operator rather ' +
                  'than the competent engineer NFR-6 describes; the change ' +
                  'says which of the two it timed.',
                'The measurement is taken from a clean environment and the ' +
                  'change says how it got one. A node_modules, a dist or a ' +
                  '.mpgm directory carried over from a machine that has ' +
                  'already built this repository hides exactly the setup cost ' +
                  'NFR-6 is about, and the build is required: bin/mpgm.mjs ' +
                  'imports from dist.',
                'It is operator-run rather than in CI, with the other demos ' +
                  'that make real model calls. A timing taken without ' +
                  'credentials would be measuring the failure path.',
                'The measured time is the finding, whatever it is. If the ' +
                  'walk takes longer than an hour, or cannot be completed ' +
                  'without opening a source file, that is reported rather ' +
                  'than worked around by moving where the walk starts or ' +
                  'stops.',
              ],
              dependsOn: [],
              tracesTo: ['NFR-6'],
            },
            {
              id: 'T4.2.11',
              title: 'A sentence that starts with a trailer key is not a trace claim',
              completionCriteria: [
                'A Key: value line inside a prose paragraph is not read as a ' +
                  'trailer. extractCommitLinks (src/trace/links.ts) scans ' +
                  'every line of a commit body, so the wrapped sentence ' +
                  '"verifies: tracesTo, which extractArtifactLinks turned ' +
                  'into verifies" — carried mid-paragraph by two commits in ' +
                  'this history — is read as a verifies claim with two ' +
                  "comma-separated values. T4.2.5's id-shape filter refuses " +
                  'those values, so today the cost is four NOTE lines rather ' +
                  'than four graph edges; but the key that got through is ' +
                  'Verifies, the only one TraceIndexStore.coverage counts, ' +
                  'and a prose line reading "Verifies: ORC-1, because ..." ' +
                  'would raise a coverage figure.',
                "Git's own trailer parsing is not the fix and the change does " +
                  'not reach for it. git log --format=%(trailers) reads only ' +
                  'the last paragraph of a message, and on this repository it ' +
                  'returns a trailer for none of the 24 commits carrying ' +
                  'Traces: — those commits put Traces: in its own paragraph ' +
                  'above Co-Authored-By:, so git never sees it. Delegating to ' +
                  'git would silently discard every claim T4.2.5 just made ' +
                  'readable.',
                'The rule is measured against this history before it is ' +
                  'adopted. Over main today, 62 recognised-key trailer lines ' +
                  'sit in paragraphs whose every line is Key: value shaped, ' +
                  'and exactly 2 sit inside prose — the two above. A rule ' +
                  'requiring the containing paragraph to be entirely ' +
                  'trailer-shaped therefore drops both false positives and ' +
                  'keeps all 62 real claims. The change reports those two ' +
                  'counts for whatever rule it picks, and a rule that drops ' +
                  'any of the 62 is not the rule.',
                'A test carries a commit whose body has a prose line ' +
                  'beginning Verifies: and asserts no verifying link is ' +
                  'created, and a second commit whose trailer paragraph is ' +
                  'well formed and asserts the link is. Without the second ' +
                  'half the test passes on a parser that reads no trailers at ' +
                  'all (CONV-6).',
                'The test builds its own repository rather than walking this ' +
                  'one. CI checks this repository out at depth one, so a test ' +
                  'reading its history finds neither offending commit and ' +
                  'passes while the defect is live — the same trap T4.2.5 ' +
                  'named.',
                'Where a trailer must sit is written where a commit author ' +
                  'looks. T4.2.5 put the vocabulary in CLAUDE.md; an author ' +
                  'who knows the keys but not the placement rule can still ' +
                  'write a claim that is not read, or a sentence that is.',
                'The two commits are not rewritten. Their messages are the ' +
                  'history; what changes is that the parser stops misreading ' +
                  'them, and the four NOTE lines mpgm trace prints for them ' +
                  'stop appearing.',
              ],
              dependsOn: ['T4.2.5'],
              tracesTo: ['ADR-4', 'TST-2'],
            },
            {
              id: 'T4.2.12',
              title: 'ChangeMerged names a commit no clone can resolve',
              completionCriteria: [
                'The sha ChangeMerged carries exists where a reader will ' +
                  'look for it. mergeBranch (src/implement/merge.ts) merges ' +
                  'the task branch into the local trunk --no-ff and records ' +
                  'git rev-parse HEAD, and the kernel pushes the task branch ' +
                  'alone (src/cli/commands.ts) and never the trunk — so the ' +
                  'recorded commit stays on the operator machine while the ' +
                  "pull request's own merge commit, the one every clone has, " +
                  'is recorded nowhere. Four events already name a commit ' +
                  'absent from origin/main: T4.2.2b 24d396e, T4.2.5 d3a0e6b, ' +
                  'T4.2.6 887610f and T4.2.7 6f0affd.',
                'The change picks between pushing the trunk after the local ' +
                  "merge and recording the sha the pull request's merge " +
                  'produced, and says which and why. The two are different ' +
                  "claims about where truth lives: pushing makes the kernel's " +
                  'merge the fact and the pull request closing a consequence; ' +
                  'reading back makes GitHub the fact and the local merge a ' +
                  'rehearsal. A change recording both says which one a ' +
                  'consumer is to believe.',
                'The resume path still answers. gitMergeContract.check ' +
                  'resolves by merge-base --is-ancestor tip into against the ' +
                  'local repository (src/implement/merge.ts), so a merge that ' +
                  'comes to depend on a push says what check answers when the ' +
                  'merge landed and the push did not, and fails closed toward ' +
                  'a merge redone rather than a merge lost.',
                'What the existing four events cost is reported rather than ' +
                  'assumed. They are not rewritten — the log is append-only ' +
                  '(DESIGN section 6). The escaped-defect rate reads a ' +
                  "ChangeMerged's ts and taskId and never its commit " +
                  '(src/state/escaped-defect-rate.ts), so no figure is wrong ' +
                  'today; what is lost is reconstruction from a fresh clone ' +
                  '(OBS-1), and the change names every consumer that reads ' +
                  'the field at all.',
                'The operator ritual this removes is named. Local main ' +
                  'diverges from origin/main after every pull request merge, ' +
                  'because the loop merged locally too, and is reset to ' +
                  'origin/main by hand — three times in this history ' +
                  '(T4.2.5, T4.2.6, T4.2.7). A fix that leaves the reset in ' +
                  'place has not finished.',
                'The test builds a repository with a remote and asserts the ' +
                  "recorded sha is reachable from that remote's trunk. A test " +
                  'asserting only that some sha was recorded passes against ' +
                  'the defect (CONV-6), which is why it is not the test.',
              ],
              dependsOn: [],
              tracesTo: ['OBS-1', 'IMP-1'],
            },
            {
              id: 'T4.2.13',
              title:
                'The last rework round does not escalate the model, the way ' +
                'the last repair round does',
              completionCriteria: [
                'A review-rework round escalates one model tier on the final ' +
                  'attempt, or the change says why review differs from CI ' +
                  'repair. repairUntilGreen already escalates its last ' +
                  'attempt (isFinal && canEscalate(options.model), ' +
                  'src/implement/repair.ts), which is what T3.1.2b delivered ' +
                  'and what PLAN section 3 promises post-switchover. The ' +
                  "rework dispatch (track('rework', round, ...) in " +
                  'src/implement/loop.ts) passes no model at all, so every ' +
                  "round runs on the implementer role's frozen " +
                  'claude-sonnet-5.',
                'T4.2.9 is the case the change is measured against: three ' +
                  'rework rounds, required checks green at every one, three ' +
                  'rejections, blocked on BudgetExceeded kind=reviews, and no ' +
                  'tier ever moved — on a task PLAN section 3 assigns to ' +
                  'Opus 5.',
                'Which round escalates is stated and defended. The last is ' +
                  "T3.1.2b's choice for CI; escalating every round spends the " +
                  'stronger model on rounds the weaker one closes; escalating ' +
                  'none is the behaviour today.',
                'The PLAN Model column is not quietly made binding. ' +
                  'planTaskSchema (src/schemas.ts) carries no model field, so ' +
                  'the gated Plan artifact never holds one and no code path ' +
                  'can read it; PLAN section 3 says the column is advisory ' +
                  'and hands routing to T5.2.3. A change that does make a ' +
                  'per-task model reach dispatch says so and revises section ' +
                  "3 and T5.2.3's scope in the same commit; one that does not " +
                  'says the escalation is role-relative and the column stays ' +
                  'documentation.',
                'The escalated round is legible in the log afterwards. ' +
                  'TaskDispatched records model, so a reader can tell which ' +
                  'round ran on which, and the test asserts it there rather ' +
                  'than on a return value.',
                'The cost budget is addressed rather than assumed. A stronger ' +
                  'tier costs more per round against a task ledger measured ' +
                  'in dollars (AGT-4), so the change says what happens when ' +
                  'the escalated round would exhaust what is left: refusing ' +
                  'is a decision, silently dropping back a tier is not.',
                'The test rejects every round and asserts the final rework ' +
                  'was dispatched one tier up, and that a task approved on ' +
                  'round one never escalates. Without the second half the ' +
                  'test passes on an implementation that escalates ' +
                  'unconditionally (CONV-6).',
              ],
              dependsOn: [],
              tracesTo: ['AGT-5', 'IMP-3'],
            },
            {
              id: 'T4.2.14',
              title:
                "A review's findings are a count in the log, so a refusal " +
                'cannot be reconstructed',
              completionCriteria: [
                "A blocked task's refusal can be read back from the log " +
                  'alone. The review output schema carries findings as an ' +
                  'array of {file, line?, concern, remedy, severity} ' +
                  '(src/schemas.ts); ChangeReviewed stores findings as a ' +
                  'number (src/event/catalog.ts). The implementing session ' +
                  'sees the detail in its rework prompt and nothing else ' +
                  'ever does, because transcripts are deliberately not an ' +
                  'interface — so once a task blocks, why it was refused ' +
                  'exists nowhere an operator or a later session can read.',
                'T4.2.10 is the case the change is measured against: its ' +
                  'third review ends "Two smaller inaccuracies and one ' +
                  'assertion gap follow" and the log holds findings: 4, so ' +
                  'the operator redirecting that task could carry only what ' +
                  'the prose summary happened to name.',
                'The precedent in the same payload is cited rather than ' +
                  'rediscovered: deviations, declaredDeviations and ' +
                  'undeclaredDeviations are all kept as arrays precisely so ' +
                  'a reader need not infer them. This is OBS-1 — a log ' +
                  'sufficient for full run reconstruction — failing on the ' +
                  'event that decides whether work merges.',
                'CONV-7 followed: a payload only grows, so this is a version ' +
                  'bump with an upcaster carrying older events, with ' +
                  'SessionUsage v1 to v2 (T4.2.8) as the worked example.',
                "Inline or behind a blobRef is the change's call and it " +
                  'justifies the one it makes against a review returning ' +
                  'thirty findings on a large diff; ToolCallLogged.outputBlob ' +
                  'is the existing pattern for payload text that can be big.',
                'Redaction at log-write is checked against whatever the new ' +
                  'field carries rather than assumed to cover it, since ' +
                  'findings quote file paths and code.',
                'The test blocks a task, replays the log alone, and reads ' +
                  "back every finding's severity and remedy. Asserting a " +
                  'non-zero count is what the code already does (CONV-6).',
              ],
              dependsOn: [],
              tracesTo: ['OBS-1', 'IMP-3'],
            },
            {
              id: 'T4.2.15',
              title:
                'A merge the operator performs by hand leaves the task ' +
                'blocked in the log forever',
              completionCriteria: [
                'A task whose change reached the trunk is recorded as ' +
                  'merged whoever performed the merge. ChangeMerged is ' +
                  'appended by mergeBranch (src/implement/merge.ts) and ' +
                  'nowhere else, so a task the loop abandons and an operator ' +
                  'then merges on GitHub never gets one. M4.2 is the case ' +
                  'and it is measured, not asserted: 13 of its 15 tasks ' +
                  'carry a ChangeMerged and T4.2.9 and T4.2.10 do not, both ' +
                  'having ended on BudgetExceeded kind=reviews limit=3 ' +
                  '(T4.2.9 three times) before being merged by hand as pull ' +
                  'requests 134 and 135.',
                'What the gap costs is named rather than left to inference, ' +
                  'because every figure below is wrong today and reads ' +
                  'plausible: folded state reports both tasks blocked while ' +
                  'their code is on main; the dashboard shows 3 blocked on a ' +
                  'run whose work is done; the implementer success rate ' +
                  'counts them as failures; and the escaped-defect rate ' +
                  'divides by the tasks that merged ' +
                  '(src/state/escaped-defect-rate.ts), which is 28 where the ' +
                  'truth is 30. This is OBS-1 — a log sufficient for full ' +
                  'run reconstruction — failing in the milestone that ' +
                  'delivers observability, the same shape as T4.2.12 (a sha ' +
                  'no clone could resolve) and T4.2.14 (a refusal that could ' +
                  'not be read back).',
                'TaskAttested is not the answer and the change says why ' +
                  'rather than reaching for it: the catalog defines it as a ' +
                  'plan task completed **outside the harness** ' +
                  '(src/event/catalog.ts) and reduce.ts sets status ' +
                  "'attested', which is false here — the sessions ran inside " +
                  'the harness and their cost is already in the ledger; only ' +
                  'the merge happened outside. Attesting would also leave ' +
                  'ChangeMerged absent, so the merged-tasks denominator ' +
                  'stays wrong. The 10 genuinely attested tasks (T3.1.1 to ' +
                  'T3.1.9) are the contrast.',
                'The change picks between a verb the operator runs when they ' +
                  'merge by hand and the kernel observing the trunk, says ' +
                  'which and why, and does not let a claim go unchecked: an ' +
                  'operator asserting a merge that never landed would put a ' +
                  'sha in the log that no clone resolves, which is the defect ' +
                  'T4.2.12 just closed. Whatever it records is verified ' +
                  'against the repository the way gitMergeContract.check ' +
                  'already does, and fails closed toward refusing the record ' +
                  'rather than writing an unverifiable one.',
                'A task reaching this path was abandoned on a budget, so the ' +
                  'change says what the recorded event claims about review: ' +
                  'the last ChangeReviewed for T4.2.9 and T4.2.10 rejected, ' +
                  'and a merge recorded as though the gate passed would make ' +
                  "the merge-gate refusal rate read better than the run's " +
                  'history. Recording that the operator overrode a refusal ' +
                  'is a different fact from recording that no refusal ' +
                  'happened (HIL-5).',
                'T4.2.9 and T4.2.10 are brought into the log by the change ' +
                  'or the cost of leaving them out is stated: their events ' +
                  'are not rewritten — the log is append-only (DESIGN ' +
                  'section 6) — so anything recorded now is appended with ' +
                  'its own later timestamp, and the change says what that ' +
                  'does to any figure that reads ts ordering, the ' +
                  'escaped-defect rate above all. T4.2.9 also carries a ' +
                  'redirection note whose only purpose is to tell a future ' +
                  'session the task is already done; the change says whether ' +
                  'that note is now retired.',
                'The test drives a task to BudgetExceeded, records the ' +
                  "operator's merge, and asserts from the log alone that the " +
                  'task reads merged, that the recorded sha is reachable ' +
                  'from the trunk, and that the merged-tasks denominator ' +
                  'moved. A test asserting only that an event was appended ' +
                  'passes against a record nothing verified (CONV-6).',
              ],
              dependsOn: [],
              tracesTo: ['OBS-1', 'OBS-4', 'HIL-5'],
            },
          ],
        },
        {
          id: 'M4.3',
          title: 'The Test phase runs',
          verification:
            'A Test phase run over mpgm itself, which is what M3.2 named and never ' +
            'performed: a requirement-coverage report over a Scope artifact that ' +
            'exists, an adversarial suite that catches a planted defect, that defect ' +
            'filed as a Defect artifact and round-tripped through route, fix and ' +
            're-test, and a Test gate presented over what was found rather than over ' +
            'an empty set.',
          validatesRisk: null,
          tasks: [
            {
              id: 'T4.3.1',
              title: 'mpgm has no Scope artifact, so its coverage report is empty',
              completionCriteria: [
                "mpgm's own requirements exist as a scope artifact. " +
                  'artifacts/ holds two files today — artifacts/demo/brief.md ' +
                  'and artifacts/plan/plan.v1.md — and the requirement list a ' +
                  'coverage report is computed over is assembled from ' +
                  'artifacts stored under the scope schema ' +
                  '(src/cli/commands.ts). REQUIREMENTS.md is hand-authored ' +
                  'from the P1 bootstrap and is not one, so ' +
                  'requirementCoverageReport (src/test/nfr.ts) returns zero ' +
                  'rows over this repository.',
                'The gate consequence is stated, because it is the reason ' +
                  'this task comes first. The Test gate REQUIREMENTS states ' +
                  'reads all Must-have requirements verified; over an empty ' +
                  'requirement set that is vacuously true, so a Test phase ' +
                  'run today would report 0 of 0 verified and a met gate. ' +
                  'That is the no-op reading T4.2.2b was written to refuse, ' +
                  'one milestone later.',
                'The artifact is derived from REQUIREMENTS.md rather than ' +
                  'invented beside it, and the change says what it did with ' +
                  'anything that would not fit. Ids are carried across ' +
                  'unchanged — ORC-1, TST-5, OBS-4 — because every trace ' +
                  'claim in three foundation documents, the commit trailers ' +
                  'and the artifact frontmatter already spells them that way ' +
                  '(ART-2). An id that changes spelling here silently ' +
                  'unverifies whatever cited it.',
                'The quantified thresholds SCP-1 requires are carried or ' +
                  'their absence is reported per requirement. NfrRequirement ' +
                  '(src/test/nfr.ts) needs a threshold to judge a run ' +
                  'against, and nfrCoverage reports not-run and ' +
                  'below-threshold as different problems; a requirement ' +
                  'arriving with no threshold must read as one the suite ' +
                  'cannot judge rather than one it passed.',
                'A test asserts the coverage report over this artifact names ' +
                  'both verified and unverified requirements — not that it ' +
                  'returns rows. A report of n rows all reading unverified is ' +
                  'as uninformative as zero rows and passes any test that ' +
                  'counts them (CONV-6).',
              ],
              dependsOn: [],
              tracesTo: ['SCP-1', 'TST-2'],
            },
            {
              id: 'T4.3.2',
              title: "A phase's work can be code, and the Test phase says which of it is",
              completionCriteria: [
                'The Test phase can execute the suites M3.2 delivered. It ' +
                  'cannot today: every step a playbook expands to is a ' +
                  'session or a panel tally (GraphStep is SessionStep | ' +
                  'TallyStep, src/playbook/graph.ts), so nothing a playbook ' +
                  'declares can call runAdversarialSuite, nodeTestExecutor, ' +
                  'adversarialVerdict (src/test/adversarial.ts), runNfrSuite, ' +
                  'nfrCoverage or requirementCoverageReport ' +
                  '(src/test/nfr.ts). An agent session can emit an ' +
                  'AdversarialSuite; nothing can then run it.',
                'The change picks between a step kind that invokes a bound ' +
                  'capability contract and a verb that drives the phase as ' +
                  'mpgm implement already does, and says which and why. Both ' +
                  'exist as precedent in this codebase and they are not ' +
                  'equivalent: a step kind keeps the phase declarative and ' +
                  'its evidence inside GateEvidence, a verb keeps the ' +
                  'playbook mechanism untouched and puts the sequencing in ' +
                  'code.',
                'test.nfr is bound to something that runs. runNfrSuite takes ' +
                  'an injected callback — typically invoke on a bound ' +
                  'contract — and testNfrContract (src/test/nfr.ts) is a ' +
                  'ContractSpec with no provider, no binding and no ' +
                  'invocation anywhere outside the export list in ' +
                  'src/index.ts. contracts/test.nfr.md is prose. Without a ' +
                  'provider the NFR half of the phase has no executor at all.',
                'The test runs a real suite and a real NFR run end to end, ' +
                  'not a stubbed executor standing in for both. A provider ' +
                  'that returns a fixed passing result satisfies any test ' +
                  'asserting the phase completed, and is the shape that let ' +
                  'a defect round-trip be accepted as an in-process unit test ' +
                  'in T3.2.4 (CONV-6).',
                'Where the adversarial suite executes is stated. ' +
                  'nodeTestExecutor writes agent-authored JavaScript into a ' +
                  'project directory and runs node --test there, and ' +
                  'src/test/adversarial.ts says plainly that the subject ' +
                  'restriction is not a confinement boundary and that a case ' +
                  'reaches whatever the harness reaches. Running it over this ' +
                  'repository is a decision, not a default.',
              ],
              dependsOn: [],
              tracesTo: ['TST-1', 'TST-3', 'EXT-3'],
            },
            {
              id: 'T4.3.3',
              title: 'The Test phase has a playbook, schemas and a gate',
              completionCriteria: [
                'phases/test.yaml exists and mpgm run test executes it. The ' +
                  'phase itself needs no code registration: ' +
                  'PlaybookRegistry.fromDirectory scans phases/, the run verb ' +
                  'looks the phase up by name (src/cli/commands.ts), and a ' +
                  "playbook's phase field is a free identifier — no enum, no " +
                  'phase-ordering constraint. phases/ holds definition, ' +
                  'scope, design and plan and nothing else.',
                'Every artifact the playbook declares is registered as an ' +
                  'artifact schema, and the change says which were not. ' +
                  'adversarial-suite is in projectOutputSchemas ' +
                  '(src/schemas.ts) and not in projectArtifactSchemas, and ' +
                  'ArtifactStore validates at write while the playbook loader ' +
                  'never consults the registry — so a playbook declaring it ' +
                  'today loads and then fails at write. ' +
                  'RequirementCoverageReport (src/test/nfr.ts) is a ' +
                  'TypeScript interface and not a zod schema at all, so it is ' +
                  'in neither registry.',
                'defect is not among them and no step declares one. ' +
                  'src/schemas.ts states why it is an artifact schema and ' +
                  'deliberately not an output schema: a Defect is built by ' +
                  'the round trip in src/test/defect.ts from evidence and a ' +
                  'routing decision, not asserted whole by a session. A step ' +
                  'asking a session to emit a Defect would make TST-5 a ' +
                  'matter of what an agent chose to say.',
                'The gate reads the defects the phase filed, or the change ' +
                  'states that it cannot and what that costs. Two facts ' +
                  'combine here: none of the four criterion kinds ' +
                  '(artifact-exists, agent-assertion, vote-carried, ' +
                  'traces-resolve — src/playbook/definition.ts) reads a ' +
                  'Defect artifact or a coverage figure, and GateEvidence ' +
                  '(src/phase/runner.ts) is filled only from step.produces, ' +
                  'so defects written outside that mechanism (T4.3.4) are ' +
                  'invisible even to artifact-exists. A criterion kind that ' +
                  'reads them has TraceIndexStore.coverage ' +
                  '(src/trace/index-store.ts) already available for the ' +
                  'coverage half.',
                'An agent-assertion is not a free fallback, and the change ' +
                  'does not present it as one. It requires a boolean field on ' +
                  "a named task's registered output schema (src/gate/" +
                  'manager.ts treats an absent or non-boolean field as ' +
                  'unmet), and no Test-phase output schema has one — ' +
                  'adversarial-suite is subject, summary and cases. Resting ' +
                  'the gate there means a new output schema and a role to ' +
                  'emit it, which is a role-freeze edit (see T4.3.4).',
                'The gate is exercised in both directions. A test presents it ' +
                  'over a run with an open high-severity defect and over one ' +
                  'without, and the two decisions differ. A gate asserted ' +
                  'only on the clean case passes while it is incapable of ' +
                  'refusing (CONV-6).',
              ],
              dependsOn: ['T4.3.2'],
              tracesTo: ['TST-1', 'TST-2', 'EXT-3'],
            },
            {
              id: 'T4.3.4',
              title: 'A defect is filed by the phase, not by a test',
              completionCriteria: [
                'A failing adversarial case and a below-threshold NFR row ' +
                  'each become a Defect artifact on disk. src/test/defect.ts ' +
                  'names these two as the producers already in this codebase, ' +
                  'and fileDefect has no call site outside the export list in ' +
                  'src/index.ts today.',
                'The adversarial producer is completed before it can file ' +
                  'anything, and the change does that work rather than ' +
                  'assuming it done. fileDefect requires tracesTo non-empty — ' +
                  'TST-5 files a defect traced to requirements, and ' +
                  'src/test/defect.ts explains that a defect naming no ' +
                  'requirement gives the phase it is routed to nothing to ' +
                  'check the fix against. No requirement id exists anywhere ' +
                  'in the adversarial substrate: not on adversarialCaseSchema ' +
                  '(id, kind, about, defect, body), not on AdversarialSuite, ' +
                  'not on AdversarialCaseResult, and roles/' +
                  'adversarial-tester.md never asks for one. The NFR ' +
                  'producer has it — NfrCoverageRow carries the requirement ' +
                  'id — and the adversarial one does not.',
                'Editing that role means editing roles/freeze.json in the ' +
                  'same commit, with who approved it and why. ' +
                  'adversarial-tester is carried in that manifest by digest ' +
                  'and a role that moves without it fails CI. This is stated ' +
                  'because the work above forces the edit, and because any ' +
                  'new role this task introduces needs the same.',
                'severity, title and an evidence detail that is not empty are ' +
                  'supplied rather than assumed. Neither producer carries a ' +
                  'severity or a title, and both can hand back an empty ' +
                  'detail — AdversarialExecution allows it explicitly and ' +
                  "nfrRunOutput's evidence defaults to the empty string — " +
                  'while defectEvidenceSchema requires a non-empty one. A ' +
                  'filing path that passes those through throws instead of ' +
                  'filing, on exactly the runs that found something.',
                'The defects are written outside the playbook produces ' +
                  'mechanism, under artifacts/defect, and the change says ' +
                  'where that code lives. A step writes exactly one declared ' +
                  'artifact at one fixed basePath (src/phase/runner.ts) and a ' +
                  "fan-out's workers get no produces at all — only its " +
                  'collect step does (src/playbook/graph.ts) — so seven ' +
                  'failures cannot be seven declared artifacts, and seven ' +
                  'versions of one would be collapsed to one by latestPerId ' +
                  '(src/state/escaped-defect-rate.ts). The path is not free ' +
                  'either: mpgm status --rates lists artifacts/defect, so a ' +
                  'defect written elsewhere is invisible to the rate.',
                'The round trip is driven by the phase rather than by a test ' +
                  'asserting it. routeDefect, recordFix and retestDefect ' +
                  'already refuse any call that skips an edge, so what is ' +
                  'missing is a caller: the change says which component ' +
                  'routes a filed defect and on what evidence — ' +
                  'src/test/defect.ts leaves that judgement to a person or an ' +
                  'agent under ORC-1, so the answer is a role or an operator ' +
                  'prompt and not an inference from the evidence — and a test ' +
                  'drives a planted failure from filed to verified through ' +
                  'the real artifact store, reading each version back off ' +
                  'disk.',
                'What this does and does not do to the escaped-defect rate is ' +
                  'stated correctly. Filing a defect during a Test run does ' +
                  'not make the rate read a figure: it divides by the ' +
                  "run's own ChangeMerged events, and a Test phase run emits " +
                  'none, so the rate stays null for that run. The rate ' +
                  'becomes readable for a run that both merges and files, ' +
                  'and it needs the artifact dating T4.2.7 delivers. A ' +
                  'criterion claiming otherwise would be met with a ' +
                  'hand-built event fixture.',
              ],
              dependsOn: ['T4.3.3'],
              tracesTo: ['TST-5', 'ORC-1', 'TST-4'],
            },
            {
              id: 'T4.3.5',
              title: "M3.2's verification, run",
              completionCriteria: [
                'A demo under scripts/demo/ runs the Test phase over a real ' +
                  'subject and shows the two legs of M3.2 that never ran: a ' +
                  'requirement-coverage report, and one adversarially found ' +
                  'defect round-tripped to a fix. M3.2 has three legs and the ' +
                  'third — the sample service ready for P4 — did happen; P4 ' +
                  'was built on it. T3.2.4 was accepted on the criterion that ' +
                  'a defect round-trips through fix and re-test, which an ' +
                  'in-process unit test satisfies, and the milestone closed ' +
                  'on its tasks rather than on the run.',
                'The demo is operator-run rather than in CI, and the change ' +
                  'knows what marks it so. Nothing in package.json annotates ' +
                  'a demo as operator-run: every one is listed identically, ' +
                  'and the only marker is absence from the check script and ' +
                  'from the CI workflow. This demo makes real model calls, ' +
                  'which puts it with demo:agent, demo:definition, ' +
                  'demo:scope, demo:design and demo:plan — a verification ' +
                  'that silently skipped itself would be worse than none.',
                'The defect it round-trips is planted, and the demo fails if ' +
                  'the adversarial suite does not catch it. A demo reporting ' +
                  'success because the suite found nothing proves the phase ' +
                  'ran, not that it works, which is the whole difference ' +
                  'between M3.2 being verified and M3.2 having tasks that ' +
                  'closed.',
                'The demo asserts the artifacts on disk and the event log ' +
                  'after the run, never a session transcript: a Defect ' +
                  'artifact at verified, a coverage report naming verified ' +
                  'and unverified requirements, and the gate decision in the ' +
                  'log. Artifacts are the only interface between phases and ' +
                  'gate truth lives in the log, so a demo reading a ' +
                  'transcript asserts against the one thing DESIGN says is ' +
                  'not the interface.',
                'The subject the suite attacks is stated and is not this ' +
                  'working tree by default. nodeTestExecutor runs ' +
                  'agent-authored JavaScript with node --test in the project ' +
                  'directory it is given, and the subject restriction is ' +
                  'documented as not being a confinement boundary.',
                'The change reports what the run found about M3.2 rather than ' +
                  'quietly closing it. If the phase cannot meet the gate ' +
                  'REQUIREMENTS states — all Must-have requirements verified, ' +
                  'no open critical or high defects, NFR results within the ' +
                  'Scope thresholds — that is the finding, reported rather ' +
                  'than worked around by weakening the gate.',
              ],
              dependsOn: ['T4.3.1', 'T4.3.4'],
              tracesTo: ['TST-1', 'TST-2', 'TST-5'],
            },
          ],
        },
      ],
    },
    {
      id: 'P5',
      title: 'Maintain and Self-Improvement',
      intent: 'Close the lifecycle loop: signals in, incidents handled, roles improved.',
      milestones: [
        {
          id: 'M5.1',
          title: 'Maintain integration',
          verification:
            'A synthetic alert becomes a prioritised work item; a simulated incident runs ' +
            'detect, operator-approved mitigation, remediation and postmortem; an injected ' +
            'CVE advisory yields a severity-prioritised upgrade task.',
          validatesRisk: null,
          tasks: [
            {
              id: 'T5.1.1',
              title: 'Signal ingestors and the triage role',
              completionCriteria: [
                'A synthetic alert becomes a prioritised task.',
                'An operator-filed GitHub issue becomes a prioritised task.',
              ],
              dependsOn: [],
              tracesTo: ['MNT-1', 'PMG-3'],
            },
            {
              id: 'T5.1.2',
              title: 'Incident state machine and postmortem playbook',
              completionCriteria: [
                'A simulated incident runs detect, approve, remediate, postmortem.',
              ],
              dependsOn: ['T5.1.1'],
              tracesTo: ['MNT-2'],
            },
            {
              id: 'T5.1.3',
              title: 'Dependency upgrade tasks with severity priority',
              completionCriteria: [
                'An injected CVE advisory yields a severity-prioritised upgrade task.',
              ],
              dependsOn: ['T5.1.1'],
              tracesTo: ['MNT-3'],
            },
            {
              id: 'T5.1.4',
              title: 'Drift audit tasks',
              completionCriteria: [
                'Planted drift is detected and a reconciliation task is raised.',
              ],
              dependsOn: [],
              tracesTo: ['MNT-4'],
            },
          ],
        },
        {
          id: 'M5.2',
          title: 'Evals and the improvement loop',
          verification:
            'The full eight-phase lifecycle runs on the sample project under mpgm, and ' +
            "mpgm's own backlog is maintained by mpgm; every REQUIREMENTS MUST maps to a " +
            'passing verification or a filed defect.',
          validatesRisk: null,
          tasks: [
            {
              id: 'T5.2.1a',
              title: 'Eval harness core and the adoption gate',
              completionCriteria: [
                'A role change without a green eval is blocked.',
                'The section 1 role freeze is lifted.',
              ],
              dependsOn: [],
              tracesTo: ['AGT-6'],
            },
            {
              id: 'T5.2.1b',
              title: 'Per-role eval suites for every shipped role',
              completionCriteria: ['Every shipped role has a green baseline suite.'],
              dependsOn: ['T5.2.1a'],
              tracesTo: ['AGT-6'],
            },
            {
              id: 'T5.2.2',
              title: 'Feedback miner',
              completionCriteria: [
                'One adopted refinement lands via the full loop: miner, diff, review, eval, adopt.',
              ],
              dependsOn: ['T5.2.1a'],
              tracesTo: ['AGT-7'],
            },
            {
              id: 'T5.2.3',
              title: 'Model routing table',
              completionCriteria: [
                'The routing table is honoured per task class (test).',
              ],
              dependsOn: [],
              tracesTo: ['AGT-5'],
            },
          ],
        },
      ],
    },
  ],
};
