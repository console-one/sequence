/**
 * spread-stmt.test.ts — Block-level spread (walker #35).
 *
 * `...expr` at statement position evaluates `expr` at walk time and
 * pastes the resulting string of ft text inline, as if it had been
 * written in place. Typical form: `...expand()` where `expand` is a
 * tool returning a snippet.
 */

import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';

describe('block-level spread — snippet paste (walker #35)', () => {
  test('pastes snippet returned by a tool', () => {
    const seq = new Sequence();
    seq.mount('tool', 'expand', () =>
      'req.foo.status = "open"\nreq.foo.source = "foo"'
    );
    receive(`
      head = "a"
      ...expand()
      tail = "z"
    `, seq);
    expect(seq.get('head')).toBe('a');
    expect(seq.get('tail')).toBe('z');
    expect(seq.get('req.foo.status')).toBe('open');
    expect(seq.get('req.foo.source')).toBe('foo');
  });

  test('tool can read from seq and produce a snippet', () => {
    const seq = new Sequence();
    seq.mount('bind', '_policies.alpha', { trigger: 'x' });
    seq.mount('bind', '_policies.beta', { trigger: 'y' });
    // Tool reads the policies and emits one req per policy.
    seq.mount('tool', 'promoteAll', () => {
      const keys = seq.keys('_policies');
      return keys.map(k => `req.${k}.status = "open"`).join('\n');
    });
    receive('...promoteAll()', seq);
    expect(seq.get('req.alpha.status')).toBe('open');
    expect(seq.get('req.beta.status')).toBe('open');
  });

  test('non-string result is a no-op', () => {
    const seq = new Sequence();
    seq.mount('tool', 'nothing', () => null);
    // Should not throw; just skip.
    expect(() => receive('...nothing()', seq)).not.toThrow();
  });

  test('snippet can reference earlier statements in the same block', () => {
    const seq = new Sequence();
    seq.mount('bind', '_policies.one', { foo: 1 });
    seq.mount('tool', 'expand2', () => 'derived.count = 1');
    receive(`
      above = "before"
      ...expand2()
      below = "after"
    `, seq);
    expect(seq.get('above')).toBe('before');
    expect(seq.get('derived.count')).toBe(1);
    expect(seq.get('below')).toBe('after');
  });
});
