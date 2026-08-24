# `ci.checks`

**Purpose.** Report the merge checks a CI provider has run for a ref.
Satisfies IMP-2 (build, lint, type check, tests, security scan before every
merge) and SAF-5 (the security scan among them).

**Definition.** `ciChecksContract` in [`src/implement/checks.ts`](../src/implement/checks.ts).
**Reference provider.** GitHub Actions, [`src/implement/github-checks.ts`](../src/implement/github-checks.ts) (DESIGN §9 — Actions is the v1 CI).

## What the contract does not do

It does not run checks, decide what a check means, or merge anything. CI is an
oracle: the kernel asks what happened and decides for itself whether that is
enough (`mergeVerdict`). The decision is a pure function of the reported runs,
so it can be replayed from the log rather than re-asked of a provider whose
answer may since have changed (ORC-3).

## Operations

### `status`

| | |
|---|---|
| Input | `{ repo: string, ref: string }` — `owner/repo`, and a commit sha, branch or tag |
| Output | `{ ref: string, runs: CheckRun[] }` |
| Effects | `read-only` |

`CheckRun` is `{ name, status, conclusion, url }`, where `status` is
`queued | in_progress | completed` and `conclusion` is null until the run
completes.

A provider MUST:

- report **every** check run for the ref, however it concluded — including
  ones it considers unimportant. What is required is the kernel's decision, and
  a provider that filters makes that decision for it;
- report a check that has not finished as `queued` or `in_progress` with a null
  conclusion, rather than omitting it. An omitted pending check is
  indistinguishable from one that was never configured, and the two have
  opposite consequences;
- never invent a run. Silence about a check means the check did not report,
  which blocks the merge — that is the intended outcome, not a failure of the
  provider.

### `logs`

| | |
|---|---|
| Input | `{ repo: string, ref: string, check: string }` — the check name exactly as `status` reported it |
| Output | `{ check: string, text: string }` |
| Effects | `read-only` |

What the check printed, for feeding back to the agent that broke it (IMP-2).

Empty text is a legitimate answer: not every CI exposes logs through an API,
and a log may have expired or been redacted. The repair loop then feeds back
the verdict alone — worse feedback, but honest. A provider MUST NOT fail the
call because a log is unavailable; an unreadable log is not a reason to abandon
a repair that still knows what failed.

## How the verdict is decided

Kinds required before any merge: `build`, `lint`, `typecheck`, `test`, `scan`.

A **mapping** — supplied by the project, not by the contract — says which check
names cover which kinds. mpgm's own workflow names its jobs after the kinds, so
the default mapping applies; a project with one job that does everything maps
that one name to all five.

A kind is satisfied when at least one covering run passed and none failed.
Everything else blocks:

| Situation | Verdict |
|---|---|
| Covering run failed, cancelled, timed out, went stale, or needs action | blocked — `failing` |
| Covering run still queued or running | blocked — `pending` |
| No run covers the kind | blocked — `uncovered` |
| Covering runs all `skipped` or `neutral` | blocked — `uncovered`: a skipped scan is not a scan |
| A failing run that covers no required kind | blocked: it is red, and a gate that merges past red checks is decorative |

**Absence is not success.** The dangerous version of this component is the one
that merges because it found nothing wrong.

## Failing closed

The GitHub provider maps a status it does not recognise to "no result yet", and
a *conclusion* it does not recognise to `failure`. The asymmetry is deliberate:
an unfamiliar status means CI has not spoken yet, while an unfamiliar
conclusion means CI has spoken in words this code cannot read — and deciding a
merge on a value nobody understood is the failure worth preventing.

## What it does not cover yet

- Legacy commit statuses (the pre-check-runs API). Actions reports check runs.
- Triggering or re-running checks. A repair pushes a commit, which re-triggers
  CI on its own; explicit re-runs would be for infrastructure failures, and are
  not needed until something needs them.

## Consumers

- [`src/implement/repair.ts`](../src/implement/repair.ts) — the bounded repair
  loop (IMP-2, NFR-1). It requires a *settled* verdict: `awaitChecks` polls
  until nothing is still running, because a verdict read mid-run is not an
  answer and repairing against one spends an attempt on a build that had not
  failed yet.
