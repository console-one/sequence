/**
 * concreteness.test.ts — Time-conditioned concreteness distribution.
 *
 * Three factors: completion (CDF on time-distribution) × typeSurvival
 * (decay constraint walked up ancestor chain) × provenance (stub).
 */

import { Sequence } from '../sequence';
import { concretenessDistribution, cdf, survival } from '../stdlib';
import { createType, decay, distribution } from '../../src/type';

const FIXED_T0 = 1_000_000;
const T_LATER = 1_000 * 60 * 5; // 5 minutes after fixed T0

function fixedClock(t: number): () => number {
  return () => t;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Completion factor — distribution('time', family, params)
// ═══════════════════════════════════════════════════════════════════════

describe('completion factor', () => {
  test('alreadyRealized cell returns 1 at any time', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({ path: 'state.x', value: 42 });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.completion(FIXED_T0)).toBe(1);
    expect(d.factors.completion(FIXED_T0 + T_LATER)).toBe(1);
  });

  test('schema-only cell with no time distribution returns 0 for completion', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({ path: 'state.x', type: createType('number') });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.completion(FIXED_T0 + T_LATER)).toBe(0);
  });

  test('exponential time distribution drives completion via cdf', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.x',
      type: createType('number', [
        distribution('time', 'exponential', { rate: 0.001 }),
      ]),
    });
    const d = concretenessDistribution(seq, 'state.x');
    // dt = T_LATER (300_000), rate 0.001 → 1 - exp(-300) ≈ 1
    expect(d.factors.completion(FIXED_T0 + T_LATER)).toBeCloseTo(
      cdf('exponential', T_LATER, { rate: 0.001 }),
      6,
    );
  });

  test('completion at t < now is 0', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.x',
      type: createType('number', [
        distribution('time', 'exponential', { rate: 0.001 }),
      ]),
    });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.completion(FIXED_T0 - 100)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Type-survival factor — decay constraint
// ═══════════════════════════════════════════════════════════════════════

describe('typeSurvival factor', () => {
  test('no decay constraint anywhere → survival is 1', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({ path: 'state.x', value: 42 });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.typeSurvival(FIXED_T0 + T_LATER)).toBe(1);
  });

  test('exponential decay applies named-family survival', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.x',
      type: createType('number', [decay('exponential', { rate: 0.001 })]),
      value: 42,
    });
    const d = concretenessDistribution(seq, 'state.x');
    // dt = T_LATER from rootTime; survival = exp(-0.001 * 300_000)
    expect(d.factors.typeSurvival(FIXED_T0 + T_LATER)).toBeCloseTo(
      survival('exponential', T_LATER, { rate: 0.001 }),
      6,
    );
  });

  test("'fn' decay calls the supplied function", () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    const f = (dt: number) => Math.exp(-0.0001 * dt);
    seq.insert({
      path: 'state.x',
      type: createType('number', [decay('fn', f)]),
      value: 42,
    });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.typeSurvival(FIXED_T0 + T_LATER)).toBeCloseTo(
      f(T_LATER),
      6,
    );
  });

  test('decay walked up ancestor chain — parent carries the constraint', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.parent',
      type: createType('object', [decay('exponential', { rate: 0.002 })]),
    });
    seq.insert({ path: 'state.parent.child', value: 'inner' });
    const d = concretenessDistribution(seq, 'state.parent.child');
    expect(d.factors.typeSurvival(FIXED_T0 + T_LATER)).toBeCloseTo(
      survival('exponential', T_LATER, { rate: 0.002 }),
      6,
    );
  });

  test('nearest decay wins — child overrides ancestor', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.parent',
      type: createType('object', [decay('exponential', { rate: 0.001 })]),
    });
    seq.insert({
      path: 'state.parent.child',
      type: createType('any', [decay('exponential', { rate: 0.005 })]),
      value: 'x',
    });
    const d = concretenessDistribution(seq, 'state.parent.child');
    // Child's 0.005 wins over parent's 0.001.
    expect(d.factors.typeSurvival(FIXED_T0 + T_LATER)).toBeCloseTo(
      survival('exponential', T_LATER, { rate: 0.005 }),
      6,
    );
  });

  test('survival at rootTime = 1', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.x',
      type: createType('number', [decay('exponential', { rate: 0.001 })]),
      value: 42,
    });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.typeSurvival(FIXED_T0)).toBeCloseTo(1, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Joint cdf = completion * typeSurvival * provenance
// ═══════════════════════════════════════════════════════════════════════

describe('joint cdf — three factors compose multiplicatively', () => {
  test('alreadyRealized + decay → joint = decay survival at t', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.x',
      type: createType('number', [decay('exponential', { rate: 0.001 })]),
      value: 42,
    });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.cdf(FIXED_T0 + T_LATER)).toBeCloseTo(
      survival('exponential', T_LATER, { rate: 0.001 }),
      6,
    );
  });

  test('time distribution + decay → product of CDF and survival', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({
      path: 'state.x',
      type: createType('number', [
        distribution('time', 'exponential', { rate: 0.0005 }),
        decay('exponential', { rate: 0.0001 }),
      ]),
    });
    const d = concretenessDistribution(seq, 'state.x');
    const expected =
      cdf('exponential', T_LATER, { rate: 0.0005 }) *
      survival('exponential', T_LATER, { rate: 0.0001 });
    expect(d.cdf(FIXED_T0 + T_LATER)).toBeCloseTo(expected, 6);
  });

  test('no schema, no value, no decay → joint = 0', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.cdf(FIXED_T0 + T_LATER)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Provenance factor (currently stub = 1; documents intended shape)
// ═══════════════════════════════════════════════════════════════════════

describe('provenance factor — stub', () => {
  test('always returns 1 (placeholder until producer-chain walking)', () => {
    const seq = new Sequence(fixedClock(FIXED_T0));
    seq.insert({ path: 'state.x', value: 42 });
    const d = concretenessDistribution(seq, 'state.x');
    expect(d.factors.provenance(FIXED_T0)).toBe(1);
    expect(d.factors.provenance(FIXED_T0 + T_LATER)).toBe(1);
  });
});
