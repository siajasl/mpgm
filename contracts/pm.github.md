# `pm.github`

**Purpose.** Project the plan and the run onto GitHub — a board, milestones,
labels, and one issue per plan task — and keep it current. Satisfies PMG-1
(the projection), PMG-2 (event-driven currency), PMG-3 (derived, repaired by
reconcile) and PMG-4 (idempotent bootstrap).

**Definition.** `pmGithubContract` in [`src/pm/reconcile.ts`](../src/pm/reconcile.ts).
**Projector.** [`src/pm/projector.ts`](../src/pm/projector.ts).
**Reference provider.** [`src/pm/github-provider.ts`](../src/pm/github-provider.ts) — GitHub REST via `gh`.

## The shape of it

The board is derived state, so there is nothing to keep in sync. There is a
**desired projection** — a pure function of the gated Plan artifact and folded
kernel state — and a diff against what the board holds.

```
desiredProjection(plan, run)  ─┐
                               ├─→ reconcile(...) ─→ operations ─→ apply
observe()                     ─┘
```

Bootstrap is that call against an empty board. Reconcile is the same call
again. Currency is the same call running when an event commits rather than on
a timer. One function, four requirements — and PMG-4's "re-running converges
instead of duplicating" is structural rather than something a provider has to
be careful about.

## Operations

### `observe`

| | |
|---|---|
| Input | `{ repo: string }` |
| Output | `{ labels, milestones, issues, columns, boardTitle }` |
| Effects | `read-only` |

Each issue is reported with a `key` — the task id, read back from the marker in
its body (`<!-- mpgm:task=T3.1.1 -->`). **Idempotency rests entirely on this.**
A provider that matched issues by title would create a second issue the first
time a task was renamed.

A provider MUST report only issues carrying the marker. Issues people opened
are not the projector's to know about.

### `apply`

| | |
|---|---|
| Input | `{ repo: string, operations: object[] }` |
| Output | `{ applied: number, issues: Record<taskId, number> }` |
| Effects | `idempotent` |

Operations, in order:

| `kind` | Meaning |
|---|---|
| `create-board` | Board with the six task columns |
| `create-label` / `update-label` | Label taxonomy |
| `create-milestone` / `update-milestone` | Plan milestones |
| `create-issue` | New task issue, marker in the body |
| `update-issue` | Title, body, labels, milestone |
| `move-issue` | Column and open/closed state |
| `link-pull-request` | Associate a PR with a task's issue |

A provider MUST fail on an operation kind it does not recognise. Skipping one
silently leaves the board wrong in a way the next reconcile will keep trying
and failing to fix.

Every operation is keyed by something stable — a label name, a milestone title,
a task marker — so replaying the batch after a crash converges rather than
duplicating. That is what makes the effect semantics honestly `idempotent`.

## Columns

`backlog`, `ready`, `in-progress`, `in-review`, `blocked`, `done`.

How a column is *represented* is the provider's business, which is the point of
having a contract. The reference provider encodes one as a `status:<column>`
label, because labels are what a repository has on its first day and what
survives a board being deleted. A GitHub Projects v2 provider encodes it as a
board field instead, with no change anywhere above it (EXT-2/3).

`done` is the one that needs care. A task that went through the implement loop
is done when its change **merged**, not when its session finished — showing a
completed session whose change is still in review as done is the one wrong
answer that matters. A task that never entered the loop is done when it
completes, because nothing else is going to happen to it.

## Labels

`type:task`, `phase:<id>`, `milestone:<id>`, and `role:<name>` once a task has
been dispatched — the role comes from the kernel, not the plan, because a plan
task does not name one (DESIGN §4.2).

PMG-1 also asks for a priority label. The Plan schema carries no priority, so
there is nothing to encode; inventing one here would put a field on the board
that nothing decides. It arrives when the plan does.

## What the projector will not do

**Delete.** An issue the plan no longer mentions is left alone — it may be a
task somebody split, an issue a person opened, or a plan revision still in
review. A projector that closes other people's issues because they are not in
its model is one nobody will leave running.

**Read GitHub as truth.** Inbound activity arrives through the Maintain signal
path and becomes triaged work items (DESIGN §4.9), never direct kernel
mutations (PMG-3).
