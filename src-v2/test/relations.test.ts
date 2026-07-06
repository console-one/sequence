// relations.test.ts — the one budget/threshold relation pair. Spec of
// "done": inclusive boundaries (check's min/max semantics), fail-CLOSED
// on every non-finite input (the policy the desktop gate and the server
// admission gate both depend on), and duality.

import { withinMax, reachedMin } from '../relations';

describe('withinMax — `number ∧ max(limit)` conformance, fail-closed', () => {
  test('under, at, over the limit (max is inclusive)', () => {
    expect(withinMax(4, 5)).toBe(true);
    expect(withinMax(5, 5)).toBe(true);
    expect(withinMax(6, 5)).toBe(false);
  });
  test('non-finite value or limit DENIES (never fail-open on NaN)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(withinMax(bad, 5)).toBe(false);
      expect(withinMax(4, bad)).toBe(false);
    }
  });
  test('zero and negative domains behave as plain ≤', () => {
    expect(withinMax(0, 0)).toBe(true);
    expect(withinMax(-2, -1)).toBe(true);
    expect(withinMax(-1, -2)).toBe(false);
  });
});

describe('reachedMin — the dual, `number ∧ min(threshold)`', () => {
  test('below, at, above the threshold (min is inclusive)', () => {
    expect(reachedMin(4, 5)).toBe(false);
    expect(reachedMin(5, 5)).toBe(true);
    expect(reachedMin(6, 5)).toBe(true);
  });
  test('non-finite value or threshold DENIES', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(reachedMin(bad, 5)).toBe(false);
      expect(reachedMin(6, bad)).toBe(false);
    }
  });
  test('duality on finite inputs: reachedMin(v,t) === !withinMax(v, t-1) for integers', () => {
    for (let v = 0; v <= 10; v++) {
      expect(reachedMin(v, 5)).toBe(!withinMax(v, 4));
    }
  });
});
