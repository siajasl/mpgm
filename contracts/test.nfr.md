# `test.nfr`

**Purpose.** Measure one quantified non-functional requirement against the
threshold Scope declared for it (SCP-1), and report whether it held. Feeds the
Test-phase requirement-coverage report — TST-3 for the non-functional
requirements themselves, folded into the general TST-2 report every
requirement gets (DESIGN §4.7).

**Definition.** `testNfrContract` in [`src/test/nfr.ts`](../src/test/nfr.ts).

## What the contract does not do

It does not decide whether a measurement is "within threshold". A threshold
is a metric, a value, a unit and how it is measured (SCP-1) — nothing in that
shape says whether the value is a ceiling or a floor, and a latency threshold
and a throughput threshold read the same number in opposite directions. The
provider is the thing that ran the load test or the scan; it is the one that
knows what "held" means for the metric it was given, in the same way `ci.checks`
treats CI as the oracle for whether a check passed rather than re-deriving a
verdict from a log. What the kernel decides is coverage — which quantified
NFRs a suite ran at all, and of those, which reported passing (`nfrCoverage`
in `src/test/nfr.ts`) — not the pass/fail judgement itself.

It does not run the suite. Calling the operation once per requirement
(`runNfrSuite`) is the whole of the orchestration; how a provider turns a
`run` call into a k6 script, a ZAP scan, or a fault-injection run is its own
business (EXT-1) and is not specified here, the same way `ci.checks` does not
specify how a project's CI executes a build.

## Operations

### `run`

| | |
|---|---|
| Input | `{ repo, ref, requirementId, metric, value, unit, measuredBy }` |
| Output | `{ requirementId, metric, measured, unit, passed, evidence }` |
| Effects | `idempotent` |

Input carries the requirement's own threshold fields (SCP-1's `metric`,
`value`, `unit`, `measuredBy`) rather than a threshold id, so a provider never
has to read the Scope artifact back to find out what it was asked to measure.

`evidence` points at what was measured — a report, a log, a dashboard link —
and is `''` where a provider cannot supply one, exactly as `ci.checks#logs`
treats an unavailable log as a legitimate, if worse, answer. It is never a
reason to withhold `passed`: an unlinked verdict is worth less than a linked
one, not withheld.

A provider MUST NOT invent a measurement for a requirement it did not run. A
call this contract never received is reported as `not-run` by `nfrCoverage`
(TST-3 binds *every* quantified NFR, so silence is exactly as unverified as a
result that came back outside threshold — the dangerous version of this
component is the one that reads "nothing ran" as "nothing to worry about").

Repeatable: a rerun produces a fresh, independently comparable measurement.
Unlike `pm.github#apply`, nothing here needs to converge on a prior call's
effect, because there is no state to converge on — only a new reading.

## Coverage

`nfrCoverage(requirements, results)` is pure — the same requirements and
reported results always produce the same rows, so it replays from the log
rather than re-asking a provider whose target may since have changed
(mirrors `mergeVerdict`). A row is:

- **verified** — a result came back for the requirement and `passed` was true;
- **not-run** — no result came back for it at all;
- **below-threshold** — a result came back and `passed` was false.

`requirementCoverageReport` folds these rows into the general trace-graph
coverage query (`TraceIndex.coverage`, TST-2) that already answers for
functional requirements from commit `Verifies:` trailers: a requirement counts
as verified if *either* source says so. A quantified NFR this run did not
re-measure but a still-current commit already verified is not newly
unverified because this run happened to skip it, and a fresh pass counts
before anything has been committed to say so.

## Consumers

- [`src/test/nfr.ts`](../src/test/nfr.ts) — `runNfrSuite` (the orchestration:
  call `run` once per quantified NFR), `nfrCoverage` (TST-3 verdict) and
  `requirementCoverageReport` (the combined TST-2/TST-3 report this contract
  exists to produce).
