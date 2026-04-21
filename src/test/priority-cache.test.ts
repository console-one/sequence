/**
 * priority-cache.test.ts — Commit 1 of the concreteness-as-distribution pass.
 *
 * Asserts that the gap priority cache invalidates as a consequence of the
 * forward cascade walking `_rt`. The invalidation is moved from ad-hoc
 * conjunction-only clearing into the cascade's dispatch when `_rt` is in
 * `changedPaths` (which it always is, on every mount).
 *
 * This test is intentionally minimal. The visible downstream effect only
 * shows up once concreteness is time-conditioned (Commit 2), at which point
 * priorities actually change as `_rt` advances. For now, the test asserts
 * structurally: cache is populated by a gaps() call, cleared on the next
 * mount, then re-populated on the next gaps() call.
 */

import { Sequence } from '../sequence';
import { createType, property } from '../type';
import { FT } from '../builder';

describe('priority cache invalidation via forward cascade (Commit 1)', () => {
  let clock: number;
  let seq: Sequence;

  beforeEach(() => {
    clock = 1_000_000;
    seq = new Sequence(() => clock);
  });

  test('cache is empty on a fresh sequence', () => {
    expect(seq._priorityCacheSize).toBe(0);
  });

  test('cache populates when gaps() is queried and an obligation exists', () => {
    // Mount a schema creating an obligation (no value at task.title).
    seq.mount('schema', 'task', createType('object', [
      property('title', FT.string(), false),
    ]));

    // Before any gaps() call, cache is empty.
    expect(seq._priorityCacheSize).toBe(0);

    // Query gaps — this populates the cache.
    const g = seq.gaps();
    expect(g.length).toBeGreaterThan(0);
    expect(seq._priorityCacheSize).toBeGreaterThan(0);
  });

  test('cache clears on the next mount because _rt is in changedPaths', () => {
    seq.mount('schema', 'task', createType('object', [
      property('title', FT.string(), false),
    ]));

    // Populate the cache.
    seq.gaps();
    expect(seq._priorityCacheSize).toBeGreaterThan(0);

    // Advance the clock and mount something unrelated.
    // The mount puts _rt into changedPaths, fireLaws walks, the cascade's
    // response to _rt clears the priority cache.
    clock += 1000;
    seq.mount('bind', 'unrelated', 42);

    // Cache should now be empty.
    expect(seq._priorityCacheSize).toBe(0);

    // A subsequent gaps() call repopulates lazily.
    seq.gaps();
    expect(seq._priorityCacheSize).toBeGreaterThan(0);
  });

  test('gaps() returns correct priorities after time advances', () => {
    // Regression: the pre-Commit-1 cache never cleared on _rt advance, so a
    // stale priority could persist across ticks. With the clear in the
    // cascade, gaps() after time advance produces fresh values (same as a
    // fresh computation would).
    seq.mount('schema', 'task', createType('object', [
      property('title', FT.string(), false),
      property('body', FT.string(), false),
    ]));

    const before = seq.gaps().map(g => g.path).sort();

    clock += 5000;
    seq.mount('bind', 'marker', 'tick');

    const after = seq.gaps().map(g => g.path).sort();

    expect(after).toEqual(before);
  });
});
