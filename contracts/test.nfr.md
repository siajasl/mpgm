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

`requirementId` in the output MUST echo the one the provider was asked to
measure. `runNfrSuite` refuses a result whose echoed `requirementId` disagrees
with the requirement it just requested, by throwing `NfrMismatchError` rather
than rebinding the result to the requested id: a mismatch reads identically
whether the provider mislabelled the right measurement or answered a
different, out-of-order call, and only the provider knows which. Rebinding
would resolve that ambiguity by trusting it — reporting the requested
requirement verified from a measurement that may actually be of another one.



Repeatable: a rerun produces a fresh, independently comparable measurement.
Unlike `pm.github#apply`, nothing here needs to converge on a prior call's
effect, because there is no state to converge on — only a new reading.

## Coverage

`nfrCoverage(requirements, results)` is pure — the same requirements and
reported results always produce the same rows, so it replays from the log
rather than re-asking a provider whose target may since have changed
(mirrors `mergeVerdict`). Where `results` holds more than one entry for the
same requirement — a rerun after a fix, replayed from a log spanning several
runs — the most recent entry wins; an earlier, superseded measurement never
outvotes the one that actually ran last. A row is:

- **verified** — a result came back for the requirement and `passed` was true;
- **not-run** — no result came back for it at all;
- **below-threshold** — a result came back and `passed` was false.

A verified row's `verifiedBy` names the requirement's own `measuredBy` (SCP-1)
— the "by which tests" attribution TST-2 asks the general coverage report for.
It is empty wherever the row is not verified.

`requirementCoverageReport` folds these rows into the general trace-graph
coverage query (`TraceIndex.coverage`, TST-2) that already answers for
functional requirements from commit `Verifies:` trailers: a requirement counts
as verified if *either* source says so, and its `verifiedBy` is whichever
source(s) verified it. A quantified NFR this run did not re-measure but a
still-current commit already verified is not newly unverified because this
run happened to skip it, and a fresh pass counts — attribution included —
before anything has been committed to say so.

That OR has one exception: a fresh **below-threshold** result decides on its
own, ahead of the trace graph. It is this run's own evidence that the
requirement failed, and an older `Verifies:` trailer — necessarily measured
before this run, or it would be this run's own result — does not get to
outvote it. The row reports `verified: false` and keeps `problem:
'below-threshold'` regardless of what the graph claims; only the *not-run*
case falls back to the graph's verdict, because there the graph is the only
source with anything to say.

## Quarantine (TST-6)

A quarantine ledger tracks flaky tests and excludes them from coverage claims
(DESIGN §4.7). `detectFlaky` (`src/test/quarantine.ts`) compares at least two
reruns of the same suite against the same code and reports every test id whose
outcome disagreed — including a test that sometimes went unreported, which is
itself a disagreement rather than a hole to skip over. A rerun that reports
the same test id twice is refused (`FlakyDetectionDuplicateIdError`), not
folded: comparing an id's two reports against each other inside one run would
read as that id disagreeing with itself, which is a within-run duplicate
mistaken for a between-run flake. `detectAndQuarantine`
folds what it finds straight into the ledger: there is no operator gate
between detection and quarantine, the same way a red `ci.checks` verdict
blocks a merge without anyone approving that it should. Quarantining the same
test again is a no-op (idempotent, mirroring `pm.github`'s reconcile), so a
still-flaky test does not grow a second row every time it disagrees again.

The ledger reaches `requirementCoverageReport` through its `quarantined`
input: `withoutQuarantined` strips a quarantined id out of `verifiedBy` on
both the `graph` and `nfr` sources *before* they are combined, so a
requirement whose only evidence was a since-quarantined test comes back
`verified: false` rather than holding on evidence the ledger no longer
trusts — coverage drops, it does not silently stay put. A requirement a
second, non-quarantined source still verifies is unaffected: quarantine
removes one test's standing as evidence, not the requirement's.

## Reference provider

[`commandNfrProvider`](../src/test/nfr-provider.ts) is what `mpgm run <phase>`
binds this capability to (`src/cli/commands.ts`), so a playbook's `nfr` node
reaches a real measurement from the entry point an operator actually uses —
before T4.3.2 the contract had a specification, a runner and no provider at
all.

It runs what the project declares in `test/nfr.yaml`:

```yaml
measurements:
  - requirement: PERF-1
    metric: p95-latency
    unit: ms
    direction: at-most       # or at-least; no default
    command: npm
    args: ['run', 'bench:latency']
    evidence: reports/latency.json   # optional
```

One entry per quantified requirement. The command is run in the project root
and the last non-empty line of its stdout is the measurement; `direction` is
what turns that number into `passed`, and it is required rather than defaulted
because this contract says in as many words that only the provider knows which
way a threshold reads (CONV-5).

**What it measures is the checkout at that root, and it says so.** `run`
carries a `repo` and a `ref`, and the kernel blocks a whole phase rather than
guess either; this provider therefore corroborates the ref instead of
accepting it as a label. `git rev-parse HEAD` must be the commit `ref` names —
a full sha, an abbreviation, a branch or a tag, whichever the operator passed,
resolved in that checkout — and a root that is not a readable git checkout is
refused outright. Running `mpgm run test --ref <sha>` from a working tree at
any other commit would otherwise measure the working tree and file the numbers
as measurements of `<sha>`: the same measured-one-thing-labelled-another
ambiguity this contract already refuses for a drifted `metric`/`unit` and for
a mislabelled `requirementId`. Every result's `evidence` names
`repo@<head sha>` for the same reason, so a row records what was measured and
not only what it was asked about.

The guarantee is at commit granularity, and the limit is stated rather than
implied: a *modified* working tree is reported — `evidence` gains `working
tree modified` — not refused, because a phase writes its own artifacts into
the project root as it runs and refusing would block a phase on its own
output.

Six things it refuses rather than answers, all for the reason this contract
gives above — a measurement that did not happen is never reported as one that
held (CONV-4):

- a requirement the manifest does not declare (the provider must not invent a
  measurement for a requirement it did not run);
- an entry whose `metric`/`unit` disagree with the threshold the kernel sent,
  which is a manifest that has drifted from the requirement it names and is
  measuring something else under the right id;
- a root whose commit cannot be read at all;
- a root at a commit other than the one `ref` names;
- a command that failed, timed out, or printed nothing — `Number('')` is `0`,
  and zero is inside every ceiling there is;
- a last line that is not a number.

Each throws, which blocks the step — and a blocked step writes no coverage
artifact at all, which is the point. `nfrCoverage`'s `not-run` row is what a
*completed* run says about a requirement nothing reported on; it is not a
softer landing these refusals fall into.

## Consumers

- [`src/test/nfr.ts`](../src/test/nfr.ts) — `runNfrSuite` (the orchestration:
  call `run` once per quantified NFR), `nfrCoverage` (TST-3 verdict) and
  `requirementCoverageReport` (the combined TST-2/TST-3 report this contract
  exists to produce).
- [`src/phase/runner.ts`](../src/phase/runner.ts) — the `nfr` playbook step
  (T4.3.2), which folds `runNfrSuite` against whatever this capability is
  bound to and blocks rather than treating an unbound one as nothing to
  measure. It produces `nfrCoverage`'s rows and stops there:
  `requirementCoverageReport` — the fold of those rows with the trace graph
  and the quarantine ledger — has **no caller yet**, and not because a
  `TraceIndex` is missing: `PhaseRunOptions.traces` already exists and
  `run()` (`src/cli/commands.ts`) already builds and passes one, so the
  general trace-graph coverage query is reachable today. What is missing is
  a quarantine-ledger option on `PhaseRunOptions` (the `quarantined` input
  has nowhere to arrive from), a registration of `RequirementCoverageReport`
  in either schema registry (so `writeArtifact` — whose schema comes from
  the *calling playbook's own* `artifacts` map — would have nothing to write
  it against even if one were computed), and a playbook node naming which
  node produces it, over the full Scope requirement list rather than the
  quantified subset one `nfr` step measures. All three are the Test phase's
  own wiring (T4.3.3, which already records `RequirementCoverageReport` as an
  interface in neither schema registry), and are named here rather than left
  to be discovered: until they land, a Test run reports NFR coverage and not
  the combined TST-2/TST-3 report.
- [`src/test/quarantine.ts`](../src/test/quarantine.ts) — `detectFlaky`,
  `quarantineFlaky`/`detectAndQuarantine` (TST-6's ledger) and
  `withoutQuarantined` (the exclusion `requirementCoverageReport` applies).
