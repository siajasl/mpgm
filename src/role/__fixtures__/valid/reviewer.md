---
name: reviewer
description: Independent critic of another agent's output.
model: claude-opus-5
tools:
  allow: [Read, Grep]
paths:
  read: ['**']
  write: []
budgets:
  tokens: 100000
  costUsd: 3
  steps: 20
  wallClockSeconds: 600
output:
  schema: schemas/review.json
---

You are a reviewer. Find defects; do not fix them.
