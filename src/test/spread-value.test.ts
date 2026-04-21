/**
 * spread-value.test.ts — Value-level spread in walker array literals.
 *
 * The walker's toValue used to ignore ArrayElement.spread, so
 * `[a, ...[b, c], d]` emitted `[a, [b, c], d]` (broken). This verifies
 * the fix: spread elements whose value is iterable get inlined.
 *
 * Stage A Task #32. Call and glob spread are handled by #33 / #34 and
 * require a Sequence reference at toValue time.
 */

import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';

describe('value-level array spread (walker #32)', () => {
  test('spreads an inline array literal', () => {
    const seq = new Sequence();
    receive('nums = [1, ...[2, 3], 4]', seq);
    expect(seq.get('nums')).toEqual([1, 2, 3, 4]);
  });

  test('spread at the head of the array', () => {
    const seq = new Sequence();
    receive('head = [...[1, 2], 3]', seq);
    expect(seq.get('head')).toEqual([1, 2, 3]);
  });

  test('spread at the tail of the array', () => {
    const seq = new Sequence();
    receive('tail = [1, ...[2, 3]]', seq);
    expect(seq.get('tail')).toEqual([1, 2, 3]);
  });

  test('multiple spreads in one array', () => {
    const seq = new Sequence();
    receive('multi = [...[1], ...[2, 3], 4, ...[5]]', seq);
    expect(seq.get('multi')).toEqual([1, 2, 3, 4, 5]);
  });

  test('spread of nested arrays does not deep-flatten', () => {
    const seq = new Sequence();
    // One level of flatten only.
    receive('nested = [...[1, [2, 3]], 4]', seq);
    expect(seq.get('nested')).toEqual([1, [2, 3], 4]);
  });

  test('non-spread array literal unchanged', () => {
    const seq = new Sequence();
    receive('plain = [1, 2, 3]', seq);
    expect(seq.get('plain')).toEqual([1, 2, 3]);
  });
});
