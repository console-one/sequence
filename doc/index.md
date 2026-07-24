# An introduction to sequence

sequence is a tool for building systems where the *description* of the
system — its types, its obligations, its costs, its rules — is the same
substance as the system's data, lives in one append-only store, and can
be computed with.

That sentence is dense, so here is the problem it answers. If you are
building anything agent-shaped — a harness, a tool router, a job queue
that LLMs and people share — you need answers to questions ordinary type
systems refuse to touch:

- *Is this record complete enough to act on?* (not "does it typecheck" —
  how close is it, and what exactly is missing?)
- *How long will this call take?* (a distribution learned from observed
  calls, not a constant someone guessed)
- *Can this plan finish before the deadline, at what confidence?*
- *Who may write this, and what happens to writes that arrive early?*
- *Given a 500-token budget, what is the most useful rendering of this
  state for this reader?*

sequence's answer is one mechanism: an append-only log of typed facts
("mount" is the only write), a derived projection over it, and a type
lattice where **a value is just a maximally concrete type**. Schemas,
values, laws, cost curves, and even the reader configurations that
render the store are all mounts on the same log. There is a text form —
the **ft language** — that round-trips with the store: what you can
mount from text, the store can emit back as text.

Fair warning: some of this will feel inverted at first (the type system
is *runtime data*; "compiling" is mounting). The tutorial builds up in
small steps, and every code block below is real — the ft blocks in these
pages are executed by the repository's test suite, and shown outputs
come from actual runs. Where the system has a known wart, the text says
so and links the issue rather than writing around it.

## The tutorial

1. **[The continuum](part1-the-continuum.md)** — mount, schemas vs
   values, `=` vs `<<`, obligations, and concreteness: the distance
   between "declared" and "done" as a number.
2. **[The language](part2-the-language.md)** — ft text in and out:
   wildcard schemas, unions, rejection with reasons, `when`-gated writes
   that suspend and resume, and hoisting the store back to text. A task
   queue in ~20 lines.
3. **[Time and belief](part3-time-and-belief.md)** — cost as a learned
   curve, evidence that ages, and deadline-feasibility for stochastic
   plans that fails closed when you don't declare independence.
4. **[Laws and identity](part4-laws-and-identity.md)** — admission laws
   the store enforces at its own write boundary (including over their
   own handoff), and deriving required inputs backward from a goal.
5. **[Attention](part5-attention.md)** — one store, many readers, each
   with a budget: cluster → score → rank → budget → hoist, with
   evictions reported instead of silently dropped.
6. **[Clauses and claims](part6-clauses-and-claims.md)** — the layer the
   language was designed for: `when`/`while`/`by` gates on statements,
   enforced predicates (`MATCHES`, `IN`, bounds), Δt interval scope and
   reliability curves on claims, and the quantifier layer (∀/∈ as
   `index … over … where`). Includes the honest designed-vs-implemented
   ledger.

## Where this is used

sequence is the semantic kernel of [Shared Office](https://www.sharedoffice.ai)
— capability there is fn-definitions-stored-as-facts on this store, and
its budgeted views are part5's pipeline in production. The runnable
claim-by-claim proofs live in [`examples/`](../examples/README.md), and
the honest benchmarks (including the currently-unflattering mount
scaling curve, [#1](https://github.com/console-one/sequence/issues/1))
in `examples/bench.mjs`.
