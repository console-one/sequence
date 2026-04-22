/**
 * contract.test.ts — Tool contracts with heartbeat-gated availability,
 * nested tools, derived obligations, and term stacking.
 *
 * Uses unprefixed paths (default to state partition) to avoid cross-partition
 * issues — this test is about contract semantics, not partition boundaries.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { createType, property } from '../type';
import type { Constraint } from '../type';

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Arithmetic expression for evalConstraint: { op, lhs, rhs }. */
function arith(op: string, lhs: unknown, rhs: unknown) {
  return { op, lhs, rhs };
}

/** while: _rt - pingPath < maxAgeMs */
function heartbeatFresh(pingPath: string, maxAgeMs: number): Constraint {
  return { op: 'lt', args: [arith('-', '_rt', pingPath), maxAgeMs] };
}

// ═══════════════════════════════════════════════════════════════════════
// HEARTBEAT-GATED CONTRACT
// ═══════════════════════════════════════════════════════════════════════

describe('heartbeat-gated availability contract', () => {

  test('contract valid while heartbeat is fresh, invalidated when stale', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    // Heartbeat
    seq.mount('bind', 'svc.api1.lastPing', now);

    // Contract block gated on heartbeat freshness
    const r = seq.mount([
      { op: 'bind', path: 'contracts.api1.status', value: 'available' },
      { op: 'bind', path: 'contracts.api1.provider', value: 'api1' },
    ], {
      while: [heartbeatFresh('svc.api1.lastPing', 5000)],
      onBreakPath: 'contracts.api1._invalidated',
    });

    expect(r.ok).toBe(true);
    expect(seq.get('contracts.api1.status')).toBe('available');

    // 3 seconds later — still fresh
    now = 1003000;
    seq.mount('bind', '_tick', now);
    expect(seq.get('contracts.api1.status')).toBe('available');

    // 6 seconds since last ping — stale, contract invalidated
    now = 1006000;
    seq.mount('bind', '_tick', now);
    expect(seq.get('contracts.api1.status')).toBeUndefined();
    expect(seq.get('contracts.api1._invalidated')).toBe(true);
  });

  test('heartbeat renewal keeps contract alive', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    seq.mount('bind', 'svc.api1.lastPing', now);

    seq.mount([
      { op: 'bind', path: 'contracts.api1.status', value: 'available' },
    ], {
      while: [heartbeatFresh('svc.api1.lastPing', 5000)],
    });

    // 4s later — renew heartbeat
    now = 1004000;
    seq.mount('bind', 'svc.api1.lastPing', now);
    seq.mount('bind', '_tick', now);
    expect(seq.get('contracts.api1.status')).toBe('available');

    // 4s after renewal — still fresh
    now = 1008000;
    seq.mount('bind', 'svc.api1.lastPing', now);
    seq.mount('bind', '_tick', now);
    expect(seq.get('contracts.api1.status')).toBe('available');

    // Stop renewing — 6s later, stale
    now = 1014000;
    seq.mount('bind', '_tick', now);
    expect(seq.get('contracts.api1.status')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CONTRACT AS OBLIGATION TEMPLATE
// ═══════════════════════════════════════════════════════════════════════

describe('contract as obligation template', () => {

  test('fn schema without impl → gap. fn schema with impl → no gap.', () => {
    const seq = new Sequence();

    // fn schema: "something here must be able to approve"
    seq.mount('schema', 'services.approve', createType('fn', [
      { op: 'param', args: [createType('object', [
        property('document', FT.string(), false),
      ])] },
      { op: 'returns', args: [createType('object', [
        property('approved', FT.boolean(), false),
      ])] },
    ]));

    // No impl → gap exists
    expect(seq.gaps().some(g => g.path === 'services.approve')).toBe(true);

    // Install impl → tool-availability gap filled
    seq.mount('tool', 'services.approve', () => ({ approved: true }));
    expect(seq.gaps().some(g => g.path === 'services.approve')).toBe(false);
  });

  test('multiple fn schemas → multiple gaps, each filled independently', () => {
    const seq = new Sequence();

    const fnType = (inputProp: string, outputProp: string) => createType('fn', [
      { op: 'param', args: [createType('object', [property(inputProp, FT.string())])] },
      { op: 'returns', args: [createType('object', [property(outputProp, FT.string())])] },
    ]);

    seq.mount('schema', 'services.create', fnType('title', 'id'));
    seq.mount('schema', 'services.read', fnType('id', 'content'));
    seq.mount('schema', 'services.delete', fnType('id', 'deleted'));

    // Three gaps
    const gaps = seq.gaps().filter(g => g.path.startsWith('services.'));
    expect(gaps.length).toBe(3);

    // Fill one
    seq.mount('tool', 'services.create', () => ({ id: '123' }));
    const remaining = seq.gaps().filter(g => g.path.startsWith('services.'));
    expect(remaining.length).toBe(2);

    // Fill all
    seq.mount('tool', 'services.read', () => ({ content: 'text' }));
    seq.mount('tool', 'services.delete', () => ({ deleted: 'yes' }));
    expect(seq.gaps().filter(g => g.path.startsWith('services.')).length).toBe(0);
  });

  // ─── REGRESSION LOCK: tool gap invariant ───────────────

  test('INVARIANT: fn schema at P + installed impl for P => P is NOT a tool gap', () => {
    const seq = new Sequence();

    // Mount fn schema
    seq.mount('schema', 'tools.translate', createType('fn', [
      { op: 'param', args: [createType('object', [
        property('text', FT.string(), false),
        property('lang', FT.string(), false),
      ])] },
      { op: 'returns', args: [createType('object', [
        property('translated', FT.string(), false),
      ])] },
    ]));

    // Before impl: IS a gap
    const gapsBefore = seq.gaps();
    const gapBefore = gapsBefore.find(g => g.path === 'tools.translate');
    expect(gapBefore).toBeDefined();
    expect(gapBefore!.type.kind).toBe('fn');

    // Install impl
    seq.mount('tool', 'tools.translate', (input: any) => ({
      translated: `[${input.lang}] ${input.text}`,
    }));

    // After impl: NOT a gap — this is the invariant
    const gapsAfter = seq.gaps();
    const gapAfter = gapsAfter.find(g => g.path === 'tools.translate');
    expect(gapAfter).toBeUndefined();

    // Verify the impl actually works (invocation still produces output)
    seq.mount('bind', 'tools.translate', { text: 'hello', lang: 'es' });
    expect(seq.get('tools.translate.result')).toEqual({ translated: '[es] hello' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TERM STACKING — outer gate invalidates all nested entries
// ═══════════════════════════════════════════════════════════════════════

describe('term stacking', () => {

  test('outer while gate invalidates all nested entries', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    seq.mount('bind', 'svc.heartbeat', now);

    seq.mount([
      { op: 'bind', path: 'svc.status', value: 'online' },
      { op: 'bind', path: 'svc.tool.a', value: 'ready' },
      { op: 'bind', path: 'svc.tool.b', value: 'ready' },
      { op: 'bind', path: 'svc.tool.c', value: 'ready' },
    ], {
      while: [heartbeatFresh('svc.heartbeat', 3000)],
    });

    expect(seq.get('svc.tool.a')).toBe('ready');
    expect(seq.get('svc.tool.b')).toBe('ready');
    expect(seq.get('svc.tool.c')).toBe('ready');

    // Heartbeat drops
    now = 1004000;
    seq.mount('bind', '_tick', now);

    expect(seq.get('svc.tool.a')).toBeUndefined();
    expect(seq.get('svc.tool.b')).toBeUndefined();
    expect(seq.get('svc.tool.c')).toBeUndefined();
    expect(seq.get('svc.status')).toBeUndefined();
  });

  test('independent contracts with independent heartbeats', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    seq.mount('bind', 'svc1.heartbeat', now);
    seq.mount('bind', 'svc2.heartbeat', now);

    seq.mount([
      { op: 'bind', path: 'svc1.status', value: 'online' },
    ], { while: [heartbeatFresh('svc1.heartbeat', 3000)] });

    seq.mount([
      { op: 'bind', path: 'svc2.status', value: 'online' },
    ], { while: [heartbeatFresh('svc2.heartbeat', 3000)] });

    // svc1 drops, svc2 renews
    now = 1004000;
    seq.mount('bind', 'svc2.heartbeat', now);
    seq.mount('bind', '_tick', now);

    expect(seq.get('svc1.status')).toBeUndefined();
    expect(seq.get('svc2.status')).toBe('online');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CAPABILITY IO — fn schema + impl + invocation
// ═══════════════════════════════════════════════════════════════════════

describe('tool IO', () => {

  test('fn schema + tool → no gap. Invocation mounts output.', () => {
    const seq = new Sequence();

    seq.mount('schema', 'tools.double', createType('fn', [
      { op: 'param', args: [createType('object', [property('x', FT.number())])] },
      { op: 'returns', args: [createType('object', [property('result', FT.number())])] },
    ]));

    // Gap before impl
    expect(seq.gaps().some(g => g.path === 'tools.double')).toBe(true);

    // Install impl
    seq.mount('tool', 'tools.double', (input: any) => ({ result: input.x * 2 }));

    // No gap after impl
    expect(seq.gaps().some(g => g.path === 'tools.double')).toBe(false);

    // Invoke
    seq.mount('bind', 'tools.double', { x: 21 });
    expect(seq.get('tools.double.result')).toEqual({ result: 42 });
  });

  test('full: heartbeat-gated contract with tool, invoke, then drop', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    seq.mount('bind', 'mathsvc.heartbeat', now);

    // Gated contract with a fn schema inside
    seq.mount([
      { op: 'bind', path: 'mathsvc.provider', value: 'math-service' },
      { op: 'schema', path: 'mathsvc.add', value: createType('fn', [
        { op: 'param', args: [createType('object', [
          property('a', FT.number()), property('b', FT.number()),
        ])] },
        { op: 'returns', args: [createType('object', [
          property('sum', FT.number()),
        ])] },
      ]) },
    ], {
      while: [heartbeatFresh('mathsvc.heartbeat', 5000)],
    });

    // Gap exists
    expect(seq.gaps().some(g => g.path === 'mathsvc.add')).toBe(true);

    // Install impl
    seq.mount('tool', 'mathsvc.add', (input: any) => ({ sum: input.a + input.b }));
    expect(seq.gaps().some(g => g.path === 'mathsvc.add')).toBe(false);

    // Invoke
    seq.mount('bind', 'mathsvc.add', { a: 3, b: 4 });
    expect(seq.get('mathsvc.add.result')).toEqual({ sum: 7 });

    // Heartbeat drops → contract invalidated, everything gone
    now = 1006000;
    seq.mount('bind', '_tick', now);
    expect(seq.get('mathsvc.provider')).toBeUndefined();
    // Schema was in the gated block — invalidated
    // Note: the result may persist as a value even after schema invalidation,
    // because invalidation removes bind entries from the block, not all descendants.
    // The tool and schema are gone though.
  });
});
