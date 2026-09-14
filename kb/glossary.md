---
title: Glossary
egress: internal
---

# Glossary

- **Artifact** — a versioned markdown document with YAML frontmatter, the only
  interface between lifecycle phases. Immutable once gated.
- **Defect** — a finding against behaviour that has already merged, filed as an
  artifact, traced to requirements and routed back through Implement or Design
  (TST-5, `src/test/defect.ts`). Filing one takes evidence: the suite or
  contract that caught it, and the case id a re-test reruns. A finding with no
  failing case to re-run therefore cannot be filed as one honestly — the fields
  are there and nothing true goes in them — and belongs in the plan as a task,
  which is what MNT-4 already prescribes for drift found by audit rather than
  by test. T4.2.5 is that shape: the trace index silently discards every claim
  spelled `Traces:`, which is the spelling the P1 bootstrap commits used. It
  was found by reading those commits — no suite caught it, and there is no case
  for a re-test to rerun.

  Two things this line does **not** mean. A finding caught *before* the change
  merges, by review or by CI, is neither a defect nor a task — it is rework,
  and T4.2.2a counts it as that. And a finding that becomes a task rather than
  a defect has still escaped: it counts against the harness exactly as much,
  because the escaped-defect rate (OBS-4, T4.2.2b) measures what got past the
  gates and not what got filed on a particular form. A finding reclassified to
  keep a rate down is the rate measuring its own filing convention.
- **Gate** — three different things here are called one, and the word alone
  never says which.

  The **phase gate** is an operator decision between phases (HIL-1), recorded
  as `GateApproved`/`GateRejected`. Gate truth lives in the event log; git tags
  are derived markers.

  The **merge gate** decides whether one task's change may land (`decideMerge`,
  `src/implement/merge.ts`). It treats CI as an oracle and decides per required
  check kind, where absence is not success — failed, pending, skipped and never
  configured all block — and it refuses an unreviewed change, a review of an
  earlier commit, a reviewer sharing the author's role (IMP-3), and a
  convention the reviewer found broken that the change never declared (IMP-4).
  It writes no event of its own, so a refusal is visible only through the
  `ChecksReported` and `ChangeReviewed` it read.

  The **deploy gate** requires explicit operator approval for anything
  irreversible or outward-facing whatever the phase gate's settings say
  (HIL-2, `src/policy/deploy-gate.ts`), and spends a confirmation when it is
  given.

  So a phrase like "gate rejection rate" says nothing until it says which.
- **Playbook** — `phases/<name>.yaml`, declaring the tasks, artifacts and gate
  criteria of one phase.
- **Role** — `roles/<name>.md`, declaring an agent's model, toolset, path
  permissions, budgets and output schema.
- **Role freeze** — `roles/freeze.json`, pinning every role file by digest.
  Adding a role, or changing one, means updating that manifest in the same
  commit with who approved it and why; a role the manifest does not account
  for is refused before any task is dispatched, and the check runs in CI, so
  a change that adds a role and not its digest goes red. The freeze is not a
  convention a reviewer can excuse — it fails closed and stays closed until
  the manifest agrees. It lifts when the eval harness lands (T5.2.1a), which
  is what will notice a role getting quietly worse.
- **Run** — one execution of the harness over a project, recorded as an
  append-only event log.
- **Sample service** — `siajasl/library-loans`, a repository separate from
  mpgm's own. It is what tells the difference between a harness and a harness
  that only works on one repository: implementing, reviewing, releasing,
  deploying and rolling back have to be done to something that is not the
  thing doing them. It is a Node HTTP service answering `GET /health`,
  listening on `$PORT`, with a `Dockerfile` at its root that builds the image
  a release deploys.

  When a task says "the sample service" it means that repository, and a
  release, deploy or rollback is meant to carry *it*. Beware the name
  collision: `deploy/sample-service/` **inside mpgm** is a fixture — a
  throwaway page whose only job is to make the release machinery observable,
  by baking a version into what it serves so two releases differ visibly. It
  is a test double for the mechanism, never the subject of one. T4.1.2 released
  the fixture and called the criterion met, because nothing recorded this and
  three reviews had no basis to object.
