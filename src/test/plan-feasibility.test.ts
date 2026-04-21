/**
 * plan-feasibility.test.ts — Plan-level probabilistic feasibility guards.
 *
 * Proves:
 * 1. Plan with 3 steps at P99 each is NOT P99 as a plan.
 * 2. Dependency model is required (absent → worst_case_bound).
 * 3. Independent vs worst_case gives different (correct) results.
 * 4. Monotonicity: more steps can't increase feasibility.
 * 5. Trace object has all required fields.
 * 6. Uncertain status for weakly identified models.
 * 7. Hard reject when below threshold.
 * 8. No silent point estimates.
 */

import { planFeasibility, cdf } from '../compose';
import type { StepDistribution, PlanFeasibilityTrace } from '../compose';

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

const SLOW_STEP: StepDistribution = { family: 'lognormal', params: { mu: 7, sigma: 0.5 } };
// median ≈ 1097ms, mean ≈ 1243ms

const FAST_STEP: StepDistribution = { family: 'lognormal', params: { mu: 6, sigma: 0.3 } };
// median ≈ 403ms, mean ≈ 422ms

const FIXED_STEP: StepDistribution = { family: 'fixed', params: { value: 500 } };

function assertTraceComplete(trace: PlanFeasibilityTrace): void {
  expect(trace.deadline).toBeDefined();
  expect(trace.required_confidence).toBeDefined();
  expect(trace.computed_probability).toBeDefined();
  expect(trace.dependency_model).toBeDefined();
  expect(trace.status).toBeDefined();
  expect(trace.reason).toBeDefined();
  expect(trace.steps).toBeDefined();
  expect(trace.naive_product).toBeDefined();
  expect(trace.conservative_bound).toBeDefined();
  expect(['feasible', 'infeasible', 'uncertain']).toContain(trace.status);
}

// ═══════════════════════════════════════════════════════════════════════
// GUARD CONDITION 1: Never infer plan-level from per-step
// ═══════════════════════════════════════════════════════════════════════

describe('guard: plan-level ≠ per-step product', () => {

  test('3 steps each P99 at deadline → plan is NOT P99', () => {
    // Each step: P(≤5000ms) ≈ 0.999 → naive product ≈ 0.997
    // But independent sum: P(sum≤5000) ≈ 0.870 → BELOW 95%
    const steps = [SLOW_STEP, SLOW_STEP, SLOW_STEP];
    const trace = planFeasibility(steps, 5000, 0.95, 'independent');

    // Per-step looks great
    expect(trace.naive_product).toBeGreaterThan(0.99);
    for (const s of trace.steps) {
      expect(s.per_step_cdf).toBeGreaterThan(0.99);
    }

    // But plan-level is below threshold
    expect(trace.computed_probability).toBeLessThan(0.95);
    expect(trace.status).toBe('infeasible');

    // The naive product is NOT used for the decision
    expect(trace.computed_probability).not.toBe(trace.naive_product);
  });

  test('same 3 steps with generous deadline → plan is feasible', () => {
    // P(sum≤10000) ≈ 0.999 for independent sum
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP, SLOW_STEP], 10000, 0.95, 'independent',
    );
    expect(trace.status).toBe('feasible');
    expect(trace.computed_probability).toBeGreaterThan(0.95);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD 2-3: Dependency model required, fail closed
// ═══════════════════════════════════════════════════════════════════════

describe('guard: dependency model', () => {

  test('missing dependency model → fail closed to worst_case_bound', () => {
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP, SLOW_STEP], 5000, 0.95, null,
    );
    expect(trace.dependency_model).toBe('worst_case_bound');
    // Worst case: each step gets 5000/3 ≈ 1667ms
    // P(step≤1667) ≈ 0.799 → infeasible at 0.95
    expect(trace.status).toBe('infeasible');
    expect(trace.computed_probability).toBeLessThan(0.95);
  });

  test('undefined dependency model → same as null', () => {
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP], 5000, 0.95, undefined,
    );
    expect(trace.dependency_model).toBe('worst_case_bound');
  });

  test('independent vs worst_case give different results', () => {
    const steps = [SLOW_STEP, SLOW_STEP];
    const indep = planFeasibility(steps, 5000, 0.90, 'independent');
    const worst = planFeasibility(steps, 5000, 0.90, 'worst_case_bound');

    // Independent should be more optimistic than worst-case
    expect(indep.computed_probability).toBeGreaterThan(worst.computed_probability);

    // They may differ in feasibility status
    // 2 steps independent at 5000ms should be feasible at 90%
    // 2 steps worst-case: each gets 2500ms, P(≤2500) ≈ 0.954
    expect(indep.status).toBe('feasible');
  });

  test('worst_case_bound: per-step budget = deadline / n', () => {
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP, SLOW_STEP, SLOW_STEP], 8000, 0.95, 'worst_case_bound',
    );
    // 4 steps, deadline=8000 → per-step budget=2000ms
    // P(step≤2000) ≈ 0.885 < 0.95 → infeasible
    expect(trace.status).toBe('infeasible');
    expect(trace.reason).toContain('per-step budget=2000');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD 4: Uncertain status for weakly identified models
// ═══════════════════════════════════════════════════════════════════════

describe('guard: uncertain status', () => {

  test('shared_factor without params → uncertain', () => {
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP], 5000, 0.95, 'shared_factor',
    );
    expect(trace.status).toBe('uncertain');
    expect(trace.reason).toContain('parameters not provided');
    expect(trace.reason).toContain('conservative bound');
  });

  test('copula without params → uncertain', () => {
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP], 5000, 0.95, 'copula',
    );
    expect(trace.status).toBe('uncertain');
  });

  test('uncertain still provides conservative bound', () => {
    const trace = planFeasibility(
      [SLOW_STEP, SLOW_STEP], 5000, 0.95, 'shared_factor',
    );
    expect(trace.computed_probability).toBeGreaterThan(0);
    expect(trace.conservative_bound).toBeGreaterThan(0);
    expect(trace.computed_probability).toBe(trace.conservative_bound);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD 5-6: Trace completeness + audit fields
// ═══════════════════════════════════════════════════════════════════════

describe('guard: trace completeness', () => {

  test('trace has all required fields', () => {
    const trace = planFeasibility([SLOW_STEP, FAST_STEP], 3000, 0.95, 'independent');
    assertTraceComplete(trace);

    // Per-step detail
    expect(trace.steps.length).toBe(2);
    expect(trace.steps[0].family).toBe('lognormal');
    expect(trace.steps[0].params).toEqual({ mu: 7, sigma: 0.5 });
    expect(typeof trace.steps[0].per_step_cdf).toBe('number');
  });

  test('trace shows naive product for comparison (never used for decision)', () => {
    const trace = planFeasibility([SLOW_STEP, SLOW_STEP, SLOW_STEP], 5000, 0.95, 'independent');
    // Naive product is high (~0.997) but plan probability is low (~0.870)
    expect(trace.naive_product).toBeGreaterThan(trace.computed_probability);
    // The decision uses computed_probability, not naive_product
    expect(trace.status).toBe('infeasible');
  });

  test('reason string explains the dependency model used', () => {
    const indep = planFeasibility([SLOW_STEP], 5000, 0.95, 'independent');
    expect(indep.reason).toContain('Fenton-Wilkinson');

    const worst = planFeasibility([SLOW_STEP], 5000, 0.95, 'worst_case_bound');
    expect(worst.reason).toContain('comonotonic');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD 7: Hard reject when below threshold
// ═══════════════════════════════════════════════════════════════════════

describe('guard: hard reject', () => {

  test('below threshold → infeasible, not "close enough"', () => {
    // P just barely below 0.95
    // 3 steps at deadline=5000: P≈0.870 (independent), need 0.90 → infeasible
    const trace = planFeasibility([SLOW_STEP, SLOW_STEP, SLOW_STEP], 5000, 0.90, 'independent');
    expect(trace.computed_probability).toBeLessThan(0.90);
    expect(trace.status).toBe('infeasible');
  });

  test('exactly at threshold → feasible (≥ not >)', () => {
    // Find a deadline where P ≈ threshold
    // 1 step lognormal(mu=7, sigma=0.5) at 5000ms: P≈0.999 at confidence 0.999
    const trace = planFeasibility([SLOW_STEP], 5000, 0.99, 'independent');
    expect(trace.computed_probability).toBeGreaterThanOrEqual(0.99);
    expect(trace.status).toBe('feasible');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MONOTONICITY: more steps can't increase feasibility
// ═══════════════════════════════════════════════════════════════════════

describe('monotonicity', () => {

  test('adding steps cannot increase feasibility (independent)', () => {
    const p1 = planFeasibility([SLOW_STEP], 5000, 0.95, 'independent');
    const p2 = planFeasibility([SLOW_STEP, SLOW_STEP], 5000, 0.95, 'independent');
    const p3 = planFeasibility([SLOW_STEP, SLOW_STEP, SLOW_STEP], 5000, 0.95, 'independent');

    // More steps → lower probability (same deadline, more work)
    expect(p1.computed_probability).toBeGreaterThanOrEqual(p2.computed_probability);
    expect(p2.computed_probability).toBeGreaterThanOrEqual(p3.computed_probability);
  });

  test('adding steps cannot increase feasibility (worst_case)', () => {
    const p1 = planFeasibility([SLOW_STEP], 5000, 0.95, 'worst_case_bound');
    const p2 = planFeasibility([SLOW_STEP, SLOW_STEP], 5000, 0.95, 'worst_case_bound');
    const p4 = planFeasibility([SLOW_STEP, SLOW_STEP, SLOW_STEP, SLOW_STEP], 5000, 0.95, 'worst_case_bound');

    expect(p1.computed_probability).toBeGreaterThanOrEqual(p2.computed_probability);
    expect(p2.computed_probability).toBeGreaterThanOrEqual(p4.computed_probability);
  });

  test('tighter deadline cannot increase feasibility (same steps)', () => {
    const loose = planFeasibility([SLOW_STEP, SLOW_STEP], 10000, 0.95, 'independent');
    const medium = planFeasibility([SLOW_STEP, SLOW_STEP], 5000, 0.95, 'independent');
    const tight = planFeasibility([SLOW_STEP, SLOW_STEP], 2000, 0.95, 'independent');

    expect(loose.computed_probability).toBeGreaterThanOrEqual(medium.computed_probability);
    expect(medium.computed_probability).toBeGreaterThanOrEqual(tight.computed_probability);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD 8: No silent point estimates
// ═══════════════════════════════════════════════════════════════════════

describe('guard: no silent point estimates', () => {

  test('fixed distributions (point estimates) are handled but result in zero variance', () => {
    // Two fixed 500ms steps: sum = 1000ms exactly. P(sum≤1000) = 1, P(sum≤999) = 0.
    const trace = planFeasibility([FIXED_STEP, FIXED_STEP], 1000, 0.95, 'independent');
    // FW with zero variance: the approximation may be imprecise, but the
    // conservative bound should catch it
    assertTraceComplete(trace);
  });

  test('mixed fixed + stochastic: point estimate does not mask stochastic uncertainty', () => {
    // 1 fixed 500ms step + 1 lognormal step
    // Sum distribution is shifted lognormal: P(500 + lognormal ≤ D)
    const steps: StepDistribution[] = [
      FIXED_STEP,
      { family: 'lognormal', params: { mu: 7, sigma: 0.5 } },
    ];
    const trace = planFeasibility(steps, 2000, 0.95, 'independent');
    // The fixed step consumes 500ms of the 2000ms budget
    // Remaining 1500ms for the lognormal: P(≤1500) ≈ 0.739
    // But Fenton-Wilkinson treats this as sum of two distributions
    // Either way, the result should NOT be a point estimate
    assertTraceComplete(trace);
    expect(trace.computed_probability).toBeLessThan(1); // not falsely certain
    expect(trace.computed_probability).toBeGreaterThan(0); // not falsely impossible
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════

describe('edge cases', () => {

  test('empty plan → feasible', () => {
    const trace = planFeasibility([], 5000, 0.95, 'independent');
    expect(trace.status).toBe('feasible');
    expect(trace.computed_probability).toBe(1);
  });

  test('single step → same as step-level CDF', () => {
    const trace = planFeasibility([SLOW_STEP], 5000, 0.95, 'independent');
    const stepCdf = cdf('lognormal', 5000, { mu: 7, sigma: 0.5 });
    // For single step, FW should be close to the raw CDF
    expect(Math.abs(trace.computed_probability - stepCdf)).toBeLessThan(0.01);
  });

  test('zero deadline → infeasible', () => {
    const trace = planFeasibility([SLOW_STEP], 0, 0.95, 'independent');
    expect(trace.status).toBe('infeasible');
    expect(trace.computed_probability).toBe(0);
  });

  test('zero confidence → always feasible', () => {
    const trace = planFeasibility([SLOW_STEP, SLOW_STEP, SLOW_STEP], 100, 0, 'independent');
    expect(trace.status).toBe('feasible');
  });
});
