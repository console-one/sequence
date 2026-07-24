// 06 — Attention, priced: one store, one render pipeline, per-reader budgets.
//
// renderForReader runs cluster → score → rank → budget → hoist. The same
// state produces different honest renderings under different budgets, and
// the pipeline REPORTS what it evicted — compression never silently drops.
import { Sequence, FT, renderForReader } from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('06-attention — the same store rendered under two budgets');

const seq = new Sequence();

// Four independent subsystems, each with declared shape and partial state
// (unfilled properties are gaps — the raw material of actionability).
for (const [name, bound] of [['billing', 2], ['ingest', 1], ['deploy', 0], ['alerts', 3]]) {
  seq.mount('schema', name, FT.object({
    status: FT.string().toType(),
    owner: FT.string().toType(),
    retries: FT.number().toType(),
  }));
  const values = { status: 'ok', owner: 'ops', retries: 0 };
  Object.entries(values).slice(0, bound).forEach(([k, v]) => seq.mount('bind', `${name}.${k}`, v));
}

const reader = (maxItems) => ({
  maxItems,
  maxDepth: 3,
  weights: { actionability: 1, coherence: 0.5, cascadeImpact: 0.5, urgency: 1, learnedBoost: 0.2 },
  priors: new Map(),
});

const narrow = renderForReader(seq, reader(2));
const wide = renderForReader(seq, reader(10));

console.log(`  narrow budget: ${narrow.clusters.length} clusters shown, ${narrow.evicted.length} paths evicted`);
console.log(`  wide budget:   ${wide.clusters.length} clusters shown, ${wide.evicted.length} paths evicted`);

assert(narrow.text.length > 0 && wide.text.length > 0, 'both budgets produce a rendering');
assert(narrow.evicted.length > 0, 'the narrow budget evicts — scarcity is real');
assert(wide.evicted.length < narrow.evicted.length, 'a wider budget evicts less of the same store');
assert(narrow.text.length < wide.text.length, 'the narrow rendering is genuinely smaller');

// Nothing evicted is lost — eviction is a rendering decision, not a data
// decision. Every evicted path still resolves in the store.
const missing = narrow.evicted.filter(p => {
  const root = p.split('.')[0];
  return seq.concreteness(root) === undefined;
});
assert(missing.length === 0, 'every evicted path still lives in the store, expandable on demand');

console.log('PASS');
