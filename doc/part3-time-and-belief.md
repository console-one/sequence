# Part 3: Time and belief

Every scheduling decision an agent system makes leans on two questions
ordinary type systems can't ask: *how long do things take*, and *how
much do we still believe what we observed*. sequence carries both as
data — a cost is a distribution, an observation has a validity that
decays — and gives you closed operations over them. This part prices a
tool call, learns from real calls, and decides whether a plan fits a
deadline.

These are plain exported functions (`conjugateUpdate`, `cdfInverse`,
`evidenceDecay`, `planFeasibility`); in the full system the resulting
curves are mounted on the store like any other fact, so a tool's cost
travels with its definition.

## A cost you learn, not guess

Model a tool call's runtime as exponential with unknown rate, and hold a
gamma belief over that rate. Start nearly ignorant — one pseudo-
observation of one second:

```js
let belief = { shape: 1, rate: 1 };
```

Five real calls land, with runtimes in seconds. Fold each one in:

```js
for (const s of [1.8, 2.3, 1.9, 2.2, 1.7]) {
  belief = conjugateUpdate('gamma', belief, s);
}
```

```
belief → { shape: 6, rate: 10.9 }      // every observation accounted for
posteriorPredictive('gamma', belief) → 0.5505 calls/sec
expected runtime → 1.82s               // tracking the true ~2s mean
```

No fitting step, no separate estimator service: the belief is two
numbers, and updating it is addition. That cheapness is what lets a cost
curve ride along on every tool definition.

## The deadline question, answered from the same belief

"When is this call 95% likely to be done?" is the inverse CDF of the
same belief — tail risk included:

```js
cdfInverse('exponential', 0.95, { rate: 0.5505 })
```

```
→ { t: 5.44, approximate: false }      // 5.44s, well past the 1.82s mean
```

## Evidence ages

An observation from three hours ago should move today's belief less than
one from three minutes ago. `evidenceDecay(age, halfLife)` is the
weight, and `conjugateUpdate` takes it directly:

```js
evidenceDecay(1 * HOUR, HOUR)   // → 0.5
evidenceDecay(3 * HOUR, HOUR)   // → 0.125

conjugateUpdate('gamma', belief, 10, 0.25)  // a stale 10s observation…
```

```
stale update moves rate by +2.50   // …counts for a quarter
fresh update moves rate by +10.00  // of a fresh one
```

## Does the plan fit the window?

Now compose. A two-step plan — an LLM call then a deploy, each a
lognormal runtime in milliseconds — against a deadline, at a required
confidence:

```js
const steps = [
  { family: 'lognormal', params: { mu: 7, sigma: 0.5 } },   // ~1.1s median
  { family: 'lognormal', params: { mu: 8, sigma: 0.5 } },   // ~3s median
];
planFeasibility(steps, 20_000, 0.9, 'independent')
planFeasibility(steps,  3_000, 0.9, 'independent')
```

```
20s window → feasible   (P = 1.000)
 3s window → infeasible (P = 0.188)
```

Same plan, two verdicts — deadlines bind agents, and now the binding is
computable *before* the work starts.

One more thing, and it is the most characteristic design choice in this
part. If you *don't* declare how the steps' runtimes correlate, the
kernel does not quietly assume independence — it falls back to a
comonotonic worst-case bound and says so:

```js
planFeasibility(steps, 20_000, 0.9, null)
```

```
→ feasible (P = 0.992), dependency_model: "worst_case_bound"
```

The probability is *lower* than the independent model's — the answer you
get without stating your assumptions is never more confident than the
one you get by stating them. Honesty is the default, not a flag.

Next: [Part 4 — laws and identity](part4-laws-and-identity.md), where
the store enforces its own constitution at the write boundary.
