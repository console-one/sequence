/**
 * federation-e2e.test.ts — End-to-end demonstration that v2 actually
 * distributes.
 *
 * Brings together everything ported in this push:
 *   - installCrossSequence + receiveFromPeer (transport-agnostic
 *     bilateral forwarding)
 *   - installWriterAuthority (admission rule, ported from v1)
 *   - installAuthCaps + stampSessionToken (HMAC tokens, ported)
 *   - installSessionLifecycle + installHolderRelease (lifecycle)
 *   - captureSnapshot + restoreSnapshot (permanent-agent handoff)
 *   - installNodeStorage + installCommitment (substrate-native tools)
 *
 * Each test is a scenario the distributed product needs to handle.
 * Together they prove v2 is the substrate the lens-desktop migration
 * was supposed to land on.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Sequence } from '../sequence';
import { NodeStorage } from '../env/storage';
import {
  installCrossSequence, receiveFromPeer,
  installWriterAuthority,
  installAuthCaps, mintSessionToken, stampSessionToken,
  installSessionLifecycle,
  installCommitment, installNodeStorage, installIndexSpec,
  advanceClock, flushPending,
  captureSnapshot, restoreSnapshot,
  type Outgoing,
} from '../stdlib';

// ── In-process bilateral transport: pipes Outgoing deltas between two seqs ──
function pairFederation(A: Sequence, B: Sequence, opts: { aId: string; bId: string }) {
  installCrossSequence(A, opts.aId, (d: Outgoing) => receiveFromPeer(B, opts.aId, d));
  installCrossSequence(B, opts.bId, (d: Outgoing) => receiveFromPeer(A, opts.bId, d));
}

const SHARED_SECRET = 'cafebabe'.repeat(16);
const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;

describe('federation-e2e: writer-authority survives the wire', () => {
  it('peer A stamps Alice; B sees the stamp; impersonation from B is rejected on A', () => {
    const A = new Sequence();
    const B = new Sequence();
    installAuthCaps(A, { secret: SHARED_SECRET });
    installAuthCaps(B, { secret: SHARED_SECRET });
    installWriterAuthority(A, { scope: 'sessions', ownerSegmentIndex: 1 });
    installWriterAuthority(B, { scope: 'sessions', ownerSegmentIndex: 1 });
    advanceClock(A, NOW); advanceClock(B, NOW);
    pairFederation(A, B, { aId: 'A', bId: 'B' });

    // Alice's connection arrives on A with a real token.
    const aliceToken = mintSessionToken('alice', NOW + ONE_HOUR, SHARED_SECRET);
    const stampResult = stampSessionToken(A, {
      token: aliceToken,
      identityPath: 'id.conn.alice',
    });
    expect(stampResult.ok).toBe(true);

    // The stamp wrote sessions.alice.holder=id.conn.alice on A; that
    // forwarded to B; B now also knows the holder.
    expect(A.get('sessions.alice.holder')).toBe('id.conn.alice');
    expect(B.get('sessions.alice.holder')).toBe('id.conn.alice');

    // Bob, on B, tries to forge a write to alice's session as if he
    // owned it. B's writer-authority rejects locally — the forged
    // write never even gets forwarded to A.
    const r1 = B.insert({
      path: 'sessions.alice.note',
      value: 'pwned',
      author: 'id.conn.bob',
    });
    expect(r1.suspended).toBe(true);
    expect(A.get('sessions.alice.note')).toBeUndefined();
    expect(B.get('sessions.alice.note')).toBeUndefined();

    // Alice on A keeps writing; reaches B; admission accepts because
    // author flows across the wire.
    const r2 = A.insert({
      path: 'sessions.alice.heartbeat',
      value: NOW + 100,
      author: 'id.conn.alice',
    });
    expect(r2.suspended).toBe(false);
    expect(B.get('sessions.alice.heartbeat')).toBe(NOW + 100);
  });

  it('shared secret + cross-sequence: token minted on A validates on B', () => {
    const A = new Sequence();
    const B = new Sequence();
    installAuthCaps(A, { secret: SHARED_SECRET });
    installAuthCaps(B, { secret: SHARED_SECRET });
    advanceClock(A, NOW); advanceClock(B, NOW);

    const tokenFromA = mintSessionToken('alice', NOW + ONE_HOUR, SHARED_SECRET);
    // B validates A's token successfully because they share the secret.
    const validate = B.impls.get('auth.validateSessionToken');
    const result = (validate as any)({ token: tokenFromA });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user).toBe('alice');
  });
});

describe('federation-e2e: session lifecycle propagates across the wire', () => {
  it('heartbeat-driven status transitions visible on the peer', () => {
    const A = new Sequence();
    const B = new Sequence();
    installIndexSpec(A); installIndexSpec(B);
    installSessionLifecycle(A, { activeWindowMs: 30_000, expiryWindowMs: 120_000 });
    installSessionLifecycle(B, { activeWindowMs: 30_000, expiryWindowMs: 120_000 });
    advanceClock(A, NOW); advanceClock(B, NOW);
    pairFederation(A, B, { aId: 'A', bId: 'B' });

    // Alice's connection lands on A; user + heartbeat propagate.
    A.insert({ path: 'sessions.alice.user', value: 'alice', author: 'id.conn.alice' });
    A.insert({ path: 'sessions.alice.env', value: 'browser', author: 'id.conn.alice' });
    A.insert({ path: 'sessions.alice.heartbeat', value: NOW - 10_000, author: 'id.conn.alice' });

    // B's session-lifecycle classes ran independently on the propagated
    // state — both A and B have the same status.
    expect(A.get('sessions.alice.status')).toBe('active');
    expect(B.get('sessions.alice.status')).toBe('active');

    // Advance B's clock past expiry. B's lifecycle classes flip locally.
    advanceClock(B, NOW + 200_000);
    expect(B.get('sessions.alice.status')).toBe('expired');
    // (A still sees 'active' until A's own clock advances — that's
    // correct: each peer's clock is local.)
  });
});

describe('federation-e2e: snapshot survives federation', () => {
  it('A captures, A2 restores, A2 federates with B as if it were A', () => {
    const A = new Sequence();
    const B = new Sequence();
    installAuthCaps(A, { secret: SHARED_SECRET });
    installAuthCaps(B, { secret: SHARED_SECRET });
    installWriterAuthority(A, { scope: 'sessions', ownerSegmentIndex: 1 });
    installWriterAuthority(B, { scope: 'sessions', ownerSegmentIndex: 1 });
    advanceClock(A, NOW); advanceClock(B, NOW);
    pairFederation(A, B, { aId: 'A', bId: 'B' });

    // Alice connects to A; state federates.
    const aliceToken = mintSessionToken('alice', NOW + ONE_HOUR, SHARED_SECRET);
    stampSessionToken(A, { token: aliceToken, identityPath: 'id.conn.alice' });
    A.insert({ path: 'sessions.alice.heartbeat', value: NOW, author: 'id.conn.alice' });
    expect(B.get('sessions.alice.holder')).toBe('id.conn.alice');

    // Snapshot A. A drops out (simulated — we just stop using it).
    const snap = captureSnapshot(A);

    // A2 boots from snapshot. Same identity ('A') for the federation
    // pairing, so B continues seeing it as the same peer.
    const A2 = new Sequence();
    installAuthCaps(A2, { secret: SHARED_SECRET });
    installWriterAuthority(A2, { scope: 'sessions', ownerSegmentIndex: 1 });
    advanceClock(A2, NOW);
    restoreSnapshot(A2, { kind: 'entries', entries: snap });
    // Wire A2 ↔ B — replacing the dropped A.
    installCrossSequence(A2, 'A', (d: Outgoing) => receiveFromPeer(B, 'A', d));
    // (B's existing forwarder still references receiveFromPeer(A, ...);
    // for the test we manually wire the reverse leg.)
    installCrossSequence(B, 'B-2', (d: Outgoing) => receiveFromPeer(A2, 'B-2', d));

    // A2 has the inherited state.
    expect(A2.get('sessions.alice.holder')).toBe('id.conn.alice');
    expect(A2.get('sessions.alice.heartbeat')).toBe(NOW);

    // A2 continues writing as alice; updates flow to B.
    const r = A2.insert({
      path: 'sessions.alice.heartbeat',
      value: NOW + 60_000,
      author: 'id.conn.alice',
    });
    expect(r.suspended).toBe(false);
    expect(B.get('sessions.alice.heartbeat')).toBe(NOW + 60_000);
  });
});

describe('federation-e2e: storage survives a process boundary', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fed-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('A persists to NodeStorage; A2 reboots from same dir + snapshot, sees state', async () => {
    const A = new Sequence();
    installCommitment(A);
    const storageA = new NodeStorage(dir);
    installNodeStorage(A, storageA);

    // Tool: A writes a file via its substrate-native storage tool.
    A.insert({ path: 'tools.storage.write', value: { key: 'agent.state.json', data: '{"agent":"alice","step":3}' } });
    await flushPending(A);
    expect(A.get('tools.storage.write.result')).toEqual({});

    // Capture A's full state.
    const snap = captureSnapshot(A);

    // A2 boots: re-installs commitment + re-points at SAME storage dir.
    // Substrate state restored from snapshot; persistent file is on disk.
    const A2 = new Sequence();
    installCommitment(A2);
    const storageA2 = new NodeStorage(dir);
    installNodeStorage(A2, storageA2);
    restoreSnapshot(A2, { kind: 'entries', entries: snap });

    // A2 reads the file written by A.
    A2.insert({ path: 'tools.storage.read', value: { key: 'agent.state.json' } });
    await flushPending(A2);
    expect(A2.get('tools.storage.read.result')).toEqual({
      content: '{"agent":"alice","step":3}',
    });
  });
});

describe('federation-e2e: scope-filtered forwarding (private partitions stay local)', () => {
  it('A forwards only org.* + shared.*, NOT private.*', () => {
    const A = new Sequence();
    const B = new Sequence();
    installCrossSequence(A, 'A',
      (d: Outgoing) => receiveFromPeer(B, 'A', d),
      ['org.*', 'shared.*'],
    );
    installCrossSequence(B, 'B',
      (d: Outgoing) => receiveFromPeer(A, 'B', d),
      ['org.*', 'shared.*'],
    );

    A.insert({ path: 'org.publicState', value: 'visible-to-B' });
    A.insert({ path: 'private.secret', value: 'local-only' });
    A.insert({ path: 'shared.config', value: 'sync-me' });

    expect(B.get('org.publicState')).toBe('visible-to-B');
    expect(B.get('shared.config')).toBe('sync-me');
    expect(B.get('private.secret')).toBeUndefined();
    expect(A.get('private.secret')).toBe('local-only');  // local A still has it
  });
});

describe('federation-e2e: full security stack — three peers, mixed traffic', () => {
  it('Alice on A + Bob on B + impersonation attempts via direct cross-write', () => {
    const A = new Sequence();
    const B = new Sequence();
    installAuthCaps(A, { secret: SHARED_SECRET });
    installAuthCaps(B, { secret: SHARED_SECRET });
    installWriterAuthority(A, { scope: 'sessions', ownerSegmentIndex: 1 });
    installWriterAuthority(B, { scope: 'sessions', ownerSegmentIndex: 1 });
    advanceClock(A, NOW); advanceClock(B, NOW);
    pairFederation(A, B, { aId: 'A', bId: 'B' });

    // Alice connects on A.
    const aliceTok = mintSessionToken('alice', NOW + ONE_HOUR, SHARED_SECRET);
    expect(stampSessionToken(A, { token: aliceTok, identityPath: 'id.conn.alice' }).ok).toBe(true);

    // Bob connects on B.
    const bobTok = mintSessionToken('bob', NOW + ONE_HOUR, SHARED_SECRET);
    expect(stampSessionToken(B, { token: bobTok, identityPath: 'id.conn.bob' }).ok).toBe(true);

    // Both stamps propagated.
    expect(B.get('sessions.alice.holder')).toBe('id.conn.alice');
    expect(A.get('sessions.bob.holder')).toBe('id.conn.bob');

    // Each writes to their OWN session — admitted everywhere.
    const ra = A.insert({ path: 'sessions.alice.note', value: "alice's note", author: 'id.conn.alice' });
    const rb = B.insert({ path: 'sessions.bob.note', value: "bob's note", author: 'id.conn.bob' });
    expect(ra.suspended).toBe(false);
    expect(rb.suspended).toBe(false);
    expect(B.get('sessions.alice.note')).toBe("alice's note");
    expect(A.get('sessions.bob.note')).toBe("bob's note");

    // Bob (on B) forges a write to alice — local rejection.
    const forge1 = B.insert({ path: 'sessions.alice.note', value: 'pwned by bob', author: 'id.conn.bob' });
    expect(forge1.suspended).toBe(true);
    expect(B.get('sessions.alice.note')).toBe("alice's note");
    expect(A.get('sessions.alice.note')).toBe("alice's note");

    // Mallory (no token) lands on A and tries — local rejection.
    const forge2 = A.insert({ path: 'sessions.alice.note', value: 'mallory', author: 'id.conn.mallory' });
    expect(forge2.suspended).toBe(true);
    expect(A.get('sessions.alice.note')).toBe("alice's note");
  });
});
