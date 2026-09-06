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
              id: 'T4.1.4',
              title: 'Production deploy gate',
              completionCriteria: [
                'A production deploy is impossible without an approval event.',
                'Every route to a declared production environment is gated, not ' +
                  'only the release path.',
              ],
              dependsOn: ['T4.1.3'],
              tracesTo: ['HIL-2'],
            },
            {
              id: 'T4.1.5',
              title: 'The rollback verb',
              completionCriteria: [
                'An operator can roll back a declared environment from the CLI, ' +
                  'and the rollback is recorded without being gated.',
              ],
              dependsOn: ['T4.1.4'],
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
            'reaches a gated Definition artifact within one hour, timed.',
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
              id: 'T4.2.2',
              title: 'Quality metrics: gate rejection, rework, escaped defects',
              completionCriteria: ['A longitudinal report over at least three runs.'],
              dependsOn: ['T4.2.1'],
              tracesTo: ['OBS-4'],
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
