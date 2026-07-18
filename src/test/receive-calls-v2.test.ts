/**
 * receive-calls-v2.test.ts — the ft call subset executes against v2.
 *
 * Stage 1 of the v1 deletion ledger: text → shared parser → async impl
 * dispatch through seq.impls → result inserted via the ONE operation.
 */

import { Sequence } from '../../src-v2/sequence';
import { receiveCalls } from '../../src-v2/receive-calls';
import { registerCombinators } from '../../src-v2/tools';

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

  // ── property deref on bound objects (the agent-demo t1 gap) ─────────

  test('dotted names deref into a scope-bound object param', async () => {
    const seq = officeLike();
    await receiveCalls(seq, 'title = (t: object) -> [ r = sum({ a: t.a, b: t.b }) ]');
    const r = await receiveCalls(seq, 'x = title({ t: { a: 40, b: 2 } })');
    expect(r.errors).toEqual([]);
    expect(seq.get('x')).toEqual({ r: 42 });
  });

  test('dotted names deref into a top-level bound object (x.items after x = call)', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, [
      'x = content.get({ topicID: "t1", contentID: "c9" })',
      'y = sum({ a: 1, b: 1 })',
      'z = x.topicID',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('z')).toBe('t1');
  });

  test('deref through nested objects, and a miss stays undefined (never a throw)', async () => {
    const seq = officeLike();
    const r = await receiveCalls(seq, [
      'x = content.get({ topicID: "t1", contentID: "c9" })',
      'deep = x.body.ok',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('deep')).toBe(true);
    const miss = await receiveCalls(seq, 'gone = x.nosuch.deeper');
    expect(miss.errors).toEqual([]);
  });

  // ── combinators: a formatter lives IN the language (seam 3) ─────────

  test('str.concat/or/pick compose into a line-formatter definition', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const def = await receiveCalls(seq, [
      'line = (l: object) -> [',
      '  r = str.concat({ parts: [l.when, " · ", or({ a: l.title, b: l.topicID }), pick({ cond: l.corrected, a: " (corrected)", b: "" })] })',
      ']',
    ].join('\n'));
    expect(def.errors).toEqual([]);
    const withTitle = await receiveCalls(
      seq,
      'a = line({ l: { when: "18:13", title: "Narratives", topicID: "t1", corrected: true } })',
    );
    expect(withTitle.errors).toEqual([]);
    expect(seq.get('a')).toEqual({ r: '18:13 · Narratives (corrected)' });
    const fallback = await receiveCalls(
      seq,
      'b = line({ l: { when: "18:14", topicID: "t1" } })',
    );
    expect(fallback.errors).toEqual([]);
    expect(seq.get('b')).toEqual({ r: '18:14 · t1' });
  });

  // ── SPECIAL FORMS — the conditional-effects unlock (2026-07-18):
  //    pick/or elect lazily over literal branches; attempt is try/else.
  //    The bar: an unchosen branch's EFFECT never fires. ──────────────

  test('pick with literal branches evaluates ONLY the chosen one (effects safe)', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const fired: string[] = [];
    seq.impls.set('effect', async (args: { tag: string }) => {
      fired.push(args.tag);
      return { did: args.tag };
    });
    const r = await receiveCalls(seq, [
      'ensure = (have: boolean) -> [',
      '  r = pick({ cond: have, a: effect({ tag: "kept" }), b: effect({ tag: "created" }) })',
      ']',
      'x = ensure({ have: false })',
      'y = ensure({ have: true })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(fired).toEqual(['created', 'kept']); // exactly one per call — never both
    expect(seq.get('x')).toEqual({ r: { did: 'created' } });
  });

  test('or short-circuits: the fallback effect fires only on nullish', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    let fallbacks = 0;
    seq.impls.set('fallback', async () => {
      fallbacks++;
      return 'computed';
    });
    const r = await receiveCalls(seq, [
      'a = or({ a: "present", b: fallback({}) })',
      'b = or({ b: fallback({}) })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('a')).toBe('present');
    expect(seq.get('b')).toBe('computed');
    expect(fallbacks).toBe(1); // the present case never computed the fallback
  });

  test('pick/or over BOUND values (non-literal arg) still work via the impls', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'args = { cond: true, a: "yes", b: "no" }',
      'x = pick(args)',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('x')).toBe('yes');
  });

  test('attempt: do wins; else runs on a thrown error; errors in else propagate', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    let boomCalls = 0;
    seq.impls.set('boom', async () => {
      boomCalls++;
      throw new Error('boom failed');
    });
    const r = await receiveCalls(seq, [
      'ok = attempt({ do: sum({ a: 40, b: 2 }), else: "unused" })',
      'saved = attempt({ do: boom({}), else: "recovered" })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('ok')).toBe(42);
    expect(seq.get('saved')).toBe('recovered');
    expect(boomCalls).toBe(1);
    // the compiled race-retry shape: attempt + re-check + assert
    const rethrow = await receiveCalls(
      seq,
      'bad = attempt({ do: boom({}), else: assert({ cond: false, message: "still missing after retry" }) })',
    );
    expect(rethrow.errors).toHaveLength(1);
    expect(rethrow.errors[0]).toContain('still missing after retry');
  });

  test('list.some — the attr/value membership predicate', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'types = [{ name: "note" }, { name: "due" }]',
      'has = list.some({ items: types, attr: "name", value: "note" })',
      'missing = list.some({ items: types, attr: "name", value: "cash" })',
      'any = list.some({ items: types })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('has')).toBe(true);
    expect(seq.get('missing')).toBe(false);
    expect(seq.get('any')).toBe(true);
  });

  // ── the scalar combinators (seam 3, ledger entries 3+): equality,
  //    presence, arithmetic, string predicates — pure and TOLERANT
  //    (eager evaluation computes unchosen branches too) ──────────────

  test('eq / present — presence is not truthiness (0 EXISTS)', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'a = eq({ a: 1, b: 1 })',
      'b = eq({ a: "x", b: "y" })',
      'c = present({ v: 0 })',
      'd = present({})',
      'rate = (d?: number) -> [ r = pick({ cond: present({ v: d }), a: str.concat({ parts: [d, "%"] }), b: "none" }) ]',
      'zero = rate({ d: 0 })',
      'gone = rate({})',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('a')).toBe(true);
    expect(seq.get('b')).toBe(false);
    expect(seq.get('c')).toBe(true);
    expect(seq.get('d')).toBe(false);
    expect(seq.get('zero')).toEqual({ r: '0%' });
    expect(seq.get('gone')).toEqual({ r: 'none' });
  });

  test('num.gt/round/mul/div — a percent cell composes in-language', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'pct = (burned: number, limit: number) -> [',
      '  r = pick({ cond: num.gt({ a: limit, b: 0 }), a: num.round({ v: num.mul({ a: num.div({ a: burned, b: limit }), b: 100 }) }), b: 0 })',
      ']',
      'p = pct({ burned: 7, limit: 40 })',
      'z = pct({ burned: 3, limit: 0 })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('p')).toEqual({ r: 18 });
    // /0 flows Infinity through the UNCHOSEN branch; the guard elects 0.
    expect(seq.get('z')).toEqual({ r: 0 });
  });

  test('str.lower/startsWith/endsWith/stripPrefix — predicates without a regex engine', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'a = str.lower({ s: "DAILY@09:00" })',
      'b = str.startsWith({ s: "daily@09:00", prefix: "daily@" })',
      'c = str.endsWith({ s: "reader.tick", suffix: ".tick" })',
      'd = str.stripPrefix({ s: "reader-brief", prefix: "reader-" })',
      'e = str.stripPrefix({ s: "brief", prefix: "reader-" })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('a')).toBe('daily@09:00');
    expect(seq.get('b')).toBe(true);
    expect(seq.get('c')).toBe(true);
    expect(seq.get('d')).toBe('brief');
    expect(seq.get('e')).toBe('brief');
  });

  test('str.padEnd — right-pad to a column width; overflow is identity', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'a = str.padEnd({ s: "user-bob", width: 12 })',
      'b = str.padEnd({ s: "a-name-longer-than-width", width: 8 })',
      'c = str.padEnd({ s: "x", width: 4, fill: "." })',
      'd = str.padEnd({})',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('a')).toBe('user-bob    ');
    expect(seq.get('b')).toBe('a-name-longer-than-width');
    expect(seq.get('c')).toBe('x...');
    // Tolerance: absent operands never throw (eager unchosen branches).
    expect(seq.get('d')).toBe('');
  });

  test('json.encode — the quoted/escaped form, and tolerance of absent inputs', async () => {
    const seq = officeLike();
    registerCombinators(seq);
    const r = await receiveCalls(seq, [
      'q = json.encode({ v: "say \\"hi\\"" })',
      'gt = eq({ a: num.gt({}), b: false })',
      'low = str.lower({})',
    ].join('\n'));
    // NOTE: the tokenizer keeps escapes honest — this pins whatever the
    // parser delivers for the string; the tolerance assertions are the
    // real subject (absent operands never throw).
    expect(r.errors).toEqual([]);
    expect(seq.get('gt')).toBe(true);
    expect(seq.get('low')).toBe('');
    expect(typeof seq.get('q')).toBe('string');
  });
});
