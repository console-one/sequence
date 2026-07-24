// Reproducible micro-benchmark: mount scaling, budgeted render latency,
// and plan-feasibility throughput, printed with the machine it ran on.
// `node examples/bench.mjs` — numbers are meant to be re-run, not quoted.
//
// Honesty note: the mount series prints a SCALING CURVE, not one number —
// per-mount cost currently grows with log length (the projection walks
// the log), so throughput depends on store size. Watch the curve, and if
// a future version flattens it, this bench is how you check.
import { Sequence, FT, renderForReader, planFeasibility } from '@console-one/sequence';
import os from 'node:os';

const cpu = os.cpus()[0]?.model ?? 'unknown cpu';
console.log(`bench — node ${process.version} on ${cpu}`);

// 1. Mount scaling: fresh store per row, 20 subsystems, N binds.
console.log('  mount scaling (fresh store per row):');
for (const n of [250, 500, 1000, 2000]) {
  const seq = new Sequence();
  for (let i = 0; i < 20; i++) {
    seq.mount('schema', `sys${i}`, FT.object({ status: FT.string().toType(), retries: FT.number().toType() }));
  }
  const t0 = performance.now();
  for (let i = 0; i < n; i++) seq.mount('bind', `sys${i % 20}.retries`, i);
  const dt = performance.now() - t0;
  console.log(`    ${String(n).padStart(4)} binds: ${dt.toFixed(0).padStart(5)}ms — ${Math.round(n / (dt / 1000))} mounts/sec`);
}

// 2. Budgeted render over a 1,000-mount store, narrow and wide.
const seq = new Sequence();
for (let i = 0; i < 50; i++) {
  seq.mount('schema', `sys${i}`, FT.object({ status: FT.string().toType(), retries: FT.number().toType() }));
}
for (let i = 0; i < 1000; i++) seq.mount('bind', `sys${i % 50}.retries`, i);
const reader = (maxItems) => ({
  maxItems, maxDepth: 3,
  weights: { actionability: 1, coherence: 0.5, cascadeImpact: 0.5, urgency: 1, learnedBoost: 0.2 },
  priors: new Map(),
});
for (const budget of [5, 50]) {
  const t0 = performance.now();
  const r = renderForReader(seq, reader(budget));
  const dt = performance.now() - t0;
  console.log(`  render(budget=${String(budget).padEnd(2)}): ${dt.toFixed(1)}ms — ${r.clusters.length} clusters scored, ${r.evicted.length} paths evicted, ${r.text.length} chars emitted`);
}

// 3. Plan feasibility: the scheduling primitive, called per candidate plan.
const steps = [
  { family: 'lognormal', params: { mu: 7, sigma: 0.5 } },
  { family: 'lognormal', params: { mu: 8, sigma: 0.5 } },
  { family: 'exponential', params: { rate: 0.001 } },
];
const M = 10_000;
const t0 = performance.now();
for (let i = 0; i < M; i++) planFeasibility(steps, 20_000, 0.9, 'independent');
const dt = performance.now() - t0;
console.log(`  planFeasibility:  ${M} evaluations in ${dt.toFixed(0)}ms — ${Math.round(M / (dt / 1000))} plans/sec`);
