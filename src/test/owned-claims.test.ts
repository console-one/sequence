/**
 * owned-claims.test.ts — Per-owner claim semantics.
 *
 * The substrate's per-path constraint store groups claims by OWNER.
 * Each owner is a lifecycle holder (a commitment id, an author, or
 * a kernel-internal token). Releasing an owner drops their claims;
 * other owners' claims remain. The slot's effective region is the
 * meet of every owner's narrowings — and incompatible narrowings
 * are rejected at write time so the slot can never be incoherent.
 */

import { Sequence, bindOwner, schemaOwner, commitmentOwner } from '../sequence';
import { createType, literal, min } from '../type';

describe('owned claims — per-owner lifecycle', () => {
  test('two owners can each claim at the same path with compatible narrowings', () => {
    const seq = new Sequence();
    // Schema owner declares: number, min 0
    seq.mount('schema', 'X', createType('number', [min(0)]));
    // A different schema-owner declares an additional constraint
    // on the same path (compatible — both narrowings inhabit a
    // non-empty region).
    seq.mount('schema', 'X', createType('number', [literal(7)]), { author: 'alice' } as any);
    // The aggregate region admits 7 — it's >= 0 and equals 7.
    expect(seq.get('X')).toBe(7);
    expect(seq.typeAt('X')?.kind).toBe('number');
  });

  test('two owners with conflicting narrowings: the second is rejected', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', [literal(7)]));
    const r = seq.mount('schema', 'X', createType('number', [literal(99)]), { author: 'alice' } as any);
    expect(r.ok).toBe(false);
    expect(seq.get('X')).toBe(7);
  });

  test('releaseOwner drops only that owner\'s claims; others remain', () => {
    const seq = new Sequence();
    // Two distinct owners claim min/max — together they bound X to [0, 100].
    seq.mount('schema', 'X', createType('number', [min(0)]));
    const aliceOwner = schemaOwner('alice');
    seq.mount('schema', 'X', createType('number', [{ op: 'max', args: [100] }]), { author: 'alice' } as any);
    expect(seq.typeAt('X')?.kind).toBe('number');
    // Alice releases: her max(100) constraint vacates.
    const affected = seq.releaseOwner(aliceOwner);
    expect(affected).toContain('X');
    // The other owner's min(0) constraint persists.
    const t = seq.typeAt('X');
    expect(t?.constraints.some(c => c.op === 'min' && c.args[0] === 0)).toBe(true);
    expect(t?.constraints.some(c => c.op === 'max')).toBe(false);
  });

  test('releaseOwner on an unknown owner is a no-op', () => {
    const seq = new Sequence();
    seq.mount('bind', 'X', 7);
    const affected = seq.releaseOwner('commitment:does-not-exist');
    expect(affected).toEqual([]);
    expect(seq.get('X')).toBe(7);
  });

  test('a commitment-held bind survives the binder release; the bind value is gone but other claims persist', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', createType('number', [min(0)]));
    seq.mount('bind', 'X', 42);  // owner = bindOwner('anon')
    expect(seq.get('X')).toBe(42);
    // Release the binder. The bind value vacates; the schema constraint
    // (mounted by a different owner) persists.
    seq.releaseOwner(bindOwner(undefined));
    expect(seq.get('X')).toBeUndefined();
    expect(seq.typeAt('X')?.kind).toBe('number');
    expect(seq.typeAt('X')?.constraints.some(c => c.op === 'min')).toBe(true);
  });

  test('owner ids: bindOwner / schemaOwner / commitmentOwner produce distinct namespaces', () => {
    expect(bindOwner('alice')).toBe('bind:alice');
    expect(schemaOwner('alice')).toBe('schema:alice');
    expect(commitmentOwner('c_xyz')).toBe('commitment:c_xyz');
    // Same author, different ops — different owners. Two writes
    // can coexist at the same path.
    expect(bindOwner('alice')).not.toBe(schemaOwner('alice'));
  });
});
