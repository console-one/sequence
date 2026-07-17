/**
 * receive-calls-v2.test.ts — the ft call subset executes against v2.
 *
 * Stage 1 of the v1 deletion ledger: text → shared parser → async impl
 * dispatch through seq.impls → result inserted via the ONE operation.
 */

import { Sequence } from '../../src-v2/sequence';
import { receiveCalls } from '../../src-v2/receive-calls';

function officeLike(): Sequence {
  const seq = new Sequence();
  seq.impls.set('ls', async () => [{ id: 't1', title: 'Narratives' }]);
  seq.impls.set('content.get', async (args: { topicID: string; contentID: string }) => {
    if (!args.topicID) throw new Error('topicID required');
    return { topicID: args.topicID, contentID: args.contentID, body: { ok: true } };
  });
  seq.impls.set('sum', async (args: { a: number; b: number }) => args.a + args.b);
  return seq;
}

describe('receiveCalls (v2)', () => {
  test('executes an async call with object args and binds the result', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, 'x = content.get({ topicID: "t1", contentID: "c9" })');
    expect(r.errors).toEqual([]);
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0].fn).toBe('content.get');
    expect(seq.get('x')).toEqual({ topicID: 't1', contentID: 'c9', body: { ok: true } });
  });

  test('dotted fn names resolve through impls (the package tree is real)', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, 'topics = ls({})');
    expect(r.errors).toEqual([]);
    expect(seq.get('topics')).toEqual([{ id: 't1', title: 'Narratives' }]);
  });

  test('later statements read earlier binds by name', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, [
      'a = sum({ a: 20, b: 1 })',
      'b = sum({ a: a, b: a })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('a')).toBe(21);
    expect(seq.get('b')).toBe(42);
  });

  test('impl errors are collected per statement; execution continues', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, [
      'bad = content.get({ contentID: "c9" })',
      'good = sum({ a: 1, b: 2 })',
    ].join('\n'));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('topicID required');
    expect(seq.get('good')).toBe(3);
  });

  test('unknown impl and unsupported statements are typed errors, never silent', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, 'y = nosuch({})');
    expect(r.errors[0]).toContain("no implementation registered at 'nosuch'");
    const r2 = await receiveCalls(seq, 'tool some.path');
    expect(r2.errors[0]).toContain("unsupported statement kind");
  });

  test('plain value assignment works in the same subset', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, 'greeting = "hello"');
    expect(r.errors).toEqual([]);
    expect(seq.get('greeting')).toBe('hello');
  });

  test('DEFINES a command as data: register, call, and it types into the frame', async () => {
    const seq = officeLike();
    const def = await receiveCalls(seq, [
      'twice = (n: number) -> [',
      '  r = sum({ a: n, b: n })',
      ']',
    ].join('\n'));
    expect(def.errors).toEqual([]);
    expect(def.outcomes[0].defined).toBe(true);
    // The definition is callable immediately, through the same dispatch.
    const call = await receiveCalls(seq, 'x = twice({ n: 21 })');
    expect(call.errors).toEqual([]);
    expect(seq.get('x')).toEqual({ r: 42 });
    // And it is a typed name in the environment — it appears in the frame.
    expect(seq.rawTypeAt('twice')?.kind).toBe('fn');
  });

  test('defined fns compose: a definition calling a definition', async () => {
    const seq = officeLike();
    await receiveCalls(seq, 'double = (n: number) -> [ r = sum({ a: n, b: n }) ]');
    await receiveCalls(seq, 'quad = (n: number) -> [ d = double({ n: n }) ]');
    const r = await receiveCalls(seq, 'y = quad({ n: 10 })');
    expect(r.errors).toEqual([]);
    expect(seq.get('y')).toEqual({ d: { r: 20 } });
  });

  test('missing required param is a typed error naming the fn and param', async () => {
    const seq = officeLike();
    await receiveCalls(seq, 'twice = (n: number) -> [ r = sum({ a: n, b: n }) ]');
    const r = await receiveCalls(seq, 'x = twice({})');
    expect(r.errors[0]).toContain("twice: param 'n' is required");
  });
});
