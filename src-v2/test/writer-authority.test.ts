/**
 * writer-authority.test.ts — port from v1's writer-authority law.
 *
 * v1 commit cf27d83 landed this rule on sessions.*:
 *   or(notExists('$instancePath.holder'),
 *      eq('$instancePath.holder', '$author'),
 *      eq('$instancePath.status', 'expired'))
 *
 * These tests prove the v2-stdlib port preserves the same security
 * semantics end-to-end. Needed before v2 cross-sequence forwarding can
 * be safely enabled: without writer-authority any peer can write any
 * partition over the wire.
 */

import { Sequence } from '../sequence';
import { installWriterAuthority } from '../stdlib';

function mount(seq: Sequence, opts: { path: string; value: unknown; author?: string }) {
  return seq.insert({ path: opts.path, value: opts.value, author: opts.author });
}

describe('writer-authority: sessions.{user}.* admission law', () => {
  function makeSeq(): Sequence {
    const s = new Sequence();
    installWriterAuthority(s, { scope: 'sessions', ownerSegmentIndex: 1 });
    return s;
  }

  it('allows any author to claim a session with no holder set', () => {
    const s = makeSeq();
    const r = mount(s, { path: 'sessions.alice.heartbeat', value: 100, author: 'alice' });
    expect(r.suspended).toBe(false);
    expect(s.get('sessions.alice.heartbeat')).toBe(100);
  });

  it('once a holder is set, the holder keeps writing freely', () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    const r = mount(s, { path: 'sessions.alice.heartbeat', value: 200, author: 'alice' });
    expect(r.suspended).toBe(false);
    expect(s.get('sessions.alice.heartbeat')).toBe(200);
  });

  it("once a holder is set, a DIFFERENT author cannot overwrite the session's state", () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    mount(s, { path: 'sessions.alice.heartbeat', value: 100, author: 'alice' });
    const r = mount(s, { path: 'sessions.alice.heartbeat', value: 999, author: 'bob' });
    expect(r.suspended).toBe(true);
    // Alice's value survives — Bob's write was rejected at admission.
    expect(s.get('sessions.alice.heartbeat')).toBe(100);
  });

  it('cross-user attempts against other users are rejected too', () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    // Bob tries to write to Alice's session as if he owned it.
    const r = mount(s, { path: 'sessions.alice.secretNote', value: 'pwned', author: 'bob' });
    expect(r.suspended).toBe(true);
    expect(s.get('sessions.alice.secretNote')).toBeUndefined();
  });

  it('expired session allows takeover by a new author', () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    mount(s, { path: 'sessions.alice.status', value: 'expired', author: 'alice' });
    // Bob can now reclaim an expired session.
    const r = mount(s, { path: 'sessions.alice.holder', value: 'bob', author: 'bob' });
    expect(r.suspended).toBe(false);
    expect(s.get('sessions.alice.holder')).toBe('bob');
  });

  it('cascade-induced blocks bypass the check (systemInternal equivalent)', () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    // Cascade-emitted block has cause.ruleId, no author — must not be blocked.
    const result = s.insert({
      path: 'sessions.alice.systemMeta',
      value: 'set-by-rule',
      // Simulate a rule-emitted block
      author: undefined,
    });
    // Manually set cause to simulate cascade emission
    result.block.cause = { from: 'test', ruleId: 'some_rule' };
    // Re-submit the same block-shape through direct step wouldn't be kosher;
    // easier: install a one-shot rule that emits under another path as bob.
    s.emitters.set('impersonator', () => [{
      path: 'sessions.alice.byCascade', value: 'from rule', author: 'bob',
    }]);
    s.insert({
      path: '_rules.imp',
      rules: [{
        id: 'imp',
        phase: 'observation',
        scope: '',
        watching: ['trigger'],
        emit: 'impersonator',
      }],
    });
    s.insert({ path: 'trigger', value: 'go' });
    // The rule emitted a block with author='bob' targeting alice's session,
    // but since it was cascade-emitted (cause.ruleId set), the writer-auth
    // check bypasses, and the write lands.
    expect(s.get('sessions.alice.byCascade')).toBe('from rule');
  });

  it('writes to paths shallower than the instance are unaffected (fail-open)', () => {
    const s = makeSeq();
    // Writing to `sessions` root itself — doesn't carry a session identity.
    const r = mount(s, { path: 'sessions', value: 'root-data', author: 'anyone' });
    expect(r.suspended).toBe(false);
  });

  it('writes to unrelated paths outside the scope are unaffected', () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    // Bob can write to his own session elsewhere
    const r = mount(s, { path: 'sessions.bob.heartbeat', value: 50, author: 'bob' });
    expect(r.suspended).toBe(false);
    // And to completely unrelated paths
    const r2 = mount(s, { path: 'unrelated.thing', value: 42, author: 'bob' });
    expect(r2.suspended).toBe(false);
  });

  it('no-author writes are rejected when a holder is already set', () => {
    const s = makeSeq();
    mount(s, { path: 'sessions.alice.holder', value: 'alice', author: 'alice' });
    const r = mount(s, { path: 'sessions.alice.heartbeat', value: 123 });
    // block.author is undefined; holder is 'alice'; holder !== undefined → reject
    expect(r.suspended).toBe(true);
  });

  it('no-author writes ARE allowed when no holder is set yet (first claim)', () => {
    const s = makeSeq();
    const r = mount(s, { path: 'sessions.alice.heartbeat', value: 10 });
    expect(r.suspended).toBe(false);
  });
});

describe('writer-authority: parameterization', () => {
  it('ownerSegmentIndex: 2 works for three-segment schemas like orgs.{org}.sessions.*', () => {
    const s = new Sequence();
    installWriterAuthority(s, { scope: 'orgs', ownerSegmentIndex: 2 });
    mount(s, { path: 'orgs.acme.sessions.holder', value: 'alice', author: 'alice' });
    // Alice writes to her session — allowed
    const r1 = mount(s, { path: 'orgs.acme.sessions.heartbeat', value: 100, author: 'alice' });
    expect(r1.suspended).toBe(false);
    // Bob tries — rejected
    const r2 = mount(s, { path: 'orgs.acme.sessions.heartbeat', value: 200, author: 'bob' });
    expect(r2.suspended).toBe(true);
  });

  it('disabling statusField disables the expired-session takeover path', () => {
    const s = new Sequence();
    installWriterAuthority(s, { scope: 'locks', ownerSegmentIndex: 1, statusField: null });
    mount(s, { path: 'locks.res1.holder', value: 'alice', author: 'alice' });
    mount(s, { path: 'locks.res1.status', value: 'expired', author: 'alice' });
    // Even with status=expired, bob is rejected because takeover is disabled.
    const r = mount(s, { path: 'locks.res1.holder', value: 'bob', author: 'bob' });
    expect(r.suspended).toBe(true);
    expect(s.get('locks.res1.holder')).toBe('alice');
  });

  it('holderField custom name — "owner" instead of "holder"', () => {
    const s = new Sequence();
    installWriterAuthority(s, { scope: 'resources', ownerSegmentIndex: 1, holderField: 'owner' });
    mount(s, { path: 'resources.doc1.owner', value: 'alice', author: 'alice' });
    const r1 = mount(s, { path: 'resources.doc1.data', value: 'content', author: 'alice' });
    expect(r1.suspended).toBe(false);
    const r2 = mount(s, { path: 'resources.doc1.data', value: 'hacked', author: 'bob' });
    expect(r2.suspended).toBe(true);
  });
});
