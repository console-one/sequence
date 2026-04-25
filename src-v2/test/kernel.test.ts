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

describe('access rules (Wire 2)', () => {
  test('get() on a valued cell fires access rule with accessKind=hit', () => {
    const s = new Sequence();
    const events: Array<{ path: string; kind: string; val: unknown }> = [];
    s.emitters.set('track', (ctx) => {
      events.push({ path: ctx.delta.path, kind: ctx.delta.accessKind!, val: ctx.delta.next });
      return [];
    });
    s.insert({
      path: '_rules.track',
      rules: [{ id: 'track', phase: 'access', scope: 'x', emit: 'track' }],
    });
    s.insert({ path: 'x', value: 42 });
    expect(s.get('x')).toBe(42);
    expect(events).toEqual([{ path: 'x', kind: 'hit', val: 42 }]);
  });

  test('get() on a type-only cell fires access rule with accessKind=miss', () => {
    const s = new Sequence();
    const events: Array<{ path: string; kind: string }> = [];
    s.emitters.set('track', (ctx) => {
      events.push({ path: ctx.delta.path, kind: ctx.delta.accessKind! });
      return [];
    });
    s.insert({
      path: '_rules.track',
      rules: [{ id: 'track', phase: 'access', scope: 'slot', emit: 'track' }],
    });
    s.insert({ path: 'slot', type: createType('string') });
    expect(s.get('slot')).toBeUndefined();
    expect(events).toEqual([{ path: 'slot', kind: 'miss' }]);
  });

  test('get() on a never-mounted path fires access-miss via glob-watcher', () => {
    const s = new Sequence();
    let miss = 0;
    s.emitters.set('count', (ctx) => {
      if (ctx.delta.accessKind === 'miss') miss++;
      return [];
    });
    s.insert({
      path: '_rules.count',
      rules: [{ id: 'count', phase: 'access', scope: 'nowhere_else', watching: ['any'], emit: 'count' }],
    });
    expect(s.get('any.ghost')).toBeUndefined();
    expect(miss).toBe(1);
  });

  test('contextClass threads through to the access delta', () => {
    const s = new Sequence();
    const ctxs: Array<string | undefined> = [];
    s.emitters.set('capture', (ctx) => {
      ctxs.push(ctx.delta.contextClass);
      return [];
    });
    s.insert({
      path: '_rules.capture',
      rules: [{ id: 'capture', phase: 'access', scope: 'y', emit: 'capture' }],
    });
    s.insert({ path: 'y', value: 1 });
    s.get('y');
    s.get('y', 'render');
    s.get('y', 'plan');
    expect(ctxs).toEqual([undefined, 'render', 'plan']);
  });

  test('access rule emitter can insert follow-up state (posterior update)', () => {
    const s = new Sequence();
    s.emitters.set('bump', (ctx) => [
      { path: `_access.${ctx.delta.path}.count`,
        value: ((s.get(`_access.${ctx.delta.path}.count`) as number) ?? 0) + 1 },
    ]);
    s.insert({
      path: '_rules.bump',
      rules: [{ id: 'bump', phase: 'access', scope: 'z', emit: 'bump' }],
    });
    s.insert({ path: 'z', value: 'hello' });
    s.get('z');
    s.get('z');
    s.get('z');
    expect(s.get('_access.z.count')).toBe(3);
  });

  test('re-entrancy guard: access rule reading another cell does not fire more access events', () => {
    const s = new Sequence();
    let fires = 0;
    s.emitters.set('e', () => {
      fires++;
      s.get('other');  // inside emitter — would loop without the guard
      return [];
    });
    s.insert({
      path: '_rules.e',
      rules: [{ id: 'e', phase: 'access', scope: 'a', emit: 'e' }],
    });
    s.insert({ path: 'a', value: 1 });
    s.insert({ path: 'other', value: 2 });
    s.get('a');
    expect(fires).toBe(1);
  });

  test('access rules do NOT fire on write-delta cascades (only on get)', () => {
    const s = new Sequence();
    let fires = 0;
    s.emitters.set('e', () => { fires++; return []; });
    s.insert({
      path: '_rules.e',
      rules: [{ id: 'e', phase: 'access', scope: 'w', emit: 'e' }],
    });
    s.insert({ path: 'w', value: 'first' });
    s.insert({ path: 'w', value: 'second' });
    expect(fires).toBe(0);  // writes don't trigger access
    s.get('w');
    expect(fires).toBe(1);
  });

  test('observation rules do NOT fire on access events', () => {
    const s = new Sequence();
    let obsFires = 0;
    s.emitters.set('obs', () => { obsFires++; return []; });
    s.insert({
      path: '_rules.obs',
      rules: [{ id: 'obs', phase: 'observation', scope: 'x', emit: 'obs' }],
    });
    s.insert({ path: 'x', value: 'a' });
    const before = obsFires;
    s.get('x');
    s.get('x');
    expect(obsFires).toBe(before);  // no observation rule invocations from reads
  });
});

describe('gap auto-expand on get (Wire 1)', () => {
  test('derived cell declared AFTER source is set: get() auto-computes', () => {
    const s = new Sequence();
    s.impls.set('doubler', (n: number) => n * 2);
    s.insert({ path: 'x', value: 5 });
    s.insert({ path: 'y', type: createType('number', [derived('doubler', 'x')]) });
    // Before Wire 1 this would be undefined (no cascade fired for y).
    expect(s.get('y')).toBe(10);
  });

  test('chain: Z derives from Y derives from X (sources set first)', () => {
    const s = new Sequence();
    s.impls.set('inc', (n: number) => n + 1);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'x', value: 3 });
    s.insert({ path: 'y', type: createType('number', [derived('inc', 'x')]) });
    s.insert({ path: 'z', type: createType('number', [derived('double', 'y')]) });
    // Reading z triggers y's expand (reads x), then z's expand (reads y).
    expect(s.get('z')).toBe(8);  // (3+1)*2
  });

  test('claim slot (type only, no derived constraint) stays undefined on get', () => {
    const s = new Sequence();
    s.insert({ path: 'slot', type: createType('string') });
    expect(s.get('slot')).toBeUndefined();
    // Cell still type-only — no value was invented.
    expect(s.getCell('slot')?.value).toBeUndefined();
    expect(s.getCell('slot')?.type?.kind).toBe('string');
  });

  test('derived cell with missing source returns undefined (no throw)', () => {
    const s = new Sequence();
    s.impls.set('doubler', (n: number) => n * 2);
    s.insert({ path: 'y', type: createType('number', [derived('doubler', 'x')]) });
    // x is never set. y can't materialize. Return undefined, don't throw.
    expect(() => s.get('y')).not.toThrow();
    expect(s.get('y')).toBeUndefined();
  });

  test('self-referential derivation does not infinite-loop on get', () => {
    const s = new Sequence();
    s.impls.set('id', (n: number) => n);
    s.insert({ path: 'x', type: createType('number', [derived('id', 'x')]) });
    // Cycle: x derives from x. Guard must prevent infinite recursion.
    expect(() => s.get('x')).not.toThrow();
    expect(s.get('x')).toBeUndefined();
  });

  test('mutual cycle Y→X→Y does not infinite-loop on get', () => {
    const s = new Sequence();
    s.impls.set('id', (n: number) => n);
    s.insert({ path: 'y', type: createType('number', [derived('id', 'x')]) });
    s.insert({ path: 'x', type: createType('number', [derived('id', 'y')]) });
    expect(() => s.get('y')).not.toThrow();
    expect(s.get('y')).toBeUndefined();
    expect(s.get('x')).toBeUndefined();
  });

  test('auto-expanded value persists: second get is a hit, not another expand', () => {
    const s = new Sequence();
    let calls = 0;
    s.impls.set('countingDoubler', (n: number) => { calls++; return n * 2; });
    s.insert({ path: 'x', value: 7 });
    s.insert({ path: 'y', type: createType('number', [derived('countingDoubler', 'x')]) });
    expect(s.get('y')).toBe(14);
    expect(s.get('y')).toBe(14);
    expect(s.get('y')).toBe(14);
    expect(calls).toBe(1);  // expand ran once; subsequent gets are cached hits
  });

  test('access-miss observation still fires for claim slots with no local producer', () => {
    const s = new Sequence();
    let misses = 0;
    s.emitters.set('m', (ctx) => {
      if (ctx.delta.accessKind === 'miss') misses++;
      return [];
    });
    s.insert({
      path: '_rules.m',
      rules: [{ id: 'm', phase: 'access', scope: 'slot', emit: 'm' }],
    });
    s.insert({ path: 'slot', type: createType('string') });
    s.get('slot');
    expect(misses).toBe(1);
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
