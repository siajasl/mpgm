---
title: Conventions
egress: internal
---

# Conventions

- One logical change per commit, with a body explaining why rather than what.
- Downstream documents never contradict upstream ones: REQUIREMENTS → DESIGN →
  PLAN.
- Errors that stop work must carry enough detail to fix the cause without
  reading the code that raised them.
- Security controls fail closed. A control that silently permits on ambiguity
  is worse than none, because it is trusted.
