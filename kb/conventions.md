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
- **CONV-7** An event payload only grows. Add a field, bump the registered
  version, and carry older payloads forward with an upcaster (`EventRegistry`,
  ADR-2). Narrowing, renaming or removing one in place makes every log already
  written unreadable, and an unreadable log is state that cannot be folded —
  which is every command the kernel has.
- **CONV-8** A commit trailer only counts if it sits in a paragraph of its
  own, where every line is `Key: value` shaped, set apart from prose by a
  blank line above (T4.2.11, ADR-4). A `Key: value` line that opens a wrapped
  sentence inside a prose paragraph is not read as a claim, however true the
  sentence is.
- **CONV-9** Write `Verifies:` on the commit that checks a requirement, not
  merely serves it. `Traces:` / `Traces-To:` / `Implements:` / `Closes-Task:`
  all record what a change serves; `Verifies:` is the only one
  `TraceIndexStore.coverage()` counts toward a requirement's TST-2 test
  coverage, so a check recorded under the wrong trailer reports as unverified
  however real the test was.
