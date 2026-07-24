// 03 — Time is in the type system: evidence ages, plans have feasibility.
//
// Two temporal primitives:
//   evidenceDecay(age, halfLife) — the validity(t) weight of a fact.
//   planFeasibility(steps, deadline, confidence, model) — will this chain
//     of stochastic steps finish before the window closes? The dependency
//     model is explicit; when it is missing the answer fails CLOSED to a
//     conservative bound rather than silently assuming independence.
import { evidenceDecay, planFeasibility } from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('03-temporal — aging beliefs and deadline-feasible plans');

const HOUR = 3600_000;

// Fresh evidence is worth 1; one half-life later, half; monotone after.
assert(evidenceDecay(0, HOUR) === 1, 'fresh evidence has full weight');
assert(Math.abs(evidenceDecay(HOUR, HOUR) - 0.5) < 1e-9, 'one half-life halves the weight');
assert(
  evidenceDecay(3 * HOUR, HOUR) < evidenceDecay(2 * HOUR, HOUR),
  'decay is monotone — older is always worth less',
);

// A two-step plan: an LLM call then a deploy, each a lognormal runtime
// (milliseconds). mu/sigma in log-space: e^7 ≈ 1.1s, e^8 ≈ 3s medians.
const steps = [
  { family: 'lognormal', params: { mu: 7, sigma: 0.5 } },
  { family: 'lognormal', params: { mu: 8, sigma: 0.5 } },
];

const generous = planFeasibility(steps, 20_000, 0.9, 'independent');
const tight = planFeasibility(steps, 3_000, 0.9, 'independent');
console.log(`  20s window: ${generous.status} (P=${generous.computed_probability.toFixed(3)})`);
console.log(`  3s window:  ${tight.status} (P=${tight.computed_probability.toFixed(3)})`);

assert(generous.status === 'feasible', 'the same plan is feasible in a 20s window');
assert(tight.status === 'infeasible', 'and infeasible in a 3s window — deadlines bind agents');

// No dependency model declared → the kernel does NOT assume independence;
// it bounds from the worst case. Honesty is the default.
const guarded = planFeasibility(steps, 20_000, 0.9, null);
assert(guarded.dependency_model === 'worst_case_bound', 'missing model fails closed to the conservative bound');
assert(
  guarded.computed_probability <= generous.computed_probability + 1e-9,
  'the conservative bound never claims more confidence than the independent model',
);

console.log('PASS');
