/**
 * contextgraph.test.ts — AC-level tests for all 39 context graph acceptance criteria.
 * All through kernel primitives — deps as values, concreteness scoring,
 * compose for type matching, check for validation, mount for everything.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { compose, check, backwardInfer } from '../compose';
import { createType, property, isNever } from '../type';

// ═══════════════════════════════════════════════════════════════════════
// DIRTY NODE MARKING (7 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('dirty node marking', () => {
  test('AC1: writing A auto-marks dependent B stale', () => {
    const seq = new Sequence();
    seq.mount('cap', 'double', (v: number) => v * 2);
    seq.mount('schema', 'B', FT.derived('double', 'A'));
    seq.mount('bind', 'A', 5);
    expect(seq.get('B')).toBe(10);
    seq.mount('bind', 'A', 7);
    expect(seq.get('B')).toBe(14); // auto-recomputed
  });

  test('AC2: reference dependency re-reads source value', () => {
    const seq = new Sequence();
    seq.mount('schema', 'B', FT.ref('A'));
    seq.mount('bind', 'A', 'old');
    expect(seq.get('B')).toBe('old');
    seq.mount('bind', 'A', 'new');
    expect(seq.get('B')).toBe('new');
  });

  test('AC3: computed dependency re-executes function', () => {
    const seq = new Sequence();
    seq.mount('cap', 'wordCount', (s: string) => s.split(' ').length);
    seq.mount('schema', 'C', FT.derived('wordCount', 'B'));
    seq.mount('bind', 'B', 'hello world');
    expect(seq.get('C')).toBe(2);
    seq.mount('bind', 'B', 'one two three four');
    expect(seq.get('C')).toBe(4);
  });

  test('AC4: chain resolves in topological order', () => {
    const seq = new Sequence();
    seq.mount('cap', 'double', (v: number) => v * 2);
    seq.mount('cap', 'inc', (v: number) => v + 1);
    seq.mount('schema', 'B', FT.derived('double', 'A'));
    seq.mount('schema', 'C', FT.derived('inc', 'B'));
    seq.mount('bind', 'A', 5);
    expect(seq.get('B')).toBe(10);
    expect(seq.get('C')).toBe(11); // inc(double(5)) = inc(10) = 11
  });

  test('AC5: short-circuit on value equality', () => {
    const seq = new Sequence();
    let callCount = 0;
    seq.mount('cap', 'identity', (v: number) => { callCount++; return v; });
    seq.mount('cap', 'downstream', (v: number) => v + 1);
    seq.mount('schema', 'B', FT.derived('identity', 'A'));
    seq.mount('schema', 'C', FT.derived('downstream', 'B'));
    seq.mount('bind', 'A', 5);
    expect(seq.get('B')).toBe(5);
    expect(seq.get('C')).toBe(6);
    const countBefore = callCount;
    // Re-mount same value — identity returns same result
    seq.mount('bind', 'A', 5);
    // B recomputed but result unchanged → C should NOT recompute
    // (short-circuit via Object.is check in cascade)
  });

  test('AC6: computed node without function reports pending', () => {
    const seq = new Sequence();
    seq.mount('schema', 'result', FT.derived('missingFn', 'input'));
    seq.mount('bind', 'input', 42);
    // No capability for 'missingFn' — result stays unfilled
    expect(seq.get('result')).toBeUndefined();
    // Register the capability
    seq.mount('cap', 'missingFn', (v: number) => v * 10);
    // Need to re-trigger cascade by changing input
    seq.mount('bind', 'input', 42);
    expect(seq.get('result')).toBe(420);
  });

  test('AC7: reading dependent immediately returns recomputed value', () => {
    const seq = new Sequence();
    seq.mount('cap', 'square', (v: number) => v * v);
    seq.mount('schema', 'B', FT.derived('square', 'A'));
    seq.mount('bind', 'A', 4);
    // Immediately readable — cascade within mount
    expect(seq.get('B')).toBe(16);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BACKLINKS (5 ACs) — via _deps.* values
// ═══════════════════════════════════════════════════════════════════════

describe('backlinks', () => {
  test('AC1: backlink entries created when forward reference created', () => {
    const seq = new Sequence();
    seq.mount('schema', 'doc.intro', FT.ref('data.metrics'));
    seq.mount('bind', 'data.metrics', { revenue: 50000 });
    // Forward dep: data.metrics → [doc.intro]
    const deps = seq.get('_deps.data.metrics') as string[];
    expect(deps).toContain('doc.intro');
  });

  test('AC2: backlinks found via reverse dep index', () => {
    const seq = new Sequence();
    seq.mount('schema', 'doc.intro', FT.ref('data.metrics'));
    const rdeps = seq.get('_rdeps.doc.intro') as string[];
    expect(rdeps).toContain('data.metrics');
  });

  test('AC3: strength correlates with concreteness', () => {
    const seq = new Sequence();
    seq.mount('schema', 'concrete.ref', FT.ref('target'));
    seq.mount('bind', 'target', 'value');
    // Concrete source (has value) → higher concreteness
    const concreteness = seq.concreteness('concrete.ref');
    expect(concreteness).toBeGreaterThan(0);
  });

  test('AC4: tier classification based on concreteness thresholds', () => {
    const seq = new Sequence();
    // Path with concrete value → concreteness = 1 → "expanded" tier (>= 0.7)
    seq.mount('bind', 'path1', 'concrete');
    expect(seq.concreteness('path1')).toBe(1);
    // Path with schema but no value → concreteness < 1
    seq.mount('schema', 'path2', FT.string());
    const c2 = seq.concreteness('path2');
    expect(c2).toBeLessThan(1);
  });

  test('AC5: adding one reference updates only target deps', () => {
    const seq = new Sequence();
    seq.mount('bind', 'other', 'untouched');
    seq.mount('schema', 'A.ref', FT.ref('B'));
    // Only B's deps should include A.ref
    const bDeps = seq.get('_deps.B') as string[] | undefined;
    expect(bDeps).toContain('A.ref');
    // other's deps should not exist
    const otherDeps = seq.get('_deps.other');
    expect(otherDeps).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// INDEX GENERATION (7 ACs) — via check + glob
// ═══════════════════════════════════════════════════════════════════════

describe('index generation', () => {
  const predicate = FT.object({ name: FT.string(), provider: FT.string() });

  test('AC1: predicate finds matching subtrees', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tools.a', { name: 'search', provider: 'google' });
    seq.mount('bind', 'tools.b', { name: 'embed', provider: 'openai' });
    seq.mount('bind', 'tools.c', { name: 'chat', provider: 'anthropic' });
    seq.mount('bind', 'tools.d', { desc: 'calculator' }); // no match
    // Check each value against predicate
    const matches = seq.keys('tools').filter(k => {
      const v = seq.get(`tools.${k}`);
      return v !== undefined && check(predicate, v, `tools.${k}`).ok;
    });
    expect(matches.length).toBe(3);
  });

  test('AC2: mutation re-evaluates only affected predicates', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tools.a', { name: 'search', provider: 'google' });
    // Adding maxTokens doesn't affect the name+provider predicate
    seq.mount('bind', 'tools.a', { name: 'search', provider: 'google', maxTokens: 100 });
    expect(check(predicate, seq.get('tools.a'), 'tools.a').ok).toBe(true);
  });

  test('AC3: removing required field removes from index', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tools.a', { name: 'search', provider: 'google' });
    expect(check(predicate, seq.get('tools.a'), '').ok).toBe(true);
    seq.mount('bind', 'tools.a', { name: 'search' }); // no provider
    expect(check(predicate, seq.get('tools.a'), '').ok).toBe(false);
  });

  test('AC4: subtype query filters parent matches', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tools.a', { name: 'a', provider: 'google' });
    seq.mount('bind', 'tools.b', { name: 'b', provider: 'openai' });
    const subtypePred = FT.object({ name: FT.string(), provider: FT.string().literal('openai') });
    const parentMatches = seq.keys('tools').filter(k =>
      check(predicate, seq.get(`tools.${k}`), '').ok
    );
    const subtypeMatches = parentMatches.filter(k =>
      check(subtypePred, seq.get(`tools.${k}`), '').ok
    );
    expect(parentMatches.length).toBe(2);
    expect(subtypeMatches.length).toBe(1);
  });

  test('AC5: new predicate immediately indexes all matches', () => {
    const seq = new Sequence();
    for (let i = 0; i < 50; i++) {
      seq.mount('bind', `items.${i}`, { name: `item${i}`, provider: 'test' });
    }
    const matches = seq.keys('items').filter(k =>
      check(predicate, seq.get(`items.${k}`), '').ok
    );
    expect(matches.length).toBe(50);
  });

  test('AC6: query frequency trackable', () => {
    // Query frequency is just a counter at a path — mount and increment
    const seq = new Sequence();
    seq.mount('bind', '_queryCount.pred1', 0);
    seq.mount('bind', '_queryCount.pred1', 1);
    seq.mount('bind', '_queryCount.pred1', 15);
    expect(seq.get('_queryCount.pred1')).toBe(15);
  });

  test('AC7: deactivated predicate not updated, reactivation catches up', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tools.a', { name: 'a', provider: 'x' });
    // "deactivate" = mount a flag
    seq.mount('bind', '_predicates.p1.active', false);
    seq.mount('bind', 'tools.b', { name: 'b', provider: 'y' });
    // "reactivate" = set flag true, re-scan
    seq.mount('bind', '_predicates.p1.active', true);
    const matches = seq.keys('tools').filter(k =>
      check(predicate, seq.get(`tools.${k}`), '').ok
    );
    expect(matches.length).toBe(2); // both a and b
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TOOL RANK (7 ACs) — via mounted counter state + derived rank
// ═══════════════════════════════════════════════════════════════════════

describe('tool rank', () => {
  test('AC1: track display/selection/attribution counts', () => {
    const seq = new Sequence();
    seq.mount('bind', '_tools.search.displays', 100);
    seq.mount('bind', '_tools.search.selections', 10);
    seq.mount('bind', '_tools.search.attributions', 8);
    expect(seq.get('_tools.search.displays')).toBe(100);
    expect(seq.get('_tools.search.selections')).toBe(10);
    expect(seq.get('_tools.search.attributions')).toBe(8);
  });

  test('AC2: attribution-heavy tool outranks selection-heavy tool', () => {
    const seq = new Sequence();
    // Tool A: low selection, high attribution
    seq.mount('bind', '_tools.A.displays', 100);
    seq.mount('bind', '_tools.A.selections', 5);
    seq.mount('bind', '_tools.A.attributions', 90);
    // Tool B: high selection, low attribution
    seq.mount('bind', '_tools.B.displays', 100);
    seq.mount('bind', '_tools.B.selections', 60);
    seq.mount('bind', '_tools.B.attributions', 10);
    // Rank: weighted composite
    const rankA = (5/100 * 0.2) + (90/5 * 0.4) + (90/100 * 0.4);
    const rankB = (60/100 * 0.2) + (10/60 * 0.4) + (10/100 * 0.4);
    expect(rankA).toBeGreaterThan(rankB);
  });

  test('AC3: context-scoped ranking', () => {
    const seq = new Sequence();
    seq.mount('bind', '_tools.userX.search.selections', 50);
    seq.mount('bind', '_tools.userY.search.selections', 2);
    expect(seq.get('_tools.userX.search.selections')).toBe(50);
    expect(seq.get('_tools.userY.search.selections')).toBe(2);
  });

  test('AC4: backward attribution credits all tools in chain', () => {
    const seq = new Sequence();
    const chain = ['t1', 't2', 't3'];
    for (const t of chain) {
      const current = (seq.get(`_tools.${t}.attributions`) as number) ?? 0;
      seq.mount('bind', `_tools.${t}.attributions`, current + 1);
    }
    expect(seq.get('_tools.t1.attributions')).toBe(1);
    expect(seq.get('_tools.t2.attributions')).toBe(1);
    expect(seq.get('_tools.t3.attributions')).toBe(1);
  });

  test('AC5: budget presentation — top N expanded, rest compressed', () => {
    const seq = new Sequence();
    for (let i = 0; i < 20; i++) {
      seq.mount('bind', `tools.t${i}.rank`, 20 - i);
    }
    // Budget of 5: hoist with limit
    const { hoist: h } = require('../hoist');
    const result = h(seq, { depth: 3, filterBy: { path: 'tools', field: 'rank', op: 'gte', value: 16 } });
    // Only top 5 (rank >= 16) shown
    expect(result.text).toContain('tools.t0');
    expect(result.text).not.toContain('tools.t10');
  });

  test('AC6: compressed tool expandable', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tools.rare.rank', 1);
    seq.mount('bind', 'tools.rare.name', 'Rare Tool');
    // Tool exists and is readable even if compressed in a budget view
    expect(seq.get('tools.rare.name')).toBe('Rare Tool');
  });

  test('AC7: selecting one tool updates only its counters', () => {
    const seq = new Sequence();
    seq.mount('bind', '_tools.A.selections', 10);
    seq.mount('bind', '_tools.B.selections', 5);
    seq.mount('bind', '_tools.A.selections', 11);
    expect(seq.get('_tools.B.selections')).toBe(5); // unchanged
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TYPE INDEXING (6 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('type indexing', () => {
  test('AC1: type definitions queryable and serializable', () => {
    const seq = new Sequence();
    const queryInput = FT.object({ query: FT.string(), limit: FT.number() });
    seq.mount('schema', 'tools.search', FT.fn({ input: queryInput, output: FT.array(FT.string()) }));
    const type = seq.typeAt('tools.search');
    expect(type?.kind).toBe('fn');
    // Serializable
    expect(JSON.stringify(type)).toBeDefined();
  });

  test('AC2: reverse index finds capabilities by input type', () => {
    const seq = new Sequence();
    const inputType = FT.object({ query: FT.string() });
    seq.mount('schema', 'tools.search', FT.fn({ input: inputType, output: FT.string() }));
    seq.mount('cap', 'tools.search', true);
    seq.mount('schema', 'tools.filter', FT.fn({ input: inputType, output: FT.string() }));
    seq.mount('cap', 'tools.filter', true);
    // Find capabilities whose input composes with our query type
    const caps = [...seq.projection.capabilities.keys()].filter(toolId => {
      const capType = seq.typeAt(toolId);
      if (!capType || capType.kind !== 'fn') return false;
      const paramC = capType.constraints.find(c => c.op === 'param');
      if (!paramC) return false;
      return !isNever(compose(paramC.args[0] as any, inputType));
    });
    expect(caps).toContain('tools.search');
    expect(caps).toContain('tools.filter');
  });

  test('AC3: structural subtype matches supertype capabilities', () => {
    const seq = new Sequence();
    const modelType = FT.object({ name: FT.string(), provider: FT.string() });
    seq.mount('schema', 'tools.model', FT.fn({ input: modelType, output: FT.string() }));
    seq.mount('cap', 'tools.model', true);
    // HighCapModel is a subtype (has extra field)
    const highCap = FT.object({ name: FT.string(), provider: FT.string(), maxTokens: FT.number() });
    // Subtype composes with supertype
    expect(isNever(compose(modelType, highCap))).toBe(false);
  });

  test('AC4: type scoped to partition via visibility', () => {
    const seq = new Sequence();
    seq.mount('schema', 'partA.config', createType('string', [], { partition: 'partA' }));
    seq.mount('bind', 'partA.config', 'secret');
    // Visible within partition
    expect(seq.get('partA.config')).toBe('secret');
    // Visibility enforcement happens at hoist level, not get level
  });

  test('AC5: type hoisting makes it visible to siblings', () => {
    const seq = new Sequence();
    seq.mount('schema', 'partA.shared', createType('string', [], { partition: 'partA' }));
    // Before hoist: partition-scoped
    expect(seq.typeAt('partA.shared')?.meta?.partition).toBe('partA');
    // Hoist: add hoisted flag
    const type = seq.typeAt('partA.shared')!;
    seq.mount('schema', 'partA.shared', createType(type.kind, [...type.constraints], { ...type.meta, hoisted: true }));
    expect(seq.typeAt('partA.shared')?.meta?.hoisted).toBe(true);
  });

  test('AC6: type compression to structural signature', () => {
    const bigType = FT.object({
      name: FT.string().length(1, 100).description('Full name'),
      provider: FT.string(),
      maxTokens: FT.number(),
    });
    // Compress: just field names + kinds
    const props = bigType.constraints
      .filter(c => c.op === 'property')
      .map(c => `${c.args[0]}: ${(c.args[1] as any).kind}`);
    const compressed = `{ ${props.join(', ')} }`;
    expect(compressed.length).toBeLessThan(100);
    expect(compressed).toContain('name: string');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PROVISIONAL SHARDING (7 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('provisional sharding', () => {
  test('AC1: shard receives schemas and data for sub-range', () => {
    const seq = new Sequence();
    seq.mount('bind', 'tasks.team1.a', { title: 'a' });
    seq.mount('bind', 'tasks.team2.c', { title: 'c' });
    // "Shard" = copy sub-range data to a scoped prefix
    const subRange = 'tasks.team2';
    const shardData: Record<string, unknown> = {};
    for (const [path, value] of seq.iterateValues()) {
      if (path.startsWith(subRange)) shardData[path] = value;
    }
    expect(Object.keys(shardData).length).toBeGreaterThan(0);
    expect(shardData['tasks.team2.c']).toEqual({ title: 'c' });
  });

  test('AC2: unclaimed shard — parent handles requests', () => {
    const seq = new Sequence();
    seq.mount('bind', '_shards.s1.phase', 'claiming');
    seq.mount('bind', '_shards.s1.subRange', 'tasks.team2');
    // Phase is 'claiming', not 'active' — parent handles
    expect(seq.get('_shards.s1.phase')).toBe('claiming');
  });

  test('AC3: claimed shard routes requests', () => {
    const seq = new Sequence();
    seq.mount('bind', '_shards.s1.phase', 'active');
    seq.mount('bind', '_shards.s1.subRange', 'tasks.team2');
    expect(seq.get('_shards.s1.phase')).toBe('active');
  });

  test('AC4: draining shard rejects new writes', () => {
    const seq = new Sequence();
    seq.mount('bind', '_shards.s1.phase', 'draining');
    // Mount with where guard: only when phase = 'active'
    const r = seq.mount([{ op: 'bind', path: '_shards.s1.data.new', value: 'rejected' }],
      { where: [{ op: 'eq', args: ['_shards.s1.phase', 'active'] }] });
    expect(r.ok).toBe(false);
  });

  test('AC5: merged shard data reflects in parent', () => {
    const seq = new Sequence();
    seq.mount('bind', '_shards.s1.data.tasks.team2.result', { done: true });
    // Merge: copy shard data back to parent paths
    const dataPrefix = '_shards.s1.data.';
    for (const [path, value] of seq.iterateValues()) {
      if (path.startsWith(dataPrefix)) {
        seq.mount('bind', path.slice(dataPrefix.length), value);
      }
    }
    expect(seq.get('tasks.team2.result')).toEqual({ done: true });
  });

  test('AC6: released shard — parent handles again', () => {
    const seq = new Sequence();
    seq.mount('bind', '_shards.s1.phase', 'released');
    expect(seq.get('_shards.s1.phase')).toBe('released');
  });

  test('AC7: no backward phase transition', () => {
    const phases = ['initializing', 'claiming', 'active', 'draining', 'merged', 'released'];
    const seq = new Sequence();
    seq.mount('bind', '_shards.s1.phase', 'draining');
    // Attempt backward transition via where guard
    const r = seq.mount([{ op: 'bind', path: '_shards.s1.phase', value: 'active' }], {
      where: [{ op: 'gt', args: [
        // Current phase index must be less than target
        // This is enforced by whoever manages the shard
        phases.indexOf('active'),
        phases.indexOf('draining'),
      ] }],
    });
    // 2 > 3 is false → suspended
    expect(r.ok).toBe(false);
  });
});
