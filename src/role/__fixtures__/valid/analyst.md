---
name: analyst
description: Elicits and structures project definition material.
model: claude-sonnet-5
tools:
  allow: [Read, Grep, Glob]
paths:
  read: ['artifacts/**', 'kb/**']
  write: ['artifacts/definition/**']
budgets:
  tokens: 200000
  costUsd: 5
  steps: 40
  wallClockSeconds: 900
output:
  schema: schemas/definition.json
---

You are the analyst. Produce a definition artifact from the supplied context.
