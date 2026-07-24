# Examples — runnable claims

Each file here demonstrates one claim of the type system and **asserts
it** — the script exits non-zero the moment the claim stops being true.
They are proofs you can run, not printouts.

```bash
git clone https://github.com/console-one/sequence.git
cd sequence
npm install && npm run build
node examples/run-all.mjs     # all six, fail-fast
node examples/bench.mjs       # reproducible numbers on your machine
```

The examples import `@console-one/sequence` by name (Node self-reference)
— every line works unchanged in your own project after
`npm install @console-one/sequence`.

| Example | Claim it proves |
|---|---|
| `01-continuum.mjs` | Types and values are one continuum: a value is a maximally concrete type; `compose` (lattice meet) only narrows; contradictions bottom out at `never`. |
| `02-distributions.mjs` | Runtime cost is a curve, not a constant: gamma-conjugate learning from observed calls, `cdfInverse` answers "when is this 95% likely done", aged evidence updates with less weight. |
| `03-temporal.mjs` | Time is in the type system: `evidenceDecay` ages beliefs; `planFeasibility` decides whether a stochastic plan fits a deadline — and fails closed to a conservative bound when the dependency model is undeclared. |
| `04-identity.mjs` | Function types carry identity (`preserves`): `backwardInfer` derives required inputs from a required output through a chain; `covers` checks claims. |
| `05-laws.mjs` | Laws are data, enforced by the store at admission — including over their own handoff. |
| `06-attention.mjs` | Attention, priced: one store rendered under two budgets via cluster → score → rank → budget → hoist, with evictions reported, never silent. |
