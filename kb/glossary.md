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
- **Run** — one execution of the harness over a project, recorded as an
  append-only event log.
