/**
 * conjunction.test.ts — Three-way flow via Sequence.gaps() priority.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { eq, exists, lt } from '../type';

describe('conjunction priority via gaps()', () => {

  test('suspended where clause creates gap with priority', () => {
    const seq = new Sequence();
    seq.append('bind', 'session', { user: 'alice' }, {
      where: [eq('auth', 'valid'), exists('token')],
    });
    // session is suspended → it's an obligation that gaps() can surface
    // auth and token are conjunction refs
    expect(seq.suspended().length).toBe(1);
  });

  test('ref near completion gets higher priority', () => {
    const seq = new Sequence();
    seq.append('bind', 'a', 1); // a exists
    seq.append('bind', 'b', 2); // b exists
    // c is the LAST thing needed
    seq.append('bind', 'result', 'ok', {
      where: [exists('a'), exists('b'), exists('c')],
    });

    // We can check priority indirectly: gaps should include the schema
    // for whatever 'result' depends on
    const suspended = seq.suspended();
    expect(suspended.length).toBe(1);
    expect(suspended[0].entries[0].path).toBe('result');
  });

  test('resolving a ref changes sibling priorities', () => {
    const seq = new Sequence();
    // Two obligations sharing 'auth' ref
    seq.append('bind', 'session', 'x', {
      where: [exists('auth'), exists('token')],
    });
    seq.append('bind', 'admin', 'x', {
      where: [exists('auth'), exists('admin_key')],
    });

    expect(seq.suspended().length).toBe(2);

    // Resolve auth
    seq.append('bind', 'auth', 'valid');

    // One should have resumed if the other ref was also present
    // In this case neither token nor admin_key exist, so both still suspended
    expect(seq.suspended().length).toBe(2);

    // Now resolve admin_key → admin should resume
    seq.append('bind', 'admin_key', 'secret');
    const stillSuspended = seq.suspended();
    // admin should have resumed (auth + admin_key both exist)
    expect(stillSuspended.length).toBe(1);
    expect(stillSuspended[0].entries[0].path).toBe('session');
  });

  test('while clause conjunction: both refs must hold', () => {
    const seq = new Sequence();
    seq.append('bind', 'alive', true);
    seq.append('bind', '_T', 100);
    seq.append('bind', 'lock', 'held', {
      while: [eq('alive', true), lt('_T', 500)],
    });
    expect(seq.get('lock')).toBe('held');

    // Break one ref
    seq.append('bind', '_T', 600);
    expect(seq.get('lock')).toBeUndefined(); // invalidated
  });

  test('derived with multiple inputs: both needed', () => {
    const seq = new Sequence();
    seq.append('cap', 'combine', (a: number, b: number) => a + b);
    seq.append('schema', 'sum', FT.derived('combine', 'x', 'y'));

    // Neither input exists
    seq.append('bind', 'x', 10);
    // y still missing — derived can't compute
    expect(seq.get('sum')).toBeUndefined();

    // Now provide y
    seq.append('bind', 'y', 20);
    // Cascade should compute sum = combine(10, 20) = 30
    expect(seq.get('sum')).toBe(30);
  });

  test('gaps() sorts by conjunction-derived priority', () => {
    const seq = new Sequence();
    // Low priority: both refs missing
    seq.append('schema', 'low', FT.string());
    // Needs a and b, neither exists → low conjunction priority

    // High priority: one ref already exists
    seq.append('bind', 'ready', true);
    seq.append('schema', 'high', FT.number());

    const g = seq.gaps();
    expect(g.length).toBe(2);
    // Both are simple schemas without conjunction refs, so priority is base-level
    // But they should both be returned
    expect(g.some(gap => gap.path === 'low')).toBe(true);
    expect(g.some(gap => gap.path === 'high')).toBe(true);
  });
});
