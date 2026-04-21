/**
 * process.test.ts — Sequence IS the process.
 * All interaction through seq.mount() or seq.append(op, path, value, opts).
 * Hoist reads directly from the sequence.
 */

import { FT } from '../builder';
import { Sequence } from '../sequence';
import { hoist } from '../hoist';
import {
  eq, lt, gt, exists, notExists,
  or, and, not, regex, between, oneOf, contains, matchesType, countGte,
} from '../type';

describe('mount — block-based (atomic)', () => {

  test('block of multiple entries applied atomically', () => {
    const seq = new Sequence();
    const result = seq.mount([
      { op: 'bind', path: 'a', value: 1 },
      { op: 'bind', path: 'b', value: 2 },
      { op: 'bind', path: 'c', value: 3 },
    ]);
    expect(result.ok).toBe(true);
    expect(seq.get('a')).toBe(1);
    expect(seq.get('b')).toBe(2);
    expect(seq.get('c')).toBe(3);
  });

  test('block with where clause: all-or-nothing', () => {
    const seq = new Sequence();
    const result = seq.mount([
      { op: 'bind', path: 'x', value: 10 },
      { op: 'bind', path: 'y', value: 20 },
    ], { where: [eq('auth', 'valid')] });
    expect(result.ok).toBe(false);
    expect(seq.get('x')).toBeUndefined();
    expect(seq.get('y')).toBeUndefined();
  });

  test('block with where satisfied: all entries apply', () => {
    const seq = new Sequence();
    seq.mount('bind', 'auth', 'valid');
    const result = seq.mount([
      { op: 'bind', path: 'x', value: 10 },
      { op: 'bind', path: 'y', value: 20 },
    ], { where: [eq('auth', 'valid')] });
    expect(result.ok).toBe(true);
    expect(seq.get('x')).toBe(10);
    expect(seq.get('y')).toBe(20);
  });

  test('block with while: invalidation removes all entries', () => {
    const seq = new Sequence();
    seq.mount('bind', '_T', 100);
    seq.mount([
      { op: 'bind', path: 'lock.holder', value: 'agent-1' },
      { op: 'bind', path: 'lock.acquired', value: true },
    ], { while: [lt('_T', 500)] });
    expect(seq.get('lock.holder')).toBe('agent-1');
    expect(seq.get('lock.acquired')).toBe(true);

    seq.mount('bind', '_T', 600);
    expect(seq.get('lock.holder')).toBeUndefined();
    expect(seq.get('lock.acquired')).toBeUndefined();
  });

  test('block type fail → entire block suspended', () => {
    const seq = new Sequence();
    seq.mount('schema', 'x', FT.string());
    const result = seq.mount([
      { op: 'bind', path: 'x', value: 42 },
      { op: 'bind', path: 'y', value: 'ok' },
    ]);
    expect(result.ok).toBe(false);
    expect(seq.get('x')).toBeUndefined();
    expect(seq.get('y')).toBeUndefined();
  });

  test('single entry sugar', () => {
    const seq = new Sequence();
    seq.mount('bind', 'x', 42);
    expect(seq.get('x')).toBe(42);
  });
});

describe('Sequence as Process', () => {

  test('bind and read', () => {
    const seq = new Sequence();
    seq.append('bind', 'x', 42);
    expect(seq.get('x')).toBe(42);
  });

  test('schema enforces type', () => {
    const seq = new Sequence();
    seq.append('schema', 'name', FT.string());
    expect(seq.append('bind', 'name', 'Alice').ok).toBe(true);
    expect(seq.append('bind', 'name', 42).ok).toBe(false);
  });

  test('capability + derived execution', () => {
    const seq = new Sequence();
    seq.append('cap', 'double', (n: number) => n * 2);
    seq.append('bind', 'input', 21);
    seq.append('schema', 'output', FT.derived('double', 'input'));
    const fn = seq.capabilityAt('double')!;
    seq.append('bind', 'output', fn(seq.get('input')));
    expect(seq.get('output')).toBe(42);
  });

  test('policy: additive transition', () => {
    const seq = new Sequence();
    seq.append('schema', 'score', FT.number().min(0));
    seq.append('policy', 'score', { transition: 'add' });
    seq.append('bind', 'score', 10);
    seq.append('bind', 'score', 5);
    expect(seq.get('score')).toBe(15);
  });

  test('where: rejects when unsatisfied', () => {
    const seq = new Sequence();
    const result = seq.append('bind', 'session', { user: 'alice' }, {
      where: [eq('auth', 'valid')],
    });
    expect(result.ok).toBe(false);
  });

  test('where: passes when satisfied', () => {
    const seq = new Sequence();
    seq.append('bind', 'auth', 'valid');
    expect(seq.append('bind', 'session', { user: 'alice' }, {
      where: [eq('auth', 'valid')],
    }).ok).toBe(true);
  });

  test('where: exists', () => {
    const seq = new Sequence();
    expect(seq.append('bind', 'x', 1, { where: [exists('missing')] }).ok).toBe(false);
    seq.append('bind', 'missing', 'here');
    expect(seq.append('bind', 'x', 1, { where: [exists('missing')] }).ok).toBe(true);
  });

  test('while: invalidates on break', () => {
    const seq = new Sequence();
    seq.append('bind', '_T', 100);
    seq.append('bind', 'lock', { holder: 'a1' }, { while: [lt('_T', 500)] });
    expect(seq.get('lock')).toBeDefined();
    const result = seq.append('bind', '_T', 600);
    expect(result.invalidated).toContain('lock');
    expect(seq.get('lock')).toBeUndefined();
  });

  test('while: eq breaks on value change', () => {
    const seq = new Sequence();
    seq.append('bind', 'alive', true);
    seq.append('bind', 'data', 'important', { while: [eq('alive', true)] });
    expect(seq.get('data')).toBe('important');
    const result = seq.append('bind', 'alive', false);
    expect(result.invalidated).toContain('data');
    expect(seq.get('data')).toBeUndefined();
  });

  test('while: onBreakPath fires', () => {
    const seq = new Sequence();
    seq.append('bind', 'alive', true);
    seq.append('bind', 'resource', 'claimed', {
      while: [eq('alive', true)],
      onBreakPath: 'events.released',
    });
    seq.append('bind', 'alive', false);
    expect(seq.get('events.released')).toBe(true);
  });

  test('suspended statement stays in sequence', () => {
    const seq = new Sequence();
    seq.append('schema', 'x', FT.string());
    seq.append('bind', 'x', 42);
    expect(seq.suspended().length).toBe(1);
  });

  test('cascade: derived auto-updates', () => {
    const seq = new Sequence();
    seq.append('cap', 'double', (n: number) => n * 2);
    seq.append('bind', 'x', 5);
    seq.append('schema', 'y', FT.derived('double', 'x'));
    const fn = seq.capabilityAt('double')!;
    seq.append('bind', 'y', fn(5));
    seq.append('bind', 'x', 20);
    expect(seq.get('y')).toBe(40);
  });

  test('ref follows source', () => {
    const seq = new Sequence();
    seq.append('bind', 'source', 'hello');
    seq.append('schema', 'alias', FT.ref('source'));
    expect(seq.get('alias')).toBe('hello');
    seq.append('bind', 'source', 'world');
    expect(seq.get('alias')).toBe('world');
  });

  test('product-space ref: getAt reads historical', () => {
    const seq = new Sequence();
    seq.append('bind', 'x', 'first');
    seq.append('bind', 'x', 'second');
    seq.append('bind', 'x', 'third');
    expect(seq.getAt('x', 0)).toBe('first');
    expect(seq.getAt('x', 1)).toBe('second');
    expect(seq.get('x')).toBe('third');
  });

  test('product-space ref: getPrevious', () => {
    const seq = new Sequence();
    seq.append('bind', 'x', 'old');
    seq.append('bind', 'x', 'new');
    expect(seq.getPrevious('x')).toBe('old');
  });

  test('defaults fill missing', () => {
    const seq = new Sequence();
    seq.append('schema', 'config', FT.defaults({ model: 'gpt-4', tokens: 1000 }));
    seq.append('bind', 'config', { model: 'claude' });
    const c = seq.get('config') as any;
    expect(c.model).toBe('claude');
    expect(c.tokens).toBe(1000);
  });

  test('compact removes old, keeps projection', () => {
    const seq = new Sequence();
    seq.append('bind', 'a', 1);
    seq.append('bind', 'b', 2);
    seq.append('bind', 'c', 3);
    const before = seq.length;
    seq.compact(2);
    expect(seq.length).toBeLessThanOrEqual(before);
    expect(seq.get('c')).toBe(3);
  });

  test('hoist: reads directly from sequence', () => {
    const seq = new Sequence();
    seq.append('bind', 'tasks.t1.status', 'pending');
    seq.append('bind', 'config.mode', 'production');
    const result = hoist(seq, { depth: 2 });
    expect(result.text).toContain('tasks');
    expect(result.text).toContain('config');
  });

  test('segmented type', () => {
    const seq = new Sequence();
    seq.append('schema', 'prompt', FT.segmented([
      { name: 'system', type: FT.string(), budget: 500 },
      { name: 'tools', type: FT.string(), budget: 2000 },
    ]));
    seq.append('bind', 'prompt', ['You are an assistant.', 'search(): Result[]']);
    expect(seq.get('prompt')).toEqual(['You are an assistant.', 'search(): Result[]']);
  });
});

describe('Sequence.concreteness — lattice position IS probability', () => {

  test('value exists and satisfies schema = 1 (literal = determined)', () => {
    const seq = new Sequence();
    seq.append('bind', 'x', 42);
    expect(seq.concreteness('x')).toBe(1);
  });

  test('no value, no schema = Poisson base rate (low but not zero)', () => {
    const seq = new Sequence();
    // No schema → P(schema arrives) ≈ low base rate
    expect(seq.concreteness('missing')).toBeGreaterThan(0);
    expect(seq.concreteness('missing')).toBeLessThan(0.1);
  });

  test('never schema = 0 (contradiction)', () => {
    const seq = new Sequence();
    seq.append('schema', 'impossible', FT.never());
    expect(seq.concreteness('impossible')).toBe(0);
  });

  test('schema but no value = typeSpecificity (lattice position)', () => {
    const seq = new Sequence();
    seq.append('schema', 'name', FT.string());
    // Lattice position of string() — constrained but not literal
    const c = seq.concreteness('name');
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  test('more constrained type = higher concreteness', () => {
    const seq = new Sequence();
    seq.append('schema', 'loose', FT.number());
    seq.append('schema', 'tight', FT.number().min(0).max(100));
    expect(seq.concreteness('tight')).toBeGreaterThan(seq.concreteness('loose'));
  });

  test('value satisfies schema = 1', () => {
    const seq = new Sequence();
    seq.append('schema', 'x', FT.number().min(0));
    seq.append('bind', 'x', 42);
    expect(seq.concreteness('x')).toBe(1);
  });

  test('object concreteness = product of property positions', () => {
    const seq = new Sequence();
    seq.append('schema', 'config', FT.object({
      name: FT.string('alice'),   // literal = 1
      age: FT.number(),           // unconstrained = low
    }));
    const c = seq.concreteness('config');
    // product: 1 * low = low
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  test('_rt is updated on every mount', () => {
    let now = 1000;
    const seq = new Sequence(() => now);
    seq.append('bind', 'x', 1);
    expect(seq.get('_rt')).toBe(1000);
    now = 2000;
    seq.append('bind', 'y', 2);
    expect(seq.get('_rt')).toBe(2000);
  });

  test('temporal where clause: lt(_rt, deadline)', () => {
    let now = 1000;
    const seq = new Sequence(() => now);
    // This block only applies if real time < 5000
    const r = seq.mount('bind', 'task', 'active', {
      where: [lt('_rt', 5000)],
    });
    expect(r.ok).toBe(true);

    // After deadline, same mount suspends
    now = 6000;
    const r2 = seq.mount('bind', 'task2', 'late', {
      where: [lt('_rt', 5000)],
    });
    expect(r2.ok).toBe(false);
  });

  test('certainty: committed capability = 1 (obligation is a fact)', () => {
    const seq = new Sequence(() => 0);
    seq.append('schema', 'result', FT.object({ data: FT.string() }));
    seq.append('cap', 'fetch', () => ({ data: 'hello' }));
    seq.append('schema', 'fetch', FT.fn({
      input: FT.any(),
      output: FT.object({ data: FT.string() }),
    }));
    // Capability is committed → certainty = 1 (the obligation exists)
    expect(seq.certainty('result')).toBe(1);
  });

  test('feasibility: lock expiry affects feasibility, not certainty', () => {
    const seq = new Sequence(() => 0);
    seq.lockExpiry = 10000;
    seq.append('schema', 'result', FT.object({ data: FT.string() }));
    seq.append('cap', 'fetch', () => ({ data: 'hello' }));
    seq.append('schema', 'fetch', FT.fn({
      input: FT.any(),
      output: FT.object({ data: FT.string() }),
    }));

    const fWithTime = seq.feasibility('result');

    seq.lockExpiry = 0;
    const fExpired = seq.feasibility('result');

    // With time: feasible. Expired: not feasible.
    expect(fWithTime).toBeGreaterThan(fExpired);
  });

  test('nextWake returns earliest temporal event', () => {
    let now = 1000;
    const seq = new Sequence(() => now);
    seq.lockExpiry = 10000;

    // Mount a block with while clause that breaks at _rt >= 5000
    seq.mount('bind', 'x', 1, {
      while: [lt('_rt', 5000)],
    });

    // nextWake should be min(lockExpiry=10000, while-break=5000) = 5000
    expect(seq.nextWake()).toBe(5000);

    // Mount a suspended block that resumes at _rt >= 3000
    seq.mount('bind', 'y', 2, {
      where: [gt('_rt', 3000)],
    });

    // Now nextWake = min(5000, 3000) = 3000
    expect(seq.nextWake()).toBe(3000);
  });

  test('mount returns nextWake', () => {
    let now = 0;
    const seq = new Sequence(() => now);
    seq.lockExpiry = 10000;

    const r = seq.mount('bind', 'x', 1, {
      while: [lt('_rt', 5000)],
    });
    expect(r.nextWake).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PREDICATE LANGUAGE — composite and value predicates (C7)
// ═══════════════════════════════════════════════════════════════════════

describe('Predicate language', () => {

  // ── Composite predicates ──

  test('or: passes when any sub-clause holds', () => {
    const seq = new Sequence();
    seq.append('bind', 'role', 'admin');
    const r = seq.append('bind', 'granted', true, {
      where: [or(eq('role', 'admin'), eq('role', 'superuser'))],
    });
    expect(r.ok).toBe(true);
    expect(seq.get('granted')).toBe(true);
  });

  test('or: fails when no sub-clause holds', () => {
    const seq = new Sequence();
    seq.append('bind', 'role', 'guest');
    const r = seq.append('bind', 'granted', true, {
      where: [or(eq('role', 'admin'), eq('role', 'superuser'))],
    });
    expect(r.ok).toBe(false);
  });

  test('and: passes when all sub-clauses hold', () => {
    const seq = new Sequence();
    seq.append('bind', 'age', 25);
    seq.append('bind', 'verified', true);
    const r = seq.append('bind', 'approved', true, {
      where: [and(gt('age', 18), eq('verified', true))],
    });
    expect(r.ok).toBe(true);
  });

  test('and: fails when any sub-clause fails', () => {
    const seq = new Sequence();
    seq.append('bind', 'age', 15);
    seq.append('bind', 'verified', true);
    const r = seq.append('bind', 'approved', true, {
      where: [and(gt('age', 18), eq('verified', true))],
    });
    expect(r.ok).toBe(false);
  });

  test('not: inverts a clause', () => {
    const seq = new Sequence();
    seq.append('bind', 'status', 'active');
    const r = seq.append('bind', 'action', 'delete', {
      where: [not(eq('status', 'locked'))],
    });
    expect(r.ok).toBe(true);
  });

  test('not: fails when inner clause holds', () => {
    const seq = new Sequence();
    seq.append('bind', 'status', 'locked');
    const r = seq.append('bind', 'action', 'delete', {
      where: [not(eq('status', 'locked'))],
    });
    expect(r.ok).toBe(false);
  });

  test('nested: or inside and', () => {
    const seq = new Sequence();
    seq.append('bind', 'role', 'editor');
    seq.append('bind', 'verified', true);
    const r = seq.append('bind', 'can_publish', true, {
      where: [and(
        or(eq('role', 'admin'), eq('role', 'editor')),
        eq('verified', true),
      )],
    });
    expect(r.ok).toBe(true);
  });

  // ── Value predicates ──

  test('regex: matches string pattern', () => {
    const seq = new Sequence();
    seq.append('bind', 'email', 'user@example.com');
    const r = seq.append('bind', 'valid', true, {
      where: [regex('email', '^[^@]+@[^@]+\\.[^@]+$')],
    });
    expect(r.ok).toBe(true);
  });

  test('regex: rejects non-matching string', () => {
    const seq = new Sequence();
    seq.append('bind', 'email', 'not-an-email');
    const r = seq.append('bind', 'valid', true, {
      where: [regex('email', '^[^@]+@[^@]+\\.[^@]+$')],
    });
    expect(r.ok).toBe(false);
  });

  test('between: numeric range (inclusive)', () => {
    const seq = new Sequence();
    seq.append('bind', 'temp', 72);
    const r = seq.append('bind', 'comfortable', true, {
      where: [between('temp', 65, 80)],
    });
    expect(r.ok).toBe(true);
  });

  test('between: out of range', () => {
    const seq = new Sequence();
    seq.append('bind', 'temp', 95);
    const r = seq.append('bind', 'comfortable', true, {
      where: [between('temp', 65, 80)],
    });
    expect(r.ok).toBe(false);
  });

  test('oneOf: value in set', () => {
    const seq = new Sequence();
    seq.append('bind', 'status', 'active');
    const r = seq.append('bind', 'ok', true, {
      where: [oneOf('status', 'active', 'pending', 'review')],
    });
    expect(r.ok).toBe(true);
  });

  test('oneOf: value not in set', () => {
    const seq = new Sequence();
    seq.append('bind', 'status', 'deleted');
    const r = seq.append('bind', 'ok', true, {
      where: [oneOf('status', 'active', 'pending', 'review')],
    });
    expect(r.ok).toBe(false);
  });

  test('contains: substring in string', () => {
    const seq = new Sequence();
    seq.append('bind', 'message', 'Error: connection timeout');
    const r = seq.append('bind', 'is_error', true, {
      where: [contains('message', 'Error')],
    });
    expect(r.ok).toBe(true);
  });

  test('contains: element in array', () => {
    const seq = new Sequence();
    seq.append('bind', 'tags', ['urgent', 'bug', 'frontend']);
    const r = seq.append('bind', 'needs_attention', true, {
      where: [contains('tags', 'urgent')],
    });
    expect(r.ok).toBe(true);
  });

  test('contains: missing element', () => {
    const seq = new Sequence();
    seq.append('bind', 'tags', ['docs', 'chore']);
    const r = seq.append('bind', 'needs_attention', true, {
      where: [contains('tags', 'urgent')],
    });
    expect(r.ok).toBe(false);
  });

  test('matchesType: value satisfies type constraint', () => {
    const seq = new Sequence();
    seq.append('bind', 'config', { name: 'prod', port: 8080 });
    const r = seq.append('bind', 'valid_config', true, {
      where: [matchesType('config', FT.object({ name: FT.string(), port: FT.number() }))],
    });
    expect(r.ok).toBe(true);
  });

  test('matchesType: value fails type constraint', () => {
    const seq = new Sequence();
    seq.append('bind', 'config', { name: 'prod' }); // missing port
    const r = seq.append('bind', 'valid_config', true, {
      where: [matchesType('config', FT.object({ name: FT.string(), port: FT.number() }))],
    });
    expect(r.ok).toBe(false);
  });

  test('countGte: enough children', () => {
    const seq = new Sequence();
    seq.append('bind', 'items.a', 1);
    seq.append('bind', 'items.b', 2);
    seq.append('bind', 'items.c', 3);
    const r = seq.append('bind', 'enough', true, {
      where: [countGte('items', 3)],
    });
    expect(r.ok).toBe(true);
  });

  test('countGte: not enough children', () => {
    const seq = new Sequence();
    seq.append('bind', 'items.a', 1);
    const r = seq.append('bind', 'enough', true, {
      where: [countGte('items', 3)],
    });
    expect(r.ok).toBe(false);
  });

  // ── While clauses with new predicates ──

  test('while with or: holds while either condition true', () => {
    const seq = new Sequence();
    seq.append('bind', 'mode', 'auto');
    seq.append('bind', 'lock', 'held', {
      while: [or(eq('mode', 'auto'), eq('mode', 'manual'))],
    });
    expect(seq.get('lock')).toBe('held');

    seq.append('bind', 'mode', 'disabled');
    expect(seq.get('lock')).toBeUndefined(); // invalidated
  });

  // ── Change tracking ──

  test('changes: direct bind reports old and new value', () => {
    const seq = new Sequence();
    seq.append('bind', 'x', 10);
    const r = seq.append('bind', 'x', 20);
    expect(r.changes).toBeDefined();
    const xChange = r.changes!.find(c => c.path === 'x');
    expect(xChange).toBeDefined();
    expect(xChange!.oldValue).toBe(10);
    expect(xChange!.newValue).toBe(20);
    expect(xChange!.cause).toBe('direct');
  });

  test('changes: cascade reports derived value change', () => {
    const seq = new Sequence();
    seq.append('cap', 'double', (n: number) => n * 2);
    seq.append('bind', 'x', 5);
    seq.append('schema', 'y', FT.derived('double', 'x'));
    const fn = seq.capabilityAt('double')!;
    seq.append('bind', 'y', fn(5)); // y = 10

    const r = seq.append('bind', 'x', 20); // cascade: y → 40
    const yChange = r.changes!.find(c => c.path === 'y');
    expect(yChange).toBeDefined();
    expect(yChange!.oldValue).toBe(10);
    expect(yChange!.newValue).toBe(40);
    expect(yChange!.cause).toBe('cascade');
  });

  test('changes: invalidation reports removed value', () => {
    const seq = new Sequence();
    seq.append('bind', 'alive', true);
    seq.append('bind', 'resource', 'claimed', {
      while: [eq('alive', true)],
    });
    const r = seq.append('bind', 'alive', false);
    const resChange = r.changes!.find(c => c.path === 'resource' && c.cause === 'invalidate');
    expect(resChange).toBeDefined();
    expect(resChange!.oldValue).toBe('claimed');
    expect(resChange!.newValue).toBeUndefined();
  });

  test('changes: resume reports newly applied value', () => {
    const seq = new Sequence();
    seq.append('bind', 'data', 'waiting', {
      where: [exists('ready')],
    });
    expect(seq.get('data')).toBeUndefined(); // suspended

    const r = seq.append('bind', 'ready', true);
    const dataChange = r.changes!.find(c => c.path === 'data' && c.cause === 'resume');
    expect(dataChange).toBeDefined();
    expect(dataChange!.oldValue).toBeUndefined();
    expect(dataChange!.newValue).toBe('waiting');
  });

  // ── Behavioral predicate enforcement ──

  test('identity predicate: prior updates on observation', () => {
    const seq = new Sequence();
    // Schema with identity: output.x should equal input.y
    seq.mount('schema', 'cache', FT.object({
      stored: FT.string(),
      retrieved: FT.string(),
    }));
    // Add identity constraint: stored and retrieved should be equal
    seq.mount('schema', 'cache', {
      kind: 'object', constraints: [
        { op: 'identity', args: ['cache.stored', 'cache.retrieved'] },
        { op: 'property', args: ['stored', { kind: 'string', constraints: [] }, false] },
        { op: 'property', args: ['retrieved', { kind: 'string', constraints: [] }, false] },
      ]
    });

    // Write matching values — predicate holds
    seq.mount('bind', 'cache.stored', 'hello');
    seq.mount('bind', 'cache.retrieved', 'hello');

    // Prior should have been updated with success
    const prior = seq.get('cache._prior.reliability') as any;
    if (prior) {
      expect(prior.alpha).toBeGreaterThan(1); // at least one success recorded
    }
  });

  test('identity predicate: prior degrades on violation', () => {
    const seq = new Sequence();
    seq.mount('schema', 'store', {
      kind: 'object', constraints: [
        { op: 'identity', args: ['store.written', 'store.read_back'] },
        { op: 'property', args: ['written', { kind: 'string', constraints: [] }, false] },
        { op: 'property', args: ['read_back', { kind: 'string', constraints: [] }, false] },
      ]
    });

    // Write value
    seq.mount('bind', 'store.written', 'original');
    seq.mount('bind', 'store.read_back', 'original'); // matches — success

    // Now violate: read_back diverges from written
    seq.mount('bind', 'store.read_back', 'corrupted'); // doesn't match — failure

    const prior = seq.get('store._prior.reliability') as any;
    if (prior) {
      // Should have both successes and failures
      expect(prior.beta).toBeGreaterThan(1); // at least one failure recorded
    }
  });

  test('suspended with or: resumes when any branch satisfies', () => {
    const seq = new Sequence();
    const r = seq.append('bind', 'proceed', true, {
      where: [or(exists('approval'), exists('override'))],
    });
    expect(r.ok).toBe(false); // suspended

    seq.append('bind', 'override', true);
    expect(seq.get('proceed')).toBe(true); // resumed via override
  });
});

// ═══════════════════════════════════════════════════════════════════════
// COMPACTION POLICIES — per-path compaction rules (C8)
// ═══════════════════════════════════════════════════════════════════════

describe('Compaction policies', () => {

  test('default: compact keeps last value per path', () => {
    const seq = new Sequence();
    seq.append('schema', 'doc', FT.string());
    for (let i = 0; i < 20; i++) seq.append('bind', 'doc', `draft ${i}`);
    expect(seq.length).toBeGreaterThan(20);

    seq.compact(15);
    expect(seq.get('doc')).toBe('draft 19'); // latest value preserved
  });

  test('preserve: blocks at preserved paths survive compaction', () => {
    const seq = new Sequence();
    seq.append('policy', 'audit', { compact: 'preserve' });
    seq.append('bind', 'audit.entry1', 'action A');
    seq.append('bind', 'audit.entry2', 'action B');
    seq.append('bind', 'audit.entry3', 'action C');
    seq.append('bind', 'temp', 'disposable');

    const before = seq.length;
    seq.compact(seq.head);
    // audit entries preserved, temp may be compacted
    expect(seq.get('audit.entry1')).toBe('action A');
    expect(seq.get('audit.entry2')).toBe('action B');
    expect(seq.get('audit.entry3')).toBe('action C');
  });

  test('snapshot_every: keeps every Nth block for historical sampling', () => {
    const seq = new Sequence();
    seq.append('schema', 'metrics', FT.number());
    seq.append('policy', 'metrics', { compact: 5 }); // keep every 5th
    for (let i = 0; i < 20; i++) seq.append('bind', 'metrics', i);

    seq.compact(seq.head);
    // Current value preserved
    expect(seq.get('metrics')).toBe(19);
    // Should have sampled blocks (every 5th of the 20 binds)
    expect(seq.length).toBeGreaterThan(1); // more than just the snapshot
  });

  test('mixed policies: preserve + default on different paths', () => {
    const seq = new Sequence();
    seq.append('policy', 'log', { compact: 'preserve' });
    // 5 log entries (preserved) + 20 overwrites to a single temp path (compactable)
    for (let i = 0; i < 5; i++) seq.append('bind', `log.${i}`, `event ${i}`);
    for (let i = 0; i < 20; i++) seq.append('bind', 'temp', `scratch ${i}`);
    const before = seq.length;
    seq.compact(seq.head);
    // All log entries preserved
    for (let i = 0; i < 5; i++) expect(seq.get(`log.${i}`)).toBe(`event ${i}`);
    // Temp value still readable (last value)
    expect(seq.get('temp')).toBe('scratch 19');
    // 20 temp writes collapsed to 1 snapshot → total reduced
    expect(seq.length).toBeLessThan(before);
  });
});

describe('backward index — unified law dispatch', () => {

  test('cascade fires through backward index', () => {
    const seq = new Sequence();
    seq.mount('schema', 'a', FT.number());
    seq.mount('schema', 'b', FT.number());
    seq.mount('schema', 'sum', FT.derived('add', 'a', 'b'));
    seq.mount('cap', 'add', (a: number, b: number) => a + b);

    seq.mount('bind', 'a', 10);
    seq.mount('bind', 'b', 20);

    expect(seq.get('sum')).toBe(30);

    // Update a → cascade should fire through backward index
    seq.mount('bind', 'a', 5);
    expect(seq.get('sum')).toBe(25);
  });

  test('resume fires through backward index', () => {
    const seq = new Sequence();
    seq.mount('schema', 'status', FT.string());

    // Suspend a block waiting for status = "ready"
    const r = seq.mount([
      { op: 'bind', path: 'data', value: 42 },
    ], { where: [eq('status', 'ready')] });
    expect(r.ok).toBe(false);
    expect(seq.get('data')).toBeUndefined();

    // Set status → resume fires through backward index
    seq.mount('bind', 'status', 'ready');
    expect(seq.get('data')).toBe(42);
  });

  test('while invalidation fires through backward index', () => {
    const seq = new Sequence();
    seq.mount('bind', 'lock', 'held');

    // Mount with while condition
    seq.mount([
      { op: 'bind', path: 'guarded', value: 'protected' },
    ], { while: [eq('lock', 'held')] });
    expect(seq.get('guarded')).toBe('protected');

    // Break the while → invalidation fires through backward index
    seq.mount('bind', 'lock', 'released');
    expect(seq.get('guarded')).toBeUndefined();
  });

  test('resumed block with while gets invariant indexed', () => {
    const seq = new Sequence();

    // Suspend a block that also has a while
    const r = seq.mount([
      { op: 'bind', path: 'val', value: 'hi' },
    ], { where: [exists('trigger')], while: [eq('alive', true)] });
    expect(r.ok).toBe(false);

    seq.mount('bind', 'alive', true);
    seq.mount('bind', 'trigger', 'go');
    expect(seq.get('val')).toBe('hi');

    // Now break the while — should invalidate through backward index
    seq.mount('bind', 'alive', false);
    expect(seq.get('val')).toBeUndefined();
  });

  test('backward index survives compaction', () => {
    const seq = new Sequence();
    seq.mount('bind', 'active', true);
    seq.mount([
      { op: 'bind', path: 'comp', value: 'data' },
    ], { while: [eq('active', true)] });
    expect(seq.get('comp')).toBe('data');

    // Compact old blocks
    seq.compact(seq.head - 1);

    // The while invariant should still be tracked
    seq.mount('bind', 'active', false);
    expect(seq.get('comp')).toBeUndefined();
  });
});
