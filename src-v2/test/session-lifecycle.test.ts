/**
 * session-lifecycle.test.ts — port of v1's session-rules + session.test
 *
 * Four index_spec classes driving:
 *   - status = 'active' while heartbeat is within activeWindow
 *   - status = 'idle' when heartbeat is past active but within expiry
 *   - status = 'expired' + expiredAt when heartbeat is past expiry
 *   - holder cleared when holder identity has disconnectedAt
 *
 * Ported from v1 commit cf27d83. All four are pure type state — no
 * setInterval, no TS iteration over sessions.*. Status transitions are
 * driven by heartbeat-age arithmetic in the index_spec filters; the
 * fixpoint driver re-projects on any sessions.* change OR any _rt
 * advance.
 */

import { Sequence } from '../sequence';
import {
  installIndexSpec, installSessionLifecycle, installHolderRelease,
  installWriterAuthority, advanceClock,
} from '../stdlib';

function makeSeq(): Sequence {
  // Fake clock so tests are deterministic. _rt is read from the cell
  // (set via advanceClock) when present; fallback is seq.now().
  const s = new Sequence();
  installIndexSpec(s);
  installSessionLifecycle(s, { activeWindowMs: 30_000, expiryWindowMs: 120_000 });
  installHolderRelease(s);
  return s;
}

function stampSession(s: Sequence, user: string, heartbeat: number, holder?: string) {
  s.insert({ path: `sessions.${user}.user`, value: user, author: user });
  s.insert({ path: `sessions.${user}.env`, value: 'test', author: user });
  s.insert({ path: `sessions.${user}.heartbeat`, value: heartbeat, author: user });
  if (holder) {
    s.insert({ path: `sessions.${user}.holder`, value: holder, author: user });
  }
}

describe('session-lifecycle: status transitions', () => {
  it('heartbeat within activeWindow → status=active', () => {
    const s = makeSeq();
    advanceClock(s, 1_000_000);
    stampSession(s, 'alice', 990_000);  // 10s ago, < 30s activeWindow
    expect(s.get('sessions.alice.status')).toBe('active');
  });

  it('heartbeat past active but within expiry → status=idle', () => {
    const s = makeSeq();
    advanceClock(s, 1_000_000);
    stampSession(s, 'alice', 940_000);  // 60s ago: active=false, idle=true (within 120s)
    expect(s.get('sessions.alice.status')).toBe('idle');
  });

  it('heartbeat past expiry → status=expired + expiredAt stamped', () => {
    const s = makeSeq();
    advanceClock(s, 1_000_000);
    stampSession(s, 'alice', 800_000);  // 200s ago: expired
    expect(s.get('sessions.alice.status')).toBe('expired');
    expect(s.get('sessions.alice.expiredAt')).toBe(1_000_000);
  });

  it('status is mutually exclusive: advancing clock flips states', () => {
    const s = makeSeq();
    advanceClock(s, 1_000_000);
    stampSession(s, 'alice', 1_000_000);  // fresh
    expect(s.get('sessions.alice.status')).toBe('active');
    advanceClock(s, 1_040_000);  // 40s later
    expect(s.get('sessions.alice.status')).toBe('idle');
    advanceClock(s, 1_130_000);  // 130s later
    expect(s.get('sessions.alice.status')).toBe('expired');
  });

  it('multiple sessions classify independently', () => {
    const s = makeSeq();
    advanceClock(s, 1_000_000);
    stampSession(s, 'alice', 990_000);   // active
    stampSession(s, 'bob',   940_000);   // idle
    stampSession(s, 'carol', 800_000);   // expired
    expect(s.get('sessions.alice.status')).toBe('active');
    expect(s.get('sessions.bob.status')).toBe('idle');
    expect(s.get('sessions.carol.status')).toBe('expired');
  });
});

describe('session-lifecycle: HolderRelease', () => {
  it('clears sessions.{user}.holder when holder identity has disconnectedAt', () => {
    const s = makeSeq();
    advanceClock(s, 1_000_000);
    s.insert({ path: 'sessions.alice.user', value: 'alice' });
    s.insert({ path: 'sessions.alice.holder', value: 'id.conn.abc' });
    // Before disconnect: holder still set.
    expect(s.get('sessions.alice.holder')).toBe('id.conn.abc');
    // Stamp disconnect fact on the identity path.
    s.insert({ path: 'id.conn.abc.disconnectedAt', value: 1_000_100 });
    // HolderRelease class fires, clears the holder.
    expect(s.get('sessions.alice.holder')).toBeUndefined();
  });

  it('does NOT clear holder when disconnectedAt is on a different identity', () => {
    const s = makeSeq();
    s.insert({ path: 'sessions.alice.user', value: 'alice' });
    s.insert({ path: 'sessions.alice.holder', value: 'id.conn.abc' });
    // Disconnect on a DIFFERENT identity — alice's holder unaffected.
    s.insert({ path: 'id.conn.OTHER.disconnectedAt', value: 100 });
    expect(s.get('sessions.alice.holder')).toBe('id.conn.abc');
  });
});

describe('session-lifecycle: integration with writer-authority', () => {
  it('expired session admits a new holder (writer-authority takeover)', () => {
    const s = new Sequence();
    installIndexSpec(s);
    installSessionLifecycle(s, { activeWindowMs: 30_000, expiryWindowMs: 120_000 });
    installWriterAuthority(s, { scope: 'sessions', ownerSegmentIndex: 1 });

    advanceClock(s, 1_000_000);
    s.insert({ path: 'sessions.alice.user', value: 'alice', author: 'alice' });
    s.insert({ path: 'sessions.alice.heartbeat', value: 990_000, author: 'alice' });
    s.insert({ path: 'sessions.alice.holder', value: 'alice', author: 'alice' });

    // Bob can't write while alice is the active holder.
    const denied = s.insert({ path: 'sessions.alice.heartbeat', value: 5, author: 'bob' });
    expect(denied.suspended).toBe(true);

    // Fast-forward past expiry window.
    advanceClock(s, 1_200_000);
    expect(s.get('sessions.alice.status')).toBe('expired');

    // Bob reclaims the session — writer-authority condition (c) fires.
    const ok = s.insert({ path: 'sessions.alice.holder', value: 'bob', author: 'bob' });
    expect(ok.suspended).toBe(false);
    expect(s.get('sessions.alice.holder')).toBe('bob');
  });

  it('disconnect shortcut: HolderRelease clears holder, new claimant admitted', () => {
    const s = new Sequence();
    installIndexSpec(s);
    installSessionLifecycle(s, { activeWindowMs: 30_000, expiryWindowMs: 120_000 });
    installHolderRelease(s);
    installWriterAuthority(s, { scope: 'sessions', ownerSegmentIndex: 1 });

    advanceClock(s, 1_000_000);
    s.insert({ path: 'sessions.alice.user', value: 'alice', author: 'alice' });
    s.insert({ path: 'sessions.alice.heartbeat', value: 995_000, author: 'alice' });
    // holder value is the identity path (not the username) — HolderRelease
    // reads ${holder_value}.disconnectedAt, which is an identity-scoped fact.
    s.insert({ path: 'sessions.alice.holder', value: 'id.conn.alice', author: 'alice' });
    s.insert({ path: 'id.conn.alice.connectedAt', value: 995_000 });

    // While connected: bob rejected. Author 'bob' vs holder 'id.conn.alice' —
    // writer-authority compares block.author to the holder value literally.
    // In the real product, the comparison is between identity paths; tests
    // below use that shape. Here bob's write is rejected because the holder
    // is set and does not match his author string.
    const r1 = s.insert({ path: 'sessions.alice.note', value: 'pwned', author: 'bob' });
    expect(r1.suspended).toBe(true);

    // Alice's identity records disconnect.
    s.insert({ path: 'id.conn.alice.disconnectedAt', value: 1_000_100 });
    // HolderRelease clears the holder (reads id.conn.alice.disconnectedAt).
    expect(s.get('sessions.alice.holder')).toBeUndefined();

    // Bob now claims — writer-authority condition (a) "no holder" fires.
    const r2 = s.insert({ path: 'sessions.alice.holder', value: 'id.conn.bob', author: 'bob' });
    expect(r2.suspended).toBe(false);
    expect(s.get('sessions.alice.holder')).toBe('id.conn.bob');
  });
});
