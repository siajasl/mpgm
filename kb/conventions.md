---
title: Conventions
kind: conventions
egress: internal
---

# Conventions

Numbered so that a deviation can be declared and reviewed by id (IMP-4). An
undeclared deviation is refused at merge; a declared one is a decision the
reviewer judges. If a convention is wrong, say so — do not work around it.

- **CONV-1** One logical change per commit, with a body explaining why rather
  than what.
- **CONV-2** Downstream documents never contradict upstream ones:
  REQUIREMENTS → DESIGN → PLAN.
- **CONV-3** Errors that stop work must carry enough detail to fix the cause
  without reading the code that raised them.
- **CONV-4** Security controls fail closed. A control that silently permits on
  ambiguity is worse than none, because it is trusted.
- **CONV-5** Express an obligation as something that cannot be represented
  rather than something that is checked, wherever the artifact cannot
  meaningfully exist without it.
- **CONV-6** Every test must be able to fail. A test that passes against the
  unmodified code reports coverage that does not exist.
