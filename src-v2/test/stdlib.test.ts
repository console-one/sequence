/**
 * Stdlib tests — features installed on top of the kernel.
 *
 * Every feature tested here is added to the kernel by calling an
 * install*() function. The kernel does not know about commitment,
 * reliability, posteriorAdmit, or indexSpec — these are rules + emitters
 * supplied by stdlib. These tests prove the factoring is right: the
 * capabilities work as substrate features without touching the kernel.
 */

import { Sequence } from '../sequence';
import {
  installCommitment,
  installReliability,
  installPosteriorAdmit,
  installIndexSpec,
  installStdLib,
  posteriorAdmit,
  flushPending,
  advanceClock,
  installReader,
  hoistForReader,
  installCrossSequence,
  receiveFromPeer,
  renderDocument,
  search,
  searchCandidates,
  executePlan,
  flattenPlan,
  feasibility,
  subtypeKey,
  registerRefiner,
  type Outgoing,
  type DocSection,
} from '../stdlib';
import { createType, param, returns, impl, indexSpec, bindFrom, temporal } from '../../src/type';

const numberFn = () => createType('fn', [
  param(createType('number')),
  returns(createType('number')),
  impl('double'),
]);

function commitmentIds(s: Sequence): string[] {
  return s.cells().map(c => c.path)
    .filter(p => /^_commitments\.[^.]+$/.test(p))
    .map(p => p.split('.')[1]);
}

// ═══ Commitment ═══

describe('stdlib: commitment', () => {
  test('invocation elects record + mounts input/result + status fulfilled', () => {
    const s = new Sequence();
    installCommitment(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 5 });

    const ids = commitmentIds(s);
    expect(ids).toHaveLength(1);
    const rec = `_commitments.${ids[0]}`;
    expect(s.get(`${rec}.typeRef`)).toBe('tool');
    expect(s.get(`${rec}.holder`)).toBe('tool');
    expect(s.get(`${rec}.head`)).toBe('tool.result');
    expect(s.get(`${rec}.status`)).toBe('fulfilled');
    expect(s.get('tool.input')).toBe(5);
    expect(s.get('tool.result')).toBe(10);
    expect(typeof s.get(`${rec}.latencyMs`)).toBe('number');
  });

  test('impl throw → status violated with reason', () => {
    const s = new Sequence();
    installCommitment(s);
    s.impls.set('double', () => { throw new Error('boom'); });
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 1 });

    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('violated');
    expect(s.get(`_commitments.${id}.violateReason`)).toBe('boom');
  });

  test('missing impl → status pending (external holder case)', () => {
    const s = new Sequence();
    installCommitment(s);
    s.insert({ path: 'tool', type: numberFn() });
    s.insert({ path: 'tool', value: 1 });

    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('pending');
  });

  test('each invocation gets its own record', () => {
    const s = new Sequence();
    installCommitment(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 1 });
    s.insert({ path: 'tool', value: 2 });
    s.insert({ path: 'tool', value: 3 });

    expect(commitmentIds(s)).toHaveLength(3);
  });
});

// ═══ Reliability ═══

describe('stdlib: reliability', () => {
  test('fulfillment increments alpha (default Beta(1,1) prior)', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 1 });

    expect(s.get('_holders.tool.reliability.alpha')).toBe(2);
    expect(s.get('_holders.tool.reliability.beta') ?? 1).toBe(1);
  });

  test('violation increments beta', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    s.impls.set('double', () => { throw new Error('fail'); });
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 1 });

    expect(s.get('_holders.tool.reliability.alpha') ?? 1).toBe(1);
    expect(s.get('_holders.tool.reliability.beta')).toBe(2);
  });

  test('mixed history converges to Beta(α+success, β+failure)', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    let ok = true;
    s.impls.set('double', (n: number) => { if (!ok) throw new Error('x'); return n * 2; });
    s.insert({ path: 'tool', type: numberFn() });

    ok = true;  s.insert({ path: 'tool', value: 1 });
    ok = true;  s.insert({ path: 'tool', value: 2 });
    ok = false; s.insert({ path: 'tool', value: 3 });
    ok = true;  s.insert({ path: 'tool', value: 4 });
    ok = false; s.insert({ path: 'tool', value: 5 });

    expect(s.get('_holders.tool.reliability.alpha')).toBe(4); // 1 + 3 successes
    expect(s.get('_holders.tool.reliability.beta')).toBe(3);  // 1 + 2 failures
  });
});

// ═══ PosteriorAdmit ═══

describe('stdlib: posteriorAdmit', () => {
  test('admits while mean ≥ threshold, rejects once it drops', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    installPosteriorAdmit(s);
    s.impls.set('double', () => { throw new Error('x'); });
    s.insert({ path: 'tool', type: numberFn() });

    // 10 failures — posterior Beta(1, 11), mean ≈ 0.083
    for (let i = 0; i < 10; i++) s.insert({ path: 'tool', value: i });

    // Install admission rule gating on the posterior
    s.insert({
      path: '_rules.posterior_gate',
      rules: [{
        id: 'posterior_gate',
        phase: 'admission',
        scope: 'tool',
        when: posteriorAdmit('_holders.tool.reliability', 0.5),
      }],
    });

    // Subsequent invocation blocked
    const r = s.insert({ path: 'tool', value: 99 });
    expect(r.suspended).toBe(true);
    expect(commitmentIds(s)).toHaveLength(10); // no 11th record elected
  });

  test('gate opens as reliability recovers', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    installPosteriorAdmit(s);
    s.impls.set('double', () => { throw new Error('x'); });
    s.insert({ path: 'tool', type: numberFn() });

    // 3 failures → Beta(1, 4), mean 0.2
    for (let i = 0; i < 3; i++) s.insert({ path: 'tool', value: i });
    s.insert({
      path: '_rules.gate',
      rules: [{
        id: 'gate',
        phase: 'admission',
        scope: 'tool',
        when: posteriorAdmit('_holders.tool.reliability', 0.5),
      }],
    });
    expect(s.insert({ path: 'tool', value: 99 }).suspended).toBe(true);

    // Directly raise alpha (simulating successful alternate holder history)
    s.insert({ path: '_holders.tool.reliability.alpha', value: 10 });
    // Now mean = 10/14 ≈ 0.71; admission opens
    s.impls.set('double', (n: number) => n * 2);
    const r = s.insert({ path: 'tool', value: 99 });
    expect(r.suspended).toBe(false);
    expect(s.get('tool.result')).toBe(198);
  });
});

// ═══ IndexSpec ═══

describe('stdlib: indexSpec', () => {
  test('class fires body for each tuple (inputs-before-class order)', () => {
    const s = new Sequence();
    installIndexSpec(s);
    s.insert({ path: 'tasks.a', value: true });
    s.insert({ path: 'tasks.b', value: true });

    s.insert({
      path: 'Q',
      type: createType('any', [indexSpec({
        indexedBy: ['t'],
        where: [bindFrom('t', 'tasks.*')],
        body: [{ op: 'bind', path: 'queue.{t}', value: 'pending' }],
      })]),
    });

    expect(s.get('queue.a')).toBe('pending');
    expect(s.get('queue.b')).toBe('pending');
  });

  test('class fires body for each tuple (class-before-inputs order)', () => {
    const s = new Sequence();
    installIndexSpec(s);
    s.insert({
      path: 'Q',
      type: createType('any', [indexSpec({
        indexedBy: ['t'],
        where: [bindFrom('t', 'tasks.*')],
        body: [{ op: 'bind', path: 'queue.{t}', value: 'pending' }],
      })]),
    });
    s.insert({ path: 'tasks.a', value: true });
    s.insert({ path: 'tasks.b', value: true });

    expect(s.get('queue.a')).toBe('pending');
    expect(s.get('queue.b')).toBe('pending');
  });

  test('eq filter restricts the tuple space', () => {
    const s = new Sequence();
    installIndexSpec(s);
    s.insert({ path: 'tasks.a.status', value: 'active' });
    s.insert({ path: 'tasks.b.status', value: 'done' });
    s.insert({ path: 'tasks.c.status', value: 'active' });

    s.insert({
      path: 'ActiveOnly',
      type: createType('any', [indexSpec({
        indexedBy: ['t'],
        where: [bindFrom('t', 'tasks.*'), { op: 'eq', args: ['t.status', 'active'] }],
        body: [{ op: 'bind', path: 'active.{t}', value: true }],
      })]),
    });

    expect(s.get('active.a')).toBe(true);
    expect(s.get('active.b')).toBeUndefined();
    expect(s.get('active.c')).toBe(true);
  });

  test('multi-variable tuples produce Cartesian product', () => {
    const s = new Sequence();
    installIndexSpec(s);
    s.insert({ path: 'rows.r1', value: true });
    s.insert({ path: 'rows.r2', value: true });
    s.insert({ path: 'cols.c1', value: true });
    s.insert({ path: 'cols.c2', value: true });

    s.insert({
      path: 'Matrix',
      type: createType('any', [indexSpec({
        indexedBy: ['r', 'c'],
        where: [bindFrom('r', 'rows.*'), bindFrom('c', 'cols.*')],
        body: [{ op: 'bind', path: 'm.{r}.{c}', value: 1 }],
      })]),
    });

    expect(s.get('m.r1.c1')).toBe(1);
    expect(s.get('m.r1.c2')).toBe(1);
    expect(s.get('m.r2.c1')).toBe(1);
    expect(s.get('m.r2.c2')).toBe(1);
  });
});

// ═══ Async commitment ═══

describe('stdlib: async commitment', () => {
  test('promise-returning impl: pending until resolve, then fulfilled', async () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    let resolve!: (v: number) => void;
    s.impls.set('double', () => new Promise<number>((r) => { resolve = r; }));
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 5 });
    const id = commitmentIds(s)[0];

    // Before settle: record exists, status pending, result not yet mounted.
    expect(s.get(`_commitments.${id}.status`)).toBe('pending');
    expect(s.get('tool.result')).toBeUndefined();

    // Settle the promise; drain pending.
    resolve(10);
    await flushPending(s);

    // After settle: status fulfilled, result mounted, reliability updated.
    expect(s.get(`_commitments.${id}.status`)).toBe('fulfilled');
    expect(s.get('tool.result')).toBe(10);
    expect(s.get('_holders.tool.reliability.alpha')).toBe(2);
  });

  test('promise rejection → violated + reliability β increments', async () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    let reject!: (e: Error) => void;
    s.impls.set('double', () => new Promise<number>((_, r) => { reject = r; }));
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 1 });
    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('pending');

    reject(new Error('upstream timeout'));
    await flushPending(s);

    expect(s.get(`_commitments.${id}.status`)).toBe('violated');
    expect(s.get(`_commitments.${id}.violateReason`)).toBe('upstream timeout');
    expect(s.get('_holders.tool.reliability.beta')).toBe(2);
    expect(s.get('_holders.tool.reliability.alpha') ?? 1).toBe(1);
  });

  test('concurrent async invocations: each settles independently', async () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    const resolvers: Array<(v: number) => void> = [];
    s.impls.set('double', () => new Promise<number>((r) => { resolvers.push(r); }));
    s.insert({ path: 'tool', type: numberFn() });

    // Fire three invocations; all pending.
    s.insert({ path: 'tool', value: 1 });
    s.insert({ path: 'tool', value: 2 });
    s.insert({ path: 'tool', value: 3 });
    const ids = commitmentIds(s);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(s.get(`_commitments.${id}.status`)).toBe('pending');

    // Settle in reverse order.
    resolvers[2](6);
    resolvers[0](2);
    resolvers[1](4);
    await flushPending(s);

    for (const id of ids) expect(s.get(`_commitments.${id}.status`)).toBe('fulfilled');
    // 3 successes → Beta(4, 1).
    expect(s.get('_holders.tool.reliability.alpha')).toBe(4);
  });

  test('async impl that synchronously returns a promise fulfilled already', async () => {
    const s = new Sequence();
    installCommitment(s);
    s.impls.set('double', (n: number) => Promise.resolve(n * 2));
    s.insert({ path: 'tool', type: numberFn() });

    s.insert({ path: 'tool', value: 7 });
    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('pending');

    await flushPending(s);

    expect(s.get(`_commitments.${id}.status`)).toBe('fulfilled');
    expect(s.get('tool.result')).toBe(14);
  });

  test('mixed sync and async invocations coexist', async () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);

    s.insert({ path: 'sync', type: numberFn() });
    s.insert({ path: 'asyn', type: numberFn() });
    s.impls.set('sync', (n: number) => n + 1);
    s.impls.set('asyn', (n: number) => Promise.resolve(n + 100));

    // Path-keyed impls
    s.impls.set('sync', (n: number) => n + 1);
    s.impls.set('asyn', (n: number) => Promise.resolve(n + 100));

    s.insert({ path: 'sync', value: 1 });   // sync path: fulfilled immediately
    s.insert({ path: 'asyn', value: 1 });   // async path: pending

    const ids = commitmentIds(s);
    // Identify which is which by holder
    const syncId = ids.find(i => s.get(`_commitments.${i}.holder`) === 'sync')!;
    const asynId = ids.find(i => s.get(`_commitments.${i}.holder`) === 'asyn')!;

    expect(s.get(`_commitments.${syncId}.status`)).toBe('fulfilled');
    expect(s.get(`_commitments.${asynId}.status`)).toBe('pending');

    await flushPending(s);

    expect(s.get(`_commitments.${asynId}.status`)).toBe('fulfilled');
    expect(s.get('asyn.result')).toBe(101);
  });
});

// ═══ Deadline → violation ═══

describe('stdlib: deadline violation', () => {
  const timedFn = () => createType('fn', [
    param(createType('number')),
    returns(createType('number')),
    impl('pending'),
    temporal('lt', '_rt', 1000),          // absolute deadline at _rt=1000
  ]);

  test('pending commitment violates when clock crosses deadline', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    // Impl never resolves — commitment stays pending in sync emission.
    // (External holder case.)
    s.insert({ path: 'tool', type: timedFn() });

    s.insert({ path: 'tool', value: 5 });
    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('pending');
    expect(s.get(`_commitments.${id}.deadline`)).toBe(1000);

    // Clock is still before deadline — status unchanged.
    advanceClock(s, 500);
    expect(s.get(`_commitments.${id}.status`)).toBe('pending');

    // Crossing the deadline flips status to violated + records reason.
    advanceClock(s, 1500);
    expect(s.get(`_commitments.${id}.status`)).toBe('violated');
    expect(s.get(`_commitments.${id}.violateReason`)).toBe('deadline_exceeded');

    // Reliability prior registers the failure.
    expect(s.get('_holders.tool.reliability.beta')).toBe(2);
  });

  test('commitment that fulfilled before deadline is not violated when clock crosses', async () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    let resolve!: (v: number) => void;
    s.impls.set('pending', () => new Promise<number>((r) => { resolve = r; }));
    s.insert({ path: 'tool', type: timedFn() });

    s.insert({ path: 'tool', value: 5 });
    const id = commitmentIds(s)[0];

    resolve(10);
    await flushPending(s);
    expect(s.get(`_commitments.${id}.status`)).toBe('fulfilled');

    // Clock crosses the would-be deadline; status must stay fulfilled.
    advanceClock(s, 1500);
    expect(s.get(`_commitments.${id}.status`)).toBe('fulfilled');
    expect(s.get(`_commitments.${id}.violateReason`)).toBeUndefined();
  });

  test('relative deadline: temporal(lt, _rt, {add: [_rt, 100]}) at invocation time', () => {
    const s = new Sequence(() => 50);  // start clock at t=50
    installCommitment(s);
    const relFn = () => createType('fn', [
      param(createType('number')),
      returns(createType('number')),
      impl('pending'),
      temporal('lt', '_rt', { add: ['_rt', 100] } as any),
    ]);
    s.insert({ path: 'tool', type: relFn() });

    s.insert({ path: 'tool', value: 1 });
    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.deadline`)).toBe(150); // 50 + 100

    advanceClock(s, 200);
    expect(s.get(`_commitments.${id}.status`)).toBe('violated');
  });
});

// ═══ Reader / hoist ═══

describe('stdlib: reader + hoist', () => {
  test('reader over a flat path set emits path=value lines', () => {
    const s = new Sequence();
    s.insert({ path: 'tools.a', value: 'alpha' });
    s.insert({ path: 'tools.b', value: 'beta' });
    s.insert({ path: 'tools.c', value: 42 });
    installReader(s, 'tools', { source: 'tools.*' });

    const { text, paths } = hoistForReader(s, 'tools');
    expect(paths).toEqual(expect.arrayContaining(['tools.a', 'tools.b', 'tools.c']));
    expect(text).toContain('tools.a = "alpha"');
    expect(text).toContain('tools.b = "beta"');
    expect(text).toContain('tools.c = 42');
  });

  test('gaps render as [[ path : type ]] expansion tokens', () => {
    const s = new Sequence();
    s.insert({ path: 'form.name', type: createType('string') });
    s.insert({ path: 'form.age', type: createType('number') });
    s.insert({ path: 'form.name', value: 'alice' });
    installReader(s, 'form', { source: 'form.*' });

    const { text, gaps } = hoistForReader(s, 'form');
    expect(text).toContain('form.name = "alice"');
    expect(text).toContain('[[ form.age : number ]]');
    expect(gaps.map(g => g.path)).toEqual(['form.age']);
  });

  test('reader over commitments shows live substrate state', async () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({
      path: 'tool',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('number')),
        impl('double'),
      ]),
    });
    s.insert({ path: 'tool', value: 5 });

    installReader(s, 'commitments', { source: '_commitments.*', depth: 2 });
    const { text } = hoistForReader(s, 'commitments');
    expect(text).toContain('.status = "fulfilled"');
    expect(text).toContain('.holder = "tool"');
    expect(text).toContain('.head = "tool.result"');
  });

  test('depth bound limits emitted paths', () => {
    const s = new Sequence();
    s.insert({ path: 'a', value: 1 });
    s.insert({ path: 'a.b', value: 2 });
    s.insert({ path: 'a.b.c', value: 3 });
    s.insert({ path: 'a.b.c.d', value: 4 });
    installReader(s, 'shallow', { source: 'a.*', depth: 2 });

    const { paths } = hoistForReader(s, 'shallow');
    // depth 2 relative to prefix 'a' → at most 2 segs below
    expect(paths).toContain('a.b');
    expect(paths).toContain('a.b.c');
    expect(paths).not.toContain('a.b.c.d');
  });

  test('multiple readers over different slices compose', () => {
    const s = new Sequence();
    s.insert({ path: 'left.x', value: 1 });
    s.insert({ path: 'right.y', value: 2 });
    installReader(s, 'L', { source: 'left.*' });
    installReader(s, 'R', { source: 'right.*' });

    const L = hoistForReader(s, 'L');
    const R = hoistForReader(s, 'R');
    expect(L.text).toContain('left.x = 1');
    expect(L.text).not.toContain('right');
    expect(R.text).toContain('right.y = 2');
    expect(R.text).not.toContain('left');
  });
});

// ═══ Cross-sequence forwarding ═══

describe('stdlib: cross-sequence', () => {
  test('bilateral sync: A mounts → B sees, B mounts → A sees, no echo', () => {
    const A = new Sequence();
    const B = new Sequence();
    const sends: { fromA: Outgoing[]; fromB: Outgoing[] } = { fromA: [], fromB: [] };

    installCrossSequence(A, 'A', (d) => { sends.fromA.push(d); receiveFromPeer(B, 'A', d); });
    installCrossSequence(B, 'B', (d) => { sends.fromB.push(d); receiveFromPeer(A, 'B', d); });

    // A writes locally → should appear on B + emit exactly one outgoing from A.
    A.insert({ path: 'shared.x', value: 1 });
    expect(B.get('shared.x')).toBe(1);
    const xSends = sends.fromA.filter(s => s.path === 'shared.x');
    expect(xSends).toHaveLength(1);
    // B did not re-forward A's delta (no echo).
    const xEchoes = sends.fromB.filter(s => s.path === 'shared.x');
    expect(xEchoes).toHaveLength(0);

    // B writes locally → appears on A, no echo.
    B.insert({ path: 'shared.y', value: 2 });
    expect(A.get('shared.y')).toBe(2);
    expect(sends.fromB.filter(s => s.path === 'shared.y')).toHaveLength(1);
    expect(sends.fromA.filter(s => s.path === 'shared.y')).toHaveLength(0);
  });

  test('internal `_*` paths are not forwarded (substrate-private)', () => {
    const A = new Sequence();
    const B = new Sequence();
    const sent: Outgoing[] = [];
    installCrossSequence(A, 'A', (d) => sent.push(d));
    installCrossSequence(B, 'B', () => {});

    A.insert({ path: 'visible.x', value: 1 });
    // Commitment records would also go through internal paths — verify
    // that `_rt`, `_self`, etc. don't leak.
    A.insert({ path: '_rt', value: 1000 });

    const visibleOnly = sent.filter(s => !s.path.startsWith('_'));
    const internal = sent.filter(s => s.path.startsWith('_'));
    expect(visibleOnly.length).toBeGreaterThan(0);
    expect(internal).toHaveLength(0);
  });

  test('types propagate alongside values', () => {
    const A = new Sequence();
    const B = new Sequence();
    installCrossSequence(A, 'A', (d) => receiveFromPeer(B, 'A', d));
    installCrossSequence(B, 'B', (d) => receiveFromPeer(A, 'B', d));

    A.insert({ path: 'shared.n', type: createType('number') });
    A.insert({ path: 'shared.n', value: 7 });

    expect(B.typeAt('shared.n')?.kind).toBe('number');
    expect(B.get('shared.n')).toBe(7);

    // Violating the type on B should reject (B also knows the schema now).
    const r = B.insert({ path: 'shared.n', value: 'not a number' });
    expect(r.suspended).toBe(true);
  });
});

// ═══ Scope-filtered forwarding ═══

describe('stdlib: scope-filtered cross-sequence', () => {
  test('scopes restrict which paths forward', () => {
    const A = new Sequence();
    const B = new Sequence();
    const sent: Outgoing[] = [];
    installCrossSequence(A, 'A', (d) => { sent.push(d); receiveFromPeer(B, 'A', d); }, ['shared.*']);
    installCrossSequence(B, 'B', () => {});

    A.insert({ path: 'shared.x', value: 1 });
    A.insert({ path: 'private.y', value: 2 });

    expect(B.get('shared.x')).toBe(1);
    expect(B.get('private.y')).toBeUndefined();
    expect(sent.map(s => s.path)).toEqual(['shared.x']);
  });

  test('asymmetric scopes: upstream forwards org-shared; downstream forwards user-specific', () => {
    const user = new Sequence();
    const org = new Sequence();
    const userSent: Outgoing[] = [];
    const orgSent: Outgoing[] = [];
    installCrossSequence(user, 'user', (d) => { userSent.push(d); receiveFromPeer(org, 'user', d); }, ['org.*']);
    installCrossSequence(org, 'org', (d) => { orgSent.push(d); receiveFromPeer(user, 'org', d); }, ['org.*']);

    user.insert({ path: 'org.request.x', value: 'hello' });
    user.insert({ path: 'local.note', value: 'only-me' });

    expect(org.get('org.request.x')).toBe('hello');
    expect(org.get('local.note')).toBeUndefined();
    expect(userSent.map(s => s.path)).toEqual(['org.request.x']);
  });
});

// ═══ Structured prompt document ═══

describe('stdlib: renderDocument (semantic kernel)', () => {
  test('composes identity + text + reader into one document', () => {
    const s = new Sequence();
    s.insert({ path: '_self.identity', value: 'agent-42' });
    s.insert({ path: 'tools.fetch', value: 'available' });
    installReader(s, 'tools', { source: 'tools.*' });

    const sections: DocSection[] = [
      { kind: 'identity', heading: 'IDENTITY' },
      { kind: 'text', heading: 'VALUES', body: 'maintain coherence' },
      { kind: 'reader', heading: 'TOOLS', reader: 'tools' },
    ];
    const { text } = renderDocument(s, sections);

    expect(text).toContain('-- 0.0 IDENTITY');
    expect(text).toContain('identity = "agent-42"');
    expect(text).toContain('-- 0.1 VALUES');
    expect(text).toContain('maintain coherence');
    expect(text).toContain('-- 0.2 TOOLS');
    expect(text).toContain('tools.fetch = "available"');
  });

  test('commitments section shows live status + posterior-mean reliability', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({
      path: 'tool',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('number')),
        impl('double'),
      ]),
    });
    s.insert({ path: 'tool', value: 5 });
    s.insert({ path: 'tool', value: 6 });

    const sections: DocSection[] = [
      { kind: 'commitments', heading: 'OBLIGATIONS' },
    ];
    const { text } = renderDocument(s, sections);

    expect(text).toContain('-- 0.0 OBLIGATIONS');
    expect(text).toContain('holder="tool"');
    expect(text).toContain('status="fulfilled"');
    expect(text).toContain('reliability='); // Beta(3, 1), mean = 0.75
    expect(text).toContain('reliability=0.750');
  });

  test('commitments section filters by status (pending only)', () => {
    const s = new Sequence();
    installCommitment(s);
    const fn = () => createType('fn', [
      param(createType('number')),
      returns(createType('number')),
      impl('slow'),
    ]);
    s.insert({ path: 'tool', type: fn() });
    s.impls.set('slow', () => new Promise(() => {})); // Never resolves

    s.insert({ path: 'tool', value: 1 });
    s.insert({ path: 'tool', value: 2 });

    const { text } = renderDocument(s, [
      { kind: 'commitments', heading: 'PENDING', status: 'pending' },
    ]);

    expect(text).toContain('-- 0.0 PENDING');
    // Both invocations should appear as pending
    const matches = text.match(/status="pending"/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  test('gaps in reader sections surface as expansion tokens at document level', () => {
    const s = new Sequence();
    s.insert({ path: 'form.required', type: createType('string') });
    s.insert({ path: 'form.optional', value: 'filled' });
    installReader(s, 'form', { source: 'form.*' });

    const { text, gaps } = renderDocument(s, [
      { kind: 'reader', heading: 'FORM', reader: 'form' },
    ]);

    expect(text).toContain('[[ form.required : string ]]');
    expect(text).toContain('form.optional = "filled"');
    expect(gaps.map(g => g.path)).toContain('form.required');
  });
});

// ═══ Backward inference — goal → plan → execute ═══

describe('stdlib: backward inference (search + executePlan)', () => {
  test('goal already satisfied → empty plan', () => {
    const s = new Sequence();
    s.insert({ path: 'x', value: 5 });
    const plan = search(s, 'x', createType('number'));
    expect(plan.meetable).toBe(true);
    expect(plan.steps).toHaveLength(0);
  });

  test('one-step plan: goal matches a tool whose input is already available', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({
      path: 'doubler',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('number')),
        impl('double'),
      ]),
    });
    // An available number input
    s.insert({ path: 'input', value: 5 });

    const plan = search(s, 'goal', createType('number'));
    expect(plan.meetable).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].toolPath).toBe('doubler');
    expect(plan.steps[0].inputSource).toEqual({ kind: 'path', path: 'input' });
  });

  test('unmeetable: no tool produces the goal type', () => {
    const s = new Sequence();
    installStdLib(s);
    const plan = search(s, 'goal', createType('number'));
    expect(plan.meetable).toBe(false);
    expect(plan.gaps[0].reason).toBe('no tool produces this type');
  });

  test('two-step plan: chained tools (A produces input for B)', () => {
    const s = new Sequence();
    installStdLib(s);
    // stringify: number -> string
    s.impls.set('stringify', (n: number) => String(n));
    s.insert({
      path: 'stringify',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('string')),
        impl('stringify'),
      ]),
    });
    // increment: number -> number
    s.impls.set('inc', (n: number) => n + 1);
    s.insert({
      path: 'inc',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('number')),
        impl('inc'),
      ]),
    });
    // Available number to seed the chain
    s.insert({ path: 'seed', value: 7 });

    // Goal: a string. Need stringify(something:number). Something can be
    // `seed` directly (1 step) or inc(seed) (2 steps). Planner returns
    // the most reliable path; with uniform priors, any complete plan works.
    const plan = search(s, 'goal', createType('string'));
    expect(plan.meetable).toBe(true);
    expect(plan.steps[0].toolPath).toBe('stringify');
  });

  test('planner prefers higher-reliability candidates', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('reliable', (n: number) => n * 2);
    s.impls.set('unreliable', (n: number) => n * 2);
    s.insert({
      path: 'reliable',
      type: createType('fn', [param(createType('number')), returns(createType('number')), impl('reliable')]),
    });
    s.insert({
      path: 'unreliable',
      type: createType('fn', [param(createType('number')), returns(createType('number')), impl('unreliable')]),
    });
    // Directly mount reliability priors
    s.insert({ path: '_holders.reliable.reliability.alpha', value: 10 });
    s.insert({ path: '_holders.reliable.reliability.beta', value: 1 });
    s.insert({ path: '_holders.unreliable.reliability.alpha', value: 1 });
    s.insert({ path: '_holders.unreliable.reliability.beta', value: 10 });
    s.insert({ path: 'input', value: 5 });

    const plan = search(s, 'goal', createType('number'));
    expect(plan.meetable).toBe(true);
    expect(plan.steps[0].toolPath).toBe('reliable');
    expect(plan.expectedReliability).toBeGreaterThan(0.9);
  });

  test('executePlan runs tool invocations end-to-end', async () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({
      path: 'doubler',
      type: createType('fn', [param(createType('number')), returns(createType('number')), impl('double')]),
    });
    s.insert({ path: 'input', value: 21 });

    const plan = search(s, 'out', createType('number'));
    expect(plan.meetable).toBe(true);
    await executePlan(s, plan);

    // Invoking doubler with input=21 mounts tool.result=42
    expect(s.get('doubler.result')).toBe(42);
  });

  test('flattenPlan: chained sub-plans linearize in dependency order', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('stringify', (n: number) => String(n));
    s.insert({
      path: 'stringify',
      type: createType('fn', [param(createType('number')), returns(createType('string')), impl('stringify')]),
    });
    s.impls.set('inc', (n: number) => n + 1);
    s.insert({
      path: 'inc',
      type: createType('fn', [param(createType('number')), returns(createType('number')), impl('inc')]),
    });
    // No pre-existing number; sub-plan must supply it.
    // Actually: we need a number input SOMEWHERE to seed inc. Without
    // a seed, the plan is unmeetable.
    s.insert({ path: 'seed', value: 1 });

    const plan = search(s, 'out', createType('string'));
    expect(plan.meetable).toBe(true);
    const flat = flattenPlan(plan);
    expect(flat.length).toBeGreaterThanOrEqual(1);
    // Final step is always the stringify step producing the goal type.
    expect(flat[flat.length - 1].toolPath).toBe('stringify');
  });
});

// ═══ Conditional posterior + projection feasibility ═══

describe('stdlib: conditional reliability + feasibility', () => {
  const numFn = (implId: string) => createType('fn', [
    param(createType('number')),
    returns(createType('number')),
    impl(implId),
  ]);

  test('subtypeKey: coarse structural discriminator', () => {
    expect(subtypeKey(5)).toBe('number');
    expect(subtypeKey('hi')).toBe('string');
    expect(subtypeKey(true)).toBe('boolean');
    expect(subtypeKey([1, 2])).toBe('arr');
    expect(subtypeKey({ a: 1, b: 2 })).toBe('obj:a,b');
    expect(subtypeKey({ b: 1, a: 2 })).toBe('obj:a,b'); // sorted
    expect(subtypeKey(null)).toBe('null');
  });

  test('fulfillment updates BOTH aggregate and conditional posteriors', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numFn('double') });

    s.insert({ path: 'tool', value: 5 }); // number input

    // Aggregate: Beta(2, 1).
    expect(s.get('_holders.tool.reliability.alpha')).toBe(2);
    // Conditional on 'number' sub-type: Beta(2, 1).
    expect(s.get('_holders.tool.subtype.number.reliability.alpha')).toBe(2);
  });

  test('per-sub-type reliability: success on one input type, failure on another', () => {
    const s = new Sequence();
    installCommitment(s);
    installReliability(s);
    // Impl succeeds on numbers, throws on strings (we shape the tool to
    // accept 'any' so strings pass admission but then the impl decides).
    s.impls.set('picky', (v: unknown) => {
      if (typeof v === 'number') return v * 2;
      throw new Error('only numbers');
    });
    s.insert({
      path: 'tool',
      type: createType('fn', [
        param(createType('any')),
        returns(createType('any')),
        impl('picky'),
      ]),
    });

    s.insert({ path: 'tool', value: 5 });       // number → fulfilled
    s.insert({ path: 'tool', value: 7 });       // number → fulfilled
    s.insert({ path: 'tool', value: 'hello' }); // string → violated

    // Conditional on number: Beta(3, 1), mean = 0.75
    expect(s.get('_holders.tool.subtype.number.reliability.alpha')).toBe(3);
    expect(s.get('_holders.tool.subtype.number.reliability.beta') ?? 1).toBe(1);
    // Conditional on string: Beta(1, 2), mean = 0.333
    expect(s.get('_holders.tool.subtype.string.reliability.beta')).toBe(2);
    expect(s.get('_holders.tool.subtype.string.reliability.alpha') ?? 1).toBe(1);
    // Aggregate: Beta(3, 2), mean = 0.6
    expect(s.get('_holders.tool.reliability.alpha')).toBe(3);
    expect(s.get('_holders.tool.reliability.beta')).toBe(2);
  });

  test('search ranks candidates using conditional posterior for THIS input', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('a', (n: number) => n * 2);
    s.impls.set('b', (n: number) => n * 2);
    s.insert({ path: 'toolA', type: numFn('a') });
    s.insert({ path: 'toolB', type: numFn('b') });

    // toolA has great aggregate (many successes on unknown input types)
    // but poor conditional on 'number' specifically.
    s.insert({ path: '_holders.toolA.reliability.alpha', value: 100 });
    s.insert({ path: '_holders.toolA.reliability.beta', value: 1 });
    s.insert({ path: '_holders.toolA.subtype.number.reliability.alpha', value: 1 });
    s.insert({ path: '_holders.toolA.subtype.number.reliability.beta', value: 10 });

    // toolB has modest aggregate but strong conditional on 'number'.
    s.insert({ path: '_holders.toolB.reliability.alpha', value: 3 });
    s.insert({ path: '_holders.toolB.reliability.beta', value: 3 });
    s.insert({ path: '_holders.toolB.subtype.number.reliability.alpha', value: 15 });
    s.insert({ path: '_holders.toolB.subtype.number.reliability.beta', value: 1 });

    // Available number input
    s.insert({ path: 'input', value: 5 });

    const plan = search(s, 'goal', createType('number'));
    expect(plan.meetable).toBe(true);
    // Planner picks the tool with better conditional for THIS input type.
    expect(plan.steps[0].toolPath).toBe('toolB');
  });

  test('feasibility passes when bound resolvable and reliability sufficient', () => {
    const s = new Sequence(() => 1000);
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numFn('double') });
    s.insert({ path: 'input', value: 5 });

    const plan = search(s, 'goal', createType('number'));
    // Goal type carries a temporal bound; bound resolves to literal 2000
    const goalType = createType('number', [temporal('lt', '_rt', 2000)]);
    const f = feasibility(s, plan, { type: goalType, confidence: 0.4 });
    expect(f.passes).toBe(true);
    expect(f.boundResolved).toBe(2000);
    expect(f.boundStatus).toBe('within_bound');
  });

  test('feasibility rejects plan when bound already exceeded at plan time', () => {
    const s = new Sequence(() => 3000);
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numFn('double') });
    s.insert({ path: 'input', value: 5 });

    const plan = search(s, 'goal', createType('number'));
    const goalType = createType('number', [temporal('lt', '_rt', 2000)]);
    const f = feasibility(s, plan, { type: goalType });
    expect(f.passes).toBe(false);
    expect(f.boundStatus).toBe('exceeded');
    expect(f.reason).toContain('deadline');
  });

  test('feasibility resolves path-referenced bound from live state', () => {
    const s = new Sequence(() => 100);
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numFn('double') });
    s.insert({ path: 'input', value: 5 });

    // Budget lives elsewhere in the substrate and CAN CHANGE.
    s.insert({ path: 'session.expiresAt', value: 500 });

    const plan = search(s, 'goal', createType('number'));
    const goalType = createType('number', [temporal('lt', '_rt', 'session.expiresAt')]);

    // Initially within bound (100 < 500)
    let f = feasibility(s, plan, { type: goalType });
    expect(f.passes).toBe(true);
    expect(f.boundResolved).toBe(500);

    // Budget moves — session gets shorter than current time
    s.insert({ path: 'session.expiresAt', value: 50 });
    f = feasibility(s, plan, { type: goalType });
    expect(f.passes).toBe(false);
    expect(f.boundStatus).toBe('exceeded');
  });

  test('feasibility rejects when reliability below confidence threshold', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('shaky', (n: number) => n);
    s.insert({ path: 'tool', type: numFn('shaky') });
    s.insert({ path: 'input', value: 5 });

    // Engineer a poor conditional posterior for number input
    s.insert({ path: '_holders.tool.subtype.number.reliability.alpha', value: 1 });
    s.insert({ path: '_holders.tool.subtype.number.reliability.beta', value: 9 });

    const plan = search(s, 'goal', createType('number'));
    const f = feasibility(s, plan, { type: createType('number'), confidence: 0.5 });
    expect(f.passes).toBe(false);
    expect(f.reliability).toBeLessThan(0.5);
    expect(f.reason).toContain('reliability');
  });

  test('additive temporal bound: _rt + offset', () => {
    const s = new Sequence(() => 100);
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numFn('double') });
    s.insert({ path: 'input', value: 5 });

    const plan = search(s, 'goal', createType('number'));
    // Bound = _rt + 50 → 150 at plan time
    const goalType = createType('number', [
      temporal('lt', '_rt', { add: ['_rt', 50] } as any),
    ]);
    const f = feasibility(s, plan, { type: goalType });
    expect(f.boundResolved).toBe(150);
    expect(f.passes).toBe(true);
  });
});

// ═══ Refinement promotion ═══

describe('stdlib: MDL-gated refinement promotion', () => {
  const picky = () => createType('fn', [
    param(createType('any')),
    returns(createType('any')),
    impl('picky'),
  ]);

  test('refiner accumulates child posteriors even before activation', () => {
    const s = new Sequence();
    installStdLib(s);
    // Impl: succeeds on positive, fails on negative
    s.impls.set('picky', (n: number) => {
      if (n < 0) throw new Error('no negatives');
      return n * 2;
    });
    // Sign discriminator: number → 'pos' | 'neg'
    s.impls.set('signOf', (v: number) => (v >= 0 ? 'pos' : 'neg'));
    s.insert({ path: 'tool', type: picky() });
    registerRefiner(s, 'tool', 'sign', {
      parentKey: 'number',
      discriminator: 'signOf',
      minEvidence: 3,
      minDivergence: 0.3,
    });

    // Accumulate evidence under the candidate refiner: NOT active yet,
    // but both child buckets populate.
    s.insert({ path: 'tool', value: 1 });
    s.insert({ path: 'tool', value: 2 });
    s.insert({ path: 'tool', value: 3 });
    s.insert({ path: 'tool', value: -1 });
    s.insert({ path: 'tool', value: -2 });

    expect(s.get('_holders.tool.subtype.number/pos.reliability.alpha')).toBe(4); // 3 successes
    expect(s.get('_holders.tool.subtype.number/neg.reliability.beta')).toBe(3);  // 2 failures
    // Also accumulating in the coarse bucket
    expect(s.get('_holders.tool.subtype.number.reliability.alpha')).toBe(4);
    expect(s.get('_holders.tool.subtype.number.reliability.beta')).toBe(3);
  });

  test('refiner activates when divergence + evidence thresholds met', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('picky', (n: number) => {
      if (n < 0) throw new Error('no negatives');
      return n * 2;
    });
    s.impls.set('signOf', (v: number) => (v >= 0 ? 'pos' : 'neg'));
    s.insert({ path: 'tool', type: picky() });
    registerRefiner(s, 'tool', 'sign', {
      parentKey: 'number',
      discriminator: 'signOf',
      minEvidence: 3,
      minDivergence: 0.3,
    });

    // 4 positives (all succeed) + 4 negatives (all fail)
    for (const n of [1, 2, 3, 4]) s.insert({ path: 'tool', value: n });
    for (const n of [-1, -2, -3, -4]) s.insert({ path: 'tool', value: n });

    // pos: Beta(5, 1), mean ≈ 0.833
    // neg: Beta(1, 5), mean ≈ 0.167
    // divergence ≈ 0.666 > 0.3 threshold; evidence per bucket = 4 > 3
    expect(s.get('_holders.tool.refiners.sign.active')).toBe(true);
  });

  test('refiner stays inactive when divergence is below threshold', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('uniform', (_n: number) => 'ok');
    s.impls.set('signOf', (v: number) => (v >= 0 ? 'pos' : 'neg'));
    s.insert({
      path: 'tool',
      type: createType('fn', [param(createType('any')), returns(createType('any')), impl('uniform')]),
    });
    registerRefiner(s, 'tool', 'sign', {
      parentKey: 'number',
      discriminator: 'signOf',
      minEvidence: 3,
      minDivergence: 0.3,
    });

    // All succeed regardless of sign — buckets converge to same mean
    for (const n of [1, 2, 3, 4, -1, -2, -3, -4]) {
      s.insert({ path: 'tool', value: n });
    }

    // Both buckets: all successes, means ≈ equal. Divergence < threshold.
    expect(s.get('_holders.tool.refiners.sign.active') ?? false).toBe(false);
  });

  test('after activation, feasibility reads refined posterior per input', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('picky', (n: number) => {
      if (n < 0) throw new Error('no negatives');
      return n * 2;
    });
    s.impls.set('signOf', (v: number) => (v >= 0 ? 'pos' : 'neg'));
    s.insert({ path: 'tool', type: picky() });
    registerRefiner(s, 'tool', 'sign', {
      parentKey: 'number',
      discriminator: 'signOf',
      minEvidence: 2,
      minDivergence: 0.2,
    });

    // Train
    for (const n of [1, 2, 3, 4]) s.insert({ path: 'tool', value: n });
    for (const n of [-1, -2, -3, -4]) s.insert({ path: 'tool', value: n });

    expect(s.get('_holders.tool.refiners.sign.active')).toBe(true);

    // Separately prepared inputs (independent paths so planner picks
    // the intended one)
    s.insert({ path: 'inputPos', value: 5 });
    s.insert({ path: 'inputNeg', value: -5 });

    // Assert directly via feasibility — refined posterior differs sharply
    // by input sign despite the tool's aggregate being uniform.
    const makeStep = (p: string) => ({
      toolPath: 'tool',
      inputSource: { kind: 'path' as const, path: p },
      inputType: createType('any'),
      outputType: createType('any'),
      reliability: 1,
    });
    const fPos = feasibility(s, {
      goalPath: 'g', goalType: createType('any'),
      steps: [makeStep('inputPos')],
      gaps: [], meetable: true, expectedReliability: 1,
    });
    const fNeg = feasibility(s, {
      goalPath: 'g', goalType: createType('any'),
      steps: [makeStep('inputNeg')],
      gaps: [], meetable: true, expectedReliability: 1,
    });
    expect(fPos.reliability).toBeGreaterThan(0.7);
    expect(fNeg.reliability).toBeLessThan(0.3);
  });

  test('multiple refiners coexist; each activates independently', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('picky', (v: unknown) => {
      if (typeof v === 'number' && v < 0) throw new Error('neg');
      if (typeof v === 'string' && v.length > 5) throw new Error('long');
      return 'ok';
    });
    s.impls.set('signOf', (v: number) => (v >= 0 ? 'pos' : 'neg'));
    s.impls.set('lenBand', (v: string) => (v.length > 5 ? 'long' : 'short'));
    s.insert({
      path: 'tool',
      type: createType('fn', [param(createType('any')), returns(createType('any')), impl('picky')]),
    });
    registerRefiner(s, 'tool', 'sign', {
      parentKey: 'number', discriminator: 'signOf', minEvidence: 2, minDivergence: 0.2,
    });
    registerRefiner(s, 'tool', 'len', {
      parentKey: 'string', discriminator: 'lenBand', minEvidence: 2, minDivergence: 0.2,
    });

    // Train number axis
    for (const n of [1, 2, 3]) s.insert({ path: 'tool', value: n });
    for (const n of [-1, -2, -3]) s.insert({ path: 'tool', value: n });
    // Train string axis
    for (const s_ of ['a', 'b', 'c']) s.insert({ path: 'tool', value: s_ });
    for (const s_ of ['abcdef', 'abcdefg', 'abcdefgh']) s.insert({ path: 'tool', value: s_ });

    expect(s.get('_holders.tool.refiners.sign.active')).toBe(true);
    expect(s.get('_holders.tool.refiners.len.active')).toBe(true);
  });
});

// ═══ Latency posteriors + dependency-model feasibility ═══

describe('stdlib: latency posteriors', () => {
  const numFn = (implId: string) => createType('fn', [
    param(createType('number')),
    returns(createType('number')),
    impl(implId),
  ]);

  test('fulfillment tracks latency running mean per sub-type', () => {
    let nowVal = 0;
    const clock = () => nowVal;
    const s = new Sequence(clock);
    installStdLib(s);
    // Impl that takes 50ms of clock time
    s.impls.set('slow', (n: number) => { nowVal += 50; return n * 2; });
    s.insert({ path: 'tool', type: numFn('slow') });

    // Three invocations: latencies 50, 50, 50 → mean 50
    nowVal = 100; s.insert({ path: 'tool', value: 1 });
    nowVal = 200; s.insert({ path: 'tool', value: 2 });
    nowVal = 300; s.insert({ path: 'tool', value: 3 });

    // Aggregate + number-conditional should both reflect the observations
    expect(s.get('_holders.tool.latency.count')).toBe(3);
    expect(s.get('_holders.tool.latency.mean')).toBeCloseTo(50, 0);
    expect(s.get('_holders.tool.subtype.number.latency.count')).toBe(3);
    expect(s.get('_holders.tool.subtype.number.latency.mean')).toBeCloseTo(50, 0);
  });

  test('variance tracked via M2; stddev reconstructable on read', () => {
    let nowVal = 0;
    const clock = () => nowVal;
    const s = new Sequence(clock);
    installStdLib(s);
    const durations = [40, 50, 60];
    let next = 0;
    s.impls.set('varied', (_n: number) => { nowVal += durations[next++]; return 0; });
    s.insert({ path: 'tool', type: numFn('varied') });

    for (let i = 0; i < 3; i++) {
      nowVal = i * 1000;
      s.insert({ path: 'tool', value: i });
    }

    const mean = s.get('_holders.tool.latency.mean') as number;
    const m2 = s.get('_holders.tool.latency.m2') as number;
    const count = s.get('_holders.tool.latency.count') as number;
    const variance = m2 / (count - 1);
    expect(mean).toBeCloseTo(50, 0);
    expect(variance).toBeCloseTo(100, 0); // (40-50)² + 0 + (60-50)² = 200; ÷ (3-1) = 100
  });

  test('feasibility: projected completion exceeds bound → rejected', () => {
    let nowVal = 0;
    const clock = () => nowVal;
    const s = new Sequence(clock);
    installStdLib(s);
    s.impls.set('slow', (n: number) => { nowVal += 100; return n * 2; });
    s.insert({ path: 'tool', type: numFn('slow') });
    s.insert({ path: 'input', value: 5 });

    // Train: two invocations, each ~100ms
    nowVal = 0;   s.insert({ path: 'tool', value: 1 });
    nowVal = 150; s.insert({ path: 'tool', value: 2 });

    // Now we're at t=250 (after 100ms for second invocation). Mean latency = 100.
    // A plan with a 200ms budget from now (t=250 → bound=450) CAN fit (projected=350).
    // A plan with a 50ms budget (bound=300) CAN'T (projected=350 > 300).

    nowVal = 250;
    const plan = search(s, 'goal', createType('number'));

    const fPass = feasibility(s, plan, { type: createType('number', [temporal('lt', '_rt', 450)]) });
    expect(fPass.passes).toBe(true);
    expect(fPass.boundStatus).toBe('within_bound');
    expect(fPass.projectedCompletion).toBeCloseTo(350, 0);

    const fFail = feasibility(s, plan, { type: createType('number', [temporal('lt', '_rt', 300)]) });
    expect(fFail.passes).toBe(false);
    expect(fFail.boundStatus).toBe('will_exceed');
    expect(fFail.reason).toContain('projected completion');
  });

  test('dependency=worst_case: reliability=min, latency+=2σ safety margin', () => {
    let nowVal = 0;
    const clock = () => nowVal;
    const s = new Sequence(clock);
    installStdLib(s);
    const durations = [80, 100, 120]; // stddev ≈ 20
    let next = 0;
    s.impls.set('varied', (_n: number) => { nowVal += durations[next++ % 3]; return 1; });
    s.insert({ path: 'tool', type: numFn('varied') });
    s.insert({ path: 'input', value: 5 });

    // Train with varying latencies
    for (let i = 0; i < 3; i++) {
      nowVal = i * 1000;
      s.insert({ path: 'tool', value: i });
    }

    nowVal = 5000;
    const plan = search(s, 'goal', createType('number'));

    const indep = feasibility(s, plan, {
      type: createType('number'), dependency: 'independent',
    });
    const worst = feasibility(s, plan, {
      type: createType('number'), dependency: 'worst_case',
    });

    // worst_case latency should be larger (adds 2σ margin)
    expect(worst.expectedLatencyMs).toBeGreaterThan(indep.expectedLatencyMs!);
  });

  test('no bound declared: boundStatus=no_bound; feasibility ignores time', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('ok', (n: number) => n);
    s.insert({ path: 'tool', type: numFn('ok') });
    s.insert({ path: 'input', value: 5 });
    s.insert({ path: 'tool', value: 1 });

    const plan = search(s, 'goal', createType('number'));
    const f = feasibility(s, plan, { type: createType('number') });
    expect(f.boundStatus).toBe('no_bound');
    expect(f.passes).toBe(true);
  });
});

// ═══ LLM-participated plan selection ═══

describe('stdlib: candidate plans + chooser-participated selection', () => {
  const numFn = (implId: string) => createType('fn', [
    param(createType('number')),
    returns(createType('number')),
    impl(implId),
  ]);

  test('searchCandidates returns top-K viable plans by reliability', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('a', (n: number) => n * 2);
    s.impls.set('b', (n: number) => n * 3);
    s.impls.set('c', (n: number) => n + 1);
    s.insert({ path: 'toolA', type: numFn('a') });
    s.insert({ path: 'toolB', type: numFn('b') });
    s.insert({ path: 'toolC', type: numFn('c') });
    s.insert({ path: 'input', value: 5 });

    // Divergent aggregate reliabilities
    s.insert({ path: '_holders.toolA.reliability.alpha', value: 9 });
    s.insert({ path: '_holders.toolA.reliability.beta', value: 1 });
    s.insert({ path: '_holders.toolB.reliability.alpha', value: 5 });
    s.insert({ path: '_holders.toolB.reliability.beta', value: 5 });
    s.insert({ path: '_holders.toolC.reliability.alpha', value: 1 });
    s.insert({ path: '_holders.toolC.reliability.beta', value: 9 });

    const plans = searchCandidates(s, 'goal', createType('number'), 3);
    expect(plans).toHaveLength(3);
    expect(plans[0].steps[0].toolPath).toBe('toolA');
    expect(plans[1].steps[0].toolPath).toBe('toolB');
    expect(plans[2].steps[0].toolPath).toBe('toolC');
    expect(plans[0].expectedReliability).toBeGreaterThan(plans[1].expectedReliability);
  });

  test('candidates section renders plans as expansion tokens in prompt', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('fast', (n: number) => n * 2);
    s.impls.set('slow', (n: number) => n * 3);
    s.insert({ path: 'fast', type: numFn('fast') });
    s.insert({ path: 'slow', type: numFn('slow') });
    s.insert({ path: 'input', value: 5 });
    s.insert({ path: '_self.identity', value: 'agent' });

    const sections: DocSection[] = [
      { kind: 'identity', heading: 'IDENTITY' },
      {
        kind: 'candidates',
        heading: 'PLAN_OPTIONS',
        goalPath: 'goal',
        goalType: createType('number'),
        k: 3,
      },
    ];
    const { text } = renderDocument(s, sections);
    expect(text).toContain('-- 0.1 PLAN_OPTIONS');
    expect(text).toContain('[[ candidate.0 :');
    expect(text).toContain('reliability=');
    expect(text).toContain('fast(path:input)');
  });

  test('no viable candidates → (no viable plan) placeholder', () => {
    const s = new Sequence();
    installStdLib(s);
    const { text } = renderDocument(s, [
      { kind: 'candidates', heading: 'PLANS', goalPath: 'g', goalType: createType('number') },
    ]);
    expect(text).toContain('(no viable plan)');
  });

  test('chooser picks plan, then executePlan runs the chosen one', async () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('chosen', (n: number) => n * 10);
    s.impls.set('unchosen', (n: number) => n * 2);
    s.insert({ path: 'chosen', type: numFn('chosen') });
    s.insert({ path: 'unchosen', type: numFn('unchosen') });
    s.insert({ path: 'input', value: 5 });

    const plans = searchCandidates(s, 'goal', createType('number'));
    expect(plans.length).toBeGreaterThanOrEqual(2);

    // Simulate: chooser picks the first candidate (could be LLM output
    // mounting `_chooser.selection = 0`).
    const selectedIdx = plans.findIndex(p => p.steps[0].toolPath === 'chosen');
    const selected = plans[selectedIdx];

    await executePlan(s, selected);
    expect(s.get('chosen.result')).toBe(50);
    expect(s.get('unchosen.result')).toBeUndefined();
  });

  test('candidates renders feasibility annotations including latency when known', () => {
    let nowVal = 0;
    const clock = () => nowVal;
    const s = new Sequence(clock);
    installStdLib(s);
    s.impls.set('track', (n: number) => { nowVal += 30; return n; });
    s.insert({ path: 'tool', type: numFn('track') });
    s.insert({ path: 'input', value: 5 });

    // Train so the latency posterior exists
    nowVal = 0;   s.insert({ path: 'tool', value: 1 });
    nowVal = 100; s.insert({ path: 'tool', value: 2 });

    const { text } = renderDocument(s, [
      { kind: 'candidates', heading: 'PLANS', goalPath: 'g', goalType: createType('number') },
    ]);
    expect(text).toContain('expectedMs=');
  });
});

// ═══ Full stack composition ═══

describe('stdlib: installStdLib composes all features together', () => {
  test('all install*() calls cooperate with no kernel diff', () => {
    const s = new Sequence();
    installStdLib(s);
    s.impls.set('double', (n: number) => n * 2);
    s.insert({ path: 'tool', type: numberFn() });
    s.insert({ path: 'tool', value: 3 });

    // Commitment elected, invocation succeeded, reliability updated.
    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('fulfilled');
    expect(s.get('tool.result')).toBe(6);
    expect(s.get('_holders.tool.reliability.alpha')).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// END-TO-END PRODUCT INTEGRATION
//
// Proves the whole stack works as one loop:
//   user sequence — installStdLib + cross-sequence to org
//   user mounts a goal / tool invocation
//   commitment elected, async impl runs, result mounts, reliability
//   updates, cross-sequence forwards shared paths to org, org sees the
//   result
//   render the semantic kernel prompt — shows identity, tools, and
//   commitment history with posterior-mean reliability
// ═══════════════════════════════════════════════════════════════════════

describe('stdlib: full-stack product integration', () => {
  test('user agent → async tool → cross-sequence → org observes; prompt renders', async () => {
    // --- Set up two sequences, wire bilateral cross-sequence forwarding
    const user = new Sequence(() => 1000);
    const org = new Sequence(() => 1000);

    installStdLib(user);
    installStdLib(org);

    installCrossSequence(user, 'user', (d) => receiveFromPeer(org, 'user', d), ['shared.*']);
    installCrossSequence(org, 'org', (d) => receiveFromPeer(user, 'org', d), ['shared.*']);

    // --- Register an async tool impl on the user side
    let resolveCall!: (v: number) => void;
    user.impls.set('compute', () => new Promise<number>((r) => { resolveCall = r; }));

    // Tool has a deadline: must fulfill before _rt = 2000
    user.insert({
      path: 'shared.tool',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('number')),
        impl('compute'),
        temporal('lt', '_rt', 2000),
      ]),
    });

    // --- Invoke
    user.insert({ path: 'shared.tool', value: 21 });
    const id = commitmentIds(user)[0];

    // Commitment is pending; deadline is recorded; cross-sequence
    // forwarded the schema + input to org.
    expect(user.get(`_commitments.${id}.status`)).toBe('pending');
    expect(user.get(`_commitments.${id}.deadline`)).toBe(2000);

    // --- Fulfill the impl
    resolveCall(42);
    await flushPending(user);

    expect(user.get(`_commitments.${id}.status`)).toBe('fulfilled');
    expect(user.get('shared.tool.result')).toBe(42);

    // Result forwarded cross-sequence to org
    expect(org.get('shared.tool.result')).toBe(42);

    // Reliability updated on the user's side; not forwarded (private)
    expect(user.get('_holders.shared.tool.reliability.alpha')).toBe(2);
    expect(org.get('_holders.shared.tool.reliability.alpha')).toBeUndefined();

    // --- Render the semantic kernel prompt on the user side
    installReader(user, 'tools', { source: 'shared.*', depth: 3 });
    const { text } = renderDocument(user, [
      { kind: 'identity', heading: 'IDENTITY' },
      { kind: 'text', heading: 'VALUES', body: 'maintain coherence with peers' },
      { kind: 'reader', heading: 'TOOLS', reader: 'tools' },
      { kind: 'commitments', heading: 'OBLIGATIONS' },
    ]);

    expect(text).toContain('identity = "user"');
    expect(text).toContain('now = 1000');
    expect(text).toContain('maintain coherence with peers');
    expect(text).toContain('shared.tool.input = 21');
    expect(text).toContain('shared.tool.result = 42');
    expect(text).toContain('status="fulfilled"');
    expect(text).toContain('reliability=');
  });

  test('deadline-violated commitment updates reliability and renders in prompt', () => {
    const s = new Sequence(() => 100);
    installStdLib(s);
    s.insert({ path: '_self.identity', value: 'agent' });
    s.insert({
      path: 'tool',
      type: createType('fn', [
        param(createType('number')),
        returns(createType('number')),
        impl('pending'),
        temporal('lt', '_rt', 200),
      ]),
    });

    s.insert({ path: 'tool', value: 1 });
    advanceClock(s, 300);  // crosses deadline

    const id = commitmentIds(s)[0];
    expect(s.get(`_commitments.${id}.status`)).toBe('violated');
    expect(s.get(`_commitments.${id}.violateReason`)).toBe('deadline_exceeded');
    expect(s.get('_holders.tool.reliability.beta')).toBe(2);

    const { text } = renderDocument(s, [
      { kind: 'identity', heading: 'IDENTITY' },
      { kind: 'commitments', heading: 'HISTORY' },
    ]);
    expect(text).toContain('status="violated"');
    expect(text).toContain('deadline=200');
    expect(text).toContain('reliability=0.333'); // Beta(1, 2), mean 1/3
  });
});
