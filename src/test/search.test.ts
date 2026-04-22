/**
 * search.test.ts — Backward search + obligation detection via Sequence API.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { computable, add, mul, pm } from '../type';

describe('obligations — gap detection via Sequence', () => {

  test('schema with no value = obligation', () => {
    const seq = new Sequence();
    seq.append('schema', 'report', FT.object({ content: FT.string() }));
    expect(seq.obligations().length).toBe(1);
    expect(seq.obligations()[0].path).toBe('report');
  });

  test('schema with satisfying value = no obligation', () => {
    const seq = new Sequence();
    seq.append('schema', 'report', FT.object({ content: FT.string() }));
    seq.append('bind', 'report', { content: 'hello' });
    expect(seq.obligations().length).toBe(0);
  });

  test('ref schemas are not obligations', () => {
    const seq = new Sequence();
    seq.append('schema', 'alias', FT.ref('source'));
    expect(seq.obligations().length).toBe(0);
  });

  test('derived schemas are not obligations', () => {
    const seq = new Sequence();
    seq.append('schema', 'y', FT.derived('double', 'x'));
    expect(seq.obligations().length).toBe(0);
  });
});

describe('gaps — obligations with priority', () => {

  test('gaps returns obligations sorted by priority', () => {
    const seq = new Sequence();
    seq.append('schema', 'a', FT.string());
    seq.append('schema', 'b', FT.number());
    const g = seq.gaps();
    expect(g.length).toBe(2);
    // Both should have priority info
    expect(g[0].priority).toBeDefined();
  });

  test('gap with matching tools includes them', () => {
    const seq = new Sequence();
    // Two candidate tools, both producing {status:'done'}. With a
    // single match the kernel would auto-wire the gap into a derived
    // path and it would drop out of gaps() entirely. Multi-match
    // leaves it unwired — resolution belongs to a higher scope
    // handler, and gaps() still surfaces the candidates.
    seq.append('tool', 'processA', () => 'done');
    seq.append('schema', 'processA', FT.fn({
      input: FT.object({ data: FT.string() }),
      output: FT.object({ status: FT.string('done') }),
      preserves: '*',
    }));
    seq.append('tool', 'processB', () => 'done');
    seq.append('schema', 'processB', FT.fn({
      input: FT.object({ data: FT.string() }),
      output: FT.object({ status: FT.string('done') }),
      preserves: '*',
    }));
    seq.append('schema', 'result', FT.object({ status: FT.string('done') }));

    const g = seq.gaps();
    const resultGap = g.find(gap => gap.path === 'result');
    expect(resultGap).toBeDefined();
    expect(resultGap!.tools.length).toBeGreaterThan(0);
  });
});

describe('search — backward planning via Sequence', () => {

  test('single tool satisfies requirement', () => {
    const seq = new Sequence();
    seq.append('bind', 'data', 'raw input');
    seq.append('tool', 'process', (d: string) => ({ status: 'done', content: d }));
    seq.append('schema', 'process', FT.fn({
      input: FT.object({ data: FT.string() }),
      output: FT.object({ status: FT.string('done'), content: FT.string() }),
      preserves: '*',
    }));

    const plan = seq.search(FT.object({ status: FT.string('done'), content: FT.string() }));
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].toolId).toBe('process');
    expect(plan.steps[0].inputReady).toBe(true);
    expect(plan.meetable).toBe(true);
  });

  test('no matching tool → gap in plan', () => {
    const seq = new Sequence();
    const plan = seq.search(FT.object({ exotic: FT.string() }));
    expect(plan.meetable).toBe(false);
    expect(plan.gaps.length).toBe(1);
  });

  test('max depth prevents infinite recursion', () => {
    const seq = new Sequence();
    seq.append('tool', 'loop', (x: any) => x);
    seq.append('schema', 'loop', FT.fn({
      input: FT.object({ x: FT.string() }),
      output: FT.object({ x: FT.string() }),
      preserves: '*',
    }));
    const plan = seq.search(FT.object({ x: FT.string() }), 3);
    expect(plan).toBeDefined(); // terminates
  });
});
