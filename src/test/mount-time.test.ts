/**
 * mount-time.test.ts — time is an input of the transition, not a sample.
 *
 * An explicit BlockOpts.time wins at the outermost mount (replay,
 * cross-kernel receipt); `_rt` reflects it. MountEntry.time makes
 * loadEnv replay time-faithful: a store rebooted from its own entry
 * log keeps history's instants instead of re-stamping at boot.
 */
import { Sequence, loadEnv } from '../index';

describe('explicit block time', () => {
  it('an outermost mount with { time } freezes _rt at that instant', () => {
    const seq = new Sequence(() => 999_999);
    seq.mount('bind', 'x', 1, { time: 12_345 });
    expect(seq.get('_rt')).toBe(12_345);
  });

  it('without { time }, the injected clock stamps as before', () => {
    const seq = new Sequence(() => 777);
    seq.mount('bind', 'x', 1);
    expect(seq.get('_rt')).toBe(777);
  });

  it('a later untimed mount returns _rt to the live clock', () => {
    const seq = new Sequence(() => 500);
    seq.mount('bind', 'x', 1, { time: 100 });
    seq.mount('bind', 'y', 2);
    expect(seq.get('_rt')).toBe(500);
  });
});

describe('time-faithful replay', () => {
  it('loadEnv replays entry.time instead of re-stamping at boot', () => {
    const BOOT = 2_000_000;
    const seq = loadEnv(() => BOOT, {
      entries: [
        { op: 'bind', path: 'a', value: 1, time: 1_000 },
        { op: 'bind', path: 'b', value: 2, time: 1_500 },
      ],
    });
    // The last replayed entry's instant is the store's notion of "now"
    // at the end of replay — history was not re-stamped with BOOT.
    expect(seq.get('_rt')).toBe(1_500);
    expect(seq.get('a')).toBe(1);
    expect(seq.get('b')).toBe(2);
  });

  it('entries without time still replay on the boot clock (back-compat)', () => {
    const BOOT = 2_000_000;
    const seq = loadEnv(() => BOOT, {
      entries: [{ op: 'bind', path: 'a', value: 1 }],
    });
    expect(seq.get('_rt')).toBe(BOOT);
    expect(seq.get('a')).toBe(1);
  });
});
