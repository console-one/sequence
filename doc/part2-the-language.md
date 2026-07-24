# Part 2: The language

Part 1 wrote single statements. This part shows why the text form — the
**ft language** — is a first-class surface and not a config format: it
can declare a *family* of things at once, gate writes on state that
doesn't exist yet, refuse malformed data with reasons, and the store can
emit itself back out as the same language it was built from.

The running example is a labelled task queue: workers submit typed work,
claim it, and complete it. The whole thing is one schema and a handful
of writes. (The full file ships in the repo as
[`stdlib/taskqueue.ft`](../stdlib/taskqueue.ft).)

## One schema for a family of paths

A task's path IS its identity — `tasks.t1`, `tasks.t2`, … — so the
schema is declared once, for the wildcard:

```ft
tasks.* = {
  status: "pending" | "active" | "done" | "expired",
  input: string,
  output?: string,
  assignee?: string,
  deadline?: number,
  labels?: [string]
}
```

Every path that ever appears under `tasks.` is now governed by this
shape: four legal statuses, a required input, optional completion
fields. No registration step, no per-task ceremony.

## Submitting work — and the store saying no

A well-formed task lands immediately:

```ft
tasks.t1 = { status: "pending", input: "ship the docs" }
```

```
seq.get('tasks.t1') → { status: "pending", input: "ship the docs" }
```

A malformed one — a status outside the union — is refused *by the
schema*, with the exact reason:

```ft-rejected
tasks.t2 = { status: "bogus", input: "x" }
```

```
{ ok: false, gaps: [ { path: "tasks.t2.status", reason: "matches none of 4 branches" } ] }
```

Nothing about validation was written anywhere. The schema is the
validator, because the schema and the data live in the same lattice.

## Writes that wait: `when`

Here is the moment the language stops looking like JSON-with-types. A
write can be *gated on state that does not exist yet*. Suppose a receipt
must only exist once the task has produced output:

```ft
tasks.t1.done_receipt = "receipt-9" when tasks.t1.output EXISTS
```

The store accepts the statement but **suspends** it — the receipt is not
readable, and the suspension is visible, not swallowed:

```
seq.get('tasks.t1.done_receipt') → undefined
seq.suspended().length           → 1+
```

When the dependency lands, the suspended write promotes on its own:

```ft
tasks.t1.output = "docs shipped"
```

```
seq.get('tasks.t1.done_receipt') → "receipt-9"
```

That is a task-queue completion rule, an eventual-consistency handler,
and a "don't act before the precondition" guard — expressed as one
declarative line, enforced by the store rather than by caller
discipline.

## The store speaks its own language back

`hoist` emits the projection as ft text. This is not a debug dump — it
is *valid input*: what comes out can be received by another store.

```
tasks.t1.assignee = "worker-a"
tasks.t1.done_receipt = "receipt-9"
tasks.t1.output = "docs shipped"
…
```

Round-trippability is what makes the store a communication substrate and
not just a database: two processes that share the ft language can ship
each other typed state, obligations included. (This is how the
Shared Office product moves capability definitions between machines.)

## An honest wart

Reads at different granularities can currently disagree: if you bind a
whole object (`tasks.t1 = {…}`) and then narrow one child
(`tasks.t1.status << "active"`), the child read updates but the *parent*
read still returns the original composite — and children of object binds
aren't path-readable until individually written. Tracked as
[#2](https://github.com/console-one/sequence/issues/2). Until it's
fixed, the reliable pattern is the one this page uses: bind leaf paths
for state you'll read at leaf granularity.

Next: [Part 3 — time and belief](part3-time-and-belief.md), where a
tool call's cost is a curve the store refines as real calls land.
