/**
 * cascade-on-narrowing.test.ts — CONSTRAINT_GRAPH.md Artifact 6 R-A6.6.
 *
 * The cascade fires on any narrowing that changes observable state at
 * a path — not just on bind ops. A schema mount that lands a literal
 * constraint surfaces that literal as a value via the read-side
 * unification (Session A); dependents that watch the path must see
 * the change the same way they would see a bind.
 *
 * This is the AC-A6.6 spec assertion — the inverse of the
 * schema-narrowing-cascade-probe tests deleted in Artifact 4 (which
 * documented the prior broken-by-design behavior).
 */

import { Sequence, FT, createType, literal, eq } from '../index';

describe('cascade on narrowing — Artifact 6 R-A6.6', () => {
  test('schema-with-literal fires the same dependents a bind would', () => {
    const seq = new Sequence();
    seq.mount('cap', 'double', (n: number) => n * 2);
    seq.mount('schema', 'B', FT.derived('double', 'A'));
    // Land A's value via SCHEMA mount (with a literal), not bind.
    seq.mount('schema', 'A', createType('number', [literal(7)]));
    // Cascade fires on the schema-narrowing → derived B sees A=7.
    expect(seq.get('B')).toBe(14);
  });

  test('suspended where-clause [eq(X, V)] resumes on schema-with-literal', () => {
    const seq = new Sequence();
    seq.mount('bind', 'gated', 'pending', { where: [eq('X', 'ready')] });
    expect(seq.get('gated')).toBeUndefined();
    // Land X via SCHEMA mount, not bind. The suspended where-clause
    // should re-evaluate and the block should resume.
    seq.mount('schema', 'X', createType('string', [literal('ready')]));
    expect(seq.get('gated')).toBe('pending');
  });

  // Schema-literal vs prior-bind precedence is settled by slot
  // coherence (slot-coherence.test.ts): contradictory narrowings
  // are rejected. The author must remove the conflicting prior
  // state explicitly — neither op silently overrides the other.
});
