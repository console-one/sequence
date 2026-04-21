/**
 * glob-value.test.ts — Glob-as-set resolution at value position (walker #34).
 *
 * `foo.*` at value position resolves to the set of child keys at
 * `foo`. Useful for spreading a glob into a concrete array or passing
 * the key set into a function. This closes the third walker hole
 * alongside spread (#32) and call (#33).
 */

import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';

describe('glob-as-set at value position (walker #34)', () => {
  test('bare glob resolves to child keys', () => {
    const seq = new Sequence();
    seq.mount('bind', '_policies.alpha', { trigger: 1 });
    seq.mount('bind', '_policies.beta', { trigger: 2 });
    seq.mount('bind', '_policies.gamma', { trigger: 3 });
    receive('keys = _policies.*', seq);
    const keys = seq.get('keys') as string[];
    expect(keys.sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('spread a glob inside an array literal', () => {
    const seq = new Sequence();
    seq.mount('bind', 'items.a', 1);
    seq.mount('bind', 'items.b', 2);
    receive('all = ["head", ...items.*, "tail"]', seq);
    const arr = seq.get('all') as unknown[];
    expect(arr[0]).toBe('head');
    expect(arr[arr.length - 1]).toBe('tail');
    expect(arr.slice(1, -1).sort()).toEqual(['a', 'b']);
  });

  test('glob + call composition', () => {
    const seq = new Sequence();
    seq.mount('bind', 'users.alice', { role: 'admin' });
    seq.mount('bind', 'users.bob', { role: 'guest' });
    seq.mount('cap', 'count', (arr: unknown[]) => arr.length);
    receive('total = count(users.*)', seq);
    expect(seq.get('total')).toBe(2);
  });

  test('empty glob resolves to empty array', () => {
    const seq = new Sequence();
    receive('none = empty.*', seq);
    expect(seq.get('none')).toEqual([]);
  });
});
