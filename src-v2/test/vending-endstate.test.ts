/**
 * vending-endstate.test.ts (v2) — the IDEAL END STATE of tool vending
 * as executable scenarios, ON THE KERNEL (src-v2), beneath the
 * storyboard beats it serves (each scenario names its beat).
 *
 * This suite is the REWORK of the 2026-07-24 v1 drafts: same ratchet
 * contract, re-based to v2 (the canonical kernel) and re-cut so every
 * scenario asserts what the storyboard walk needs — enforcement or
 * round-trip, never parse or appearance:
 *
 *   · a scenario NOT in specs/impl/VENDING_LEDGER.json must pass
 *   · a ledgered scenario that STARTS passing fails the suite until
 *     struck from the ledger (loud progress, no silent ratchets)
 *
 * Rules of construction: deterministic only (injected clocks, no real
 * LLM — the agent side is a fixed script, labeled as such); every
 * scenario asserts OBSERVABLE kernel behavior, never internal shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Sequence } from '../sequence';
import { vend, continueSession, expand, revend, callThroughSession, mergeFrames } from '../vend';
import { electFrame } from '../elect-frame';
import { declareConcern } from '../case';
import { receiveDocument } from '../receive-doc';
import { timeHorizon } from '../validity';
import { FT } from '../../src/builder';
import { createType, param, returns, impl, lte } from '../../src/type';

const LEDGER: Set<string> = new Set(
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'specs', 'impl', 'VENDING_LEDGER.json'),
      'utf-8',
    ),
  ) as string[],
);

/** Ratchet wrapper: ledgered scenarios must fail; others must pass. */
function scenario(id: string, name: string, body: () => void | Promise<void>): void {
  const ledgered = LEDGER.has(id);
  test(`${id} · ${name}${ledgered ? '  [LEDGERED GAP — must still fail]' : ''}`, async () => {
    if (!ledgered) {
      await body();
      return;
    }
    let passed = false;
    try {
      await body();
      passed = true;
    } catch {
      /* still a gap — documented, not silent */
    }
    if (passed) {
      throw new Error(
        `${id} now passes — remove it from specs/impl/VENDING_LEDGER.json to record the ratchet.`,
      );
    }
  });
}

/** The fixture kernel: two fs tools whose descriptions reference ONE
 *  label group (variant election + shared-prelude dedupe), impls
 *  registered the v2 way. No posteriors are mounted here — scenarios
 *  that need observed metrics mount them EXPLICITLY, because vend must
 *  never annotate without one (the honesty rule). */
function engine(clockRef: { t: number }): Sequence {
  const seq = new Sequence(() => clockRef.t);
  seq.insert({ path: 'narratives.fsGuide.short', value: 'FS tools operate on the workspace.' });
  seq.insert({
    path: 'narratives.fsGuide.long',
    value: 'FS tools operate on the mounted workspace. Paths are absolute. Writes are atomic and journaled.',
  });
  const fnType = (input: Record<string, unknown>, output: Record<string, unknown>, id: string) =>
    createType('fn', [
      param(FT.object(input as never).toType()),
      returns(FT.object(output as never).toType()),
      impl(id),
    ]);
  seq.insert({ path: 'fs.read', type: fnType({ p: FT.string().toType() }, { content: FT.string().toType() }, 'fs.read') });
  seq.insert({ path: 'fs.read._description', value: 'read a file. Context: [[narratives.fsGuide]]' });
  seq.impls.set('fs.read', (args: unknown) => ({ content: `<${(args as { p?: string })?.p}>` }));
  seq.insert({ path: 'fs.write', type: fnType({ p: FT.string().toType(), content: FT.string().toType() }, { ok: FT.boolean(true).toType() }, 'fs.write') });
  seq.insert({ path: 'fs.write._description', value: 'write a file. Context: [[narratives.fsGuide]]' });
  seq.impls.set('fs.write', () => ({ ok: true }));
  return seq;
}

const stripComments = (text: string): string =>
  text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

// ═══ Held behavior (NOT ledgered — regression guards) ═══════════════

describe('vending end state — held on the v2 kernel', () => {
  scenario('V1', 'selection + budget: omissions are spoken, never silent (beat 8)', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs', maxTools: 1 });
    expect(r.tools).toEqual(['fs.read']);
    expect(r.omitted).toEqual(['fs.write']);
    expect(r.text).toContain('[[more :');
  });

  scenario('V2', 'round-trip law: a second v2 kernel receiving the document gains the tools (beat 12 seed)', async () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs' });
    const rx = new Sequence(() => 1_000_000);
    const rr = await receiveDocument(rx, r.text);
    expect(rr.errors).toEqual([]);
    expect(rx.rawTypeAt('fs.read')?.kind).toBe('fn');
    expect(rx.rawTypeAt('fs.write')?.kind).toBe('fn');
  });

  scenario('V3', 'label prelude: elected ONCE, as a real bind, before definitions; election on the session (beats 1/5)', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs' });
    const binds = r.text.match(/^narratives\.fsGuide = /gm) ?? [];
    expect(binds.length).toBe(1);
    expect(r.text.indexOf('narratives.fsGuide = ')).toBeLessThan(r.text.indexOf('fs.read = '));
    // Budget-free vend elects the LARGEST variant; the election is a fact.
    expect(seq.get(`_sessions.${r.sessionId}.elected.narratives.fsGuide`)).toBe('long');
    // Authoring keeps the label: the description bind still says [[…]].
    expect(r.text).toContain('[[narratives.fsGuide]]');
  });

  scenario('V4', 'session liveness: continue applies while live, refuses after expiry', async () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { ttlMs: 60_000 });
    expect((await continueSession(seq, r.sessionId, 'x = 1')).ok).toBe(true);
    clock.t += 61_000;
    expect(await continueSession(seq, r.sessionId, 'y = 2')).toEqual({ ok: false, reason: 'expired' });
  });

  scenario('V5', 'validity is STRUCTURED: the received type carries the time bound timeHorizon() reads (beat 8)', async () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs.read', ttlMs: 60_000 });
    expect(r.text).toContain(`fs.read._validUntil = ${r.expiresAt}`);
    const rx = new Sequence(() => 1_000_000);
    await receiveDocument(rx, r.text);
    const horizons = (rx.rawTypeAt('fs.read')?.constraints ?? [])
      .map((c) => timeHorizon(c))
      .filter((h): h is number => h !== null);
    expect(horizons).toContain(r.expiresAt);
  });

  scenario('V6', 'annotation honesty: NO posterior → NO annotation; observed posterior → structured distribution on the received type (beat 8 hard core)', async () => {
    const seq = engine({ t: 1_000_000 });
    // Without any observed prior, vend must not author a number.
    const bare = vend(seq, { query: 'fs.read' });
    expect(bare.text).not.toContain('~survival');
    expect(bare.text).not.toContain('_reliability');
    // With observed posteriors mounted (as the reliability rules do),
    // the annotations appear — and round-trip as constraints.
    seq.insert({ path: 'fs.read._prior.latency', value: { family: 'exponential', rate: 0.002 } });
    seq.insert({ path: 'fs.read._prior.reliability', value: { alpha: 9, beta: 1 } });
    const r = vend(seq, { query: 'fs.read' });
    expect(r.text).toContain('~survival(exp, 0.002)');
    expect(r.text).toContain('fs.read._reliability = { alpha: 9, beta: 1 }');
    const rx = new Sequence(() => 1_000_000);
    const rr = await receiveDocument(rx, r.text);
    expect(rr.errors).toEqual([]);
    const cs = JSON.stringify(rx.rawTypeAt('fs.read')?.constraints ?? []);
    expect(cs).toContain('distribution');
    expect(cs).toContain('beta');
  });

  scenario('V7', 'frame snapshot: continuance against a changed surface gets a typed stale-frame answer', async () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { query: 'fs', ttlMs: 600_000 });
    // The surface changes under the client: fs.write stops being
    // executable here (the connector was uninstalled).
    seq.impls.delete('fs.write');
    const res = await continueSession(seq, r.sessionId, 'fs.write.result = "stale-call"');
    expect(res.ok).toBe(false);
    expect((res as { reason?: string }).reason).toBe('stale-frame');
  });

  scenario('V8', 'the expand endpoint: tokens are redeemable and priced; unknown tokens refused by name', () => {
    const seq = engine({ t: 1_000_000 });
    // A budget too small to transclude the prelude forces the token.
    const r = vend(seq, { query: 'fs.read', maxTokens: 40 });
    expect(r.expandTokens.length).toBeGreaterThan(0);
    const docToken = r.expandTokens.find((t) => t.startsWith('[[doc:'));
    expect(docToken).toBeDefined();
    const out = expand(seq, r.sessionId, docToken!);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.content).toContain('FS tools operate');
      expect(out.costTokens).toBeGreaterThan(0);
    }
    const bad = expand(seq, r.sessionId, '[[doc:no.such.doc : nothing]]');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('unknown-token');
  });

  scenario('V9', 're-vend within a session: narrows under the same contract, expiry unchanged', () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { ttlMs: 60_000 });
    clock.t += 10_000;
    const out = revend(seq, r.sessionId, { query: 'fs.read' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tools).toEqual(['fs.read']);
      expect(out.text).not.toContain('fs.write = ');
      expect(out.expiresAt).toBe(r.expiresAt);
    }
  });

  scenario('V10', 'the scripted-agent loop: read → expand → install → re-vend, end to end (operator-scripted, not model cognition)', async () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { maxTokens: 80, ttlMs: 600_000 });
    const docToken = r.expandTokens.find((t) => t.startsWith('[[doc:'));
    if (docToken) expect(expand(seq, r.sessionId, docToken).ok).toBe(true);
    const installed = await continueSession(seq, r.sessionId,
      'notify.send = (msg: string) -> { ok: boolean }');
    expect(installed.ok).toBe(true);
    const again = revend(seq, r.sessionId, {});
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.text).toContain('notify.send');
  });

  scenario('V11', 'THE COMMENT-STRIP GUARD: strip every `--` line — tools, expiry and reliability facts reconstruct identically', async () => {
    const seq = engine({ t: 1_000_000 });
    seq.insert({ path: 'fs.read._prior.reliability', value: { alpha: 9, beta: 1 } });
    const r = vend(seq, { query: 'fs', ttlMs: 60_000 });

    const rxFull = new Sequence(() => 1_000_000);
    await receiveDocument(rxFull, r.text);
    const rxStripped = new Sequence(() => 1_000_000);
    const rr = await receiveDocument(rxStripped, stripComments(r.text));
    expect(rr.errors).toEqual([]);

    for (const tool of r.tools) {
      expect(rxStripped.rawTypeAt(tool)?.kind).toBe('fn');
      const h = (t: Sequence) => (t.rawTypeAt(tool)?.constraints ?? [])
        .map((c) => timeHorizon(c)).filter((x): x is number => x !== null);
      expect(h(rxStripped)).toEqual(h(rxFull));
    }
    expect(rxStripped.get('fs.read._reliability')).toEqual(rxFull.get('fs.read._reliability'));
    expect(rxStripped.get(`_sessions.${r.sessionId}.expiresAt`)).toBe(r.expiresAt);
  });

  scenario('V12', 'the learning loop, kernel grain: a moved posterior moves the NEXT vend (beat 9)', () => {
    const seq = engine({ t: 1_000_000 });
    seq.insert({ path: 'fs.read._prior.latency', value: { family: 'exponential', rate: 0.002 } });
    const before = vend(seq, { query: 'fs.read' });
    expect(before.text).toContain('~survival(exp, 0.002)');
    // The observation moves the posterior (as the reliability rules do
    // on real calls); the next frame's annotation has moved with it.
    seq.insert({ path: 'fs.read._prior.latency', value: { family: 'exponential', rate: 0.005 } });
    const after = vend(seq, { query: 'fs.read' });
    expect(after.text).toContain('~survival(exp, 0.005)');
    expect(after.text).not.toContain('~survival(exp, 0.002)');
  });

  scenario('V18', 'temporal meet: a received grant re-vended can only TIGHTEN its validity (beat 12)', async () => {
    // A vends to B with a short ttl…
    const clockA = { t: 1_000_000 };
    const a = engine(clockA);
    const ra = vend(a, { query: 'fs.read', ttlMs: 60_000 });
    // …B receives (the bound mounts on B's type), then re-vends LONGER.
    const clockB = { t: 1_000_000 };
    const b = new Sequence(() => clockB.t);
    await receiveDocument(b, ra.text);
    const rb = vend(b, { query: 'fs.read', ttlMs: 3_600_000 });
    // C's grant on fs.read expires no later than A's.
    const m = /fs\.read\._validUntil = (\d+)/.exec(rb.text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(ra.expiresAt);
  });
});

// ═══ The terminal design (ledgered until built) ═════════════════════

describe('vending end state — the target', () => {
  scenario('V13', 'expiry ENFORCED at the receiving kernel: past the bound, the tool stops being offered', async () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs.read', ttlMs: 60_000 });
    const rxClock = { t: 1_000_000 };
    const rx = new Sequence(() => rxClock.t);
    await receiveDocument(rx, r.text);
    expect(rx.rawTypeAt('fs.read')?.kind).toBe('fn');
    rxClock.t = r.expiresAt + 1;
    // Terminal semantics: an expired definition is not offered — the
    // catalog walk that vend itself uses must exclude it.
    const rv = vend(rx, { query: 'fs.read' });
    expect(rv.tools).not.toContain('fs.read');
  });

  scenario('V14', 'refinement predicates round-trip: emitted, received, and ENFORCED at the call', async () => {
    // A refined param mounts with its constraint (the shared walker
    // mapping — one AST→Type conversion for both engines)…
    const seq = engine({ t: 1_000_000 });
    const rr = await receiveDocument(seq,
      'mail.get = (addr: string | addr MATCHES /@/, n: number | n >= 1) -> { ok: boolean }');
    expect(rr.errors).toEqual([]);
    seq.impls.set('mail.get', () => ({ ok: true }));
    // …the vended line carries the refinement (renderTypeFt round-trip)…
    const r = vend(seq, { query: 'mail.get', ttlMs: 60_000 });
    expect(r.text).toContain('/@/');
    expect(r.text).toContain('>= 1');
    // …a second kernel receiving the frame holds it…
    const rx = new Sequence(() => 1_000_000);
    const rx2 = await receiveDocument(rx, r.text);
    expect(rx2.errors).toEqual([]);
    expect(JSON.stringify(rx.rawTypeAt('mail.get')?.constraints ?? [])).toContain('@');
    // …and the call path ENFORCES it: violating args are refused by
    // name, before the impl runs.
    const bad = await callThroughSession(seq, r.sessionId, 'mail.get', { addr: 'no-at', n: 0 });
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toContain('invalid-args');
    const good = await callThroughSession(seq, r.sessionId, 'mail.get', { addr: 'a@b', n: 2 });
    expect(good.ok).toBe(true);
  });

  scenario('V15', 'the AUTOMATIC loop: a call through the session updates the posterior — no manual mounting (beat 9)', async () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { query: 'fs.read', ttlMs: 600_000 });
    expect(seq.get('fs.read._prior.reliability')).toBeUndefined();
    const call = await callThroughSession(seq, r.sessionId, 'fs.read', { p: '/x' });
    expect(call.ok).toBe(true);
    // Terminal: the observation itself moved the belief.
    expect(seq.get('fs.read._prior.reliability')).toBeDefined();
  });

  scenario('V16', 'complex input types behind expansion tokens, redeemable and typed (beat 8)', () => {
    const seq = engine({ t: 1_000_000 });
    const deep = FT.object({
      filter: FT.object({
        from: FT.string().toType(), to: FT.string().toType(),
        subject: FT.string().toType(), before: FT.number().toType(),
        after: FT.number().toType(),
      }).toType(),
    } as never).toType();
    seq.insert({ path: 'mail.search', type: createType('fn', [param(deep), returns(FT.object({} as never).toType()), impl('mail.search')]) });
    const r = vend(seq, { query: 'mail.search', maxTokens: 60 });
    // The full form did not fit; the tool is still OFFERED — as a
    // receivable stub (looser, never wrong) with a redeemable token.
    expect(r.tools).toContain('mail.search');
    expect(r.text).toContain('mail.search = (input: { }) -> { }');
    const typeToken = r.expandTokens.find((t) => t.startsWith('[[type:'));
    expect(typeToken).toBeDefined();
    const out = expand(seq, r.sessionId, typeToken!);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.content).toContain('filter');
      expect(out.costTokens).toBeGreaterThan(0);
    }
  });

  scenario('V17', 'frame merge: two vended frames compose — same tool → tightest consistent; conflict → named never (beat 11)', async () => {
    const a = engine({ t: 1_000_000 });
    const b = engine({ t: 1_000_000 });
    const ra = vend(a, { query: 'fs.read', ttlMs: 60_000 });
    const rb = vend(b, { query: 'fs.read', ttlMs: 30_000 });
    const merged = await mergeFrames([ra.text, rb.text]);
    // Tightest consistent: the shorter validity wins in the merged frame.
    expect(merged.tools).toContain('fs.read');
    expect(merged.text).toContain(`fs.read._validUntil = ${rb.expiresAt}`);
    expect(merged.conflicts).toEqual([]);
    // A genuine contradiction is NAMED, never silently overwritten.
    const clash = await mergeFrames([
      'x.go = (p: string) -> { ok: boolean }',
      'x.go = (p: number) -> { ok: boolean }',
    ]);
    expect(clash.tools).not.toContain('x.go');
    expect(clash.conflicts.some((c) => c.startsWith('x.go'))).toBe(true);
  });

  scenario('V19', 'chain-grained provenance: the origin office sees the full re-vend chain (beat 12)', async () => {
    const a = engine({ t: 1_000_000 });
    const ra = vend(a, { query: 'fs.read', ttlMs: 600_000 });
    const b = new Sequence(() => 1_000_000);
    await receiveDocument(b, ra.text);
    // B re-vends A's grant; the vend owes A a chain report, and the
    // HOST delivers it — the kernel cannot transport, same contract as
    // continue itself.
    const rb = vend(b, { query: 'fs.read', ttlMs: 60_000 });
    expect(rb.chainReports.length).toBeGreaterThan(0);
    expect(rb.chainReports[0].session).toBe(ra.sessionId);
    for (const report of rb.chainReports) {
      expect((await continueSession(a, report.session, report.ft)).ok).toBe(true);
    }
    // A sees the re-vend at the capability grain, chain-keyed.
    const links = a.keys(`_sessions.${ra.sessionId}.chain`);
    expect(links).toContain(rb.sessionId);
    const link = a.get(`_sessions.${ra.sessionId}.chain.${rb.sessionId}`) as
      { tools?: string; expiresAt?: number };
    expect(link.tools).toContain('fs.read');
    // And C, receiving from B, holds the FULL chain as provenance.
    const c = new Sequence(() => 1_000_000);
    await receiveDocument(c, rb.text);
    expect(c.get('fs.read._origin.chain')).toBe(`${ra.sessionId} ${rb.sessionId}`);
  });
});

// ═══ The elected frame — stage 1 (cells → case → election → commitment) ═══

describe('the elected frame — one election over declared concerns', () => {
  scenario('E1', 'the declared walk assigns the meaning: same kernel, different concerns → different frames; claims round-trip', async () => {
    const seq = engine({ t: 1_000_000 });
    // A future-bounded fact cell — expiry/wake-shaped: a CLAIM, not a
    // tool, not a class of its own. Its type carries the bound the walk
    // reads (the same lte($now, T) family timeHorizon() reads).
    seq.insert({ path: 'standup.next', type: createType('number', [lte('$now', 1_030_000)]) });
    seq.insert({ path: 'standup.next', value: 1_030_000 });
    declareConcern(seq, 'upcoming', {
      withinHorizon: true, horizon: 100_000,
      value: { base: 1, access: 0, preference: 0, temporal: 1 },
    });
    declareConcern(seq, 'toolsOnly', {
      typeKind: 'fn',
      value: { base: 1, access: 0, preference: 0, temporal: 0 },
    });
    // Under the temporal walk the claim is the WHOLE frame (tools carry
    // no time bound here); under the fn walk the tools are — one engine,
    // meaning assigned by the declared case, never by candidate classes.
    const up = electFrame(seq, { concern: 'upcoming' });
    expect(up.admitted).toEqual(['standup.next']);
    const tl = electFrame(seq, { concern: 'toolsOnly' });
    expect(tl.admitted).toEqual(['fs.read', 'fs.write']);
    // The claim round-trips: a second kernel holds the fact AND its bound.
    const rx = new Sequence(() => 1_000_000);
    const rr = await receiveDocument(rx, up.text);
    expect(rr.errors).toEqual([]);
    expect(rx.get('standup.next')).toBe(1_030_000);
    expect(rx.get('standup.next._validUntil')).toBe(1_030_000);
  });

  scenario('E2', 'omissions spoken + duals reported: scarcity has a PRICE and the frame carries it', () => {
    const seq = engine({ t: 1_000_000 });
    for (let i = 0; i < 6; i++) {
      seq.insert({ path: `notes.n${i}`, value: `note number ${i} with some text to size it` });
    }
    declareConcern(seq, 'notes', {
      roots: ['notes'],
      value: { base: 1, access: 0, preference: 0, temporal: 0 },
    });
    const loose = electFrame(seq, { concern: 'notes', capacities: { tokens: 10_000 } });
    expect(loose.omitted).toEqual([]);
    expect(loose.duals.tokens).toBe(0); // slack capacity: attention is free
    const tight = electFrame(seq, { concern: 'notes', capacities: { tokens: 40 } });
    expect(tight.admitted.length).toBeGreaterThan(0);
    expect(tight.admitted.length).toBeLessThan(6);
    expect(tight.omitted.length).toBe(6 - tight.admitted.length);
    expect(tight.text).toContain('[[more :'); // omission spoken, never silent
    expect(tight.duals.tokens).toBeGreaterThan(0); // saturation IS a rising price
    // The price is committed as a session fact on the store, not narrated.
    expect(seq.get(`_sessions.${tight.sessionId}.duals.tokens`)).toBe(tight.duals.tokens);
  });

  scenario('E3', 'commitment round-trips at a second kernel — tools, claims and duals — with every comment stripped', async () => {
    const seq = engine({ t: 1_000_000 });
    seq.insert({ path: 'standup.next', type: createType('number', [lte('$now', 1_030_000)]) });
    seq.insert({ path: 'standup.next', value: 1_030_000 });
    declareConcern(seq, 'brief', {
      horizon: 100_000,
      value: { base: 1, access: 1, preference: 0, temporal: 1 },
    });
    const r = electFrame(seq, { concern: 'brief', capacities: { tokens: 10_000 }, ttlMs: 60_000 });
    expect(r.tools).toEqual(['fs.read', 'fs.write']);
    expect(r.admitted).toContain('standup.next');
    // The strip guard is the commitment's integrity condition: what was
    // elected reconstructs from statements alone.
    const rx = new Sequence(() => 1_000_000);
    const rr = await receiveDocument(rx, stripComments(r.text));
    expect(rr.errors).toEqual([]);
    expect(rx.rawTypeAt('fs.read')?.kind).toBe('fn');
    expect(rx.rawTypeAt('fs.write')?.kind).toBe('fn');
    expect(rx.get('standup.next')).toBe(1_030_000);
    expect(rx.get('standup.next._validUntil')).toBe(1_030_000);
    expect(rx.get(`_sessions.${r.sessionId}.duals.tokens`)).toBe(r.duals.tokens);
    expect(rx.get(`_sessions.${r.sessionId}.expiresAt`)).toBe(r.expiresAt);
  });

  scenario('E4', 'vend ≡ the tools-weighted degenerate election: byte-equivalent frames on the fixture', () => {
    const a = engine({ t: 1_000_000 });
    const b = engine({ t: 1_000_000 });
    // The concern vend declares lazily, declared by hand here — vend must
    // add NOTHING beyond this data.
    declareConcern(b, 'tools', {
      roots: [''], axes: ['structural'], typeKind: 'fn',
      value: { base: 1, access: 0, preference: 0, temporal: 0 },
    });
    const va = vend(a, { query: 'fs', maxTokens: 2000, session: 'sE4', ttlMs: 100_000 });
    const fb = electFrame(b, {
      concern: 'tools', query: 'fs', maxTokens: 2000, session: 'sE4', ttlMs: 100_000,
    });
    expect(fb.text).toBe(va.text); // byte-equivalent
    expect(fb.tools).toEqual(va.tools);
    // Under a tool cap the elected head is the old slice — same bytes,
    // with the price of a tool slot now spoken in both.
    const va2 = vend(a, { maxTools: 1, session: 'sE4b', ttlMs: 100_000 });
    const fb2 = electFrame(b, {
      concern: 'tools', capacities: { items: 1 }, session: 'sE4b', ttlMs: 100_000,
    });
    expect(fb2.text).toBe(va2.text);
    expect(va2.tools).toEqual(['fs.read']);
    expect(va2.omitted).toEqual(['fs.write']);
  });

  scenario('E5', 'capacities BIND: tighter budget → smaller, NESTED admitted set (monotone)', () => {
    const seq = engine({ t: 1_000_000 });
    for (let i = 0; i < 8; i++) {
      seq.insert({ path: `notes.n${i}`, value: `note ${i} body text for sizing` });
    }
    declareConcern(seq, 'notes', {
      roots: ['notes'],
      value: { base: 1, access: 0, preference: 0, temporal: 0 },
    });
    const at = (tokens: number): Set<string> =>
      new Set(electFrame(seq, { concern: 'notes', capacities: { tokens } }).admitted);
    const s1 = at(30);
    const s2 = at(60);
    const s3 = at(10_000);
    expect(s1.size).toBeGreaterThan(0);
    expect(s1.size).toBeLessThan(s2.size);
    expect(s2.size).toBeLessThan(s3.size);
    expect(s3.size).toBe(8);
    for (const p of s1) expect(s2.has(p)).toBe(true);
    for (const p of s2) expect(s3.has(p)).toBe(true);
  });

  scenario('E6', 'the relevance loop: what a client ignores SHRINKS in its next frame (beat 9 at the attention grain)', async () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    declareConcern(seq, 'work', {
      typeKind: 'fn',
      value: { base: 1, access: 0, preference: 0, temporal: 0 },
    });
    // Frame 1: room for everything — both tools admitted.
    const f1 = electFrame(seq, { concern: 'work', client: 'casey', ttlMs: 600_000 });
    expect(f1.admitted).toEqual(['fs.read', 'fs.write']);
    // The client engages ONE admitted cell, through the session — the
    // session is the instrument; nothing else records anything.
    const call = await callThroughSession(seq, f1.sessionId, 'fs.read', { p: '/x' });
    expect(call.ok).toBe(true);
    // The NEXT election folds the evidence: engaged → success, ignored
    // → failure — observed conjugate posteriors, per client, on facts.
    const f2 = electFrame(seq, { concern: 'work', client: 'casey', capacities: { items: 1 } });
    expect(f2.admitted).toEqual(['fs.read']);
    expect(f2.omitted).toContain('fs.write');
    const relRead = seq.get('_relevance.casey.fs.read') as { alpha: number; beta: number };
    const relWrite = seq.get('_relevance.casey.fs.write') as { alpha: number; beta: number };
    expect(relRead.alpha).toBe(2);   // one engagement observed
    expect(relRead.beta).toBe(1);
    expect(relWrite.alpha).toBe(1);
    expect(relWrite.beta).toBe(2);   // one ignore observed
    // One real observation never counts twice — f1 is spent; only f2's
    // session folds at the third election. And OMISSION IS NOT AN
    // IGNORE: fs.write was never admitted in f2, so it gains no
    // evidence; fs.read (admitted in f2, untouched) records the ignore.
    const f3 = electFrame(seq, { concern: 'work', client: 'casey', capacities: { items: 1 } });
    expect(f3.admitted).toEqual(['fs.read']);
    expect(seq.get('_relevance.casey.fs.read')).toMatchObject({ alpha: 2, beta: 2 });
    expect(seq.get('_relevance.casey.fs.write')).toMatchObject({ alpha: 1, beta: 2 });
  });

  scenario('E7', 'declared costs BIND: a `._costs` dimension under a unit capacity admits at most one of a group', () => {
    const seq = engine({ t: 1_000_000 });
    // Three alternative renderings of one section — richest first. Each
    // declares one unit of the section's slot dimension; only capacity
    // decides which alternative speaks. No switch, no ladder walker.
    seq.insert({ path: 'report.daily.r0', value: 'the full report body with every line of detail included' });
    seq.insert({ path: 'report.daily.r0._costs', value: { slot_daily: 1 } });
    seq.insert({ path: 'report.daily.r1', value: 'the medium report with a few more words of body' });
    seq.insert({ path: 'report.daily.r1._costs', value: { slot_daily: 1 } });
    seq.insert({ path: 'report.daily.r2', value: 'daily: 3 items' });
    seq.insert({ path: 'report.daily.r2._costs', value: { slot_daily: 1 } });
    declareConcern(seq, 'report', { roots: ['report'], value: { base: 1, access: 0, preference: 1, temporal: 0 } });
    // Declared preference: richer rungs claim more value (data, not code).
    seq.insert({ path: '_preferences.reader.weights.report.daily.r0', value: 3 });
    seq.insert({ path: '_preferences.reader.weights.report.daily.r1', value: 2 });
    seq.insert({ path: '_preferences.reader.weights.report.daily.r2', value: 1 });

    // Roomy tokens: the slot capacity alone binds — exactly ONE rung, the richest.
    const roomy = electFrame(seq, { concern: 'report', client: 'reader', capacities: { tokens: 10_000, slot_daily: 1 } });
    expect(roomy.admitted).toEqual(['report.daily.r0']);
    // Tight tokens: the full rung no longer fits; the slot still admits
    // at most one — the fullest AFFORDABLE rung speaks.
    const tight = electFrame(seq, { concern: 'report', client: 'reader', capacities: { tokens: 12, slot_daily: 1 } });
    expect(tight.admitted).toEqual(['report.daily.r2']);
    expect(tight.omitted).toContain('report.daily.r0');
  });
});
