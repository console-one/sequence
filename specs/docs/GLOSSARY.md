# Glossary — internal vocabulary → standard vocabulary

This package grew its own words. Every one of them names a mechanism
that has a standard name in the wider literature; this table is the
bridge, so a reader can evaluate the design in the vocabulary they
already own. Deeper mechanics live in the file each row points to.

| Term here | Standard vocabulary | What it is |
|---|---|---|
| the continuum | one lattice for types and values | Schema declarations and concrete data live in one partial order; assignment and type-narrowing are the same write. A value is a maximally concrete type. |
| ft | the DSL / wire format | The text language that round-trips with the store. Implemented entirely in `src/dsl/` — this repo is its only implementation. |
| mount (v1) / insert (v2) | append + synchronous projection update | The single write operation: append events, run reactive propagation to a fixed point. |
| block | atomic transaction / event-sourcing commit | A batch of statements applied all-or-nothing, optionally guard-gated. |
| statement | domain event | One immutable operation record (bind, delete, schema, narrow, tool, policy, invalidate). |
| cell | versioned store node | A per-path node whose patch log is authoritative; current state is a fold over it. |
| projection | derived state / materialized read model | Rebuilt from the log, cached for reads — never the source of truth. |
| narrow (`<<`) | constraint intersection / refinement merge | Tighten a type in place; never an overwrite. |
| compose | lattice meet / type unification | The tightest type consistent with both inputs; `never` (bottom) on contradiction. |
| gap | validation error, or a typed hole | A predicate a value failed, or a declared-but-unfilled slot surfaced as work to do. |
| law | policy rule as data | Admission/read predicates stored in the store they govern, evaluated at the write/read boundary — including over their own handoff. |
| cascade / fire laws | reactive dataflow propagation | Spreadsheet-style recomputation run to convergence after a write. |
| backward index | reverse dependency graph | The subscription table dispatching derived values, suspended-write retries, invariants, and transition guards. |
| concreteness | completion/confidence score | A [0,1] distance-from-done, optionally a distribution over time. |
| decay | survival function | A declared model of how a claim's probability of remaining true degrades with time. |
| conjugate update / posterior | Bayesian inference | Cost and reliability are distributions refined by observed calls, never authored. |
| hoist | serialize / pretty-print the store | Project live state back to valid ft text. Round-trip is store → text → store. |
| expansion token `[[…]]` | typed hole / lazy stub | A placeholder that parses and prints; how omitted content stays redeemable. |
| narrative | preserved comments | `--` lines survive the pipeline as data. Stripping them changes nothing load-bearing (the strip guard). |
| vend | compile a capability manifest | A budget-fitted, per-client tool surface issued with a session lease. |
| the elected frame | budgeted context assembly | Saved query → graph walk → scoring → knapsack selection → session document. |
| election | (a) selection under budget (b) act-or-wait decision | Two senses: knapsack admission with priced scarcity; and a scheduling decision with a wake epoch. |
| duals | shadow prices | Marginal value of one more unit of each saturated budget, reported with every selection. |
| label group | content variants under budget | Short/long alternatives of one doc; the budget elects one. |
| redemption | implicit-feedback relevance credit | Engaged-but-omitted content earns its way into future selections. |
| commitment | async-call lifecycle record (outbox/saga entry) | pending → fulfilled/violated, with deadline and holder. |
| holder | endpoint/principal identity key | Who a lease, commitment, or reliability posterior belongs to. |
| indexSpec | materialized view / continuous query | Declarative join-filter-project, re-evaluated on change. |
| partition (state/proc/id/req/chan/proj) | data-classification tier | Information-flow rules (allowed reference directions) plus durability policy per path class. |
| working set / evicted / promoted | budgeted cache retention | What stays hot under a budget — with evictions reported, never silent. |
| auto-wire | reactive dependency injection | An unfilled typed slot connects to the unique tool whose output covers it. |
| rotation | tiered-storage migration | Move a range colder, leave a forwarding pointer. |
| learning / promotion | schema inference from data | Repeated observed values promote to a declared union type, evidence-gated. |
| seam N | numbered architecture boundary | An internal layer/extension-point label. |
| deletion ledger | staged strangler-fig migration | The tracked stages by which v1 modules die as consumers re-point to v2. |
| ratchet (PARSE_LEDGER) | known-failure allow-list, two-way | CI fails on regressions AND on unrecorded progress. |
| author / time (on a write) | the act's indexicals — trusted inputs | Who asserted, when. Bound by the host, never derivable inside. See [HOST_CONTRACT.md](HOST_CONTRACT.md). |
