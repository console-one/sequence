/**
 * project.test.ts — `...project(BINDING in SET, MAPPER)` primitive.
 *
 * Iteration at use site. Explicit binding form: `BINDING` names the
 * iteration variable, `SET` is a path pattern with `{name}` named
 * wildcards that become fields on the binding, `MAPPER` is a fn def
 * invoked per match with the binding as input. Filter conditions
 * reference `BINDING.field` for record access — every name in the
 * filter has a visible declaration upstream.
 */

import { receive } from '../dsl/walker';
import { Sequence } from '../sequence';

describe('project(binding in set, mapper)', () => {
  test('iterates a pattern with named wildcard and invokes mapper per child', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      fulfill = (reqId: string, subject: string, response: string) -> [
        req.{reqId}.status = "fulfilled"
        req.{reqId}.responseBody = response
      ]
    `, seq);

    seq.mount('bind', 'req.r1', { subject: 'payload.1', response: 'done-one' });
    seq.mount('bind', 'req.r2', { subject: 'payload.2', response: 'done-two' });

    receive(`...project(r in req.{reqId}, fulfill)`, seq);

    expect(seq.get('req.r1.status')).toBe('fulfilled');
    expect(seq.get('req.r1.responseBody')).toBe('done-one');
    expect(seq.get('req.r2.status')).toBe('fulfilled');
    expect(seq.get('req.r2.responseBody')).toBe('done-two');
  });

  test('wildcard name becomes a field on the binding and maps to mapper param', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      record = (key: string, payload: string) -> [
        log.{key} = payload
      ]
    `, seq);

    seq.mount('bind', 'events.a', { payload: 'event-a' });
    seq.mount('bind', 'events.b', { payload: 'event-b' });

    // Wildcard name `key` matches mapper's first param `key`.
    receive(`...project(r in events.{key}, record)`, seq);

    expect(seq.get('log.a')).toBe('event-a');
    expect(seq.get('log.b')).toBe('event-b');
  });

  test('empty set is a no-op', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      bump = (name: string) -> [
        counters.{name} = 1
      ]
    `, seq);

    // No children under items — project fires zero times.
    receive(`...project(r in items.{name}, bump)`, seq);

    expect(seq.get('counters.anything')).toBeUndefined();
  });

  test('mapper fn must be declared before project fires', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      recorded = (key: string) -> [
        log.{key} = "seen"
      ]
    `, seq);

    seq.mount('bind', 'items.x', { data: 'one' });

    // Undeclared mapper → safe no-op, not a crash.
    receive(`...project(r in items.{key}, undeclaredMapper)`, seq);
    expect(seq.get('log.x')).toBeUndefined();

    // Declared mapper still works.
    receive(`...project(r in items.{key}, recorded)`, seq);
    expect(seq.get('log.x')).toBe('seen');
  });

  test('set without named wildcard is a parse-time error', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      mark = (key: string) -> [
        log.{key} = 1
      ]
    `, seq);

    // `req.*` — no named wildcard — is rejected.
    expect(() => {
      receive(`...project(r in req.*, mark)`, seq);
    }).toThrow();
  });

  test('binding form without "in" keyword is a parse-time error', () => {
    expect(() => {
      receive(`
        mark = (key: string) -> [
          log.{key} = 1
        ]

        ...project(req.{key}, mark)
      `, new Sequence(() => 1000));
    }).toThrow(/project requires 'binding in set'/);
  });
});

describe('project(binding in set, mapper).where(binding.field ...)', () => {
  test('filter references binding field for record access', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      fulfill = (reqId: string, response: string) -> [
        req.{reqId}.status = "fulfilled"
      ]
    `, seq);

    seq.mount('bind', 'req.r1', { status: 'claimed', response: 'done-one' });
    seq.mount('bind', 'req.r2', { status: 'pending', response: 'wait-two' });
    seq.mount('bind', 'req.r3', { status: 'claimed', response: 'done-three' });

    receive(`...project(r in req.{reqId}, fulfill).where(r.status = "claimed")`, seq);

    expect(seq.get('req.r1.status')).toBe('fulfilled');
    expect(seq.get('req.r3.status')).toBe('fulfilled');
    // r2 was pending → filter blocked → no sub-path mount
    expect((seq.get('req.r2') as any)?.status).toBe('pending');
    expect(seq.get('req.r2.status')).toBeUndefined();
  });

  test('exists filter on binding field skips records missing it', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      mark = (id: string, value: string) -> [
        log.{id} = value
      ]
    `, seq);

    seq.mount('bind', 'items.a', { value: 'has-value' });
    seq.mount('bind', 'items.b', { other: 'no-value' });

    receive(`...project(r in items.{id}, mark).where(r.value exists)`, seq);

    expect(seq.get('log.a')).toBe('has-value');
    expect(seq.get('log.b')).toBeUndefined();
  });

  test('_rt resolves to sequence clock in filter and body', () => {
    let now = 1000;
    const seq = new Sequence(() => now);

    seq.mount('bind', 'req.r1', { deadline: 1500, status: 'open' });
    seq.mount('bind', 'req.r2', { deadline: 800, status: 'open' });

    receive(`
      expire = (reqId: string) -> [
        req.{reqId}.status = "expired"
        req.{reqId}.expiredAt = _rt
      ]
    `, seq);

    now = 1200;
    seq.mount('bind', '_tick', now);

    receive(`...project(r in req.{reqId}, expire).where(r.deadline < _rt, r.status != "expired")`, seq);

    expect(seq.get('req.r2.status')).toBe('expired');
    expect(seq.get('req.r2.expiredAt')).toBe(1200);
    expect((seq.get('req.r1') as any)?.status).toBe('open');
    expect(seq.get('req.r1.status')).toBeUndefined();
  });

  test('multi-level glob path with named wildcard expands to matching sub-paths', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      promote = (key: string) -> [
        promoted.{key} = 1
      ]
    `, seq);

    seq.mount('bind', 'state.a.pending', true);
    seq.mount('bind', 'state.b.pending', true);
    seq.mount('bind', 'state.c.ready', true); // no .pending

    receive(`...project(r in state.{key}.pending, promote)`, seq);

    expect(seq.get('promoted.a')).toBe(1);
    expect(seq.get('promoted.b')).toBe(1);
    expect(seq.get('promoted.c')).toBeUndefined();
  });

  test('nested project: mapper body can invoke another project', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      process = (itemId: string, kind: string) -> [
        processed.{itemId} = kind
      ]

      applyPolicy = (policyId: string) -> [
        ...project(i in items.{itemId}, process)
      ]
    `, seq);

    seq.mount('bind', 'items.a', { kind: 'urgent' });
    seq.mount('bind', 'items.b', { kind: 'normal' });
    seq.mount('bind', 'policies.p1', { name: 'default' });

    receive(`...project(p in policies.{policyId}, applyPolicy)`, seq);

    expect(seq.get('processed.a')).toBe('urgent');
    expect(seq.get('processed.b')).toBe('normal');
  });

  test('absolute literal filter path reads the sequence', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      mark = (id: string) -> [
        log.{id} = "processed"
      ]
    `, seq);

    seq.mount('bind', 'items.a', { status: 'open' });
    seq.mount('bind', 'items.b', { status: 'open' });
    seq.mount('bind', 'config.processing.enabled', true);

    // Multi-segment literal path (no binding prefix) → absolute
    // sequence read. Coexists with binding-field refs in the
    // same filter.
    receive(`...project(r in items.{id}, mark).where(config.processing.enabled = true)`, seq);

    expect(seq.get('log.a')).toBe('processed');
    expect(seq.get('log.b')).toBe('processed');
  });

  test('filter re-fires when data changes', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      process = (id: string, data: string) -> [
        processed.{id} = data
      ]
    `, seq);

    seq.mount('bind', 'items.x', { status: 'pending', data: 'x-data' });

    receive(`...project(r in items.{id}, process).where(r.status = "ready")`, seq);
    expect(seq.get('processed.x')).toBeUndefined();

    seq.mount('bind', 'items.x', { status: 'ready', data: 'x-data' });
    receive(`...project(r in items.{id}, process).where(r.status = "ready")`, seq);
    expect(seq.get('processed.x')).toBe('x-data');
  });
});
