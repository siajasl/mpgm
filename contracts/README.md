# Capability contracts

Every external system mpgm touches — CI, the project board, environments,
releases, telemetry — is reached through a **capability contract** and never
directly (ADR-7, EXT-1). A contract is named by what it does, not by who
provides it: `ci.checks`, not "GitHub Actions".

Each contract has two halves that must agree:

| Half | Where | What it is for |
|---|---|---|
| Specification | `contracts/<name>.md` | What the capability means, what each operation promises, what a provider must get right |
| Definition | a `ContractSpec` in `src/` | zod schemas the kernel validates against, in both directions |

The definition is what runs; the specification is what a provider author reads.
When they disagree the specification is wrong, because the definition is the
one the kernel actually enforces — so a change to either is a change to both.

## Why the indirection

- **Provider swap without workflow change (EXT-2/3).** Playbooks, roles and
  kernel code name the capability. Replacing the provider is configuration.
- **One interception point.** Every crossing of the boundary is validated on
  the way out and on the way back. A provider that returns something the
  contract does not allow fails at the boundary, not three layers downstream
  where the shape is assumed.
- **Honest resume (DESIGN §6).** Each operation declares its effect semantics,
  so the kernel knows whether an interrupted call may be retried, must be
  checked, can be compensated, or needs an operator.

## Effect semantics

| Value | Meaning |
|---|---|
| `read-only` | Changes nothing. No intent needs recording before it. |
| `idempotent` | Re-running is harmless; resume retries. |
| `checkable` | The provider can be asked whether the effect landed; resume asks. |
| `compensatable` | The effect can be undone; resume undoes, then retries. |
| `manual` | None of the above. Only an operator can say what happened. |

## Contracts

| Contract | Specification | Landed in |
|---|---|---|
| `ci.checks` | [ci.checks.md](ci.checks.md) | T3.1.2a |
