/**
 * partition.test.ts — v2 partition model + reference-direction enforcement.
 *
 * Six partitions: state, proc, id, req, chan, proj.
 * Type-declared partition wins over path prefix.
 * `installPartitionDirection` enforces ALLOWED_REFS at admission time.
 */

import { Sequence } from '../sequence';
import {
  partitionOf,
  partitionOfType,
  installPartitionDirection,
  PARTITION_PERSISTENCE,
  PARTITION_AUTHORITY,
} from '../stdlib';
import { createType, ref, partition } from '../../src/type';

// ═══════════════════════════════════════════════════════════════════════
// 1. partitionOf — prefix detection
// ═══════════════════════════════════════════════════════════════════════

describe('partitionOf — prefix detection', () => {
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
    expect(partitionOf('_commitments.x')).toBe('state');
    expect(partitionOf('_blocks.7.status')).toBe('state');
  });

  test('bare partition name without dot is detected', () => {
    expect(partitionOf('state')).toBe('state');
    expect(partitionOf('proc')).toBe('proc');
    expect(partitionOf('id')).toBe('id');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. partitionOfType — type-declared partitions win
// ═══════════════════════════════════════════════════════════════════════

describe('partitionOfType — type-declared partitions', () => {
  test('reads partition() constraint from type', () => {
    const t = createType('string', [partition('id')]);
    expect(partitionOfType(t)).toBe('id');
  });

  test('returns undefined when no partition constraint', () => {
    const t = createType('string');
    expect(partitionOfType(t)).toBeUndefined();
  });

  test('rejects unknown partition names', () => {
    const t = createType('string', [{ op: 'partition', args: ['bogus'] }]);
    expect(partitionOfType(t)).toBeUndefined();
  });
});

describe('partitionOf — type wins over path prefix', () => {
  test('type-declared partition overrides path prefix', () => {
    const t = createType('string', [partition('id')]);
    // Path looks like state.* but type declares id — id wins.
    expect(partitionOf('state.fact', t)).toBe('id');
  });

  test('type with no partition constraint falls back to prefix', () => {
    const t = createType('string');
    expect(partitionOf('proc.x', t)).toBe('proc');
  });

  test('internal paths still return state regardless of type', () => {
    const t = createType('string', [partition('id')]);
    expect(partitionOf('_internal.foo', t)).toBe('state');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Partition reference-direction enforcement (admission rule)
// ═══════════════════════════════════════════════════════════════════════

describe('installPartitionDirection — allowed references', () => {
  test('state can reference state', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    seq.insert({ path: 'state.source', value: 42 });
    const r = seq.insert({
      path: 'state.derived',
      type: createType('number', [ref('state.source')]),
    });
    expect(r.suspended).toBe(false);
  });

  test('state can reference id', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    seq.insert({ path: 'id.users.alice.role', value: 'admin' });
    const r = seq.insert({
      path: 'state.contracts.acme.approver',
      type: createType('string', [ref('id.users.alice.role')]),
    });
    expect(r.suspended).toBe(false);
  });

  test('proc can reference state, id, req, chan, proc', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    seq.insert({ path: 'state.x', value: 1 });
    seq.insert({ path: 'id.y', value: 2 });
    seq.insert({ path: 'req.r1.payload', value: 3 });
    seq.insert({ path: 'chan.users.alice.desktop', value: 4 });
    for (const target of ['state.x', 'id.y', 'req.r1.payload', 'chan.users.alice.desktop']) {
      const r = seq.insert({
        path: `proc.p1.${target.split('.')[0]}_ref`,
        type: createType('any', [ref(target)]),
      });
      expect(r.suspended).toBe(false);
    }
  });

  test('proj can reference everything', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    seq.insert({ path: 'state.x', value: 1 });
    seq.insert({ path: 'proc.p1.s', value: 2 });
    const r = seq.insert({
      path: 'proj.session.view',
      type: createType('any', [ref('state.x'), ref('proc.p1.s')]),
    });
    expect(r.suspended).toBe(false);
  });
});

describe('installPartitionDirection — rejected references', () => {
  test('state cannot reference proc', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    seq.insert({ path: 'proc.p1.status', value: 'running' });
    const r = seq.insert({
      path: 'state.fact',
      type: createType('string', [ref('proc.p1.status')]),
    });
    expect(r.suspended).toBe(true);
  });

  test('state cannot reference proj', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'state.fact',
      type: createType('string', [ref('proj.session.view')]),
    });
    expect(r.suspended).toBe(true);
  });

  test('state cannot reference req', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'state.fact',
      type: createType('string', [ref('req.r1.x')]),
    });
    expect(r.suspended).toBe(true);
  });

  test('id cannot reference proc', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'id.user.derived',
      type: createType('string', [ref('proc.p1.x')]),
    });
    expect(r.suspended).toBe(true);
  });

  test('chan cannot reference state', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'chan.alice.desktop.bound',
      type: createType('string', [ref('state.x')]),
    });
    expect(r.suspended).toBe(true);
  });

  test('chan cannot reference proc', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'chan.alice.desktop.bound',
      type: createType('string', [ref('proc.p1.x')]),
    });
    expect(r.suspended).toBe(true);
  });
});

describe('installPartitionDirection — type-declared partition steers admission', () => {
  test('a state-prefixed path with id-declared type uses id rules', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    seq.insert({ path: 'id.alice.role', value: 'admin' });
    // Path is state.* but type declares id — id can ref id, allowed.
    const r = seq.insert({
      path: 'state.alice.aspect',
      type: createType('string', [partition('id'), ref('id.alice.role')]),
    });
    expect(r.suspended).toBe(false);
  });

  test('id-declared type cannot ref proc', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'state.alice.aspect',
      type: createType('string', [partition('id'), ref('proc.p1.x')]),
    });
    expect(r.suspended).toBe(true);
  });
});

describe('installPartitionDirection — bypass paths', () => {
  test('internal (_*) path bypasses the rule entirely', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    // Even with a forbidden ref, internal paths skip partition checks.
    const r = seq.insert({
      path: '_internal.thing',
      type: createType('string', [ref('proc.p1.x')]),
    });
    expect(r.suspended).toBe(false);
  });

  test('refs to internal paths bypass the rule', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({
      path: 'state.x',
      type: createType('any', [ref('_internal.thing')]),
    });
    expect(r.suspended).toBe(false);
  });

  test('value-only mount with no type passes through', () => {
    const seq = new Sequence();
    installPartitionDirection(seq);
    const r = seq.insert({ path: 'state.x', value: 42 });
    expect(r.suspended).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Persistence + authority tables (declarative; stdlib consumers read)
// ═══════════════════════════════════════════════════════════════════════

describe('partition persistence/authority tables', () => {
  test('PARTITION_PERSISTENCE has expected values', () => {
    expect(PARTITION_PERSISTENCE.state).toBe('required');
    expect(PARTITION_PERSISTENCE.id).toBe('required');
    expect(PARTITION_PERSISTENCE.req).toBe('required');
    expect(PARTITION_PERSISTENCE.proc).toBe('policy');
    expect(PARTITION_PERSISTENCE.chan).toBe('policy');
    expect(PARTITION_PERSISTENCE.proj).toBe('never');
  });

  test('PARTITION_AUTHORITY: proj is read-only', () => {
    expect(PARTITION_AUTHORITY.state).toBe(true);
    expect(PARTITION_AUTHORITY.proc).toBe(true);
    expect(PARTITION_AUTHORITY.id).toBe(true);
    expect(PARTITION_AUTHORITY.req).toBe(true);
    expect(PARTITION_AUTHORITY.chan).toBe(true);
    expect(PARTITION_AUTHORITY.proj).toBe(false);
  });
});
