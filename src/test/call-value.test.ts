/**
 * call-value.test.ts — CallExpr evaluation at value position (walker #33).
 *
 * Before this fix the walker's toValue had no case for CallExpr, so
 * `x = fn(a, b)` either skipped the bind or stored undefined. Now a
 * call at value position looks up the capability through the Sequence
 * and invokes it synchronously, binding the result.
 */

import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';

describe('CallExpr at value position (walker #33)', () => {
  test('invokes a registered cap and binds the result', () => {
    const seq = new Sequence();
    seq.mount('cap', 'double', (n: number) => n * 2);
    receive('x = double(21)', seq);
    expect(seq.get('x')).toBe(42);
  });

  test('supports multiple arguments', () => {
    const seq = new Sequence();
    seq.mount('cap', 'sum', (a: number, b: number) => a + b);
    receive('y = sum(10, 32)', seq);
    expect(seq.get('y')).toBe(42);
  });

  test('result can be used inside a spread', () => {
    const seq = new Sequence();
    seq.mount('cap', 'range', (n: number) => Array.from({ length: n }, (_, i) => i + 1));
    receive('nums = [0, ...range(3), 99]', seq);
    expect(seq.get('nums')).toEqual([0, 1, 2, 3, 99]);
  });

  test('missing impl yields no bind (gap)', () => {
    const seq = new Sequence();
    receive('z = unknown(1)', seq);
    // No impl → toValue returns undefined → the bind is skipped or
    // stores undefined. Either way `z` should not read back a value.
    expect(seq.get('z')).toBeUndefined();
  });
});
