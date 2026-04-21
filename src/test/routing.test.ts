/**
 * routing.test.ts — Capability routing via type composition.
 *
 * Proves: model selection, quota enforcement, backward feasibility,
 * and live constraint changes all fall out of compose/selectFirstBranch/
 * backwardInfer — not hand-written routing logic.
 *
 * The routing decision is: build a union of fn types (one per model),
 * each with a min(tokensNeeded) constraint on remaining capacity.
 * selectFirstBranch picks the first model whose constraints compose
 * with the current state. When quota is exhausted, that branch composes
 * to never and the union falls through to the next.
 */

import { Sequence } from '../sequence';
import { createType, property, literal, min, param, returns,
         distribution, preserves, responsePolicy, temporal } from '../type';
import { compose, selectFirstBranch, backwardInfer } from '../compose';
import { FT } from '../builder';

// ═══════════════════════════════════════════════════════════════════════
// HELPERS — build capability types and routing unions from live state
// ═══════════════════════════════════════════════════════════════════════

/** Build a capability fn type for a model with quota constraint. */
function modelCapability(
  modelName: string,
  tokensNeeded: number,
  opts?: { timeMu?: number; timeSigma?: number; reliabilityAlpha?: number; reliabilityBeta?: number },
) {
  const constraints = [
    param(createType('object', [
      property('prompt', FT.string()),
      property(`remaining_${modelName}`, createType('number', [min(tokensNeeded)])),
    ])),
    returns(createType('object', [
      property('model', createType('string', [literal(modelName)])),
      property('response', FT.string()),
      property('tokens_used', FT.number()),
    ])),
    preserves('prompt', 'response'),
  ];
  if (opts?.timeMu) constraints.push(distribution('time', 'lognormal', { mu: opts.timeMu, sigma: opts.timeSigma ?? 0.5 }));
  if (opts?.reliabilityAlpha) constraints.push(distribution('reliability', 'beta', { alpha: opts.reliabilityAlpha, beta: opts.reliabilityBeta ?? 5 }));
  return createType('fn', constraints);
}

/** Build a routing union from model priorities and current token requirement. */
function routingUnion(models: string[], tokensNeeded: number) {
  return createType('or', models.map(m => ({
    op: 'branch' as const,
    args: [modelCapability(m, tokensNeeded, {
      timeMu: m === 'gpt4' ? 7 : 6,
      reliabilityAlpha: m === 'gpt4' ? 95 : 90,
    })],
  })));
}

/** Build a concrete input type from current state. */
function routingInput(prompt: string, remaining: Record<string, number>) {
  const props = [property('prompt', createType('string', [literal(prompt)]))];
  for (const [model, tokens] of Object.entries(remaining)) {
    props.push(property(`remaining_${model}`, createType('number', [literal(tokens)])));
  }
  return createType('object', props);
}

/** Route a call through the Sequence: selectFirstBranch + atomic counter update + trace. */
function routeCall(
  seq: Sequence,
  callId: string,
  prompt: string,
  tokensEst: number,
  user: string,
  day: string,
  models: string[],
): { selected: string | null; rejected: { model: string; reason: string }[] } {
  // Read current capacities from live state
  const remaining: Record<string, number> = {};
  for (const m of models) {
    const used = (seq.get(`state.usage.${m}.${user}.${day}.tokens`) as number) ?? 0;
    const limit = (seq.get(`state.limits.${m}.tokens_per_day`) as number) ?? 0;
    remaining[m] = Math.max(0, limit - used);
  }

  // Type-level routing: selectFirstBranch on the union
  const union = routingUnion(models, tokensEst);
  const input = routingInput(prompt, remaining);
  const result = selectFirstBranch(union, input);

  const rejected: { model: string; reason: string }[] = [];

  if (!result) {
    // All branches produced never — total rejection
    for (const m of models) {
      rejected.push({ model: m, reason: `remaining ${remaining[m]} < needed ${tokensEst}` });
    }
    seq.mount([
      { op: 'bind', path: `_routing.${callId}.selected`, value: null },
      ...rejected.map((r, i) => ({
        op: 'bind' as const,
        path: `_routing.${callId}.rejected.${i}.model`,
        value: r.model,
      })),
      ...rejected.map((r, i) => ({
        op: 'bind' as const,
        path: `_routing.${callId}.rejected.${i}.reason`,
        value: r.reason,
      })),
    ]);
    return { selected: null, rejected };
  }

  // Extract selected model from the composed output type
  const selectedModel = models[result.index];

  // Record rejections for skipped branches
  for (let i = 0; i < result.index; i++) {
    rejected.push({
      model: models[i],
      reason: `remaining ${remaining[models[i]]} < needed ${tokensEst}`,
    });
  }

  // Atomic: increment counter + write trace in one mount block
  const usagePath = `state.usage.${selectedModel}.${user}.${day}.tokens`;
  const currentUsage = (seq.get(usagePath) as number) ?? 0;
  seq.mount([
    { op: 'bind', path: usagePath, value: currentUsage + tokensEst },
    { op: 'bind', path: `_routing.${callId}.selected`, value: selectedModel },
    { op: 'bind', path: `_routing.${callId}.tokensEstimated`, value: tokensEst },
    { op: 'bind', path: `_routing.${callId}.quotaBefore`, value: currentUsage },
    { op: 'bind', path: `_routing.${callId}.quotaAfter`, value: currentUsage + tokensEst },
    { op: 'bind', path: `_routing.${callId}.user`, value: user },
    { op: 'bind', path: `_routing.${callId}.remaining`, value: remaining },
    ...rejected.map((r, i) => ({
      op: 'bind' as const,
      path: `_routing.${callId}.rejected.${i}.model`,
      value: r.model,
    })),
    ...rejected.map((r, i) => ({
      op: 'bind' as const,
      path: `_routing.${callId}.rejected.${i}.reason`,
      value: r.reason,
    })),
  ]);

  return { selected: selectedModel, rejected };
}

/** Backward feasibility: can we handle targetCalls of avgTokens each? */
function feasibility(
  seq: Sequence,
  targetCalls: number,
  avgTokens: number,
  user: string,
  day: string,
  models: string[],
): { model: string; remaining: number; needed: number; feasible: boolean }[] {
  const totalNeeded = targetCalls * avgTokens;
  return models.map(m => {
    const used = (seq.get(`state.usage.${m}.${user}.${day}.tokens`) as number) ?? 0;
    const limit = (seq.get(`state.limits.${m}.tokens_per_day`) as number) ?? 0;
    const remaining = Math.max(0, limit - used);

    // Type-level check: does a capability for this model compose with
    // an input requiring remaining >= totalNeeded?
    const cap = modelCapability(m, totalNeeded);
    const input = routingInput('feasibility-probe', { [m]: remaining });
    const composed = compose(cap, input);
    const feasible = composed.kind !== 'never';

    return { model: m, remaining, needed: totalNeeded, feasible };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('compose-based capability routing', () => {

  let seq: Sequence;
  const MODELS = ['gpt4', 'gpt35'];
  const DAY = '2024-01-15';
  const USER = 'alice';

  beforeEach(() => {
    seq = new Sequence(() => 1000000);

    // Live state: key, limits, usage
    seq.mount('bind', 'state.keys.key1.provider', 'openai');
    seq.mount('bind', 'state.keys.key1.tier', 'tier-1');
    seq.mount('bind', 'state.keys.key1.active', true);

    seq.mount('bind', 'state.limits.gpt4.tokens_per_day', 1000);
    seq.mount('bind', 'state.limits.gpt35.tokens_per_day', 10000);

    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 0);
    seq.mount('bind', `state.usage.gpt35.${USER}.${DAY}.tokens`, 0);

    // Mount capability schemas + registrations
    seq.mount('schema', 'cap.gpt4', modelCapability('gpt4', 1, {
      timeMu: 7, reliabilityAlpha: 95,
    }));
    seq.mount('cap', 'cap.gpt4', true);

    seq.mount('schema', 'cap.gpt35', modelCapability('gpt35', 1, {
      timeMu: 6, reliabilityAlpha: 90,
    }));
    seq.mount('cap', 'cap.gpt35', true);
  });

  // ─── DETERMINISTIC BRANCH SELECTION ──────────────────────────

  test('routes to first branch (gpt4) when within quota', () => {
    const r = routeCall(seq, 'c1', 'Hello', 50, USER, DAY, MODELS);
    expect(r.selected).toBe('gpt4');
    expect(r.rejected.length).toBe(0);
    expect(seq.get('_routing.c1.selected')).toBe('gpt4');
    expect(seq.get('_routing.c1.quotaAfter')).toBe(50);
  });

  test('falls back to gpt35 when gpt4 quota exhausted', () => {
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 980);

    const r = routeCall(seq, 'c2', 'Big prompt', 50, USER, DAY, MODELS);
    expect(r.selected).toBe('gpt35');
    expect(r.rejected.length).toBe(1);
    expect(r.rejected[0].model).toBe('gpt4');
    expect(r.rejected[0].reason).toContain('remaining 20 < needed 50');

    // Trace is auditable
    expect(seq.get('_routing.c2.selected')).toBe('gpt35');
    expect(seq.get('_routing.c2.rejected.0.model')).toBe('gpt4');
    expect(seq.get('_routing.c2.rejected.0.reason')).toContain('remaining');
  });

  test('rejects all when both quotas exhausted', () => {
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 990);
    seq.mount('bind', `state.usage.gpt35.${USER}.${DAY}.tokens`, 9990);

    const r = routeCall(seq, 'c3', 'Prompt', 50, USER, DAY, MODELS);
    expect(r.selected).toBeNull();
    expect(r.rejected.length).toBe(2);
    expect(seq.get('_routing.c3.selected')).toBeNull();
  });

  test('deterministic: same state always selects same branch', () => {
    const r1 = routeCall(seq, 'c4', 'Hello', 50, USER, DAY, MODELS);
    // Reset counter
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 0);
    const r2 = routeCall(seq, 'c5', 'Hello', 50, USER, DAY, MODELS);
    expect(r1.selected).toBe(r2.selected);
  });

  // ─── QUOTA ISOLATION ─────────────────────────────────────────

  test('different users have independent quotas', () => {
    seq.mount('bind', `state.usage.gpt4.bob.${DAY}.tokens`, 0);
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 990);

    // Alice falls back
    expect(routeCall(seq, 'c6', 'P', 50, USER, DAY, MODELS).selected).toBe('gpt35');
    // Bob gets gpt4
    expect(routeCall(seq, 'c7', 'P', 50, 'bob', DAY, MODELS).selected).toBe('gpt4');
  });

  // ─── BACKWARD FEASIBILITY ────────────────────────────────────

  test('feasibility: both models can handle 10 calls of 50 tokens', () => {
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 200);

    const f = feasibility(seq, 10, 50, USER, DAY, MODELS);
    // gpt4: 800 remaining, need 500
    expect(f[0].model).toBe('gpt4');
    expect(f[0].remaining).toBe(800);
    expect(f[0].feasible).toBe(true);
    // gpt35: 10000 remaining, need 500
    expect(f[1].feasible).toBe(true);
  });

  test('feasibility: gpt4 insufficient, gpt35 feasible', () => {
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 900);

    const f = feasibility(seq, 10, 50, USER, DAY, MODELS);
    // gpt4: 100 remaining, need 500 — not feasible
    expect(f[0].feasible).toBe(false);
    // gpt35: 10000 remaining — feasible
    expect(f[1].feasible).toBe(true);
  });

  test('feasibility: nothing feasible when both exhausted', () => {
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 999);
    seq.mount('bind', `state.usage.gpt35.${USER}.${DAY}.tokens`, 9999);

    const f = feasibility(seq, 10, 50, USER, DAY, MODELS);
    expect(f.every(b => !b.feasible)).toBe(true);
  });

  test('backward inference: required output traces to input capacity requirement', () => {
    // "I need a gpt4 response" — what input is required?
    const requiredOutput = createType('object', [
      property('model', createType('string', [literal('gpt4')])),
      property('response', FT.string()),
    ]);

    const gpt4Cap = modelCapability('gpt4', 500);
    const inputReq = backwardInfer(gpt4Cap, requiredOutput);

    // backwardInfer should tell us we need remaining_gpt4 >= 500
    expect(inputReq.kind).not.toBe('never');
    // The input type preserves the capacity requirement
    if (inputReq.kind === 'object') {
      const props = inputReq.constraints.filter(c => c.op === 'property');
      const capacityProp = props.find(c => c.args[0] === 'remaining_gpt4');
      expect(capacityProp).toBeDefined();
    }
  });

  // ─── LIVE CONSTRAINT CHANGES ─────────────────────────────────

  test('tier upgrade: limits change, routing adapts immediately', () => {
    // Exhaust tier-1 gpt4 quota
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 980);

    // Before upgrade: falls back
    expect(routeCall(seq, 'c8', 'P', 50, USER, DAY, MODELS).selected).toBe('gpt35');

    // Tier upgrade: change the live limit value
    seq.mount('bind', 'state.keys.key1.tier', 'tier-2');
    seq.mount('bind', 'state.limits.gpt4.tokens_per_day', 100000);

    // After upgrade: gpt4 feasible again (100000 - 980 = 99020 remaining)
    expect(routeCall(seq, 'c9', 'P', 50, USER, DAY, MODELS).selected).toBe('gpt4');

    // Backward query reflects new limits
    const f = feasibility(seq, 100, 500, USER, DAY, MODELS);
    expect(f[0].feasible).toBe(true);
    expect(f[0].remaining).toBe(100000 - 980 - 50); // after the c9 call
  });

  test('key revocation: zero limits, all branches infeasible', () => {
    // Normal routing works
    expect(routeCall(seq, 'c10', 'P', 50, USER, DAY, MODELS).selected).toBe('gpt4');

    // Revoke: set limits to 0
    seq.mount('bind', 'state.keys.key1.active', false);
    seq.mount('bind', 'state.limits.gpt4.tokens_per_day', 0);
    seq.mount('bind', 'state.limits.gpt35.tokens_per_day', 0);

    // All infeasible
    expect(routeCall(seq, 'c11', 'P', 50, USER, DAY, MODELS).selected).toBeNull();
    expect(feasibility(seq, 1, 50, USER, DAY, MODELS).every(b => !b.feasible)).toBe(true);
  });

  test('usage reset: new billing day restores capacity', () => {
    // Exhaust today
    seq.mount('bind', `state.usage.gpt4.${USER}.${DAY}.tokens`, 990);
    expect(routeCall(seq, 'c12', 'P', 50, USER, DAY, MODELS).selected).toBe('gpt35');

    // New day: fresh counters (0 by default since path doesn't exist)
    const newDay = '2024-01-16';
    // gpt4 is feasible on the new day — no usage yet
    expect(routeCall(seq, 'c13', 'P', 50, USER, newDay, MODELS).selected).toBe('gpt4');
  });

  // ─── PROGRESSIVE EXHAUSTION ──────────────────────────────────

  test('sequential calls exhaust gpt4, fall through to gpt35', () => {
    // 20 calls of 50 tokens = 1000 total, exactly gpt4 limit
    for (let i = 0; i < 20; i++) {
      const r = routeCall(seq, `s${i}`, 'Prompt', 50, USER, DAY, MODELS);
      expect(r.selected).toBe('gpt4');
    }

    // Call 21: gpt4 exhausted, falls to gpt35
    const r21 = routeCall(seq, 's20', 'Prompt', 50, USER, DAY, MODELS);
    expect(r21.selected).toBe('gpt35');
    expect(r21.rejected[0].model).toBe('gpt4');

    // Counter is correct
    expect(seq.get(`state.usage.gpt4.${USER}.${DAY}.tokens`)).toBe(1000);
    expect(seq.get(`state.usage.gpt35.${USER}.${DAY}.tokens`)).toBe(50);
  });

  // ─── TYPE COMPOSITION PROOF ──────────────────────────────────

  test('compose correctly rejects: literal(10) vs min(50) → never', () => {
    // This is the core property that makes routing work via types
    const needsCapacity = createType('number', [min(50)]);
    const hasLittle = createType('number', [literal(10)]);
    const result = compose(needsCapacity, hasLittle);
    expect(result.kind).toBe('never');
  });

  test('compose correctly accepts: literal(800) vs min(50) → ok', () => {
    const needsCapacity = createType('number', [min(50)]);
    const hasPlenty = createType('number', [literal(800)]);
    const result = compose(needsCapacity, hasPlenty);
    expect(result.kind).not.toBe('never');
  });

  test('selectFirstBranch skips exhausted branch, picks next', () => {
    const union = routingUnion(['gpt4', 'gpt35'], 50);
    // gpt4 exhausted (remaining=10), gpt35 has room (remaining=5000)
    const input = routingInput('test', { gpt4: 10, gpt35: 5000 });

    const result = selectFirstBranch(union, input);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1); // gpt35 is second branch
  });

  test('selectFirstBranch returns null when all exhausted', () => {
    const union = routingUnion(['gpt4', 'gpt35'], 50);
    const input = routingInput('test', { gpt4: 10, gpt35: 10 });

    const result = selectFirstBranch(union, input);
    expect(result).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // TIME-AWARE ROUTING — branch elimination by deadline/confidence
  // ═══════════════════════════════════════════════════════════════

  describe('time-aware routing via probabilistic compose', () => {

    /** Build a capability fn with quota + time distribution + deadline + confidence. */
    function timedModelCapability(
      modelName: string,
      tokensNeeded: number,
      timeMu: number,
      timeSigma: number,
      timeoutMs: number,
      confidence: number,
    ) {
      return createType('fn', [
        param(createType('object', [
          property('prompt', FT.string()),
          property(`remaining_${modelName}`, createType('number', [min(tokensNeeded)])),
        ])),
        returns(createType('object', [
          property('model', createType('string', [literal(modelName)])),
          property('response', FT.string()),
        ])),
        distribution('time', 'lognormal', { mu: timeMu, sigma: timeSigma }),
        responsePolicy(timeoutMs, confidence),
        preserves('prompt', 'response'),
      ]);
    }

    test('time-aware branch fallthrough: slow model eliminated by deadline', () => {
      // gpt4: lognormal(mu=7, sigma=0.5) — median ~1097ms
      //   P(≤1000ms) ≈ 0.427 — below 95% confidence → eliminated
      // gpt35: lognormal(mu=6, sigma=0.3) — median ~403ms
      //   P(≤1000ms) ≈ 0.999 — above 95% confidence → selected
      //
      // Both have remaining quota. The elimination is purely temporal.

      const gpt4Branch = timedModelCapability('gpt4', 50, 7, 0.5, 1000, 0.95);
      const gpt35Branch = timedModelCapability('gpt35', 50, 6, 0.3, 1000, 0.95);

      const union = createType('or', [
        { op: 'branch', args: [gpt4Branch] },
        { op: 'branch', args: [gpt35Branch] },
      ]);

      // Input: both models have plenty of quota remaining
      const input = routingInput('urgent prompt', { gpt4: 5000, gpt35: 5000 });
      const result = selectFirstBranch(union, input);

      // gpt4 (branch 0) eliminated by deadline infeasibility
      // gpt35 (branch 1) selected — fast enough to meet deadline with confidence
      expect(result).not.toBeNull();
      expect(result!.index).toBe(1); // gpt35, not gpt4
    });

    test('both branches feasible when deadline is generous', () => {
      // 10000ms deadline — both models can make it easily
      const gpt4Branch = timedModelCapability('gpt4', 50, 7, 0.5, 10000, 0.95);
      const gpt35Branch = timedModelCapability('gpt35', 50, 6, 0.3, 10000, 0.95);

      const union = createType('or', [
        { op: 'branch', args: [gpt4Branch] },
        { op: 'branch', args: [gpt35Branch] },
      ]);

      const input = routingInput('relaxed prompt', { gpt4: 5000, gpt35: 5000 });
      const result = selectFirstBranch(union, input);

      // gpt4 (branch 0) is first and feasible → selected (priority order)
      expect(result).not.toBeNull();
      expect(result!.index).toBe(0);
    });

    test('both branches eliminated when deadline is impossible', () => {
      // 100ms deadline — neither can make it
      const gpt4Branch = timedModelCapability('gpt4', 50, 7, 0.5, 100, 0.95);
      const gpt35Branch = timedModelCapability('gpt35', 50, 6, 0.3, 100, 0.95);

      const union = createType('or', [
        { op: 'branch', args: [gpt4Branch] },
        { op: 'branch', args: [gpt35Branch] },
      ]);

      const input = routingInput('impossible prompt', { gpt4: 5000, gpt35: 5000 });
      const result = selectFirstBranch(union, input);

      expect(result).toBeNull(); // no branch can meet the deadline
    });

    test('quota + deadline compound: gpt4 has quota but misses deadline, gpt35 has both', () => {
      // gpt4: has remaining quota BUT deadline infeasible at 1000ms
      // gpt35: has remaining quota AND deadline feasible at 1000ms
      const gpt4Branch = timedModelCapability('gpt4', 50, 7, 0.5, 1000, 0.95);
      const gpt35Branch = timedModelCapability('gpt35', 50, 6, 0.3, 1000, 0.95);

      const union = createType('or', [
        { op: 'branch', args: [gpt4Branch] },
        { op: 'branch', args: [gpt35Branch] },
      ]);

      const input = routingInput('compound test', { gpt4: 5000, gpt35: 5000 });
      const result = selectFirstBranch(union, input);

      expect(result).not.toBeNull();
      expect(result!.index).toBe(1); // gpt35 wins on time, not quota
    });

    test('full Sequence integration: time-aware routing reads live state', () => {
      // Mount live state for a time-sensitive scenario
      seq.mount('bind', 'state.limits.gpt4.tokens_per_day', 100000);
      seq.mount('bind', 'state.limits.gpt35.tokens_per_day', 100000);

      // Both have ample quota. But gpt4 is too slow for the 1s deadline.
      const remaining: Record<string, number> = {};
      for (const m of MODELS) {
        const used = (seq.get(`state.usage.${m}.${USER}.${DAY}.tokens`) as number) ?? 0;
        const limit = (seq.get(`state.limits.${m}.tokens_per_day`) as number) ?? 0;
        remaining[m] = Math.max(0, limit - used);
      }

      // Build time-aware union from live state
      const union = createType('or', MODELS.map(m => ({
        op: 'branch' as const,
        args: [timedModelCapability(
          m, 50,
          m === 'gpt4' ? 7 : 6,  // gpt4 slower
          m === 'gpt4' ? 0.5 : 0.3,
          1000,  // 1 second deadline
          0.95,  // 95% confidence required
        )],
      })));

      const input = routingInput('live test', remaining);
      const result = selectFirstBranch(union, input);

      // gpt4 eliminated by time, gpt35 selected
      expect(result).not.toBeNull();
      expect(result!.index).toBe(1);

      // Trace the decision
      seq.mount('bind', '_routing.time_aware.selected', MODELS[result!.index]);
      seq.mount('bind', '_routing.time_aware.eliminatedBy', 'deadline_infeasibility');
      expect(seq.get('_routing.time_aware.selected')).toBe('gpt35');
    });
  });
});
