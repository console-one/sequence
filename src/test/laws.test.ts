/**
 * laws.test.ts — pre-mount admission.
 *
 * `law({admission: true, check, reason})` fires on every bind/delete/schema
 * entry whose target is covered by the declaring schema. First failure
 * rejects the whole block.
 */

import { Sequence } from '../sequence';
import { createType, law, eq, and, gt } from '../type';

describe('law enforcement — admission', () => {
  test('admission check passes when author matches session holder', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'only the current session holder may write',
      }),
    ]));

    const result = seq.mount('bind', 'sessions.tick', 1, { author: 'alice' });
    expect(result.ok).toBe(true);
    expect(seq.get('sessions.tick')).toBe(1);
  });

  test('admission check rejects when author does not match holder', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'only the current session holder may write',
      }),
    ]));

    const result = seq.mount('bind', 'sessions.tick', 1, { author: 'bob' });
    expect(result.ok).toBe(false);
    expect(result.gaps?.[0]?.reason).toBe('only the current session holder may write');
    expect(seq.get('sessions.tick')).toBeUndefined();
  });

  test('admission check rejects when author is undefined', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'must sign as holder',
      }),
    ]));

    const result = seq.mount('bind', 'sessions.tick', 1);
    expect(result.ok).toBe(false);
    expect(result.gaps?.[0]?.reason).toBe('must sign as holder');
  });

  test('admission law on per-instance schema', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.s1.holder', 'alice');
    seq.mount('bind', 'sessions.s2.holder', 'bob');
    seq.mount('schema', 'sessions.s1', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.s1.holder'),
        reason: 's1 writes must be by s1 holder',
      }),
    ]));
    seq.mount('schema', 'sessions.s2', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.s2.holder'),
        reason: 's2 writes must be by s2 holder',
      }),
    ]));

    expect(seq.mount('bind', 'sessions.s1.data', 'ok', { author: 'alice' }).ok).toBe(true);
    const r2 = seq.mount('bind', 'sessions.s2.data', 'x', { author: 'alice' });
    expect(r2.ok).toBe(false);
    expect(r2.gaps?.[0]?.reason).toBe('s2 writes must be by s2 holder');
    expect(seq.mount('bind', 'sessions.s2.data', 'ok', { author: 'bob' }).ok).toBe(true);
  });

  test('admission law with and() combines multiple checks', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('bind', 'sessions.heartbeatExpiry', 99999999999999);
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: and(
          eq('$author', 'sessions.holder'),
          gt('sessions.heartbeatExpiry', '$time'),
        ),
        reason: 'holder and live heartbeat required',
      }),
    ]));

    expect(seq.mount('bind', 'sessions.data', 'x', { author: 'alice' }).ok).toBe(true);
  });

  test('admission rejects when heartbeat is stale', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('bind', 'sessions.heartbeatExpiry', 0);
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: and(
          eq('$author', 'sessions.holder'),
          gt('sessions.heartbeatExpiry', '$time'),
        ),
        reason: 'holder and live heartbeat required',
      }),
    ]));

    const stale = seq.mount('bind', 'sessions.data', 'x', { author: 'alice' });
    expect(stale.ok).toBe(false);
    expect(stale.gaps?.[0]?.reason).toBe('holder and live heartbeat required');
  });

  test('admission gates schema mounts (lock-on-range entails lock-on-storage-policy)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'sessions.holder', 'alice');
    seq.mount('schema', 'sessions', createType('any', [
      law({
        admission: true,
        check: eq('$author', 'sessions.holder'),
        reason: 'only holder',
      }),
    ]));

    expect(seq.mount('schema', 'sessions.foo', createType('string'), { author: 'bob' }).ok).toBe(false);
    expect(seq.mount('schema', 'sessions.foo', createType('string'), { author: 'alice' }).ok).toBe(true);
    expect(seq.mount('bind', 'sessions.foo', 'x', { author: 'bob' }).ok).toBe(false);
    expect(seq.mount('bind', 'sessions.foo', 'x', { author: 'alice' }).ok).toBe(true);
    expect(seq.mount('tool', 'sessions.foo.compute', () => 'noop', { author: 'bob' }).ok).toBe(true);
  });
});

describe('law enforcement — read trigger (under commitment)', () => {
  // A commitment-scoped read gates via $commitment field access.
  // The commitment is the substrate's write-side primitive
  // (_commitments.{id}.*); read laws evaluate against its fields.

  test('commitment-scoped get masks when read law fails', () => {
    const seq = new Sequence();
    // The secret and its owner
    seq.mount('bind', 'secrets.alice.apiKey', 'sk-real-value');
    seq.mount('bind', 'secrets.alice.owner', 'alice');
    // Read law: the commitment's author must match the secret's owner
    seq.mount('schema', 'secrets.*', createType('any', [
      law({
        trigger: 'read',
        check: eq('$commitment.author', '$instancePath.owner'),
        reason: 'secret readable only by commitments authored by owner',
      }),
    ]));
    // Two open commitments — one authored by alice, one by bob
    seq.mount('bind', '_commitments.alice-task.author', 'alice');
    seq.mount('bind', '_commitments.bob-task.author', 'bob');

    // Alice's commitment reads → value surfaces
    expect(seq.get('secrets.alice.apiKey', { under: '_commitments.alice-task' }))
      .toBe('sk-real-value');
    // Bob's commitment reads → masked
    expect(seq.get('secrets.alice.apiKey', { under: '_commitments.bob-task' }))
      .toBeUndefined();
    // Kernel-internal read (no commitment) → value surfaces
    expect(seq.get('secrets.alice.apiKey')).toBe('sk-real-value');
  });

  test('read law applies to structural-leaf collection (per-child)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'secrets.alice.apiKey', 'sk-real-value');
    seq.mount('bind', 'secrets.alice.owner', 'alice');
    seq.mount('schema', 'secrets.*.apiKey', createType('any', [
      law({
        trigger: 'read',
        check: eq('$commitment.author', 'secrets.alice.owner'),
        reason: 'apiKey gated by owner',
      }),
    ]));
    seq.mount('bind', '_commitments.alice-task.author', 'alice');
    seq.mount('bind', '_commitments.bob-task.author', 'bob');

    // Bob's commitment reads the parent object — owner surfaces but
    // apiKey is masked. Descent propagates the commitment.
    const bobView = seq.get('secrets.alice', { under: '_commitments.bob-task' }) as Record<string, unknown>;
    expect(bobView?.owner).toBe('alice');
    expect(bobView?.apiKey).toBeUndefined();
    // Alice's commitment sees everything.
    const aliceView = seq.get('secrets.alice', { under: '_commitments.alice-task' }) as Record<string, unknown>;
    expect(aliceView?.apiKey).toBe('sk-real-value');
  });

  test('multiple read-triggered laws AND (any failure masks)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'vault.doc', 'top-secret');
    seq.mount('bind', 'vault.clearance', 5);
    seq.mount('schema', 'vault', createType('any', [
      law({ trigger: 'read', check: eq('$commitment.author', 'vault.allowed_author'), reason: 'not on allowlist' }),
      law({ trigger: 'read', check: gt('vault.clearance', 3), reason: 'clearance too low' }),
    ]));
    seq.mount('bind', 'vault.allowed_author', 'authorized');
    seq.mount('bind', '_commitments.task-a.author', 'authorized');
    seq.mount('bind', '_commitments.task-b.author', 'stranger');

    // Commitment by authorized author + clearance 5 > 3 → surfaces
    expect(seq.get('vault.doc', { under: '_commitments.task-a' })).toBe('top-secret');
    // Commitment by stranger → fails identity check → masked
    expect(seq.get('vault.doc', { under: '_commitments.task-b' })).toBeUndefined();
    // Clearance drops → even authorized commitment gets masked
    seq.mount('bind', 'vault.clearance', 2);
    expect(seq.get('vault.doc', { under: '_commitments.task-a' })).toBeUndefined();
  });

  test('commitment carrying an explicit grant (grants.read path)', () => {
    const seq = new Sequence();
    seq.mount('bind', 'private.data', 'sensitive');
    seq.mount('schema', 'private', createType('any', [
      law({
        trigger: 'read',
        check: eq('$commitment.grants.read', 'private'),
        reason: 'commitment must carry read grant for private.*',
      }),
    ]));
    seq.mount('bind', '_commitments.granted.grants.read', 'private');
    seq.mount('bind', '_commitments.ungranted.grants.read', 'public');

    expect(seq.get('private.data', { under: '_commitments.granted' })).toBe('sensitive');
    expect(seq.get('private.data', { under: '_commitments.ungranted' })).toBeUndefined();
  });

  test('admission law with trigger:"admission" explicitly (not shorthand) still fires', () => {
    const seq = new Sequence();
    seq.mount('schema', 'strict', createType('any', [
      law({
        trigger: 'admission',
        check: eq('$author', 'signer'),
        reason: 'must sign',
      }),
    ]));

    expect(seq.mount('bind', 'strict.x', 1, { author: 'signer' }).ok).toBe(true);
    expect(seq.mount('bind', 'strict.x', 2, { author: 'other' }).ok).toBe(false);
  });

  test('read law does not fire on kernel-internal reads', () => {
    const seq = new Sequence();
    seq.mount('bind', 'gate.holder', 'alice');
    seq.mount('bind', 'gate.resource', 'payload');
    seq.mount('schema', 'gate', createType('any', [
      law({ trigger: 'read', check: eq('$commitment.author', 'gate.holder'), reason: 'holder-only' }),
      law({ admission: true, check: eq('$author', 'gate.holder'), reason: 'holder-only write' }),
    ]));
    seq.mount('bind', '_commitments.alice-task.author', 'alice');
    seq.mount('bind', '_commitments.bob-task.author', 'bob');

    // Admission evaluator reads gate.holder kernel-internally (no commitment) — must not mask.
    expect(seq.mount('bind', 'gate.next', 'x', { author: 'alice' }).ok).toBe(true);
    // Commitment-scoped read still gates.
    expect(seq.get('gate.resource', { under: '_commitments.bob-task' })).toBeUndefined();
    expect(seq.get('gate.resource', { under: '_commitments.alice-task' })).toBe('payload');
  });
});
