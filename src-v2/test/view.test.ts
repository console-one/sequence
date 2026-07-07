// view.test.ts — planView, the consumer-indexed budgeted view (seam 5, R5).
// Spec of "done": priority is section order; election is first-fitting
// rung; the over-budget floor election is deliberate (a section always
// renders its cheapest when nothing fits, and once the spend exceeds the
// cap every later section falls to its floor); evictions name what the
// reader is not seeing; malformed specs are loud, never silent. Fixture
// shapes mirror the first real consumer — observatory's office brief
// (ladders full → truncated → count-line → empty).

import { planView } from '../view';
import type { ViewSpec } from '../view';

/** A brief-shaped spec: costs mirror real chars/4 magnitudes. */
function briefish(): ViewSpec {
  return {
    sections: [
      {
        id: 'orientation',
        rungs: [
          { cost: { tokens: 60 }, detail: 4 }, // identity+charter+4 goals
          { cost: { tokens: 50 }, detail: 3 },
          { cost: { tokens: 30 }, detail: 1 },
          { cost: { tokens: 26 }, detail: 'floor' }, // identity line alone
        ],
      },
      { id: 'state', rungs: [{ cost: { tokens: 18 } }] }, // single candidate
      {
        id: 'overdue',
        rungs: [
          { cost: { tokens: 90 }, detail: 5 },
          { cost: { tokens: 60 }, detail: 3 },
          { cost: { tokens: 30 }, detail: 1 },
          { cost: { tokens: 20 }, detail: 'count' }, // no empty rung — mirrors brief
        ],
      },
      {
        id: 'narratives',
        rungs: [
          { cost: { tokens: 120 }, detail: 6 },
          { cost: { tokens: 70 }, detail: 3 },
          { cost: { tokens: 30 }, detail: 1 },
          { cost: { tokens: 0 }, detail: 'dropped' }, // droppable
        ],
      },
    ],
  };
}

describe('planView: election under budget', () => {
  test('everything fits: rung 0 everywhere, spend is the sum, no evictions', () => {
    const plan = planView(briefish(), { tokens: 1000 });
    expect(plan.picks.map((p) => p.rung)).toEqual([0, 0, 0, 0]);
    expect(plan.spent).toEqual({ tokens: 60 + 18 + 90 + 120 });
    expect(plan.evictions).toEqual([]);
    expect(plan.picks.every((p) => !p.overBudget)).toBe(true);
  });

  test('mid budget: earlier sections keep richness, later ones degrade (priority = order)', () => {
    // 60 + 18 + 90 = 168; narratives full (120) would need 288.
    const plan = planView(briefish(), { tokens: 200 });
    expect(plan.picks.map((p) => p.rung)).toEqual([0, 0, 0, 2]); // narratives → 1 item
    expect(plan.spent.tokens).toBe(60 + 18 + 90 + 30);
    expect(plan.evictions).toEqual([
      { sectionId: 'narratives', richerRungs: [0, 1], electedDetail: 1 },
    ]);
  });

  test('floor: nothing fits — every section elects its cheapest, flagged overBudget', () => {
    const plan = planView(briefish(), { tokens: 10 });
    expect(plan.picks.map((p) => p.rung)).toEqual([3, 0, 3, 3]);
    expect(plan.picks.map((p) => p.overBudget)).toEqual([true, true, true, true]);
    // The floor still charges: 26 + 18 + 20 + 0.
    expect(plan.spent.tokens).toBe(64);
  });

  test('over-budget cascade: once spent exceeds the cap, later sections fall to their floor (compile-parity semantics)', () => {
    // Budget 70: orientation full (60) fits; state (18) would exceed → floor
    // election charges anyway (spent 78 > 70); everything after falls to
    // its cheapest even where a mid rung would have fit a fresh budget.
    const plan = planView(briefish(), { tokens: 70 });
    expect(plan.picks.map((p) => p.rung)).toEqual([0, 0, 3, 3]);
    expect(plan.picks.map((p) => p.overBudget)).toEqual([false, true, true, true]);
    expect(plan.spent.tokens).toBe(60 + 18 + 20 + 0);
  });

  test('zero-cost rung is how a section opts into dropping — elected at the floor', () => {
    const plan = planView(briefish(), { tokens: 10 });
    const narr = plan.picks.find((p) => p.sectionId === 'narratives')!;
    expect(narr.rung).toBe(3);
    expect(narr.cost).toEqual({ tokens: 0 });
  });

  test('multi-dimensional budget: every budgeted dimension binds; unbudgeted dimensions are unconstrained', () => {
    const spec: ViewSpec = {
      sections: [
        {
          id: 'a',
          rungs: [
            { cost: { tokens: 10, lines: 50, ink: 999 } },
            { cost: { tokens: 10, lines: 2 } },
          ],
        },
      ],
    };
    // tokens fits at rung 0, but lines (50 > 5) does not → rung 1. ink is
    // not budgeted → ignored.
    const plan = planView(spec, { tokens: 100, lines: 5 });
    expect(plan.picks[0].rung).toBe(1);
    expect(plan.spent).toEqual({ tokens: 10, lines: 2 });
  });

  test('determinism: same spec + budget → deep-equal plan (R9, byte-identical re-derivation)', () => {
    expect(planView(briefish(), { tokens: 200 })).toEqual(
      planView(briefish(), { tokens: 200 }),
    );
  });

  test('empty budget object means unconstrained: rung 0 everywhere', () => {
    const plan = planView(briefish(), {});
    expect(plan.picks.map((p) => p.rung)).toEqual([0, 0, 0, 0]);
  });
});

describe('planView: loud failures', () => {
  test('a section with no rungs throws named', () => {
    expect(() =>
      planView({ sections: [{ id: 'x', rungs: [] }] }, { tokens: 10 }),
    ).toThrow(/section 'x' offers no rungs/);
  });

  test('duplicate section ids throw named', () => {
    const s = { id: 'dup', rungs: [{ cost: { tokens: 1 } }] };
    expect(() => planView({ sections: [s, { ...s }] }, {})).toThrow(
      /duplicate section id 'dup'/,
    );
  });

  test('non-finite and negative costs throw named', () => {
    expect(() =>
      planView(
        { sections: [{ id: 'x', rungs: [{ cost: { tokens: NaN } }] }] },
        {},
      ),
    ).toThrow(/non-finite or negative cost for 'tokens'/);
    expect(() =>
      planView({ sections: [{ id: 'x', rungs: [{ cost: { tokens: -1 } }] }] }, {}),
    ).toThrow(/non-finite or negative/);
    expect(() =>
      planView({ sections: [{ id: 'x', rungs: [{ cost: { tokens: 1 } }] }] }, { tokens: Infinity }),
    ).toThrow(/budget has a non-finite/);
  });

  test('missing/blank section id throws named', () => {
    expect(() =>
      planView({ sections: [{ id: '', rungs: [{ cost: {} }] }] }, {}),
    ).toThrow(/non-empty string id/);
  });
});
