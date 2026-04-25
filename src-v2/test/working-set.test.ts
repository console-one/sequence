/**
 * working-set.test.ts — installWorkingSetRescore: maintain observable
 * working-set state at `_process.workingSet.*` under a `_reader.maxItems`
 * budget. Default heuristic is concreteness × betweenness; custom policy
 * overrides via `_process.evictionPolicy` impl.
 */

import { Sequence } from '../sequence';
import { installWorkingSetRescore } from '../stdlib';

describe('installWorkingSetRescore — default heuristic', () => {
  test('does nothing without a budget set', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.insert({ path: 'state.x', value: 1 });
    s.insert({ path: 'state.y', value: 2 });
    expect(s.get('_process.workingSet.kept')).toBeUndefined();
  });

  test('writes kept/evicted with budget', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    // Set the budget first.
    s.insert({ path: '_reader.maxItems', value: 2 });
    // Mount three paths. Order doesn't matter for the heuristic; the
    // test only verifies that the rule produces kept + evicted state.
    s.insert({ path: 'state.a', value: 1 });
    s.insert({ path: 'state.b', value: 2 });
    s.insert({ path: 'state.c', value: 3 });
    const kept = s.get('_process.workingSet.kept') as { path: string }[];
    const evicted = s.get('_process.workingSet.evicted') as { path: string }[];
    expect(Array.isArray(kept)).toBe(true);
    expect(Array.isArray(evicted)).toBe(true);
    expect(kept.length + evicted.length).toBeGreaterThanOrEqual(3);
    expect(kept.length).toBeLessThanOrEqual(2);
  });

  test('promoted is initialized to empty array', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.insert({ path: '_reader.maxItems', value: 5 });
    s.insert({ path: 'state.x', value: 1 });
    expect(s.get('_process.workingSet.promoted')).toEqual([]);
  });

  test('budget change re-runs the rescore', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.insert({ path: 'state.a', value: 1 });
    s.insert({ path: 'state.b', value: 2 });
    s.insert({ path: '_reader.maxItems', value: 1 });
    const kept1 = s.get('_process.workingSet.kept') as { path: string }[];
    expect(kept1.length).toBe(1);
    s.insert({ path: '_reader.maxItems', value: 5 });
    const kept2 = s.get('_process.workingSet.kept') as { path: string }[];
    expect(kept2.length).toBe(2);
  });

  test('does not include _* paths in scoring', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.insert({ path: '_reader.maxItems', value: 10 });
    s.insert({ path: 'state.public', value: 1 });
    s.insert({ path: '_internal.thing', value: 2 });
    const kept = s.get('_process.workingSet.kept') as { path: string }[];
    expect(kept.some(k => k.path.startsWith('_'))).toBe(false);
  });
});

describe('installWorkingSetRescore — custom policy override', () => {
  test('_process.evictionPolicy impl is consulted when registered', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.impls.set('_process.evictionPolicy', () => ({
      kept: [{ path: 'state.special', score: 999 }],
      evicted: [],
      promoted: [{ path: 'state.fresh' }],
    }));
    s.insert({ path: '_reader.maxItems', value: 3 });
    s.insert({ path: 'state.x', value: 1 });
    expect(s.get('_process.workingSet.kept')).toEqual([
      { path: 'state.special', score: 999 },
    ]);
    expect(s.get('_process.workingSet.promoted')).toEqual([
      { path: 'state.fresh' },
    ]);
  });

  test('failing policy falls through to default heuristic', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.impls.set('_process.evictionPolicy', () => { throw new Error('boom'); });
    s.insert({ path: '_reader.maxItems', value: 3 });
    s.insert({ path: 'state.x', value: 1 });
    // Default heuristic still produced output despite the policy throw.
    const kept = s.get('_process.workingSet.kept') as { path: string }[] | undefined;
    expect(Array.isArray(kept)).toBe(true);
  });
});

describe('installWorkingSetRescore — recursion safety', () => {
  test('writes to _process.workingSet do NOT trigger another rescore', () => {
    const s = new Sequence();
    installWorkingSetRescore(s);
    s.insert({ path: '_reader.maxItems', value: 2 });
    let inserts = 0;
    const orig = s.insert.bind(s);
    s.insert = ((input: any) => {
      if (typeof input?.path === 'string') inserts++;
      return orig(input);
    }) as any;
    s.insert({ path: 'state.a', value: 1 });
    // The cascade should produce a bounded number of inserts (the user's
    // mount + the workingSet outputs). It should not loop unbounded.
    expect(inserts).toBeLessThan(50);
  });
});
