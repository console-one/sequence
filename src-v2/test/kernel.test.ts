/**
 * Kernel tests — exercise the kernel WITHOUT any stdlib features.
 * Proves the single-algorithm substrate works for the lattice axes
 * (structural, temporal, ref) and the generic rule dispatcher.
 *
 * If these pass and stdlib tests pass, the factoring is correct:
 * features are rules + emitters, never kernel code.
 */

import { Sequence } from '../sequence';
import { createType, property, derived } from '../../src/type';

describe('structural', () => {
  test('insert + read value', () => {
    const s = new Sequence();
    s.insert({ path: 'x', value: 42 });
    expect(s.get('x')).toBe(42);
  });

  test('sub-path auto-creates parents', () => {
    const s = new Sequence();
    s.insert({ path: 'a.b.c', value: 'leaf' });
    expect(s.get('a.b.c')).toBe('leaf');
    const paths = s.cells().map(c => c.path);
    expect(paths).toEqual(expect.arrayContaining(['', 'a', 'a.b', 'a.b.c']));
  });

  test('idempotent re-insert = no new delta', () => {
    const s = new Sequence();
    const r1 = s.insert({ path: 'x', value: 1 });
    const r2 = s.insert({ path: 'x', value: 1 });
    expect(r1.changes).toHaveLength(1);
    expect(r2.changes).toHaveLength(0);
  });
});

describe('compose-at-cell', () => {
  test('schema then value; value must typecheck', () => {
    const s = new Sequence();
    s.insert({ path: 'x', type: createType('number') });
    expect(s.insert({ path: 'x', value: 42 }).suspended).toBe(false);
    expect(s.insert({ path: 'x', value: 'nope' }).suspended).toBe(true);
    expect(s.get('x')).toBe(42);
  });

  test('lattice meet composes two object schemas', () => {
    const s = new Sequence();
    s.insert({ path: 'x', type: createType('object', [property('a', createType('number'))]) });
    s.insert({ path: 'x', type: createType('object', [property('b', createType('string'))]) });
    const r = s.insert({ path: 'x', value: { a: 1, b: 'z' } });
    expect(r.suspended).toBe(false);
    expect(s.get('x')).toEqual({ a: 1, b: 'z' });
  });
});

describe('ref axis', () => {
  test('derived recomputes when source changes', () => {
    const s = new Sequence();
    s.impls.set('doubler', (n: number) => n * 2);
    s.insert({ path: 'y', type: createType('number', [derived('doubler', 'x')]) });
    expect(s.get('y')).toBeUndefined();
    s.insert({ path: 'x', value: 5 });
    expect(s.get('y')).toBe(10);
    s.insert({ path: 'x', value: 7 });
    expect(s.get('y')).toBe(14);
  });

  test('chained derivations propagate', () => {
    const s = new Sequence();
    s.impls.set('double', (n: number) => n * 2);
    s.impls.set('inc', (n: number) => n + 1);
    s.insert({ path: 'b', type: createType('number', [derived('double', 'a')]) });
    s.insert({ path: 'c', type: createType('number', [derived('inc', 'b')]) });
    s.insert({ path: 'a', value: 3 });
    expect(s.get('b')).toBe(6);
    expect(s.get('c')).toBe(7);
  });
});

describe('temporal axis', () => {
  test('where-gate suspends; resumes when gate flips', () => {
    const s = new Sequence();
    s.insert({
      path: 'x', value: 'ready',
      where: [{ op: 'eq', args: ['ready_flag', true] }],
    });
    expect(s.get('x')).toBeUndefined();
    s.insert({ path: 'ready_flag', value: true });
    expect(s.get('x')).toBe('ready');
  });

  test('gate that stays false leaves block suspended', () => {
    const s = new Sequence();
    s.insert({
      path: 'x', value: 'ready',
      where: [{ op: 'eq', args: ['ready_flag', true] }],
    });
    s.insert({ path: 'ready_flag', value: false });
    expect(s.get('x')).toBeUndefined();
  });
});

describe('lexical scope', () => {
  test('admission rule at ancestor gates descendant writes', () => {
    const s = new Sequence();
    s.insert({
      path: 'locked',
      rules: [{
        id: 'gate', phase: 'admission', scope: 'locked',
        when: { op: 'eq', args: ['gate_open', true] },
      }],
    });
    expect(s.insert({ path: 'locked.x', value: 1 }).suspended).toBe(true);
    expect(s.get('locked.x')).toBeUndefined();
    s.insert({ path: 'gate_open', value: true });
    expect(s.insert({ path: 'locked.y', value: 2 }).suspended).toBe(false);
    expect(s.get('locked.y')).toBe(2);
  });

  test('rule-only block installs rules with no value/type delta', () => {
    const s = new Sequence();
    const r = s.insert({
      path: 'ignored',
      rules: [{
        id: 'admit_always', phase: 'admission', scope: 'scope',
        when: { op: 'eq', args: [1, 1] },
      }],
    });
    expect(r.suspended).toBe(false);
    const scopeCell = s.cells().find(c => c.path === 'scope');
    expect(scopeCell?.rules).toHaveLength(1);
  });
});

describe('observation rules', () => {
  test('observation rule emits follow-up block', () => {
    const s = new Sequence();
    s.emitters.set('echo_copy', (ctx) => {
      if (ctx.delta.kind !== 'value') return [];
      return [{ path: `echo.${ctx.cell.path}`, value: ctx.delta.next }];
    });
    s.insert({
      path: '_rules.echo',
      rules: [{ id: 'echo', phase: 'observation', scope: 'src', emit: 'echo_copy' }],
    });
    s.insert({ path: 'src.a', value: 1 });
    s.insert({ path: 'src.b', value: 2 });
    expect(s.get('echo.src.a')).toBe(1);
    expect(s.get('echo.src.b')).toBe(2);
  });

  test('rule guard filters which deltas fire the emitter', () => {
    const s = new Sequence();
    s.emitters.set('log', (ctx) => [
      { path: `log.${ctx.delta.path}`, value: ctx.delta.next },
    ]);
    s.insert({
      path: '_rules.log',
      rules: [{
        id: 'log', phase: 'observation', scope: '',
        when: { op: 'pathMatches', args: ['important'] },
        emit: 'log',
      }],
    });
    s.insert({ path: 'important.a', value: 'yes' });
    s.insert({ path: 'other.a', value: 'no' });
    expect(s.get('log.important.a')).toBe('yes');
    expect(s.get('log.other.a')).toBeUndefined();
  });
});

describe('cycle + fixpoint', () => {
  test('self-referential derivation terminates', () => {
    const s = new Sequence();
    s.impls.set('id', (n: number) => n);
    s.insert({ path: 'x', type: createType('number', [derived('id', 'x')]) });
    expect(() => s.insert({ path: 'x', value: 5 })).not.toThrow();
  });

  test('seen-set prevents re-entering a cell within one cascade', () => {
    const s = new Sequence();
    let fires = 0;
    s.emitters.set('count_up', (ctx) => {
      fires++;
      return [{ path: ctx.cell.path, value: ctx.delta.next }];
    });
    s.insert({
      path: '_rules.loop',
      rules: [{ id: 'loop', phase: 'observation', scope: 'c', emit: 'count_up' }],
    });
    s.insert({ path: 'c', value: 1 });
    expect(fires).toBe(1);
  });
});
