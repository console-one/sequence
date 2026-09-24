// temporal-retry-bounded.test.ts — a parked block retried on the temporal
// axis is REPLACED by its retry, never joined by it.
//
// Found 2026-09-24 on a real office: one block parked on a guard that did
// not yet hold, whose watched cell changed every few seconds, took the
// daemon's heap from 70 MB to past 1 GB in three minutes. Each change
// retried every suspended block on the watcher; a retry that suspended
// again was pushed beside the original, which stayed suspended, so the
// next change retried both — 2^n copies after n changes (65,536 after 16).

import { Sequence } from '../sequence';

function suspendedAt(seq: Sequence, path: string): number {
  return (seq.getCell(path)?.blocks ?? []).filter((b) => b.status === 'suspended').length;
}

describe('temporal retry of a parked block', () => {
  test('a block that stays parked keeps ONE suspended copy however often its watched cell changes', () => {
    let now = 1_000;
    const seq = new Sequence(() => now);
    seq.insert({ path: 'gate', value: 0 });
    seq.insert({ path: 'parked.x', value: 1, where: [{ op: 'gt', args: ['gate', 1e12] }] });
    expect(suspendedAt(seq, 'parked.x')).toBe(1);

    for (let i = 1; i <= 12; i++) {
      now += 1_000;
      seq.insert({ path: 'gate', value: i });
    }
    expect(suspendedAt(seq, 'parked.x')).toBe(1);
    // Nothing is kept for a retry that suspended again: the cell holds the
    // one live copy, not a history of failed attempts.
    expect(seq.getCell('parked.x')!.blocks.length).toBe(1);
    expect(seq.get('parked.x')).toBeUndefined();
  });

  test('when the guard finally holds, the block applies once and nothing stays parked', () => {
    let now = 1_000;
    const seq = new Sequence(() => now);
    seq.insert({ path: 'gate', value: 0 });
    seq.insert({ path: 'parked.x', value: 7, where: [{ op: 'gt', args: ['gate', 10] }] });
    for (let i = 1; i <= 10; i++) { now += 1_000; seq.insert({ path: 'gate', value: i }); }
    expect(seq.get('parked.x')).toBeUndefined();
    expect(suspendedAt(seq, 'parked.x')).toBe(1);

    seq.insert({ path: 'gate', value: 11 });
    expect(seq.get('parked.x')).toBe(7);
    expect(suspendedAt(seq, 'parked.x')).toBe(0);
  });

  test('two blocks parked on one cell stay two', () => {
    const seq = new Sequence(() => 1_000);
    seq.insert({ path: 'gate', value: 0 });
    seq.insert({ path: 'parked.x', value: 1, where: [{ op: 'gt', args: ['gate', 1e12] }] });
    seq.insert({ path: 'parked.x', value: 2, where: [{ op: 'gt', args: ['gate', 1e12] }] });
    for (let i = 1; i <= 10; i++) seq.insert({ path: 'gate', value: i });
    expect(suspendedAt(seq, 'parked.x')).toBe(2);
  });
});
