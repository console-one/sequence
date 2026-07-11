// select.test.ts — selection under prices (R8/R5; the attention market's
// evaluator, recovered from the archived compile selector).
// Spec of "done": duals are first-class output and RISE under competition
// (saturation is the budget binding harder, not a tuned penalty); the
// block-flip failure mode the original's repair comment records is
// regression-pinned; degenerate cases are exact (one candidate ≡ a
// threshold check; Infinity ≡ unconstrained); malformed markets are loud.

import { selectUnderPrices } from '../select';
import type { SelectCandidate, SelectCapacities } from '../select';

function c(id: string, value: number, costs: Record<string, number>): SelectCandidate {
  return { id, value, costs };
}

/** Exhaustive optimum for small instances (≤ ~15 candidates). */
function bruteForceBest(
  candidates: SelectCandidate[],
  capacities: SelectCapacities,
): { value: number; ids: Set<string> } {
  const dims = Object.keys(capacities).filter((d) => Number.isFinite(capacities[d]));
  let best = { value: 0, ids: new Set<string>() };
  const n = candidates.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let value = 0;
    const used: Record<string, number> = {};
    for (const d of dims) used[d] = 0;
    const ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const cand = candidates[i];
      if (cand.value <= 0) {
        value = -Infinity; // never admit non-positive bids (module contract)
        break;
      }
      value += cand.value;
      ids.add(cand.id);
      for (const d of dims) used[d] += cand.costs[d] ?? 0;
    }
    if (value === -Infinity) continue;
    if (dims.some((d) => used[d] > capacities[d])) continue;
    if (value > best.value) best = { value, ids };
  }
  return best;
}

function selectedValue(candidates: SelectCandidate[], selected: string[]): number {
  const set = new Set(selected);
  return candidates.filter((x) => set.has(x.id)).reduce((s, x) => s + x.value, 0);
}

describe('selectUnderPrices: degenerate cases are exact', () => {
  test('zero candidates → empty, duals 0, feasible', () => {
    const r = selectUnderPrices([], { interrupts: 3 });
    expect(r).toEqual({ selected: [], duals: { interrupts: 0 }, feasible: true, iterations: 1 });
  });

  test('one candidate + one capacity ≡ a threshold check: fits → admitted at price 0', () => {
    const r = selectUnderPrices([c('a', 5, { interrupts: 1 })], { interrupts: 3 });
    expect(r.selected).toEqual(['a']);
    expect(r.duals.interrupts).toBe(0);
    expect(r.feasible).toBe(true);
  });

  test('one candidate + one capacity ≡ a threshold check: does not fit → priced out, dual > 0', () => {
    const r = selectUnderPrices([c('a', 5, { interrupts: 4 })], { interrupts: 3 });
    expect(r.selected).toEqual([]);
    expect(r.duals.interrupts).toBeGreaterThan(0); // the price that excluded it
    expect(r.feasible).toBe(true); // ∅ is feasible
  });

  test('capacity = Infinity → everything positive admitted, duals 0 (the NaN correction)', () => {
    const r = selectUnderPrices(
      [c('a', 1, { tokens: 1e9 }), c('b', 2, { tokens: 5 })],
      { tokens: Infinity },
    );
    expect(r.selected).toEqual(['a', 'b']);
    expect(r.duals).toEqual({ tokens: 0 });
    expect(r.feasible).toBe(true);
  });

  test('value ≤ 0 is never admitted, even with slack capacity', () => {
    const r = selectUnderPrices(
      [c('zero', 0, { tokens: 1 }), c('neg', -3, {}), c('pos', 1, { tokens: 1 })],
      { tokens: 100 },
    );
    expect(r.selected).toEqual(['pos']);
  });

  test('undeclared cost dimensions are unconstrained', () => {
    const r = selectUnderPrices([c('a', 1, { exotic: 1e12 })], { tokens: 10 });
    expect(r.selected).toEqual(['a']);
  });
});

describe('selectUnderPrices: knapsack correctness vs brute force', () => {
  const INSTANCES: Array<{ name: string; cands: SelectCandidate[]; caps: SelectCapacities }> = [
    {
      name: 'classic single-dimension knapsack',
      cands: [
        c('a', 60, { w: 10 }),
        c('b', 100, { w: 20 }),
        c('c', 120, { w: 30 }),
      ],
      caps: { w: 50 },
    },
    {
      name: 'greedy-by-value trap: one big crowds out two better-together',
      cands: [c('big', 10, { w: 10 }), c('s1', 6, { w: 5 }), c('s2', 6, { w: 5 })],
      caps: { w: 10 },
    },
    {
      name: 'two dimensions bind differently',
      cands: [
        c('a', 8, { cpu: 4, mem: 1 }),
        c('b', 7, { cpu: 1, mem: 4 }),
        c('c', 6, { cpu: 2, mem: 2 }),
        c('d', 3, { cpu: 3, mem: 3 }),
      ],
      caps: { cpu: 5, mem: 5 },
    },
    {
      name: 'zero-cost bids ride free',
      cands: [c('free', 1, {}), c('a', 5, { w: 3 }), c('b', 4, { w: 3 })],
      caps: { w: 4 },
    },
  ];

  for (const { name, cands, caps } of INSTANCES) {
    test(name, () => {
      const opt = bruteForceBest(cands, caps);
      const r = selectUnderPrices(cands, caps);
      expect(r.feasible).toBe(true);
      expect(selectedValue(cands, r.selected)).toBe(opt.value);
    });
  }

  test('lagrangian ≥ greedy on the greedy trap', () => {
    const cands = [c('big', 10, { w: 10 }), c('s1', 6, { w: 5 }), c('s2', 6, { w: 5 })];
    const caps = { w: 10 };
    const lag = selectUnderPrices(cands, caps);
    const greedy = selectUnderPrices(cands, caps, { strategy: 'greedy' });
    expect(selectedValue(cands, lag.selected)).toBeGreaterThanOrEqual(
      selectedValue(cands, greedy.selected),
    );
    expect(selectedValue(cands, lag.selected)).toBe(12);
  });
});

describe('selectUnderPrices: saturation — duals rise under competition (the product behavior)', () => {
  test('adding competitors raises the dual and prices out the marginal bid', () => {
    const caps = { interrupts: 2 };
    const quiet = selectUnderPrices(
      [c('a', 9, { interrupts: 1 }), c('b', 8, { interrupts: 1 })],
      caps,
    );
    // Slack-free but exactly-fitting market: both admitted.
    expect(quiet.selected).toEqual(['a', 'b']);

    const crowded = selectUnderPrices(
      [
        c('a', 9, { interrupts: 1 }),
        c('b', 8, { interrupts: 1 }),
        c('marginal', 2, { interrupts: 1 }),
        c('d', 7, { interrupts: 1 }),
      ],
      caps,
    );
    // The budget binds harder: the dual is now strictly positive…
    expect(crowded.duals.interrupts).toBeGreaterThan(quiet.duals.interrupts);
    expect(crowded.duals.interrupts).toBeGreaterThan(0);
    // …and the marginal bid is selected out; the strongest two stay.
    expect(crowded.selected).toEqual(['a', 'b']);
    expect(crowded.selected).not.toContain('marginal');
    expect(crowded.feasible).toBe(true);
  });

  test('silence is nothing clearing the price: all bids below the crowd-set price', () => {
    // Ten strong bids saturate; a weak one arrives — it never clears.
    const strong = Array.from({ length: 10 }, (_, i) => c(`s${i}`, 100, { interrupts: 1 }));
    const weak = c('weak', 1, { interrupts: 1 });
    const r = selectUnderPrices([...strong, weak], { interrupts: 10 });
    expect(r.selected).toHaveLength(10);
    expect(r.selected).not.toContain('weak');
  });
});

describe('selectUnderPrices: the block-flip regression (primal repair)', () => {
  test('n identical candidates, capacity fits exactly k → exactly k admitted, not 0, not n', () => {
    // Every candidate sees the same dual price and flips together: the
    // relaxed solve is all-in (λ low) or all-out (λ high), never exactly
    // k. Repair must land the feasible non-degenerate selection.
    const n = 8;
    const k = 3;
    const cands = Array.from({ length: n }, (_, i) => c(`t${i}`, 5, { slots: 1 }));
    const r = selectUnderPrices(cands, { slots: k });
    expect(r.selected).toHaveLength(k);
    expect(r.feasible).toBe(true);
    expect(r.duals.slots).toBeGreaterThan(0); // contested capacity is priced
  });

  test('repair also sheds when no feasible iterate was found (the DROP correction)', () => {
    // One iteration starves the tracker: the first relaxed solve (λ=0)
    // admits everything (infeasible) and there is no second chance.
    const cands = [c('a', 5, { w: 2 }), c('b', 4, { w: 2 }), c('c', 3, { w: 2 })];
    const r = selectUnderPrices(cands, { w: 3 }, { iterations: 1 });
    expect(r.feasible).toBe(true); // repair shed to feasibility
    expect(selectedValue(cands, r.selected)).toBe(5); // best single fit
  });
});

describe('selectUnderPrices: strategies', () => {
  test('beam (width 1) degrades to in-order value-keeping; lagrangian escapes the trap', () => {
    // Candidate order leads with the big bid: a width-1 beam keeps the
    // include branch (value 10 beats 0) and the two better-together bids
    // no longer fit. Pricing finds them.
    const cands = [c('big', 10, { w: 10 }), c('s1', 6, { w: 5 }), c('s2', 6, { w: 5 })];
    const caps = { w: 10 };
    const beam = selectUnderPrices(cands, caps, { strategy: 'beam', beamWidth: 1 });
    const lag = selectUnderPrices(cands, caps);
    expect(selectedValue(cands, beam.selected)).toBe(10);
    expect(selectedValue(cands, lag.selected)).toBe(12);
    expect(beam.duals).toEqual({ w: 0 }); // baselines never price
  });

  test('beam with default width solves small instances exactly', () => {
    const cands = [c('big', 10, { w: 10 }), c('s1', 6, { w: 5 }), c('s2', 6, { w: 5 })];
    const r = selectUnderPrices(cands, { w: 10 }, { strategy: 'beam' });
    expect(selectedValue(cands, r.selected)).toBe(12);
  });

  test('greedy is deterministic and feasible', () => {
    const cands = [c('a', 5, { w: 3 }), c('b', 5, { w: 3 }), c('x', 9, { w: 4 })];
    const r = selectUnderPrices(cands, { w: 7 }, { strategy: 'greedy' });
    expect(r.selected).toEqual(['a', 'x']); // value desc, id tiebreak, fits
    expect(r.feasible).toBe(true);
  });
});

describe('selectUnderPrices: fail-loud validation', () => {
  test('duplicate ids throw', () => {
    expect(() =>
      selectUnderPrices([c('a', 1, {}), c('a', 2, {})], {}),
    ).toThrow(/duplicate candidate id 'a'/);
  });
  test('non-finite value throws', () => {
    expect(() => selectUnderPrices([c('a', NaN, {})], {})).toThrow(/non-finite value/);
  });
  test('negative cost throws', () => {
    expect(() => selectUnderPrices([c('a', 1, { w: -1 })], { w: 5 })).toThrow(/finite number ≥ 0/);
  });
  test('negative capacity throws', () => {
    expect(() => selectUnderPrices([], { w: -1 })).toThrow(/must be a number ≥ 0/);
  });
});

describe('selectUnderPrices: convergence sanity (the subgradient check the directive ordered)', () => {
  test('a contested market reaches a stable answer well inside the default budget', () => {
    const cands = [
      c('a', 9, { interrupts: 1, tokens: 300 }),
      c('b', 8, { interrupts: 1, tokens: 200 }),
      c('d', 7, { interrupts: 1, tokens: 250 }),
      c('e', 2, { interrupts: 1, tokens: 50 }),
    ];
    const caps = { interrupts: 2, tokens: 500 };
    const r = selectUnderPrices(cands, caps);
    expect(r.feasible).toBe(true);
    expect(r.iterations).toBeLessThanOrEqual(30);
    // Optimal by brute force:
    const opt = bruteForceBest(cands, caps);
    expect(selectedValue(cands, r.selected)).toBe(opt.value);
  });

  test('result is invariant to harmless iteration-budget increases', () => {
    const cands = [
      c('a', 9, { interrupts: 1 }),
      c('b', 8, { interrupts: 1 }),
      c('m', 2, { interrupts: 1 }),
    ];
    const caps = { interrupts: 2 };
    const r30 = selectUnderPrices(cands, caps, { iterations: 30 });
    const r300 = selectUnderPrices(cands, caps, { iterations: 300 });
    expect(r300.selected).toEqual(r30.selected);
  });
});
