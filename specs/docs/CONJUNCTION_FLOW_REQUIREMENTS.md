# Conjunction Flow Requirements

## Status

Normative. These are the missing intelligence-layer requirements derived from the design session of March 31 - April 3, 2026. The plumbing (statements, sequence, type checking, hoist) exists. These requirements govern the intelligence that makes the system optimal.

---

## 1. Three-Way Conjunction Flow

A clause is a three-way relationship:
1. **Refs** it depends on — each with probability of resolving, importance, time horizon
2. **Consequence** it gates — what gets mounted if the clause is satisfied
3. **Conjunction** — all refs must resolve for the consequence to apply

When ANY vertex changes, implications flow to the other two:
- Ref probability changes → conjunction probability updates → consequence expected value updates
- Consequence importance changes → urgency of resolving refs updates
- One ref in conjunction resolves → other refs' importance may change

The current cascade is forward-only (value changed → deps recompute). Missing: backward flow (consequence changed → what refs are affected) and sideways flow (one ref changed → conjunction probability → other refs' priority).

**Required data structure:** Beyond the forward `depIndex` (source → targets), need:
- Reverse dep map: target → sources
- Conjunction map: which refs co-participate in which clauses
- Probability per ref: P(concrete) at current time, projected over time horizon

---

## 2. Generic Var Identity as Backward Inference Channel

`Function<T, T & Effects>` must propagate constraints from output back to input through the shared type variable T.

Given:
```
f: (T) => T & { id: T.input }
g: (U) => U & { status: 'done' }
pipeline = g(f(x))
```

If `pipeline.status == 'done'` must be true, then:
- g's identity: U out has status → U in must support status → f's output must support status
- f's identity: T out = T & { id } → must also carry status → T in must support { id, status }
- Therefore x must be a type that produces { id, status } through f

The generic var T is the WIRE. Without it, functions are black boxes — no backward propagation.

**Required:** `FieldType.compose(functionOutput, requiredConstraint)` must correctly propagate the constraint backward through the function's generic var to derive the input constraint.

---

## 3. Probability = Type Concreteness Position

The type lattice position IS the probability:
- Fully concrete (literal) = probability 1.0
- Gap (unresolved ref) = probability from historical resolution rate
- Temporal constraint = probability from REAL_TIME proximity to threshold
- `any` = maximum uncertainty
- `never` = impossible (probability 0)

Probability is NOT a separate field on a node. It IS the type's position in the lattice. `compose` IS the probability update. When two types compose, the resulting concreteness level IS the updated probability.

**Required:** The sequence must be able to answer: "what is P(path X is concrete at time T)?" by examining the type at X, its dependencies, and historical traces.

---

## 4. Time-Projected Function Types

A function type must carry its expected execution time as a type constraint:

```
function.output.time < deadline P90
```

This means: at the 90th percentile of historical execution times, this function completes before the deadline. The back-search uses this to prune paths that can't meet deadlines.

**Required:** Function types have temporal constraints computed from traces. The planner can query: "given this function and its current input concreteness, what is P(output concrete by time T)?"

---

## 5. Merge as Generator

The merge IS the scheduler. It's a generator function that:
1. Walks clauses in the patch
2. For each clause: evaluate against current state
3. If concrete → apply, advance state
4. If gap → yield the gap. Caller fills it. Generator resumes.
5. Repeat until all clauses applied or all gaps yielded.

```ts
function* merge(state, patch) {
  for (const clause of patch) {
    const result = clause.apply(state);
    if (result.concrete) {
      state = result.value;
    } else {
      const fill = yield result.gap;
      state = clause.apply(state, fill);
    }
  }
  return state;
}
```

The generator's state IS the frontier. The yield IS the suspension. The resume IS backward inference (later info closing earlier gap).

**Required:** The tell operation returns a generator, not a synchronous result. The process drives the generator, filling gaps from capabilities, LLM, or external input.

---

## 6. Delta-Only Rescheduling

When a new observation violates an assumption, only affected branches reschedule.

```
observation arrives at path X
  → find all conjunctions containing ref to X
  → recompute each conjunction's probability
  → for conjunctions whose probability changed significantly:
    → recompute the consequence's expected value
    → if expected value dropped below threshold:
      → reschedule: find alternative path or abandon plan
    → if expected value increased:
      → accelerate: this work is now more urgent
```

This is O(delta) — proportional to the change, not the plan size.

**Required:** Conjunction tracking so that observation deltas propagate minimally through the three-way flow.

---

## 7. Scheduling Algorithm (derived from above)

1. Goal arrives: (gap type, deadline)
2. Back-search: find functions whose output type closes the gap AND projected completion time < deadline
3. For each function: back-propagate input requirements through generic var identity
4. If input concrete → function can run → schedule it
5. If input is another function's output → recurse with earlier deadline (sub-goal)
6. If input probability < 1 → compute expected resolution time, factor into scheduling
7. Pick path with minimum expected regret = (depth of downstream dependency × P(assumption fails))
8. Schedule leaf tasks where REAL_TIME > their min start
9. For tasks where REAL_TIME < min start → compute next wake time from earliest pending
10. On new observation before expected start → propagate delta through conjunctions → reschedule only affected branches

---

## 8. LLM as Heuristic Fallback

For high-order work where the type-pruned backward search is too large:
- Render the conjunction graph (goals, available functions with IO types, current gaps, probability distribution) as prompt text
- LLM reasons heuristically and produces statements
- Statements get type-checked same as any function output
- Invalid → gaps. Valid → close gaps, update conjunction graph.

The prompt IS the predictive frontier rendered as text. Prompt compression = show highest expected-value conjunctions first.

---

## 9. Implementation Order

1. Generic var identity through compose (the backward channel)
2. Conjunction tracking data structure
3. Probability computation from type lattice position
4. Time-projected function types
5. Merge as generator
6. Three-way delta propagation
7. Back-search through function graph
8. Delta-only rescheduling

Each step depends on the previous. Do not skip ahead.

---

## 10. What Already Exists

In `packages/core/src/`:
- `statement.ts` — Statement type with product-space Ref
- `sequence.ts` — Statement sequence with mount, project, suspend, resume, cascade, compact, conjunction tracking
- `type.ts` — Constraint set with ~30 constraint constructors
- `compose.ts` — Lattice meet, backward inference, concreteness computation, conjugate updates
- `builder.ts` — FT.* API
- `hoist.ts` — Projection → ft text
- `dsl/` — tokenizer, parser, walker, extract

Conjunction tracking (conjRefIndex, conjProbCache, priorityCache, delta propagation) is implemented. Branch-and-bound search is implemented. Remaining: merge-as-generator (R5), some scheduling algorithm details (R7).
