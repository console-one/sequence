# Part 5: Attention

A store that holds everything is only useful if it can answer a harder
question: *given this reader and this budget, what is worth showing?* A
context window, a status pane, and a morning brief are all the same
problem — scarce representation space, allocated. sequence makes that
allocation a single pipeline over the store: **cluster → score → rank →
budget → hoist**. This part renders one store under two budgets and
watches the answer change shape honestly.

## A store with more than fits

Four subsystems, each with a declared shape and *partial* state — the
unfilled properties are gaps, and gaps are raw material for the scoring
step:

```js
for (const [name, bound] of [['billing', 2], ['ingest', 1], ['deploy', 0], ['alerts', 3]]) {
  seq.mount('schema', name, FT.object({
    status: FT.string().toType(),
    owner: FT.string().toType(),
    retries: FT.number().toType(),
  }));
  // bind the first `bound` of { status, owner, retries }
}
```

## Readers are configurations, not code

A reader is data: a budget (`maxItems`), a depth, weights over the
scoring signals, and learned priors. Two readers, same store — one
narrow, one wide:

```js
const reader = (maxItems) => ({
  maxItems,
  maxDepth: 3,
  weights: { actionability: 1, coherence: 0.5, cascadeImpact: 0.5, urgency: 1, learnedBoost: 0.2 },
  priors: new Map(),
});

const narrow = renderForReader(seq, reader(2));
const wide   = renderForReader(seq, reader(10));
```

The signals are worth naming, because they are the editorial policy made
explicit: **actionability** (gaps close to concrete — nearly-done work),
**urgency** (nearest declared deadline), **cascadeImpact** (dependencies
crossing out of the cluster — unblocking value), **coherence** (internal
connectedness), and a **learned boost** from priors over cluster shapes
(a beta belief updated by what this reader engaged with before — the
same conjugate machinery as part 3, pointed at the reader).

## Scarcity is real, and it is reported

```
narrow budget → 8 paths evicted
wide budget   → 0 paths evicted
narrow.text.length < wide.text.length
```

The budgeted result isn't a truncation — it is a *different rendering*,
and the pipeline tells you what didn't make the cut (`evicted` is a list
of paths, each still resolvable in the store, expandable on demand).
Compression that reports its losses can be audited; compression that
doesn't becomes silent data loss at the reader's expense.

That reporting is the design rule of this whole part: the store may
show you less, but it may never lie about there being less.

## The same pipeline at every boundary

Nothing in `renderForReader` knows whether the reader is a person's
status pane, an LLM's context window, or another machine's sync
partner. In [Shared Office](https://www.sharedoffice.ai) this exact
pipeline is production: the morning brief is a ~500-token election over
the owner's whole workspace, and every audience (CLI, GUI, agents over
MCP) is one renderer flavored per reader — not code per surface.

Which closes the loop of the tutorial. Part 1 made description and data
one substance; part 2 made the substance speakable; parts 3 and 4 gave
it cost, time, and law; part 5 spends a budget over it. One log, one
lattice, one judgment — *what deserves attention, priced* — bound at
different boundaries.

## Where to go next

- [`examples/`](../examples/README.md) — the claim-by-claim runnable
  proofs (each exits non-zero if its claim breaks).
- `examples/bench.mjs` — reproducible numbers, including the honest
  mount-scaling curve ([#1](https://github.com/console-one/sequence/issues/1)).
- [`specs/docs/`](../specs/docs/) — architecture and invariant papers.
