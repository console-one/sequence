/**
 * partition.test.ts — Partition model enforcement in the kernel.
 *
 * Six partitions: state, proc, id, req, chan, proj.
 * Path prefix determines partition. Unprefixed defaults to state.
 * Reference direction rules enforced on mount.
 */

import { Sequence, partitionOf, partitionOfType } from '../sequence';
import { createType, ref, derived, partition } from '../type';

// ═══════════════════════════════════════════════════════════════════════
// 1. partitionOf — prefix detection
// ═══════════════════════════════════════════════════════════════════════

describe('partitionOf', () => {

  test('prefixed paths return correct partition', () => {
    expect(partitionOf('state.contracts.acme')).toBe('state');
    expect(partitionOf('proc.p123.claims')).toBe('proc');
    expect(partitionOf('id.users.alice')).toBe('id');
    expect(partitionOf('req.r55.target')).toBe('req');
    expect(partitionOf('chan.users.alice.desktop')).toBe('chan');
    expect(partitionOf('proj.session123.view')).toBe('proj');
  });

  test('unprefixed paths default to state', () => {
    expect(partitionOf('contracts.acme')).toBe('state');
    expect(partitionOf('mydata')).toBe('state');
    expect(partitionOf('foo.bar.baz')).toBe('state');
  });

  test('internal paths (_*) return state', () => {
    expect(partitionOf('_rt')).toBe('state');
    expect(partitionOf('_deps.foo')).toBe('state');
    expect(partitionOf('_exec.3.time')).toBe('state');
    expect(partitionOf('_blocks.7.status')).toBe('state');
  });

  test('bare partition name without dot is detected', () => {
    // A path that is just "state" with no dot — prefix IS the whole path
    expect(partitionOf('state')).toBe('state');
    expect(partitionOf('proc')).toBe('proc');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Partition reference rules — enforcement on mount
// ═══════════════════════════════════════════════════════════════════════

describe('partition reference enforcement', () => {

  test('state can reference state (allowed)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'state.source', 42);
    const r = seq.mount('schema', 'state.derived', createType('number', [ref('state.source')]));
    expect(r.ok).toBe(true);
  });

  test('state can reference id (allowed)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'id.users.alice.role', 'admin');
    const r = seq.mount('schema', 'state.contracts.acme.approver', createType('string', [ref('id.users.alice.role')]));
    expect(r.ok).toBe(true);
  });

  test('state cannot reference proc (rejected)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'proc.p1.status', 'running');
    const r = seq.mount('schema', 'state.fact', createType('string', [ref('proc.p1.status')]));
    expect(r.ok).toBe(false);
    expect(r.gaps![0].reason).toContain('cannot reference');
  });

  test('state cannot reference proj (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'state.fact', createType('string', [ref('proj.session.view')]));
    expect(r.ok).toBe(false);
  });

  test('state cannot reference chan (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'state.fact', createType('string', [ref('chan.alice.desktop')]));
    expect(r.ok).toBe(false);
  });

  test('state cannot reference req (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'state.fact', createType('string', [ref('req.r55.status')]));
    expect(r.ok).toBe(false);
  });

  test('proc can reference state, id, req, chan, proc (all allowed)', () => {
    const seq = new Sequence();
    for (const target of ['state.x', 'id.x', 'req.x', 'chan.x', 'proc.other']) {
      seq.mount('bind', target, 'val');
      const r = seq.mount('schema', `proc.p1.ref_${target.replace('.', '_')}`, createType('string', [ref(target)]));
      expect(r.ok).toBe(true);
    }
  });

  test('proc cannot reference proj (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'proc.p1.view', createType('string', [ref('proj.s1.main')]));
    expect(r.ok).toBe(false);
  });

  test('id can reference id and state (allowed)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'id.orgs.acme', 'active');
    const r1 = seq.mount('schema', 'id.users.alice.org', createType('string', [ref('id.orgs.acme')]));
    expect(r1.ok).toBe(true);
    seq.mount('bind', 'state.config.default_role', 'viewer');
    const r2 = seq.mount('schema', 'id.users.bob.default', createType('string', [ref('state.config.default_role')]));
    expect(r2.ok).toBe(true);
  });

  test('id cannot reference proc (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'id.users.alice.active', createType('string', [ref('proc.p1.status')]));
    expect(r.ok).toBe(false);
  });

  test('req can reference state, id, chan, req (allowed)', () => {
    const seq = new Sequence();
    for (const target of ['state.x', 'id.x', 'chan.x', 'req.other']) {
      seq.mount('bind', target, 'val');
      const r = seq.mount('schema', `req.r1.ref_${target.replace('.', '_')}`, createType('string', [ref(target)]));
      expect(r.ok).toBe(true);
    }
  });

  test('req cannot reference proc (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'req.r1.claimed_by', createType('string', [ref('proc.p1.id')]));
    expect(r.ok).toBe(false);
  });

  test('chan can reference id and req (allowed)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'id.users.alice', 'alice');
    const r1 = seq.mount('schema', 'chan.alice.desktop.user', createType('string', [ref('id.users.alice')]));
    expect(r1.ok).toBe(true);
    seq.mount('bind', 'req.r1.target', 'alice');
    const r2 = seq.mount('schema', 'chan.alice.desktop.pending', createType('string', [ref('req.r1.target')]));
    expect(r2.ok).toBe(true);
  });

  test('chan cannot reference state (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'chan.alice.data', createType('string', [ref('state.contracts.acme')]));
    expect(r.ok).toBe(false);
  });

  test('chan cannot reference proc (rejected)', () => {
    const seq = new Sequence();
    const r = seq.mount('schema', 'chan.alice.proc_ref', createType('string', [ref('proc.p1.status')]));
    expect(r.ok).toBe(false);
  });

  test('proj can reference everything (allowed)', () => {
    const seq = new Sequence();
    for (const target of ['state.x', 'proc.x', 'id.x', 'req.x', 'chan.x', 'proj.other']) {
      seq.mount('bind', target, 'val');
      const r = seq.mount('schema', `proj.s1.ref_${target.replace('.', '_')}`, createType('string', [ref(target)]));
      expect(r.ok).toBe(true);
    }
  });

  test('derived constraint partition check', () => {
    const seq = new Sequence();
    seq.mount('bind', 'proc.p1.count', 5);
    seq.mount('cap', 'addOne', (n: number) => n + 1);
    // state path with derived from proc arg — should fail
    const r = seq.mount('schema', 'state.incremented', createType('number', [derived('addOne', 'proc.p1.count')]));
    expect(r.ok).toBe(false);
    expect(r.gaps![0].reason).toContain('cannot reference');
  });

  test('where/while constraint partition check', () => {
    const seq = new Sequence();
    seq.mount('bind', 'proc.p1.active', true);
    // state bind gated on proc path — should fail
    const r = seq.mount('bind', 'state.fact', 'hello', {
      where: [{ op: 'eq', args: ['proc.p1.active', true] }],
    });
    expect(r.ok).toBe(false);
    expect(r.gaps![0].reason).toContain('cannot depend on');
  });

  test('unprefixed paths all default to state — backward compat', () => {
    const seq = new Sequence();
    seq.mount('bind', 'source', 42);
    // unprefixed schema referencing unprefixed source — both state, allowed
    const r = seq.mount('schema', 'target', createType('number', [ref('source')]));
    expect(r.ok).toBe(true);
  });

  test('internal paths bypass partition checks', () => {
    const seq = new Sequence();
    // A state path referencing _rt — internal paths are always allowed
    const r = seq.mount('schema', 'state.timer', createType('number', [ref('_rt')]));
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Persistence policy — readable as values
// ═══════════════════════════════════════════════════════════════════════

describe('partition metadata as values', () => {

  test('persistence policy readable via get()', () => {
    const seq = new Sequence();
    expect(seq.get('_partitions.state.persistence')).toBe('required');
    expect(seq.get('_partitions.id.persistence')).toBe('required');
    expect(seq.get('_partitions.req.persistence')).toBe('required');
    expect(seq.get('_partitions.proc.persistence')).toBe('policy');
    expect(seq.get('_partitions.chan.persistence')).toBe('policy');
    expect(seq.get('_partitions.proj.persistence')).toBe('never');
  });

  test('authority readable via get()', () => {
    const seq = new Sequence();
    expect(seq.get('_partitions.state.authoritative')).toBe(true);
    expect(seq.get('_partitions.proc.authoritative')).toBe(true);
    expect(seq.get('_partitions.id.authoritative')).toBe(true);
    expect(seq.get('_partitions.req.authoritative')).toBe(true);
    expect(seq.get('_partitions.chan.authoritative')).toBe(true);
    expect(seq.get('_partitions.proj.authoritative')).toBe(false);
  });

  test('allowed refs readable via get()', () => {
    const seq = new Sequence();
    const stateRefs = seq.get('_partitions.state.allowedRefs') as string[];
    expect(stateRefs).toContain('state');
    expect(stateRefs).toContain('id');
    expect(stateRefs).not.toContain('proc');
    expect(stateRefs).not.toContain('proj');

    const projRefs = seq.get('_partitions.proj.allowedRefs') as string[];
    expect(projRefs).toContain('state');
    expect(projRefs).toContain('proc');
    expect(projRefs).toContain('id');
    expect(projRefs).toContain('req');
    expect(projRefs).toContain('chan');
    expect(projRefs).toContain('proj');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Execution records tagged with partition
// ═══════════════════════════════════════════════════════════════════════

describe('exec records with partition', () => {

  test('bind to state-prefixed path tags _exec with state', () => {
    const seq = new Sequence(() => 1000);
    const r = seq.mount('bind', 'state.contracts.acme.status', 'active');
    expect(r.ok).toBe(true);
    expect(seq.get(`_exec.${r.blockSeq}.partition`)).toBe('state');
  });

  test('bind to proc-prefixed path tags _exec with proc', () => {
    const seq = new Sequence(() => 1000);
    const r = seq.mount('bind', 'proc.p1.status', 'running');
    expect(r.ok).toBe(true);
    expect(seq.get(`_exec.${r.blockSeq}.partition`)).toBe('proc');
  });

  test('bind to unprefixed path tags _exec with state', () => {
    const seq = new Sequence(() => 1000);
    const r = seq.mount('bind', 'mydata', 42);
    expect(r.ok).toBe(true);
    expect(seq.get(`_exec.${r.blockSeq}.partition`)).toBe('state');
  });

  test('each partition prefix tags correctly', () => {
    const seq = new Sequence(() => 1000);
    const cases: [string, string][] = [
      ['state.x', 'state'],
      ['proc.x', 'proc'],
      ['id.x', 'id'],
      ['req.x', 'req'],
      ['chan.x', 'chan'],
      ['proj.x', 'proj'],
    ];
    for (const [path, expected] of cases) {
      const r = seq.mount('bind', path, 'val');
      expect(seq.get(`_exec.${r.blockSeq}.partition`)).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Partition-aware dep edges
// ═══════════════════════════════════════════════════════════════════════

describe('partition-aware dep indexing', () => {

  test('deps from state partition are tracked under _dep_partitions.state', () => {
    const seq = new Sequence();
    seq.mount('bind', 'state.source', 42);
    seq.mount('schema', 'state.target', createType('number', [ref('state.source')]));
    const deps = seq.get('_dep_partitions.state.state.source') as string[];
    expect(deps).toContain('state.target');
  });

  test('deps from proc partition are tracked under _dep_partitions.proc', () => {
    const seq = new Sequence();
    seq.mount('bind', 'proc.p1.input', 'data');
    seq.mount('schema', 'proc.p1.derived', createType('string', [ref('proc.p1.input')]));
    const deps = seq.get('_dep_partitions.proc.proc.p1.input') as string[];
    expect(deps).toContain('proc.p1.derived');
  });

  test('unprefixed deps tracked under _dep_partitions.state', () => {
    const seq = new Sequence();
    seq.mount('bind', 'source', 42);
    seq.mount('schema', 'target', createType('number', [ref('source')]));
    const deps = seq.get('_dep_partitions.state.source') as string[];
    expect(deps).toContain('target');
  });

  test('cross-partition dep (proj referencing state) tracked by source partition', () => {
    const seq = new Sequence();
    seq.mount('bind', 'state.data', 42);
    seq.mount('schema', 'proj.view.data', createType('number', [ref('state.data')]));
    // Source is state.data — tracked under state partition
    const deps = seq.get('_dep_partitions.state.state.data') as string[];
    expect(deps).toContain('proj.view.data');
  });

  test('original _deps format preserved for backward compat', () => {
    const seq = new Sequence();
    seq.mount('bind', 'state.a', 1);
    seq.mount('schema', 'state.b', createType('number', [ref('state.a')]));
    const deps = seq.get('_deps.state.a') as string[];
    expect(deps).toContain('state.b');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Cross-partition operations
// ═══════════════════════════════════════════════════════════════════════

describe('cross-partition operations', () => {

  test('proj can aggregate from all partitions', () => {
    const seq = new Sequence();
    seq.mount('bind', 'state.contracts.acme.status', 'active');
    seq.mount('bind', 'id.users.alice.role', 'admin');
    seq.mount('bind', 'req.r55.status', 'open');
    seq.mount('bind', 'chan.alice.desktop.visible', true);
    seq.mount('bind', 'proc.p1.step', 3);

    // proj view can read all of these
    seq.mount('bind', 'proj.session1.snapshot', {
      contract: 'active',
      user: 'admin',
      request: 'open',
      channel: true,
      process: 3,
    });
    expect(seq.get('proj.session1.snapshot')).toEqual({
      contract: 'active',
      user: 'admin',
      request: 'open',
      channel: true,
      process: 3,
    });
  });

  test('bind to any partition works without schema', () => {
    // Binds without schemas have no ref/derived constraints to check —
    // partition enforcement only fires on schema refs and where/while
    const seq = new Sequence();
    seq.mount('bind', 'state.x', 1);
    seq.mount('bind', 'proc.y', 2);
    seq.mount('bind', 'id.z', 3);
    seq.mount('bind', 'req.w', 4);
    seq.mount('bind', 'chan.v', 5);
    seq.mount('bind', 'proj.u', 6);
    expect(seq.get('state.x')).toBe(1);
    expect(seq.get('proc.y')).toBe(2);
    expect(seq.get('id.z')).toBe(3);
    expect(seq.get('req.w')).toBe(4);
    expect(seq.get('chan.v')).toBe(5);
    expect(seq.get('proj.u')).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Type-declared partition — dimension of type, not lexical prefix
// ═══════════════════════════════════════════════════════════════════════
//
// The partition model doc flagged prefix-only partition derivation as
// an incomplete surface encoding. A type that carries `partition(p)`
// as a constraint should be recognised as belonging to partition `p`
// regardless of where it's mounted. These tests exercise the
// type-aware dispatch and prove the prefix fallback still works for
// unannotated paths.

describe('type-declared partition', () => {

  test('partitionOfType extracts a declared partition from a type', () => {
    const t = createType('object', [partition('id')]);
    expect(partitionOfType(t)).toBe('id');
  });

  test('partitionOfType returns undefined when no partition constraint present', () => {
    const t = createType('object', []);
    expect(partitionOfType(t)).toBeUndefined();
  });

  test('partitionOf with an explicit type prefers the type-declared partition over the path prefix', () => {
    // An unprefixed path would default to state; the type wins.
    const t = createType('object', [partition('id')]);
    expect(partitionOf('foo.bar', t)).toBe('id');
  });

  test('partitionOf with an explicit type overrides a conflicting path prefix', () => {
    // Path says state, type says id. Type wins.
    const t = createType('object', [partition('id')]);
    expect(partitionOf('state.something', t)).toBe('id');
  });

  test('partitionOf with no type still uses the path prefix (backwards compat)', () => {
    expect(partitionOf('id.users.alice')).toBe('id');
    expect(partitionOf('foo.bar')).toBe('state');
  });

  test('internal paths (_*) are state even when a type declares otherwise', () => {
    const t = createType('object', [partition('id')]);
    expect(partitionOf('_internal', t)).toBe('state');
  });

  test('mount lookup: after a schema with partition(id) lands, partitionOf at that path reports id', () => {
    const seq = new Sequence();
    seq.mount('schema', 'keys.openai', createType('object', [partition('id')]));
    const stored = seq.typeAt('keys.openai');
    expect(partitionOf('keys.openai', stored)).toBe('id');
  });

  test('ref direction check honors the type-declared partition of the target', () => {
    // Target is at an unprefixed path (`secrets.openai`) but its type
    // declares the identity partition. A schema in `state` pointing at
    // it via ref() should be allowed because state → id is legal.
    const seq = new Sequence();
    seq.mount('bind', 'secrets.openai', 'sk-123');
    seq.mount('schema', 'secrets.openai', createType('string', [partition('id')]));
    const r = seq.mount(
      'schema',
      'state.needs_the_key',
      createType('string', [ref('secrets.openai')]),
    );
    expect(r.ok).toBe(true);
  });

  test('ref direction check rejects a disallowed direction established only by type-declared partition', () => {
    // Target type declares 'proc' (process partition), mounted at a
    // state-prefixed path. A schema under `chan` referencing it must
    // be rejected because chan → proc is not allowed, even though
    // the path prefix would have said state (and chan → state IS
    // allowed). The type wins.
    const seq = new Sequence();
    seq.mount('bind', 'state.computation_state', 'running');
    seq.mount('schema', 'state.computation_state', createType('string', [partition('proc')]));
    const r = seq.mount(
      'schema',
      'chan.users.alice.view',
      createType('string', [ref('state.computation_state')]),
    );
    expect(r.ok).toBe(false);
    expect(r.gaps?.[0]?.reason).toContain('cannot reference');
  });

  test('source schema with declared partition wins over its mount path prefix for direction check', () => {
    // Schema mounted at `state.routing_request` but declared as req.
    // It references `chan.users.alice.desktop` — req → chan is
    // allowed. Without type-driven partition this would be
    // state → chan which is rejected. With it, it's allowed.
    const seq = new Sequence();
    seq.mount('bind', 'chan.users.alice.desktop', true);
    const r = seq.mount(
      'schema',
      'state.routing_request',
      createType('object', [partition('req'), ref('chan.users.alice.desktop')]),
    );
    expect(r.ok).toBe(true);
  });

  test('unknown partition constraint value is ignored (falls back to prefix)', () => {
    // An invalid partition string on the constraint should not crash
    // — partitionOfType rejects it and partitionOf falls back to prefix.
    const t = { kind: 'object' as const, constraints: [{ op: 'partition', args: ['bogus'] }] };
    expect(partitionOfType(t as any)).toBeUndefined();
    expect(partitionOf('state.x', t as any)).toBe('state');
  });
});
