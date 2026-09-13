/**
 * INDEX_SPEC — the driver visits the mounted classes, not every cell.
 *
 * The driver's Case B used to run `for (const c of seq.cells())` on every
 * ordinary insert — a full walk of the fold to find the mounted index_spec
 * classes. Its own comment claimed "O(N_classes) per change"; the code was
 * O(N_cells) per change, so a log replay cost O(rows x cells).
 *
 * These tests hold the comment to the code. The walk is counted through a
 * spy on `seq.cells()` — the only caller in the driver was the walk, so a
 * count of zero after the registry is seeded IS the deletion, observed.
 */
import { Sequence } from '../sequence';
import { installIndexSpec } from '../stdlib/install';
import { captureSnapshot, restoreSnapshot } from '../stdlib/snapshot';
import { createType, indexSpec, bindFrom } from '../../src/type';

/** Three classes over a small source namespace — the shape the office runs:
 *  index classes bind over a few hundred cells while the fold holds many
 *  thousands. Case B's per-class projection is deliberately NOT the subject. */
function mountClasses(s: Sequence, n = 3): void {
  for (let i = 0; i < n; i++) {
    s.insert({
      path: `Class${i}`,
      type: createType('any', [indexSpec({
        indexedBy: ['t'],
        where: [bindFrom('t', 'src.*')],
        body: [{ op: 'bind', path: `out${i}.{t}`, value: i }],
      })]),
    });
  }
}

function fill(s: Sequence, prefix: string, count: number): void {
  for (let i = 0; i < count; i++) s.insert({ path: `${prefix}.c${i}`, value: i });
}

describe('index_spec: the driver iterates the registry, not the fold', () => {
  test('an ordinary insert walks no cells, whatever the size of the fold', () => {
    const s = new Sequence();
    installIndexSpec(s);
    fill(s, 'src', 2);
    mountClasses(s, 3);
    fill(s, 'bulk', 2000);

    // Classes are live: the projection still runs.
    expect(s.get('out0.c0')).toBe(0);
    expect(s.get('out2.c1')).toBe(2);

    const spy = jest.spyOn(s, 'cells');
    for (let i = 0; i < 200; i++) s.insert({ path: `more.c${i}`, value: i });
    // Not 200 walks of 2,000 cells. Not one per insert. None.
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();
  });

  test('the registry tracks classes mounted after the fold is large', () => {
    const s = new Sequence();
    installIndexSpec(s);
    fill(s, 'bulk', 500);
    fill(s, 'src', 3);
    mountClasses(s, 2);

    const spy = jest.spyOn(s, 'cells');
    s.insert({ path: 'src.c3', value: 3 });
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();

    // The new source member projected through both classes.
    expect(s.get('out0.c3')).toBe(0);
    expect(s.get('out1.c3')).toBe(1);
  });

  test('10,000 inserts into a fold of 5,000 cells with 3 classes', () => {
    const s = new Sequence();
    installIndexSpec(s);
    fill(s, 'src', 2);
    mountClasses(s, 3);
    fill(s, 'bulk', 5000);

    const spy = jest.spyOn(s, 'cells');
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) s.insert({ path: `log.e${i}`, value: i });
    const ms = Date.now() - t0;
    const walks = spy.mock.calls.length;
    spy.mockRestore();
    // eslint-disable-next-line no-console
    console.log(`[index_spec] 10,000 inserts / 5,000-cell fold / 3 classes: ${ms} ms, ${walks} walks`);
    expect(ms).toBeLessThan(1000);
  }, 600000);
});

describe('index_spec: restore', () => {
  test('a class restored from a snapshot indexes the next insert without a walk', () => {
    const a = new Sequence();
    installIndexSpec(a);
    a.insert({ path: 'src.x', value: 1 });
    mountClasses(a, 1);
    expect(a.get('out0.x')).toBe(0);
    const snap = captureSnapshot(a);

    const b = new Sequence();
    installIndexSpec(b);
    restoreSnapshot(b, { kind: 'entries', entries: snap });

    const spy = jest.spyOn(b, 'cells');
    b.insert({ path: 'src.y', value: 2 });
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();

    // The restored class projected the new source member.
    expect(b.get('out0.y')).toBe(0);
    expect(b.get('out0.x')).toBe(0);
  });

  test('a class mounted while the driver was not installed is still found', () => {
    // The office turns the driver off for a restore and runs one pass after.
    // A class that landed with no driver listening never passed Case A, so
    // the registry must seed itself once from the fold rather than stay empty.
    const s = new Sequence();
    s.insert({ path: 'src.x', value: 1 });
    mountClasses(s, 1);
    s.insert({ path: 'bulk.c0', value: 0 });
    expect(s.get('out0.x')).toBeUndefined();  // nothing was listening

    installIndexSpec(s);
    const spy = jest.spyOn(s, 'cells');
    s.insert({ path: 'src.y', value: 2 });
    const walks = spy.mock.calls.length;
    spy.mockRestore();

    expect(s.get('out0.x')).toBe(0);
    expect(s.get('out0.y')).toBe(0);
    // At most ONE seeding walk for the life of the instance.
    expect(walks).toBeLessThanOrEqual(1);

    const spy2 = jest.spyOn(s, 'cells');
    s.insert({ path: 'src.z', value: 3 });
    expect(spy2.mock.calls.length).toBe(0);
    spy2.mockRestore();
    expect(s.get('out0.z')).toBe(0);
  });
});
