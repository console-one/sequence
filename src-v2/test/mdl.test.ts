/**
 * mdl.test.ts — MDL gate for refinement promotion + the exposed
 * `mdlGain` helper.
 */

import { Sequence } from '../sequence';
import { mdlGain, registerRefiner, installRefinement, installCommitment, installReliability } from '../stdlib';

describe('mdlGain — pure function', () => {
  test('returns -Infinity when fewer than 2 children', () => {
    expect(mdlGain([])).toBe(-Infinity);
    expect(mdlGain([{ alpha: 5, beta: 5 }])).toBe(-Infinity);
  });

  test('returns -Infinity when no observations', () => {
    expect(mdlGain([{ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }])).toBe(-Infinity);
  });

  test('positive gain when buckets diverge meaningfully', () => {
    // One bucket nearly all successes, the other nearly all failures, with
    // plenty of evidence in each: split should clearly win.
    const gain = mdlGain([
      { alpha: 21, beta: 1 },   // 20 successes
      { alpha: 1, beta: 21 },   // 20 failures
    ]);
    expect(gain).toBeGreaterThan(0);
  });

  test('negative gain when buckets are similar (no meaningful split)', () => {
    // Both buckets near 0.5, plenty of evidence: parent-pooling beats
    // splitting because the BIC penalty isn't justified.
    const gain = mdlGain([
      { alpha: 11, beta: 11 },
      { alpha: 11, beta: 11 },
    ]);
    expect(gain).toBeLessThan(0);
  });

  test('gain scales with sample size for the same divergence pattern', () => {
    // Same divergence pattern (90/10 vs 10/90) at two sample sizes.
    // BIC penalty grows with log(n), but log-likelihood gap grows
    // linearly with n — gain is monotone in n for a fixed split shape.
    const small = mdlGain([
      { alpha: 9 + 1, beta: 1 + 1 },
      { alpha: 1 + 1, beta: 9 + 1 },
    ]);
    const big = mdlGain([
      { alpha: 90 + 1, beta: 10 + 1 },
      { alpha: 10 + 1, beta: 90 + 1 },
    ]);
    expect(big).toBeGreaterThan(small);
  });
});

describe('refinementPromote — useMDL gate path', () => {
  // Drive a few commitments to land posteriors at predictable shapes,
  // then trigger one more commitment status transition to fire the
  // refinement-promote rule. Compare with vs without useMDL.

  function setupHolder(s: Sequence, holder: string, useMDL: boolean): void {
    installCommitment(s);
    installReliability(s);
    installRefinement(s);
    s.impls.set('byClass', (v: any) => String(v?.cls ?? 'x'));
    registerRefiner(s, holder, 'byClass', {
      parentKey: 'object',
      discriminator: 'byClass',
      minEvidence: 3,
      useMDL,
      // minDivergence is irrelevant when useMDL=true; included to verify
      // the MDL path doesn't accidentally fall back to it.
      minDivergence: 99,
    });
  }

  // Helper: directly seed bucket posteriors and emit a commitment status
  // transition that triggers refinementPromote.
  function seedAndFire(
    s: Sequence,
    holder: string,
    aShape: { alpha: number; beta: number },
    bShape: { alpha: number; beta: number },
  ): void {
    s.insert({ path: `_holders.${holder}.subtype.object/A.reliability.alpha`, value: aShape.alpha });
    s.insert({ path: `_holders.${holder}.subtype.object/A.reliability.beta`, value: aShape.beta });
    s.insert({ path: `_holders.${holder}.subtype.object/B.reliability.alpha`, value: bShape.alpha });
    s.insert({ path: `_holders.${holder}.subtype.object/B.reliability.beta`, value: bShape.beta });

    // Fire the rule by simulating a commitment status transition.
    const id = `c_${Math.random().toString(36).slice(2, 8)}`;
    s.insert({ path: `_commitments.${id}.holder`, value: holder });
    s.insert({ path: `_commitments.${id}.status`, value: 'fulfilled' });
  }

  test('useMDL=true activates when MDL gain is positive', () => {
    const s = new Sequence();
    setupHolder(s, 'h1', true);
    // 20 successes vs 20 failures — clear divergence, positive MDL gain.
    seedAndFire(s, 'h1', { alpha: 21, beta: 1 }, { alpha: 1, beta: 21 });
    expect(s.get('_holders.h1.refiners.byClass.active')).toBe(true);
  });

  test('useMDL=true does NOT activate when split is unjustified by MDL', () => {
    const s = new Sequence();
    setupHolder(s, 'h2', true);
    // Buckets are similar: 0.5 each. MDL penalty wins → no activation.
    seedAndFire(s, 'h2', { alpha: 11, beta: 11 }, { alpha: 11, beta: 11 });
    expect(s.get('_holders.h2.refiners.byClass.active')).toBe(false);
  });

  test('useMDL=false retains the divergence heuristic (control)', () => {
    const s = new Sequence();
    setupHolder(s, 'h3', false);
    // Set minDivergence back to a sane value so the heuristic is the
    // honest gate.
    s.insert({ path: '_holders.h3.refiners.byClass.minDivergence', value: 0.3 });
    seedAndFire(s, 'h3', { alpha: 21, beta: 1 }, { alpha: 1, beta: 21 });
    expect(s.get('_holders.h3.refiners.byClass.active')).toBe(true);
  });

  test('useMDL=true still respects minEvidence floor', () => {
    const s = new Sequence();
    setupHolder(s, 'h4', true);
    // Strong divergence shape but only 2 observations per bucket — below
    // the minEvidence=3 floor. No activation regardless of MDL gain.
    seedAndFire(s, 'h4', { alpha: 3, beta: 1 }, { alpha: 1, beta: 3 });
    expect(s.get('_holders.h4.refiners.byClass.active')).toBe(false);
  });
});
