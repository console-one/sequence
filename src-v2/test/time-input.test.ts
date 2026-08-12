/**
 * time-input.test.ts — v2: time is an input of the transition.
 *
 * InsertInput.time carries the instant a fact became true on the
 * AUTHOR's clock (replay, cross-kernel receipt). Absent, the kernel's
 * injected clock stamps as before.
 */
import { Sequence } from '../sequence';

describe('InsertInput.time', () => {
  it('an explicit time lands on the block verbatim', () => {
    const seq = new Sequence(() => 999_999);
    const r = seq.insert({ path: 'x', value: 1, time: 42 });
    expect(r.block.time).toBe(42);
  });

  it('absent time falls back to the injected clock', () => {
    const seq = new Sequence(() => 777);
    const r = seq.insert({ path: 'x', value: 1 });
    expect(r.block.time).toBe(777);
  });

  it('replaying blocks with their original times preserves history', () => {
    const src = new Sequence(() => 1_000);
    const a = src.insert({ path: 'a', value: 1 });
    const b = src.insert({ path: 'b', value: 2 });

    const replica = new Sequence(() => 9_999_999);
    for (const blk of [a.block, b.block]) {
      const r = replica.insert({
        path: blk.coord.path,
        value: blk.value,
        time: blk.time,
        author: blk.author,
      });
      expect(r.block.time).toBe(blk.time);
    }
    expect(replica.get('a')).toBe(1);
    expect(replica.get('b')).toBe(2);
  });
});
