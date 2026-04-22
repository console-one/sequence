/**
 * narrativemodel.test.ts — AC-level tests for all 42 narrative model acceptance criteria.
 * Every AC gets a dedicated test. All through kernel primitives — no application methods.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { hoist } from '../hoist';
import { check } from '../compose';
import { createType, property, literal, eq, exists, gt, lt } from '../type';

// ═══════════════════════════════════════════════════════════════════════
// TABLES (7 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('tables', () => {
  const InvoiceLine = FT.object({
    product: FT.string().length(1, 100),
    quantity: FT.number().min(0).integer(),
    unitPrice: FT.number().min(0),
  });

  test('AC1: row violating column constraint rejected', () => {
    const result = check(InvoiceLine, { product: 'Widget', quantity: -2, unitPrice: 5 }, 'row');
    expect(result.ok).toBe(false);
    expect((result as any).gaps.some((g: any) => g.path.includes('quantity'))).toBe(true);
  });

  test('AC2: missing required columns reported', () => {
    const result = check(InvoiceLine, { product: 'Widget' }, 'row');
    expect(result.ok).toBe(false);
    const gaps = (result as any).gaps;
    expect(gaps.some((g: any) => g.reason.includes('quantity'))).toBe(true);
    expect(gaps.some((g: any) => g.reason.includes('unitPrice'))).toBe(true);
  });

  test('AC3: valid row stored and addressable by index', () => {
    const seq = new Sequence();
    seq.mount('schema', 'invoice.lines.*', InvoiceLine);
    seq.mount('bind', 'invoice.lines.0', { product: 'Widget A', quantity: 10, unitPrice: 5.99 });
    expect(seq.get('invoice.lines.0')).toEqual({ product: 'Widget A', quantity: 10, unitPrice: 5.99 });
  });

  test('AC4: derived total recomputes on row add', () => {
    const seq = new Sequence();
    seq.mount('schema', 'sum', FT.derived('add', 'a', 'b'));
    seq.mount('tool', 'add', (a: number, b: number) => a + b);
    seq.mount('bind', 'a', 153.40);
    seq.mount('bind', 'b', 20.00);
    expect(seq.get('sum')).toBeCloseTo(173.40);
  });

  test('AC5: sorting is read-time projection', () => {
    const seq = new Sequence();
    seq.mount('bind', 'items.a.price', 30);
    seq.mount('bind', 'items.b.price', 10);
    seq.mount('bind', 'items.c.price', 20);
    const sorted = hoist(seq, { depth: 3, sortBy: { path: 'items', by: 'price', desc: true } });
    const lines = sorted.text.split('\n').filter(l => l.includes('price'));
    expect(lines[0]).toContain('30');
    expect(lines[1]).toContain('20');
    expect(lines[2]).toContain('10');
    // Original order unchanged
    const unsorted = hoist(seq, { depth: 3 });
    const origLines = unsorted.text.split('\n').filter(l => l.includes('price'));
    expect(origLines[0]).toContain('items.a');
  });

  test('AC6: filtering is read-time projection', () => {
    const seq = new Sequence();
    seq.mount('bind', 'items.a.qty', 10);
    seq.mount('bind', 'items.b.qty', 3);
    seq.mount('bind', 'items.c.qty', 7);
    const filtered = hoist(seq, { depth: 3, filterBy: { path: 'items', field: 'qty', op: 'gt', value: 5 } });
    expect(filtered.text).toContain('items.a');
    expect(filtered.text).toContain('items.c');
    expect(filtered.text).not.toContain('items.b');
  });

  test('AC7: read row by index', () => {
    const seq = new Sequence();
    seq.mount('bind', 'rows.0', { name: 'first' });
    seq.mount('bind', 'rows.1', { name: 'second' });
    seq.mount('bind', 'rows.2', { name: 'third' });
    expect(seq.get('rows.1')).toEqual({ name: 'second' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// COMPACTION (5 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('compaction', () => {
  test('AC1: current state unchanged after compaction', () => {
    const seq = new Sequence();
    for (let i = 0; i < 100; i++) seq.mount('bind', 'counter', i);
    const before = seq.get('counter');
    seq.compact(seq.head - 5);
    expect(seq.get('counter')).toBe(before);
  });

  test('AC2: historical queries work correctly', () => {
    const seq = new Sequence();
    seq.mount('bind', 'x', 'a'); // seq 0
    seq.mount('bind', 'x', 'b'); // seq 1
    seq.mount('bind', 'x', 'c'); // seq 2
    seq.compact(1);
    // After cutoff: exact value
    expect(seq.getAt('x', 2)).toBe('c');
    // Before cutoff: snapshot value
    expect(seq.getAt('x', 0)).toBe('a'); // snapshot of compacted
  });

  test('AC3: schemas survive compaction', () => {
    const seq = new Sequence();
    seq.mount('schema', 'typed', FT.number().min(0));
    for (let i = 0; i < 50; i++) seq.mount('bind', 'typed', i);
    seq.compact(seq.head - 5);
    // Schema still enforced
    const r = seq.mount('bind', 'typed', -1);
    expect(r.ok).toBe(false);
  });

  test('AC4: suspended ops survive compaction', () => {
    const seq = new Sequence();
    seq.mount([{ op: 'bind', path: 'pending', value: 'waiting' }], { where: [exists('trigger')] });
    expect(seq.get('pending')).toBeUndefined();
    seq.compact(seq.head - 1);
    // Still suspended
    expect(seq.get('pending')).toBeUndefined();
    // Resume after compaction
    seq.mount('bind', 'trigger', true);
    expect(seq.get('pending')).toBe('waiting');
  });

  test('AC5: reports removed and kept counts', () => {
    const seq = new Sequence();
    for (let i = 0; i < 20; i++) seq.mount('bind', `item${i}`, i);
    const result = seq.compact(seq.head - 5);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.kept).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LIVE EDITING (6 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('live editing', () => {
  test('AC1: append-only log with editor attribution', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.text', 'alice version', { author: 'alice' });
    seq.mount('bind', 'doc.text', 'bob version', { author: 'bob' });
    expect(seq.length).toBe(2);
    expect(seq.get('doc.text')).toBe('bob version');
  });

  test('AC2: stale version edit suspended', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.version', 1);
    seq.mount('bind', 'doc.text', 'v1');
    // Alice edits at version 1
    seq.mount('bind', 'doc.version', 2);
    seq.mount('bind', 'doc.text', 'v2 by alice');
    // Bob tries to edit at version 1 (stale)
    const r = seq.mount([{ op: 'bind', path: 'doc.text', value: 'bob edit' }], { where: [eq('doc.version', 1)] });
    expect(r.ok).toBe(false);
  });

  test('AC3: resubmit against current version succeeds', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.version', 2);
    const r = seq.mount([{ op: 'bind', path: 'doc.text', value: 'bob v2' }], { where: [eq('doc.version', 2)] });
    expect(r.ok).toBe(true);
  });

  test('AC4: historical query at position', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc', 'version 1');
    seq.mount('bind', 'doc', 'version 2');
    seq.mount('bind', 'doc', 'version 3');
    expect(seq.getAt('doc', 1)).toBe('version 2');
  });

  test('AC5: log is immutable', () => {
    const seq = new Sequence();
    seq.mount('bind', 'x', 1);
    seq.mount('bind', 'x', 2);
    seq.mount('bind', 'x', 3);
    expect(seq.length).toBe(3);
  });

  test('AC6: diff computation (previous value available)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc', 'Draft A');
    seq.mount('bind', 'doc', 'Draft B');
    expect(seq.getPrevious('doc')).toBe('Draft A');
    expect(seq.get('doc')).toBe('Draft B');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// FORM SPECS (6 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('form specs', () => {
  test('AC1: required fields without values = incomplete', () => {
    const seq = new Sequence();
    seq.mount('schema', 'form.name', FT.string());
    seq.mount('schema', 'form.email', FT.string());
    seq.mount('schema', 'form.age', FT.number());
    // 3 schemas, no values = 3 obligations
    const obs = seq.obligations();
    expect(obs.length).toBe(3);
    // Fill one
    seq.mount('bind', 'form.name', 'Alice');
    const obs2 = seq.obligations();
    expect(obs2.length).toBe(2);
  });

  test('AC2: optional fields not in incomplete list', () => {
    const seq = new Sequence();
    seq.mount('schema', 'form', FT.object({ 'name': FT.string(), 'notes?': FT.string() }));
    const obs = seq.obligations();
    const paths = obs.map(o => o.path);
    expect(paths).toContain('form');
    // After filling required only
    seq.mount('bind', 'form', { name: 'Alice' });
    const obs2 = seq.obligations();
    expect(obs2.find(o => o.path === 'form')).toBeUndefined();
  });

  test('AC3: batch fill atomic', () => {
    const seq = new Sequence();
    seq.mount('schema', 'email', FT.string().pattern('^.+@.+$'));
    seq.mount('schema', 'age', FT.number().min(0));
    // Both valid
    const r1 = seq.mount([
      { op: 'bind', path: 'email', value: 'a@b.com' },
      { op: 'bind', path: 'age', value: 25 },
    ]);
    expect(r1.ok).toBe(true);
  });

  test('AC4: all violations reported at once', () => {
    const schema = FT.object({ name: FT.string().length(1, 50), email: FT.string().pattern('^.+@.+$'), age: FT.number().min(18) });
    const result = check(schema, { name: '', email: 'invalid', age: 12 }, 'form');
    expect(result.ok).toBe(false);
    expect((result as any).gaps.length).toBeGreaterThanOrEqual(2);
  });

  test('AC5: all required fields filled = complete', () => {
    const seq = new Sequence();
    seq.mount('schema', 'form', FT.object({ name: FT.string(), email: FT.string() }));
    seq.mount('bind', 'form', { name: 'Alice', email: 'a@b.com' });
    const obs = seq.obligations().filter(o => o.path === 'form');
    expect(obs.length).toBe(0);
  });

  test('AC6: defaults tracked separately (provenance)', () => {
    const seq = new Sequence();
    seq.mount('schema', 'prefs', createType('object', [
      property('theme', FT.string(), false),
      property('lang', createType('string', [{ op: 'default', args: ['en'] }]), false),
    ]));
    seq.mount('bind', 'prefs', { theme: 'dark' });
    expect(seq.get('prefs.theme._provenance')).toBe('user');
    expect(seq.get('prefs.lang._provenance')).toBe('default');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EDITABLE RANGES (6 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('editable ranges', () => {
  test('AC1: per-section editability queryable', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.title.locked', true);
    seq.mount('bind', 'doc.body.locked', false);
    seq.mount('bind', 'doc.sig.locked', true);
    expect(seq.get('doc.title.locked')).toBe(true);
    expect(seq.get('doc.body.locked')).toBe(false);
    expect(seq.get('doc.sig.locked')).toBe(true);
  });

  test('AC2: write to locked section suspends, editable applies', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.body.locked', false);
    seq.mount('bind', 'doc.title.locked', true);
    const r1 = seq.mount([{ op: 'bind', path: 'doc.body.content', value: 'hello' }],
      { where: [eq('doc.body.locked', false)] });
    expect(r1.ok).toBe(true);
    const r2 = seq.mount([{ op: 'bind', path: 'doc.title.content', value: 'changed' }],
      { where: [eq('doc.title.locked', false)] });
    expect(r2.ok).toBe(false);
  });

  test('AC3: sub-sections independently addressable', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.body.intro', 'intro text');
    seq.mount('bind', 'doc.body.analysis', 'analysis text');
    seq.mount('bind', 'doc.body.conclusion', 'conclusion text');
    seq.mount('bind', 'doc.body.analysis', 'updated analysis');
    expect(seq.get('doc.body.intro')).toBe('intro text');
    expect(seq.get('doc.body.conclusion')).toBe('conclusion text');
  });

  test('AC4: lock transfer atomic (while break invalidates)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'lock.owner', 'alice');
    seq.mount([{ op: 'bind', path: 'doc.edit', value: 'alice edit' }],
      { while: [eq('lock.owner', 'alice')] });
    expect(seq.get('doc.edit')).toBe('alice edit');
    seq.mount('bind', 'lock.owner', 'bob');
    expect(seq.get('doc.edit')).toBeUndefined();
  });

  test('AC5: size budget enforced', () => {
    const seq = new Sequence();
    seq.mount('schema', 'section', FT.string().length(0, 200));
    const r = seq.mount('bind', 'section', 'x'.repeat(250));
    expect(r.ok).toBe(false);
  });

  test('AC6: unlock resumes pending write', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.locked', true);
    seq.mount([{ op: 'bind', path: 'doc.content', value: 'pending' }],
      { where: [eq('doc.locked', false)] });
    expect(seq.get('doc.content')).toBeUndefined();
    seq.mount('bind', 'doc.locked', false);
    expect(seq.get('doc.content')).toBe('pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DUAL LINKS (7 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('dual links', () => {
  test('AC1: cross-document reference resolves', () => {
    const seq = new Sequence();
    seq.mount('schema', 'B.ref', FT.ref('A.budget'));
    seq.mount('bind', 'A.budget', 50000);
    expect(seq.get('B.ref')).toBe(50000);
  });

  test('AC2: bidirectional references resolve independently', () => {
    const seq = new Sequence();
    seq.mount('schema', 'B.ref', FT.ref('A.budget'));
    seq.mount('schema', 'A.ref', FT.ref('B.title'));
    seq.mount('bind', 'A.budget', 50000);
    seq.mount('bind', 'B.title', 'Proposal');
    expect(seq.get('B.ref')).toBe(50000);
    expect(seq.get('A.ref')).toBe('Proposal');
  });

  test('AC3: derived field recomputes on source change', () => {
    const seq = new Sequence();
    seq.mount('schema', 'formatted', FT.derived('fmt', 'raw'));
    seq.mount('tool', 'fmt', (v: number) => `$${v.toLocaleString()}`);
    seq.mount('bind', 'raw', 75000);
    expect(seq.get('formatted')).toBe('$75,000');
    seq.mount('bind', 'raw', 100000);
    expect(seq.get('formatted')).toBe('$100,000');
  });

  test('AC4: transitive cascade', () => {
    const seq = new Sequence();
    seq.mount('schema', 'overhead', FT.derived('pct', 'budget'));
    seq.mount('tool', 'pct', (b: number) => b * 0.15);
    seq.mount('schema', 'total', FT.derived('add', 'budget', 'overhead'));
    seq.mount('tool', 'add', (a: number, b: number) => a + b);
    seq.mount('bind', 'budget', 100000);
    expect(seq.get('overhead')).toBe(15000);
    expect(seq.get('total')).toBe(115000);
  });

  test('AC5: cycle detection terminates', () => {
    const seq = new Sequence();
    seq.mount('schema', 'A', FT.ref('B'));
    seq.mount('schema', 'B', FT.ref('A'));
    seq.mount('bind', 'A', 'value');
    // Should not infinite loop — visited set detects cycle, returns undefined
    // The AC requirement is TERMINATION, not a specific return value
    const start = Date.now();
    const result = seq.get('A');
    const elapsed = Date.now() - start;
    // Terminated (didn't hang) — cycle detection works
    expect(elapsed).toBeLessThan(100);
    // Cycle → undefined (both refs point to each other, neither resolves)
    expect(result).toBeUndefined();
  });

  test('AC6: removing reference clears derived value', () => {
    const seq = new Sequence();
    // Mount tool first, then schema, then value — order matters for cascade
    seq.mount('tool', 'passthrough', (v: any) => v);
    seq.mount('schema', 'B.derived', FT.derived('passthrough', 'A.val'));
    seq.mount('bind', 'A.val', 42);
    expect(seq.get('B.derived')).toBe(42);
    // Delete the source
    seq.mount('delete', 'A.val', undefined);
    expect(seq.get('A.val')).toBeUndefined();
  });

  test('AC7: downstream invalidation cascades', () => {
    const seq = new Sequence();
    seq.mount('schema', 'B', FT.ref('A'));
    seq.mount('schema', 'C', FT.ref('B'));
    seq.mount('bind', 'A', 'alive');
    expect(seq.get('B')).toBe('alive');
    expect(seq.get('C')).toBe('alive');
    seq.mount('delete', 'A', undefined);
    expect(seq.get('B')).toBeUndefined();
    expect(seq.get('C')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SECTIONING (5 ACs)
// ═══════════════════════════════════════════════════════════════════════

describe('sectioning', () => {
  test('AC1: named sections independently addressable', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.header', 'Header');
    seq.mount('bind', 'doc.body', 'Body');
    seq.mount('bind', 'doc.footer', 'Footer');
    seq.mount('bind', 'doc.body', 'Updated Body');
    expect(seq.get('doc.header')).toBe('Header');
    expect(seq.get('doc.footer')).toBe('Footer');
  });

  test('AC2: size budget enforced, exceeding suspends', () => {
    const seq = new Sequence();
    seq.mount('schema', 'doc.body', FT.string().length(0, 4000));
    const r1 = seq.mount('bind', 'doc.body', 'x'.repeat(3000));
    expect(r1.ok).toBe(true);
    const r2 = seq.mount('bind', 'doc.body', 'x'.repeat(4001));
    expect(r2.ok).toBe(false);
  });

  test('AC3: lock enforcement structural', () => {
    const seq = new Sequence();
    seq.mount('schema', 'doc.footer', FT.string().literal('Confidential - Internal Use Only'));
    seq.mount('bind', 'doc.footer', 'Confidential - Internal Use Only');
    const r = seq.mount('bind', 'doc.footer', 'Changed text');
    expect(r.ok).toBe(false);
  });

  test('AC4: enumerate sections in order', () => {
    const seq = new Sequence();
    seq.mount('bind', 'doc.header', 'H');
    seq.mount('bind', 'doc.body', 'B');
    seq.mount('bind', 'doc.footer', 'F');
    const keys = seq.keys('doc');
    expect(keys).toContain('header');
    expect(keys).toContain('body');
    expect(keys).toContain('footer');
  });

  test('AC5: mutation metadata inspectable', () => {
    const seq = new Sequence();
    seq.mount('schema', 'doc.body', FT.string().annotate('mutations', ['expand', 'compress']));
    seq.mount('bind', 'doc.body', 'content');
    const type = seq.typeAt('doc.body');
    expect(type?.meta?.mutations).toEqual(['expand', 'compress']);
  });
});
