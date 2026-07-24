// 02 — Runtime cost is a curve, learned from observation.
//
// A tool's latency can't be computed at compile time — so it is carried
// as a distribution and refined by conjugate update as real calls land.
// The gamma family is conjugate for exponential inter-completion times:
// `shape` accumulates observations, `rate` accumulates observed seconds.
// The posterior answers scheduling questions directly, e.g. "by when is
// this call 95% likely to be done?" via the inverse CDF.
import {
  conjugateUpdate, posteriorPredictive, cdf, cdfInverse,
} from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('02-distributions — a tool call priced as a learned curve');

// Weak prior: one pseudo-observation of 1s.
let belief = { shape: 1, rate: 1 };

// Five observed call runtimes, seconds. True mean ≈ 2s.
const observed = [1.8, 2.3, 1.9, 2.2, 1.7];
for (const seconds of observed) {
  belief = conjugateUpdate('gamma', belief, seconds);
}

// Posterior mean of the completion RATE (calls per second).
const ratePerSec = posteriorPredictive('gamma', belief);
const expectedRuntime = 1 / ratePerSec;
console.log(`  posterior after ${observed.length} calls: expected runtime ${expectedRuntime.toFixed(2)}s`);

assert(belief.shape === 1 + observed.length, 'every observation is accounted for in the posterior');
assert(
  expectedRuntime > 1.5 && expectedRuntime < 2.5,
  `learned expectation ${expectedRuntime.toFixed(2)}s tracks the true ~2s mean`,
);

// "When is the next call 95% likely to be done?" — the deadline question,
// answered from the same belief, no separate estimator.
const { t: t95 } = cdfInverse('exponential', 0.95, { rate: ratePerSec });
console.log(`  95% completion horizon: ${t95.toFixed(2)}s`);
assert(t95 > expectedRuntime, 'the 95% horizon is beyond the mean (tail risk is priced in)');
assert(
  Math.abs(cdf('exponential', t95, { rate: ratePerSec }) - 0.95) < 0.01,
  'the inverse CDF round-trips: P(done ≤ t95) ≈ 0.95',
);

// An aged observation counts for less: conjugate update takes validity(t)
// as its weight, so stale evidence moves the belief less than fresh.
const freshMove = conjugateUpdate('gamma', belief, 10, 1).rate - belief.rate;
const staleMove = conjugateUpdate('gamma', belief, 10, 0.25).rate - belief.rate;
assert(staleMove < freshMove, 'a decayed observation shifts the posterior less than a fresh one');

console.log('PASS');
