/**
 * laws.test.ts — pre-mount admission.
 *
 * `law({admission: true, check, reason})` fires on every bind/delete/schema
 * entry whose target is covered by the declaring schema. First failure
 * rejects the whole block.
 */

import { Sequence } from '../sequence';
import { createType, law, eq, and, gt } from '../type';

describe('law enforcement — admission', () => {
  test('admission check passes when author matches session holder', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'only the current session holder may write',
      }),
    ]));

    const result = seq.mount('bind', 'sessions.tick', 1, { author: 'alice' });
    expect(result.ok).toBe(true);
    expect(seq.get('sessions.tick')).toBe(1);
  });

  test('admission check rejects when author does not match holder', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'only the current session holder may write',
      }),
    ]));

    const result = seq.mount('bind', 'sessions.tick', 1, { author: 'bob' });
    expect(result.ok).toBe(false);
    expect(result.gaps?.[0]?.reason).toBe('only the current session holder may write');
    expect(seq.get('sessions.tick')).toBeUndefined();
  });

  test('admission check rejects when author is undefined', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'must sign as holder',
      }),
    ]));

    const result = seq.mount('bind', 'sessions.tick', 1);
    expect(result.ok).toBe(false);
    expect(result.gaps?.[0]?.reason).toBe('must sign as holder');
  });

  test('admission law on per-instance schema', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.s1.holder', 'alice');
    seq.mount('bind', 'sessions.s2.holder', 'bob');
    seq.mount('schema', 'sessions.s1', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.s1.holder'),
        reason: 's1 writes must be by s1 holder',
      }),
    ]));
    seq.mount('schema', 'sessions.s2', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.s2.holder'),
        reason: 's2 writes must be by s2 holder',
      }),
    ]));

    expect(seq.mount('bind', 'sessions.s1.data', 'ok', { author: 'alice' }).ok).toBe(true);
    const r2 = seq.mount('bind', 'sessions.s2.data', 'x', { author: 'alice' });
    expect(r2.ok).toBe(false);
    expect(r2.gaps?.[0]?.reason).toBe('s2 writes must be by s2 holder');
    expect(seq.mount('bind', 'sessions.s2.data', 'ok', { author: 'bob' }).ok).toBe(true);
  });

  test('admission law with and() combines multiple checks', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('bind', 'sessions.heartbeatExpiry', 99999999999999);
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: and(
          eq('$author', 'sessions.holder'),
          gt('sessions.heartbeatExpiry', '$time'),
        ),
        reason: 'holder and live heartbeat required',
      }),
    ]));

    expect(seq.mount('bind', 'sessions.data', 'x', { author: 'alice' }).ok).toBe(true);
  });

  test('admission rejects when heartbeat is stale', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('bind', 'sessions.heartbeatExpiry', 0);
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: and(
          eq('$author', 'sessions.holder'),
          gt('sessions.heartbeatExpiry', '$time'),
        ),
        reason: 'holder and live heartbeat required',
      }),
    ]));

    const stale = seq.mount('bind', 'sessions.data', 'x', { author: 'alice' });
    expect(stale.ok).toBe(false);
    expect(stale.gaps?.[0]?.reason).toBe('holder and live heartbeat required');
  });

  test('admission gates schema mounts (lock-on-range entails lock-on-storage-policy)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'only holder',
      }),
    ]));

    expect(seq.mount('schema', 'sessions.foo', createType('string'), { author: 'bob' }).ok).toBe(false);
    expect(seq.mount('schema', 'sessions.foo', createType('string'), { author: 'alice' }).ok).toBe(true);
    expect(seq.mount('bind', 'sessions.foo', 'x', { author: 'bob' }).ok).toBe(false);
    expect(seq.mount('bind', 'sessions.foo', 'x', { author: 'alice' }).ok).toBe(true);
    expect(seq.mount('cap', 'sessions.foo.compute', () => 'noop', { author: 'bob' }).ok).toBe(true);
  });
});
