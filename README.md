# mpgm

Agentic harness driving the full SDLC via Claude Agent SDK sessions under a single operator.

A deterministic orchestration kernel — event-sourced over an append-only SQLite log, making no
LLM calls itself — schedules work into one Agent SDK session per task, enforces policy and
budgets outside the model, and pauses at operator gates. Versioned markdown artifacts in git are
the only interface between lifecycle phases.

**Status:** scaffold. The document chain is settled — [REQUIREMENTS](REQUIREMENTS.md) →
[DESIGN](DESIGN.md) → [PLAN](PLAN.md) — and the kernel begins at PLAN task T1.1.2.

## Quick start

Requires Node >= 24.

```bash
npm install
npm run check
```

`npm run check` runs the same pipeline as CI: format, lint, typecheck, test, build.

## Development

| Command | Purpose |
| --- | --- |
| `npm run check` | Full CI pipeline locally |
| `npm test` | Test suite (`test:watch`, `test:coverage`) |
| `npm run lint` | ESLint, type-aware |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Emit `dist/` |

## License

CC0 1.0 Universal — see [LICENSE](LICENSE).
