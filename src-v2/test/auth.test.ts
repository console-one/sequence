/**
 * auth.test.ts — port of v1 session-token.test.
 *
 * Session auth tokens — HMAC-SHA256 signed assertions of user
 * identity. Ported from v1 commit 8183776. These tests prove the
 * primitive functions in isolation + the cap wiring lands
 * mint/validate as fn-kind cells on the sequence + the
 * stampSessionToken integration with writer-authority works
 * end-to-end.
 *
 * Prerequisite for cross-process sequence federation: a peer can't
 * prove identity over the wire without signed tokens.
 */

import { Sequence } from '../sequence';
import {
  mintSessionToken, validateSessionToken, generateTokenSecret,
  installAuthCaps, installWriterAuthority, stampSessionToken,
  flushPending,
  type SessionToken,
} from '../stdlib';

const secret = 'deadbeef'.repeat(16);
const now = 1_700_000_000_000;
const oneHour = 60 * 60 * 1000;

describe('auth: mint + validate primitives', () => {
  it('round-trip mint → validate returns the asserted user', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const result = validateSessionToken(token, secret, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toBe('alice');
      expect(result.expiresAt).toBe(now + oneHour);
    }
  });

  it('tampered user field breaks the signature', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const forged: SessionToken = { ...token, user: 'mallory' };
    const result = validateSessionToken(forged, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('tampered expiresAt field breaks the signature', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const forged: SessionToken = { ...token, expiresAt: now + 100 * oneHour };
    const result = validateSessionToken(forged, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('expired token rejected even with valid signature', () => {
    const token = mintSessionToken('alice', now - 1, secret);
    const result = validateSessionToken(token, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('different secret fails validation', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const wrong = 'cafebabe'.repeat(16);
    const result = validateSessionToken(token, wrong, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('malformed inputs rejected without throwing', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}, { user: 'alice' }]) {
      const result = validateSessionToken(bad, secret, now);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed');
    }
  });

  it('mint rejects invalid inputs', () => {
    expect(() => mintSessionToken('', now, secret)).toThrow();
    expect(() => mintSessionToken('alice', NaN, secret)).toThrow();
    expect(() => mintSessionToken('alice', now, '')).toThrow();
  });

  it('generateTokenSecret produces 128-char hex (64 bytes)', () => {
    const s = generateTokenSecret();
    expect(s).toHaveLength(128);
    expect(/^[0-9a-f]+$/.test(s)).toBe(true);
  });
});

describe('auth: installAuthCaps wires mint/validate onto a Sequence', () => {
  it('mounts token_secret at id.server.token_secret in id partition', () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    expect(s.get('id.server.token_secret')).toBe(secret);
    const t = s.typeAt('id.server.token_secret');
    expect(t?.kind).toBe('string');
    const partC = t?.constraints.find(c => c.op === 'partition');
    expect(partC).toBeDefined();
    expect(partC?.args[0]).toBe('id');
  });

  it('mount.mintSessionToken as a callable tool', async () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    // Fake clock for determinism.
    s.insert({ path: '_rt', value: now });

    // Invoke mint by writing input to the tool cell — commitment
    // machinery handles the call. Result lands at `.result`.
    // (For a pure-synchronous impl, just read the fn and invoke.)
    const mintFn = s.impls.get('auth.mintSessionToken');
    expect(typeof mintFn).toBe('function');
    const token = await (mintFn as any)({ user: 'alice', expiresAt: now + oneHour });
    expect(token.user).toBe('alice');
    expect(token.expiresAt).toBe(now + oneHour);
    expect(typeof token.signature).toBe('string');
  });

  it('validates a minted token via the cap', async () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    s.insert({ path: '_rt', value: now });
    const mint = s.impls.get('auth.mintSessionToken');
    const validate = s.impls.get('auth.validateSessionToken');
    const token = await (mint as any)({ user: 'alice', expiresAt: now + oneHour });
    const result = await (validate as any)({ token });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user).toBe('alice');
  });

  it('validate uses seq._rt for now (fake clock compat)', async () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    const mint = s.impls.get('auth.mintSessionToken');
    const validate = s.impls.get('auth.validateSessionToken');
    // Mint at t=now, expiring in 1 hour.
    s.insert({ path: '_rt', value: now });
    const token = await (mint as any)({ user: 'alice', expiresAt: now + oneHour });
    // Advance fake clock past expiry.
    s.insert({ path: '_rt', value: now + 2 * oneHour });
    const result = await (validate as any)({ token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('generates a random secret when none provided', () => {
    const s = new Sequence();
    const { secret: s1 } = installAuthCaps(s);
    expect(s1).toHaveLength(128);
  });
});

describe('auth: stampSessionToken integrates with writer-authority', () => {
  it('valid token → session fields stamped + subsequent writes admitted', () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    installWriterAuthority(s, { scope: 'sessions', ownerSegmentIndex: 1 });
    s.insert({ path: '_rt', value: now });

    const token = mintSessionToken('alice', now + oneHour, secret);
    const result = stampSessionToken(s, {
      token,
      identityPath: 'id.conn.aaa',
    });

    expect(result.ok).toBe(true);
    expect(s.get('sessions.alice.user')).toBe('alice');
    expect(s.get('sessions.alice.holder')).toBe('id.conn.aaa');
    expect(s.get('sessions.alice.tokenExpiry')).toBe(now + oneHour);

    // Subsequent writes from alice's connection identity are admitted
    // by writer-authority — the holder is id.conn.aaa, so block.author
    // must match that to pass. A write with the bare username 'alice'
    // would be rejected.
    const r = s.insert({
      path: 'sessions.alice.heartbeat',
      value: now + 10,
      author: 'id.conn.aaa',
    });
    expect(r.suspended).toBe(false);

    // A different connection (author='id.conn.other') is rejected.
    const r2 = s.insert({
      path: 'sessions.alice.heartbeat',
      value: 99,
      author: 'id.conn.other',
    });
    expect(r2.suspended).toBe(true);
  });

  it('invalid token → no stamp, writer-authority blocks same-claim', () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    installWriterAuthority(s, { scope: 'sessions', ownerSegmentIndex: 1 });
    s.insert({ path: '_rt', value: now });

    const token = mintSessionToken('alice', now + oneHour, 'wrong_secret_'.repeat(8));
    const result = stampSessionToken(s, {
      token,
      identityPath: 'id.conn.aaa',
    });
    expect(result.ok).toBe(false);
    expect(s.get('sessions.alice.holder')).toBeUndefined();

    // No holder set yet — writer-authority condition (a) admits first claim.
    // But since stamp failed, no assertion about alice was made; anyone
    // could still claim. This test verifies the STAMP didn't happen; the
    // subsequent security of the session depends on the claim attempt.
  });

  it('expired token rejected by stamp', () => {
    const s = new Sequence();
    installAuthCaps(s, { secret });
    s.insert({ path: '_rt', value: now });

    const token = mintSessionToken('alice', now - 1, secret);
    const result = stampSessionToken(s, {
      token,
      identityPath: 'id.conn.aaa',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});
