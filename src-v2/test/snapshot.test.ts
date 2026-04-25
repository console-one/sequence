/**
 * snapshot.test.ts — port of v1 snapshot-recovery tests.
 *
 * priorSnapshot is the permanent-agent handoff primitive: agent
 * worker A serializes Sequence state to entries, drops out, agent
 * worker B boots, restoreSnapshot replays the entries, B continues
 * where A left off. Same primitive backs hot-standby takeover and
 * Lambda cold-start.
 *
 * Ported from v1 commit f8acf5f. Entries shape only in this port;
 * ft/ftPath need v2 DSL adapter (separate task).
 */

import { Sequence } from '../sequence';
import { createType, property } from '../../src/type';
import {
  captureSnapshot, restoreSnapshot,
  installCommitment, installAgentPrompt, installTool,
  installWriterAuthority,
} from '../stdlib';

describe('snapshot: capture + restore round-trip', () => {
  it('basic primitive values round-trip exactly', () => {
    const a = new Sequence();
    a.insert({ path: 'greeting', value: 'hello' });
    a.insert({ path: 'count', value: 42 });
    a.insert({ path: 'active', value: true });
    a.insert({ path: 'nada', value: null });
    a.insert({ path: 'nested.field', value: 'deep' });

    const snap = captureSnapshot(a);
    const b = new Sequence();
    const result = restoreSnapshot(b, { kind: 'entries', entries: snap });

    expect(result.replayed).toBeGreaterThan(0);
    expect(b.get('greeting')).toBe('hello');
    expect(b.get('count')).toBe(42);
    expect(b.get('active')).toBe(true);
    expect(b.get('nada')).toBeNull();
    expect(b.get('nested.field')).toBe('deep');
  });

  it('typed cells (schemas) round-trip', () => {
    const a = new Sequence();
    a.insert({
      path: 'user',
      type: createType('object', [
        property('name', createType('string')),
        property('age', createType('number')),
      ]),
    });

    const snap = captureSnapshot(a);
    const b = new Sequence();
    restoreSnapshot(b, { kind: 'entries', entries: snap });

    const t = b.typeAt('user');
    expect(t?.kind).toBe('object');
    const props = t?.constraints.filter(c => c.op === 'property') ?? [];
    expect(props).toHaveLength(2);
  });

  it('cells with both type AND value carry over correctly', () => {
    const a = new Sequence();
    a.insert({ path: 'port', type: createType('number') });
    a.insert({ path: 'port', value: 8080 });

    const snap = captureSnapshot(a);
    const b = new Sequence();
    restoreSnapshot(b, { kind: 'entries', entries: snap });

    expect(b.typeAt('port')?.kind).toBe('number');
    expect(b.get('port')).toBe(8080);
  });

  it('skipInternal omits _-prefixed paths', () => {
    const a = new Sequence();
    a.insert({ path: 'public.thing', value: 'visible' });
    a.insert({ path: '_internal.hidden', value: 'private' });

    const snap = captureSnapshot(a, { skipInternal: true });
    const internalEntry = snap.find(e => e.path.startsWith('_internal'));
    expect(internalEntry).toBeUndefined();
    const publicEntry = snap.find(e => e.path === 'public.thing');
    expect(publicEntry).toBeDefined();
  });
});

describe('snapshot: handoff scenario (the load-bearing case)', () => {
  it('agent A → snapshot → agent B continues with full state', async () => {
    const a = new Sequence();
    installCommitment(a);
    installAgentPrompt(a);
    a.insert({ path: '_agent.id', value: 'agent-shared' });
    a.insert({ path: '_agent.moment', value: 7 });
    installTool(a, 'tools.echo', {
      inputType: createType('object', [property('msg', createType('string'))]),
      outputType: createType('object', [property('echoed', createType('string'))]),
      impl: async (input: any) => ({ echoed: input.msg }),
      description: 'Echo a message back.',
      source: { id: 'demo', displayName: 'demo' },
    });

    // Agent A had been running a while — capture state.
    const snap = captureSnapshot(a, { skipInternal: false });

    // Agent worker B boots fresh, restores from snapshot.
    const b = new Sequence();
    installCommitment(b);
    installAgentPrompt(b);  // reinstall same stdlib classes — restorer
                             // overlays state on top.
    // Re-register the impl since impls are runtime-only (not serialized
    // in entries — same as v1 priorSnapshot).
    b.impls.set('tools.echo', async (input: any) => ({ echoed: input.msg }));
    restoreSnapshot(b, { kind: 'entries', entries: snap });

    // B has agent identity from A.
    expect(b.get('_agent.id')).toBe('agent-shared');
    expect(b.get('_agent.moment')).toBe(7);
    // B has the tool A installed.
    expect(b.typeAt('tools.echo')?.kind).toBe('fn');
    // B can RENDER the agent prompt with the inherited state.
    const prompt = b.get('_prompt.agent') as string;
    expect(prompt).toContain('agent-shared');
    expect(prompt).toContain('7th MOMENT');
  });

  it('captures + restores partial state (skipInternal) — substrate re-bootstraps clean', () => {
    // Capture only application state, not substrate machinery.
    // The receiver re-installs the stdlib first, then overlays.
    const a = new Sequence();
    installAgentPrompt(a);
    installCommitment(a);
    a.insert({ path: '_agent.id', value: 'agent-alice' });
    a.insert({ path: 'app.state', value: { count: 5 } });
    a.insert({ path: 'app.task.current', value: 'review-pr-42' });

    const snap = captureSnapshot(a, { skipInternal: true });
    expect(snap.find(e => e.path.startsWith('_agent'))).toBeUndefined();
    expect(snap.find(e => e.path.startsWith('_prompt'))).toBeUndefined();
    expect(snap.find(e => e.path === 'app.state')).toBeDefined();

    const b = new Sequence();
    installAgentPrompt(b);  // re-installs all _prompt.* and _agent.* defaults
    installCommitment(b);
    restoreSnapshot(b, { kind: 'entries', entries: snap });

    // App state restored.
    expect(b.get('app.state')).toEqual({ count: 5 });
    expect(b.get('app.task.current')).toBe('review-pr-42');
    // _agent.id is the default from re-install (NOT alice — that wasn't carried).
    expect(b.get('_agent.id')).toBe('agent-local');
  });
});

describe('snapshot: admission-rule interaction', () => {
  it('writer-authority does NOT block snapshot restore (entries carry author)', () => {
    const a = new Sequence();
    installWriterAuthority(a, { scope: 'sessions', ownerSegmentIndex: 1 });
    a.insert({
      path: 'sessions.alice.holder',
      value: 'id.conn.alice',
      author: 'id.conn.alice',
    });
    a.insert({
      path: 'sessions.alice.heartbeat',
      value: 1000,
      author: 'id.conn.alice',
    });

    const snap = captureSnapshot(a);
    expect(snap.find(e => e.path === 'sessions.alice.holder')?.value).toBe('id.conn.alice');

    const b = new Sequence();
    installWriterAuthority(b, { scope: 'sessions', ownerSegmentIndex: 1 });
    // Capture preserves the original author, so the restored writes
    // pass the writer-authority check. Without preserving author, the
    // second entry would be rejected.
    const result = restoreSnapshot(b, { kind: 'entries', entries: snap });
    expect(result.suspended).toBe(0);
    expect(b.get('sessions.alice.holder')).toBe('id.conn.alice');
    expect(b.get('sessions.alice.heartbeat')).toBe(1000);
  });

  it('failOnSuspended throws on the first rejected entry', () => {
    const b = new Sequence();
    installWriterAuthority(b, { scope: 'sessions', ownerSegmentIndex: 1 });
    // Pre-stamp a holder so the next write needs to match.
    b.insert({
      path: 'sessions.alice.holder',
      value: 'id.conn.alice',
      author: 'id.conn.alice',
    });
    expect(() => restoreSnapshot(
      b,
      { kind: 'entries', entries: [
        { path: 'sessions.alice.heartbeat', value: 99, author: 'id.conn.IMPOSTER' },
      ]},
      { failOnSuspended: true },
    )).toThrow(/suspended/);
  });
});

describe('snapshot: error cases', () => {
  it('throws on unsupported kind (ft/ftPath need DSL adapter)', () => {
    const b = new Sequence();
    expect(() => restoreSnapshot(
      b,
      { kind: 'ft', text: 'foo = 1' } as any,
    )).toThrow(/only 'entries' supported/);
  });

  it('empty entries → no-op', () => {
    const b = new Sequence();
    const result = restoreSnapshot(b, { kind: 'entries', entries: [] });
    expect(result.replayed).toBe(0);
    expect(result.suspended).toBe(0);
  });
});
