/**
 * scheduler.test.ts — The caller drives: while(gaps) { fill(next) }.
 * No separate scheduler — the Sequence cascades, gaps() reports what's left.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';

describe('caller-driven execution loop', () => {

  test('no gaps → nothing to do', () => {
    const seq = new Sequence();
    seq.append('bind', 'status', 'done');
    seq.append('schema', 'status', FT.string());
    expect(seq.gaps().length).toBe(0);
  });

  test('gap appears when schema has no satisfying value', () => {
    const seq = new Sequence();
    seq.append('schema', 'report', FT.object({ content: FT.string() }));
    expect(seq.gaps().length).toBe(1);
    expect(seq.gaps()[0].path).toBe('report');
  });

  test('filling a gap removes it', () => {
    const seq = new Sequence();
    seq.append('schema', 'report', FT.object({ content: FT.string() }));
    expect(seq.gaps().length).toBe(1);

    seq.append('bind', 'report', { content: 'hello' });
    expect(seq.gaps().length).toBe(0);
  });

  test('tell with capability: cascade fills derived gaps', () => {
    const seq = new Sequence();
    seq.append('cap', 'double', (n: number) => n * 2);
    seq.append('bind', 'x', 5);
    seq.append('schema', 'y', FT.derived('double', 'x'));

    // Cascade should have computed y
    const fn = seq.capabilityAt('double')!;
    seq.append('bind', 'y', fn(5));
    expect(seq.get('y')).toBe(10);
  });

  test('full loop: gaps → fill → gaps → fill → done', () => {
    const seq = new Sequence();
    seq.append('schema', 'a', FT.string());
    seq.append('schema', 'b', FT.number());

    expect(seq.gaps().length).toBe(2);

    seq.append('bind', 'a', 'hello');
    expect(seq.gaps().length).toBe(1);

    seq.append('bind', 'b', 42);
    expect(seq.gaps().length).toBe(0);
  });

  test('search finds capability chain', () => {
    const seq = new Sequence();
    seq.append('bind', 'data', 'raw');
    seq.append('cap', 'process', () => ({ status: 'done' }));
    seq.append('schema', 'process', FT.fn({
      input: FT.object({ data: FT.string() }),
      output: FT.object({ status: FT.string('done') }),
      preserves: '*',
    }));

    const plan = seq.search(FT.object({ status: FT.string('done') }));
    expect(plan.meetable).toBe(true);
    expect(plan.steps[0].inputReady).toBe(true);
  });

  test('gaps include matching capabilities', () => {
    const seq = new Sequence();
    seq.append('cap', 'generate', () => ({ content: 'report' }));
    seq.append('schema', 'generate', FT.fn({
      input: FT.any(),
      output: FT.object({ content: FT.string() }),
    }));
    seq.append('schema', 'report', FT.object({ content: FT.string() }));

    const g = seq.gaps();
    const reportGap = g.find(gap => gap.path === 'report');
    expect(reportGap).toBeDefined();
    expect(reportGap!.capabilities).toContain('generate');
  });
});
