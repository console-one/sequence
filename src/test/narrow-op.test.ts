/**
 * narrow-op.test.ts — CONSTRAINT_GRAPH.md Artifact 6 R-A6.1.
 *
 * Verifies that mount('narrow', path, constraints[]) is the kernel-level
 * write op that bind and schema desugar to. Literal constraints in the
 * narrow list update the bind value; other constraints accumulate as
 * schema-side narrowings on the same node.
 */

import { Sequence } from '../sequence';
import { literal, min } from '../type';

describe('mount(narrow) — Artifact 6 R-A6.1', () => {
  test('narrow with one literal sets bind value', () => {
    const seq = new Sequence();
    const r = seq.mount('narrow', 'X', [literal('hello')]);
    expect(r.ok).toBe(true);
    expect(seq.get('X')).toBe('hello');
  });

  test('narrow with non-literal constraint composes into schema', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', { kind: 'number', constraints: [] });
    seq.mount('narrow', 'X', [min(0)]);
    const t = seq.typeAt('X');
    expect(t).toBeDefined();
    expect(t!.constraints.some(c => c.op === 'min' && c.args[0] === 0)).toBe(true);
  });

  test('narrow with literal AND non-literal updates both slots', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', { kind: 'number', constraints: [] });
    seq.mount('narrow', 'X', [min(0), literal(42)]);
    expect(seq.get('X')).toBe(42);
    const t = seq.typeAt('X');
    expect(t!.constraints.some(c => c.op === 'min')).toBe(true);
  });

  test('narrow preserves prior schema kind when adding constraints', () => {
    const seq = new Sequence();
    seq.mount('schema', 'X', { kind: 'string', constraints: [] });
    seq.mount('narrow', 'X', [literal('hello')]);
    // bind-side now has 'hello'; schema-side preserves kind:'string'
    expect(seq.get('X')).toBe('hello');
    expect(seq.typeAt('X')!.kind).toBe('string');
  });

  test('narrow into a path with no prior schema synthesizes kind:any', () => {
    const seq = new Sequence();
    seq.mount('narrow', 'Y', [min(0)]);
    const t = seq.typeAt('Y');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('any');
    expect(t!.constraints.some(c => c.op === 'min')).toBe(true);
  });
});
