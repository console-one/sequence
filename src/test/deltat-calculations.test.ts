/**
 * deltat/calculations.md — the arrival-process function families (R2)
 * and CDF inversion (R4/R5: threshold → first-reach time, with the
 * `approximate` honesty flag).
 *
 * Also pins the nothing-silent contract: an unknown family THROWS.
 * (Before 2026-07-09 `cdf` returned a silent 0.5 for unknown families —
 * a coin flip dressed as a forecast.)
 */

import { cdf, survival, cdfInverse, posteriorPredictive } from '../compose';

describe('cdf — arrival-process families (deltat R2)', () => {
  test('poisson: P(X ≤ ⌊t⌋) at lambda = 0.5 (AC2 shape)', () => {
    // P(X≤3) = e^{-0.5}·(1 + 0.5 + 0.125 + 0.0208333…) ≈ 0.99825
    expect(cdf('poisson', 3, { lambda: 0.5 })).toBeCloseTo(0.99825, 4);
    // Count distribution: positive mass at t = 0 (P(X≤0) = e^{-0.5})
    expect(cdf('poisson', 0, { lambda: 0.5 })).toBeCloseTo(Math.exp(-0.5), 6);
    expect(cdf('poisson', -1, { lambda: 0.5 })).toBe(0);
    // Step function: constant between integers
    expect(cdf('poisson', 3.9, { lambda: 0.5 })).toBeCloseTo(cdf('poisson', 3, { lambda: 0.5 }), 12);
  });

  test('gamma/Erlang: time to k-th arrival; shape=1 degenerates to exponential', () => {
    const t = 1234;
    expect(cdf('gamma', t, { shape: 1, rate: 0.002 }))
      .toBeCloseTo(cdf('exponential', t, { rate: 0.002 }), 6);
    // Erlang(3, 1): needs 3 arrivals — strictly less mass early than 1 arrival
    expect(cdf('gamma', 1, { shape: 3, rate: 1 })).toBeLessThan(cdf('gamma', 1, { shape: 1, rate: 1 }));
    // P(3, 3): mean is at shape/rate = 3 → CDF near 0.5768
    expect(cdf('gamma', 3, { shape: 3, rate: 1 })).toBeCloseTo(0.5768, 3);
  });

  test('linear: P(t) = slope·t + intercept, clamped', () => {
    expect(cdf('linear', 5, { slope: 0.1, intercept: 0 })).toBeCloseTo(0.5, 10);
    expect(cdf('linear', 100, { slope: 0.1, intercept: 0 })).toBe(1); // clamp
  });

  test('loglinear: P(t) = a·ln(t) + b, clamped', () => {
    expect(cdf('loglinear', Math.E, { a: 0.2, b: 0 })).toBeCloseTo(0.2, 10);
    expect(cdf('loglinear', 0.5, { a: 0.2, b: 0 })).toBe(0); // ln < 0 clamps
  });

  test('piecewise: knot interpolation, same-t knots are a jump', () => {
    const params = { t0: 0, p0: 0, t1: 5, p1: 0.5, t2: 5, p2: 0.8, t3: 10, p3: 1 };
    expect(cdf('piecewise', 2.5, params)).toBeCloseTo(0.25, 10);
    expect(cdf('piecewise', 5, params)).toBeCloseTo(0.8, 10);   // after the jump
    expect(cdf('piecewise', 7.5, params)).toBeCloseTo(0.9, 10);
    expect(cdf('piecewise', 10, params)).toBe(1);
    expect(cdf('piecewise', 42, params)).toBe(1);
  });

  test('piecewise: non-monotone knots throw (a CDF never falls)', () => {
    expect(() => cdf('piecewise', 1, { t0: 0, p0: 0.5, t1: 5, p1: 0.2 }))
      .toThrow(/monotone/);
  });

  test('survival composes with the new families', () => {
    expect(survival('poisson', 3, { lambda: 0.5 })).toBeCloseTo(1 - 0.99825, 4);
  });
});

describe('cdf / posteriorPredictive — nothing silent', () => {
  test('unknown cdf family throws instead of returning 0.5', () => {
    expect(() => cdf('cauchy', 10, {})).toThrow(/unknown distribution family 'cauchy'/);
  });

  test('unsupported conjugate family throws instead of returning 0.5', () => {
    expect(() => posteriorPredictive('dirichlet', { a: 1 })).toThrow(/dirichlet/);
  });
});

describe('cdfInverse — threshold → first-reach time (deltat R4/R5)', () => {
  test('exponential closed form (AC3): rate 0.5, p 0.9 → -ln(0.1)/0.5 ≈ 4.605', () => {
    const r = cdfInverse('exponential', 0.9, { rate: 0.5 });
    expect(r.t).toBeCloseTo(4.60517, 4);
    expect(r.approximate).toBe(false);
  });

  test('weibull closed form round-trips', () => {
    const r = cdfInverse('weibull', 0.75, { shape: 2, scale: 100 });
    expect(r.approximate).toBe(false);
    expect(cdf('weibull', r.t, { shape: 2, scale: 100 })).toBeCloseTo(0.75, 10);
  });

  test('linear closed form (R4 verifiable-by): t = (P − b) / a', () => {
    const r = cdfInverse('linear', 0.5, { slope: 0.1, intercept: 0 });
    expect(r.t).toBeCloseTo(5, 10);
    expect(r.approximate).toBe(false);
  });

  test('loglinear closed form: t = e^{(p−b)/a}', () => {
    const r = cdfInverse('loglinear', 0.4, { a: 0.2, b: 0 });
    expect(r.t).toBeCloseTo(Math.exp(2), 8);
    expect(r.approximate).toBe(false);
  });

  test('fixed: all mass arrives at value', () => {
    const r = cdfInverse('fixed', 0.9, { value: 100 });
    expect(r.t).toBe(100);
    expect(r.approximate).toBe(false);
  });

  test('poisson: first integer k with P(X ≤ k) ≥ p', () => {
    // λ=2: P(X≤1) ≈ 0.406 < 0.5 ≤ P(X≤2) ≈ 0.677
    const r = cdfInverse('poisson', 0.5, { lambda: 2 });
    expect(r.t).toBe(2);
    expect(r.approximate).toBe(false);
  });

  test('lognormal: numerical, flagged approximate (R5), round-trips', () => {
    const r = cdfInverse('lognormal', 0.5, { mu: 0, sigma: 1 });
    expect(r.approximate).toBe(true);
    expect(r.t).toBeCloseTo(1, 6); // median of lognormal(0,1) = e^0
  });

  test('gamma: numerical, flagged approximate, round-trips', () => {
    const r = cdfInverse('gamma', 0.8, { shape: 3, rate: 0.01 });
    expect(r.approximate).toBe(true);
    expect(cdf('gamma', r.t, { shape: 3, rate: 0.01 })).toBeCloseTo(0.8, 6);
  });

  test('piecewise: exact within a rising segment, approximate inside a jump (AC4)', () => {
    const params = { t0: 0, p0: 0, t1: 5, p1: 0.5, t2: 5, p2: 0.8, t3: 10, p3: 1 };
    const rising = cdfInverse('piecewise', 0.25, params);
    expect(rising.t).toBeCloseTo(2.5, 10);
    expect(rising.approximate).toBe(false);
    // 0.6 falls strictly inside the 0.5 → 0.8 jump at t = 5: F skips it
    const jump = cdfInverse('piecewise', 0.6, params);
    expect(jump.t).toBe(5);
    expect(jump.approximate).toBe(true);
  });

  test('unreachable thresholds throw — never a guessed time', () => {
    expect(() => cdfInverse('exponential', 1, { rate: 0.5 })).toThrow(/asymptotically/);
    expect(() => cdfInverse('piecewise', 0.9, { t0: 0, p0: 0, t1: 5, p1: 0.5 }))
      .toThrow(/tops out/);
    expect(() => cdfInverse('linear', 0.5, { slope: 0, intercept: 0.1 })).toThrow(/never reaches/);
    expect(() => cdfInverse('exponential', 0, { rate: 0.5 })).toThrow(/threshold/);
    expect(() => cdfInverse('cauchy', 0.5, {})).toThrow(/unknown distribution family/);
  });
});
