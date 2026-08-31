---
title: Glossary
egress: internal
---

# Glossary

- **Artifact** — a versioned markdown document with YAML frontmatter, the only
  interface between lifecycle phases. Immutable once gated.
- **Gate** — an operator decision point between phases. Gate truth lives in the
  event log; git tags are derived markers.
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
