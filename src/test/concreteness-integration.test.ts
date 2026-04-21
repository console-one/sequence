/**
 * concreteness-integration.test.ts — Commit 7.
 *
 * Weaves Commits 1-6 together into one scenario. This is the proof that
 * the concreteness-as-distribution pass composes:
 *
 *   1. A task queue with distribution('time') constraints on task
 *      completion — Commits 2, 5
 *   2. A reader as a derived rule with a glob scope — Commit 6
 *   3. A temporal commitment via cdfGte in a while gate — Commits 2, 3
 *   4. Time-conditioned priority in gaps() — Commit 5
 *   5. Cache invalidation on _rt advance — Commit 1
 *   6. Decay on ancestor type eroding the composed cdf — Commit 2
 *
 * The scenario: a client submits a task, a worker observes it via a
 * reader, time advances, priority re-derives, a while-gate with a
 * cdfGte commitment guards an admission and eventually breaks when
 * the deadline passes without completion.
 */

import { Sequence } from '../sequence';
import { createType, property, distribution, decay, cdfGte } from '../type';
import { FT } from '../builder';

describe('concreteness distribution — end-to-end (Commit 7)', () => {
  let clock: number;
  let seq: Sequence;

  beforeEach(() => {
    clock = 1_000_000;
    seq = new Sequence(() => clock);
  });

  test('full chain: submit → reader sees → priority reflects distribution → deadline breaks gate', () => {
    const readerEmissions: string[] = [];

    // ─── 1. Task queue class with completion distribution + decay ──
    //
    // tasks.* carries an exponential decay (type-survival erosion)
    // and its members (each task) have a completion distribution on
    // their result field.
    seq.mount('schema', 'tasks.*', createType('object', [
      property('status', FT.string(), false),
      property('input', FT.string(), false),
      property('result', FT.string(), true),
      // Slow decay so type-survival doesn't dominate over short horizons.
      decay('exponential', { rate: 0.00001 }),
    ]));

    // ─── 2. Reader as a derived rule with a glob scope ─────────────
    //
    // The reader is a derived rule at _readers.worker.emission. Its
    // argPath is the glob tasks.*. Any change under tasks.* fires the
    // cascade, which computes the emission via the formatEmission cap
    // and binds it at the target path. This is the same mechanism as
    // any other cascade — no new primitive.
    seq.mount('cap', 'formatEmission', (triggerPath: string, triggerValue: unknown) => {
      const line = `${triggerPath} = ${JSON.stringify(triggerValue)}`;
      readerEmissions.push(line);
      return line;
    });
    seq.mount('schema', '_readers.worker.emission',
      FT.derived('formatEmission', 'tasks.*'));

    // ─── 3. Install a capability schema + impl for task completion ─
    //
    // The schema at tasks.deploy.result carries a distribution('time')
    // constraint so concretenessDistribution knows how the result
    // evolves over time.
    seq.mount('schema', 'tasks.deploy.result', createType('string', [
      distribution('time', 'exponential', { rate: 0.001 }),
    ]));

    // ─── 4. Submit the task ─────────────────────────────────────────
    //
    // Binding a task value under tasks.* fires the reader's derived
    // rule. Each sub-path bind fires once.
    seq.mount('bind', 'tasks.deploy.status', 'pending');
    seq.mount('bind', 'tasks.deploy.input', 'deploy v2.1.3');

    // Reader should have seen both changes as emissions.
    expect(readerEmissions.some(e => e.includes('tasks.deploy.status') && e.includes('pending'))).toBe(true);
    expect(readerEmissions.some(e => e.includes('tasks.deploy.input') && e.includes('v2.1.3'))).toBe(true);

    // The derived rule's output lands at the target path.
    expect(seq.get('_readers.worker.emission')).toBeDefined();

    // ─── 5. Priority reflects three-factor concreteness ────────────
    //
    // The gap at tasks.deploy.result has:
    //   - Completion: distribution('time', exponential, rate 0.001)
    //   - Type survival: decay on tasks.* (rate 0.0001)
    //   - Provenance: 1 (placeholder)
    // Composed cdf at lookahead = clock + 60_000 should be non-trivial.
    const g = seq.gaps();
    const resultGap = g.find(x => x.path === 'tasks.deploy.result');
    expect(resultGap).toBeDefined();
    expect(resultGap!.priority).toBeGreaterThan(0);

    // ─── 6. The concrete distribution query returns the three factors ─
    //
    // The composed cdf over time is non-monotonic: completion rises
    // (more likely to finish) while type-survival falls (definitions
    // more likely to erode). Both contributions are structurally
    // present; the compositional product produces an interior peak.
    const dist = seq.concretenessDistribution('tasks.deploy.result');
    const at1s = dist.cdf(clock + 1000);
    const at10s = dist.cdf(clock + 10_000);
    expect(at1s).toBeGreaterThan(0);
    expect(at10s).toBeGreaterThan(0);

    // Completion rises monotonically with t (it's a CDF of time-to-event).
    expect(dist.factors.completion(clock + 1000))
      .toBeLessThan(dist.factors.completion(clock + 10_000));
    // Type-survival falls monotonically with t (exponential decay).
    expect(dist.factors.typeSurvival(clock + 10_000))
      .toBeLessThan(dist.factors.typeSurvival(clock + 1000));
    // Provenance is currently a placeholder 1.
    expect(dist.factors.provenance(clock + 1000)).toBe(1);

    // ─── 7. cdfGte where-gate on admission ─────────────────────────
    //
    // A dependent block that requires tasks.deploy.result to be >=95%
    // concrete by clock + 500ms. At clock=now with rate 0.001, the
    // 500ms cdf is ~0.393 — far below 0.95 — so the block is suspended.
    const earlyResult = seq.mount([
      { op: 'bind', path: 'dependent.blockedByShortDeadline', value: 'x' },
    ], {
      where: [cdfGte('tasks.deploy.result', clock + 500, 0.95)],
    });
    expect(earlyResult.ok).toBe(false);
    expect(seq.get('dependent.blockedByShortDeadline')).toBeUndefined();

    // A dependent block with a generous deadline admits.
    const generousResult = seq.mount([
      { op: 'bind', path: 'dependent.ok', value: 'y' },
    ], {
      where: [cdfGte('tasks.deploy.result', clock + 10_000, 0.9)],
    });
    expect(generousResult.ok).toBe(true);

    // ─── 8. Cache invalidation on time advance ─────────────────────
    //
    // Seed the priority cache via gaps(), advance the clock, verify the
    // cache cleared as part of the next mount's forward cascade.
    seq.gaps(); // populate cache
    expect(seq._priorityCacheSize).toBeGreaterThan(0);

    clock += 1000;
    seq.mount('bind', 'tick', true);
    expect(seq._priorityCacheSize).toBe(0);

    // New gaps() repopulates with fresh, time-conditioned priorities.
    const g2 = seq.gaps();
    expect(g2.length).toBeGreaterThan(0);
  });

  test('reader emission sees only its scope, not other tasks', () => {
    const urgentEmissions: string[] = [];
    const normalEmissions: string[] = [];

    seq.mount('cap', 'formatUrgent', (path: string, value: unknown) => {
      const line = `urgent: ${path}=${value}`;
      urgentEmissions.push(line);
      return line;
    });
    seq.mount('cap', 'formatNormal', (path: string, value: unknown) => {
      const line = `normal: ${path}=${value}`;
      normalEmissions.push(line);
      return line;
    });

    // Two readers with different scopes.
    seq.mount('schema', '_readers.urgent.emission',
      FT.derived('formatUrgent', 'tasks.urgent.*'));
    seq.mount('schema', '_readers.normal.emission',
      FT.derived('formatNormal', 'tasks.normal.*'));

    // Write to urgent scope.
    seq.mount('bind', 'tasks.urgent.fixBug.status', 'pending');
    expect(urgentEmissions).toContain('urgent: tasks.urgent.fixBug.status=pending');
    expect(normalEmissions.length).toBe(0);

    // Write to normal scope.
    seq.mount('bind', 'tasks.normal.cleanup.status', 'pending');
    expect(normalEmissions).toContain('normal: tasks.normal.cleanup.status=pending');
    // Urgent didn't see the normal change.
    expect(urgentEmissions.every(e => !e.includes('cleanup'))).toBe(true);
  });

  test('while-gate with cdfGte breaks when type-survival erodes below threshold', () => {
    // A realized path with decay on its ancestor type. At mount time,
    // the composed cdf is near 1 (completion factor = 1 since the path
    // is realized, type-survival factor = 1 at dt=0). As time advances,
    // type-survival erodes; when it drops below the while-gate's
    // threshold, the invariant entry fires and invalidates the block.
    //
    // The important property: the while-gate evaluation is driven by
    // the existing invariant machinery, NOT by a reader- or
    // concreteness-specific hook. Because _rt is in changedPaths on
    // every mount, the invariant entry watching _rt re-evaluates the
    // gate when time moves.

    seq.mount('schema', 'durable.*', createType('object', [
      property('status', FT.string(), false),
      // Heavy decay: rate 0.001 means half-life ≈ 693ms.
      decay('exponential', { rate: 0.001 }),
    ]));
    seq.mount('bind', 'durable.alpha.status', 'ready');

    // The path starts fully realized (completion = 1) and fully
    // surviving (type-survival = 1 at dt=0). Composed cdf at clock ≈ 1.
    const d0 = seq.concretenessDistribution('durable.alpha.status');
    expect(d0.cdf(clock)).toBeCloseTo(1, 3);

    // Mount a block guarded by "cdf must remain >= 0.5 at current _rt".
    const m = seq.mount([
      { op: 'bind', path: 'guarded.value', value: 'initial' },
    ], {
      while: [cdfGte('durable.alpha.status', '_rt' as any, 0.5)],
    });
    expect(m.ok).toBe(true);

    // Gate currently holds (cdf ≈ 1 > 0.5). Value is present.
    expect(seq.get('guarded.value')).toBe('initial');

    // Advance past the half-life — type-survival drops below 0.5.
    // survival(exponential, 700, rate=0.001) = exp(-0.7) ≈ 0.497
    clock += 700;
    seq.mount('bind', 'tick', true);

    // The invariant entry re-evaluates; cdf is now ≈ 0.497 < 0.5, so
    // the while-gate breaks and the block is invalidated.
    expect(seq.get('guarded.value')).toBeUndefined();
  });
});
