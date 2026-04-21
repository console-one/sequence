/**
 * concreteness-distribution.test.ts — Commit 2 of the concreteness-as-
 * distribution pass.
 *
 * Asserts that Sequence.concretenessDistribution(path) returns a computed
 * distribution object with three structurally-present factors:
 *   1. completion  — time-indexed from distribution('time', ...) constraints
 *   2. typeSurvival — time-indexed from decay constraints in ancestor types
 *   3. provenance   — currently stubbed to 1 (dimensionality without accuracy)
 *
 * The composed cdf is the product of the three factors.
 */

import { Sequence } from '../sequence';
import { createType, property, distribution, decay } from '../type';
import { FT } from '../builder';

describe('concretenessDistribution — three-factor time-indexed belief (Commit 2)', () => {
  let clock: number;
  let seq: Sequence;

  beforeEach(() => {
    clock = 1_000_000;
    seq = new Sequence(() => clock);
  });

  // ─── Already-realized paths ────────────────────────────────────
  test('realized path — cdf is 1 at any t', () => {
    seq.mount('bind', 'greeting', 'hello');
    const d = seq.concretenessDistribution('greeting');
    expect(d.cdf(clock)).toBe(1);
    expect(d.cdf(clock + 60_000)).toBe(1);
    expect(d.cdf(clock - 60_000)).toBe(1); // past-certain too
  });

  test('realized path — individual factors all report 1', () => {
    seq.mount('bind', 'x', 42);
    const d = seq.concretenessDistribution('x');
    expect(d.factors.completion(clock + 1000)).toBe(1);
    expect(d.factors.typeSurvival(clock + 1000)).toBe(1);
    expect(d.factors.provenance(clock + 1000)).toBe(1);
  });

  // ─── Unrealized path with time distribution ────────────────────
  test('unrealized path with distribution(time, exponential) — cdf grows with t', () => {
    // Mount a schema with a time distribution. No value yet — this is a
    // gap whose completion probability rises over time.
    seq.mount('schema', 'task.result', createType('string', [
      distribution('time', 'exponential', { rate: 0.001 }),
    ]));

    const d = seq.concretenessDistribution('task.result');

    // P(completion) rises with t. At t=now, should be ~0.
    const atNow = d.factors.completion(clock);
    const at1s = d.factors.completion(clock + 1000);
    const at10s = d.factors.completion(clock + 10_000);

    expect(atNow).toBeLessThan(at1s);
    expect(at1s).toBeLessThan(at10s);
    // exponential rate 0.001 at dt=1000 → cdf = 1 - e^(-1) ≈ 0.632
    expect(at1s).toBeGreaterThan(0.6);
    expect(at1s).toBeLessThan(0.7);
    // At dt=10_000 → cdf = 1 - e^(-10) ≈ 0.99995
    expect(at10s).toBeGreaterThan(0.99);
  });

  test('unrealized path without distribution — completion falls back to scalar feasibility', () => {
    seq.mount('schema', 'naked.gap', FT.string());
    const d = seq.concretenessDistribution('naked.gap');
    // No distribution('time') is present, so the factor falls back to
    // the existing feasibility computation. This is the bridge that keeps
    // pre-distribution code working while the richer model fills in.
    const val = d.factors.completion(clock + 60_000);
    expect(typeof val).toBe('number');
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(1);
  });

  // ─── Type-survival factor via decay ──────────────────────────
  test('decay on ancestor glob schema — type-survival factor decays with t', () => {
    // Glob schema with a decay constraint.
    seq.mount('schema', 'tasks.*', createType('object', [
      property('status', FT.string(), false),
      decay('exponential', { rate: 0.0001 }),
    ]));

    // Mount an instance. Its ancestor type (tasks.*) carries the decay.
    seq.mount('bind', 'tasks.deploy.status', 'pending');

    const d = seq.concretenessDistribution('tasks.deploy.status');

    // At t = mount time, survival is 1 (no elapsed time).
    const atMount = d.factors.typeSurvival(clock);
    expect(atMount).toBeCloseTo(1, 3);

    // At t = mount + 10_000, survival = exp(-0.0001 * 10000) = exp(-1) ≈ 0.368
    const at10s = d.factors.typeSurvival(clock + 10_000);
    expect(at10s).toBeGreaterThan(0.36);
    expect(at10s).toBeLessThan(0.38);

    // At t = mount + 100_000, survival = exp(-10) ≈ 0.0000454
    const at100s = d.factors.typeSurvival(clock + 100_000);
    expect(at100s).toBeLessThan(0.001);
  });

  test('no decay constraint anywhere — type-survival is always 1', () => {
    seq.mount('schema', 'plain.thing', FT.string());
    seq.mount('bind', 'plain.thing', 'value');
    const d = seq.concretenessDistribution('plain.thing');
    expect(d.factors.typeSurvival(clock)).toBe(1);
    expect(d.factors.typeSurvival(clock + 1_000_000)).toBe(1);
  });

  // ─── Composed cdf ────────────────────────────────────────────
  test('cdf composes the three factors as a product', () => {
    // Unrealized path with BOTH a time distribution AND a type-survival
    // decay in the ancestor chain. Composed cdf(t) should equal
    // completion(t) * typeSurvival(t) * provenance(t).
    seq.mount('schema', 'tasks.*', createType('object', [
      property('result', FT.string(), false),
      decay('exponential', { rate: 0.0001 }),
    ]));
    seq.mount('schema', 'tasks.a.result', createType('string', [
      distribution('time', 'exponential', { rate: 0.001 }),
    ]));

    const d = seq.concretenessDistribution('tasks.a.result');

    const t = clock + 5_000;
    const comp = d.factors.completion(t);
    const surv = d.factors.typeSurvival(t);
    const prov = d.factors.provenance(t);
    const composed = d.cdf(t);

    expect(composed).toBeCloseTo(comp * surv * prov, 5);
  });

  // ─── Provenance factor (placeholder) ─────────────────────────
  test('provenance factor is a placeholder 1 until chain walking lands', () => {
    seq.mount('bind', 'anything', 'x');
    const d = seq.concretenessDistribution('anything');
    expect(d.factors.provenance(clock)).toBe(1);
    expect(d.factors.provenance(clock + 1_000_000_000)).toBe(1);
  });

  // ─── Direct-function form (open taxonomy) ────────────────────
  test('decay(fn, directFunction) — the function IS the arg, no registry', () => {
    // Arbitrary learned/composed evolution — not a named family.
    // Sinusoidal survival curve that wouldn't fit any closed-form family.
    const customSurvival = (dt: number) => {
      if (dt <= 0) return 1;
      if (dt > 20_000) return 0;
      return 0.5 * (1 + Math.cos(Math.PI * dt / 20_000));
    };

    seq.mount('schema', 'custom.*', createType('object', [
      property('result', FT.string(), false),
      decay('fn', customSurvival),
    ]));
    seq.mount('bind', 'custom.a.result', 'pending');

    const d = seq.concretenessDistribution('custom.a.result');

    // At dt = 0 → 1
    expect(d.factors.typeSurvival(clock)).toBeCloseTo(1, 5);
    // At dt = 10_000 → 0.5 * (1 + cos(π/2)) = 0.5
    expect(d.factors.typeSurvival(clock + 10_000)).toBeCloseTo(0.5, 5);
    // At dt = 20_000 → 0.5 * (1 + cos(π)) = 0
    expect(d.factors.typeSurvival(clock + 20_000)).toBeCloseTo(0, 5);
    // Past the declared horizon
    expect(d.factors.typeSurvival(clock + 30_000)).toBe(0);
  });

  test('decay(fn, ...) composes into the overall cdf the same way named families do', () => {
    const customSurvival = (dt: number) => Math.max(0, 1 - dt / 10_000);

    seq.mount('schema', 'ramp.*', createType('object', [
      property('status', FT.string(), false),
      decay('fn', customSurvival),
    ]));
    seq.mount('schema', 'ramp.a.status', createType('string', [
      distribution('time', 'exponential', { rate: 0.0005 }),
    ]));

    const d = seq.concretenessDistribution('ramp.a.status');
    const t = clock + 2_000;
    const comp = d.factors.completion(t);
    const surv = d.factors.typeSurvival(t);
    const composed = d.cdf(t);

    // typeSurvival at dt=2000 = 1 - 0.2 = 0.8
    expect(surv).toBeCloseTo(0.8, 5);
    // cdf is the product of all factors (provenance=1)
    expect(composed).toBeCloseTo(comp * surv, 5);
  });
});
