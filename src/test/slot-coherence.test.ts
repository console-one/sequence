/**
 * slot-coherence.test.ts — A path is a slot inhabiting a region of
 * value-space, and every write narrows that region. Two writes can't
 * both inhabit the slot with contradictory values: the meet (lattice
 * intersection) of incompatible narrowings is `never`, and the
 * substrate must reject any write that would land an incoherent set.
 *
 * This is the kernel coherence guarantee. Today's representation is
 * a flat constraint list with compose-meet on every write; a richer
 * segment/interval representation would compute the same meet over
 * the value-space region directly.
 */

import { Sequence } from '../sequence';
import { createType, literal, min, max } from '../type';

describe('slot coherence — incompatible narrowings rejected', () => {
  test('schema-mount of literal that disagrees with prior schema-mount literal is rejected', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', [literal(10)]));
    const r = seq.mount('schema', 'X', createType('number', [literal(20)]));
    expect(r.ok).toBe(false);
    expect(r.gaps?.[0].reason).toMatch(/never|incompatible/i);
    // The original constraint stands.
    expect(seq.get('X')).toBe(10);
  });

  test('schema-mount of literal that disagrees with prior bind value is rejected', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', []));
    seq.mount('bind', 'X', 7);
    const r = seq.mount('schema', 'X', createType('number', [literal(99)]));
    expect(r.ok).toBe(false);
    expect(r.gaps?.[0].reason).toMatch(/never|incompatible/i);
    expect(seq.get('X')).toBe(7);
  });

  test('schema with min(0) that conflicts with max(-5) at meet is rejected', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', [min(0)]));
    const r = seq.mount('schema', 'X', createType('number', [max(-5)]));
    expect(r.ok).toBe(false);
    expect(r.gaps?.[0].reason).toMatch(/never|incompatible/i);
  });

  test('schema with same literal as prior is idempotent (meet is well-defined)', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', [literal(42)]));
    const r = seq.mount('schema', 'X', createType('number', [literal(42)]));
    expect(r.ok).toBe(true);
    expect(seq.get('X')).toBe(42);
  });

  test('bind value that violates declared schema literal is rejected (existing semantic, recorded for completeness)', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('string', [literal('Confidential')]));
    seq.mount('bind', 'X', 'Confidential');  // matches — accepted
    const r = seq.mount('bind', 'X', 'Changed');  // mismatch — rejected
    expect(r.ok).toBe(false);
    expect(seq.get('X')).toBe('Confidential');
  });

  test('subsequent valid bind still works after a rejected schema mount', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', []));
    seq.mount('bind', 'X', 7);
    seq.mount('schema', 'X', createType('number', [literal(99)]));  // rejected
    const r = seq.mount('bind', 'X', 8);  // still works — schema is unchanged
    expect(r.ok).toBe(true);
    expect(seq.get('X')).toBe(8);
  });
});
