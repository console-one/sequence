/**
 * concreteness-constraint-ops.test.ts — Commit 3 of the concreteness-as-
 * distribution pass.
 *
 * Asserts that the new constraint ops (cdf_gte, concrete_at) work as
 * where/while gate predicates on mounts. These are the primitive for
 * expressing temporal commitments: "this block is valid only while the
 * concreteness of path P by time t is at least probability p."
 *
 * Where-gates gate admission: a block with an unsatisfied where-gate is
 * suspended (not applied) until the gate flips true. While-gates gate
 * lifetime: a block with a while-gate that breaks is invalidated.
 *
 * cdfGte(path, t, p) ↔ concretenessDistribution(path).cdf(t) >= p
 * concreteAt(path, t) ↔ concretenessDistribution(path).cdf(t) >= 0.5
 */

import { Sequence } from '../sequence';
import { createType, property, distribution, decay, cdfGte, concreteAt } from '../type';
import { FT } from '../builder';

describe('cdfGte / concreteAt as where/while gate predicates (Commit 3)', () => {
  let clock: number;
  let seq: Sequence;

  beforeEach(() => {
    clock = 1_000_000;
    seq = new Sequence(() => clock);
  });

  // ─── cdfGte as a where-gate on admission ───────────────────────
  test('cdfGte(path, t, 0.9) blocks admission when completion probability is too low', () => {
    // Mount a schema with a slow exponential completion. At t=now, cdf is 0.
    seq.mount('schema', 'slow.job', createType('string', [
      distribution('time', 'exponential', { rate: 0.00001 }),
    ]));

    // Try to mount a block gated on "slow.job must be ≥90% concrete by now".
    // The gate evaluates to false, so the block is suspended.
    const result = seq.mount([
      { op: 'bind', path: 'dependent.thing', value: 'wants slow.job ready' },
    ], {
      where: [cdfGte('slow.job', clock, 0.9)],
    });

    expect(result.ok).toBe(false);
    expect(result.gaps).toBeDefined();
    expect(result.gaps![0].reason).toMatch(/where: cdf_gte/);
    expect(seq.get('dependent.thing')).toBeUndefined();
  });

  test('cdfGte admits when the probability threshold is met', () => {
    // Already-realized path: cdf is 1 at any t.
    seq.mount('bind', 'ready.signal', 'active');

    const result = seq.mount([
      { op: 'bind', path: 'dependent.thing', value: 'uses the ready signal' },
    ], {
      where: [cdfGte('ready.signal', clock, 0.9)],
    });

    expect(result.ok).toBe(true);
    expect(seq.get('dependent.thing')).toBe('uses the ready signal');
  });

  test('cdfGte admits a high-rate distribution given enough time', () => {
    // Fast exponential — rate 0.01 means cdf(100) = 1 - e^-1 ≈ 0.632,
    // cdf(500) = 1 - e^-5 ≈ 0.993
    seq.mount('schema', 'fast.job', createType('string', [
      distribution('time', 'exponential', { rate: 0.01 }),
    ]));

    // Gate: ≥ 90% concrete within 500ms → should admit.
    const result = seq.mount([
      { op: 'bind', path: 'followup', value: 'fast_enough' },
    ], {
      where: [cdfGte('fast.job', clock + 500, 0.9)],
    });

    expect(result.ok).toBe(true);
  });

  // ─── concreteAt as the "more likely than not" shortcut ────────
  test('concreteAt(path, t) is equivalent to cdfGte(path, t, 0.5)', () => {
    seq.mount('schema', 'middling.job', createType('string', [
      distribution('time', 'exponential', { rate: 0.001 }),
    ]));

    // At t = now + 693 (half-life), cdf ≈ 0.5 — so concreteAt should just
    // barely pass or fail at the boundary. Go well past it to be clear.
    const okResult = seq.mount([
      { op: 'bind', path: 'ok', value: 'yes' },
    ], {
      where: [concreteAt('middling.job', clock + 5000)], // cdf(5000) ≈ 0.993
    });
    expect(okResult.ok).toBe(true);

    const failResult = seq.mount([
      { op: 'bind', path: 'fail', value: 'no' },
    ], {
      where: [concreteAt('middling.job', clock + 100)], // cdf(100) ≈ 0.095
    });
    expect(failResult.ok).toBe(false);
    expect(seq.get('fail')).toBeUndefined();
  });

  // ─── Type-survival via decay participates in the cdf ───────────
  test('cdfGte considers decay — type-survival erodes the composed cdf', () => {
    // Fast completion (rate 0.01) paired with strong decay (rate 0.005).
    // Without decay: cdf(500) ≈ 0.993
    // With decay:    cdf(500) ≈ 0.993 * exp(-0.005 * 500) ≈ 0.993 * 0.082 ≈ 0.0816
    seq.mount('schema', 'short.lived.*', createType('object', [
      property('result', FT.string(), false),
      decay('exponential', { rate: 0.005 }),
    ]));
    seq.mount('schema', 'short.lived.foo.result', createType('string', [
      distribution('time', 'exponential', { rate: 0.01 }),
    ]));

    // Seed the decay root time so (t - rootTime) is meaningful.
    seq.mount('bind', 'short.lived.foo.kickoff', true);

    // Gate at 50% threshold — composed cdf is ~0.08, should fail.
    const result = seq.mount([
      { op: 'bind', path: 'dependent', value: 'x' },
    ], {
      where: [cdfGte('short.lived.foo.result', clock + 500, 0.5)],
    });
    expect(result.ok).toBe(false);
  });

  test('cdfGte accepts arithmetic expressions for t (e.g. _rt + deadline_ms)', () => {
    seq.mount('schema', 'fast.thing', createType('string', [
      distribution('time', 'exponential', { rate: 0.01 }),
    ]));

    // t expressed as _rt + 1000 via arithmetic expr
    const result = seq.mount([
      { op: 'bind', path: 'needs_fast', value: 'ok' },
    ], {
      where: [cdfGte('fast.thing', { op: '+', lhs: '_rt', rhs: 1000 } as any, 0.9)],
    });
    expect(result.ok).toBe(true);
  });

  // ─── Direct-fn decay participates in cdfGte ──────────────────
  test('cdfGte evaluates with a direct-function decay', () => {
    // Custom survival: linear ramp 1 → 0 over 10_000 ms
    const rampSurvival = (dt: number) => Math.max(0, 1 - dt / 10_000);

    seq.mount('schema', 'ramped.*', createType('object', [
      property('state', FT.string(), false),
      decay('fn', rampSurvival),
    ]));
    seq.mount('bind', 'ramped.a.state', 'live');

    // At mount, cdf(now) = 1 * 1 * 1 = 1 → gate passes
    const okResult = seq.mount([
      { op: 'bind', path: 'needs_live', value: 'yes' },
    ], {
      where: [cdfGte('ramped.a.state', clock, 0.9)],
    });
    expect(okResult.ok).toBe(true);

    // At t = now + 9000, survival is 1 - 0.9 = 0.1, so composed cdf is 0.1
    // Gate at 0.5 → should fail
    const failResult = seq.mount([
      { op: 'bind', path: 'future_fail', value: 'no' },
    ], {
      where: [cdfGte('ramped.a.state', clock + 9_000, 0.5)],
    });
    expect(failResult.ok).toBe(false);
  });
});
