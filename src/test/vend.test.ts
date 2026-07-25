/**
 * vend.test.ts — tool compilation for clients (TOOL_COMPILATION_VENDING).
 *
 * Pins the composition rules, not just output shape: selection by
 * query/maxTools, budget overflow as expansion tokens (never silent),
 * prelude transclusion rendered ONCE across tools that share it,
 * label-group election under budget, deep-field doc links, and the
 * session contract (mounted record, continue endpoint, structured
 * expiry refusal).
 */
import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';
import { vend, continueSession } from '../vend';
import { FT } from '../builder';

function engine(clockRef: { t: number }): Sequence {
  const seq = new Sequence(() => clockRef.t);
  seq.mount('bind', '_docs.fsGuide.short', 'FS tools operate on the workspace.');
  seq.mount(
    'bind',
    '_docs.fsGuide.long',
    'FS tools operate on the mounted workspace. Paths are absolute. Writes are atomic and journaled; reads see the latest committed write. Deletes are tombstoned for 30 days.',
  );
  seq.mount('bind', '_docs.pathField', 'Absolute path, must start with /.');
  seq.mount('schema', 'fs.read', FT.fn({
    input: FT.object({ p: FT.string().annotate('doc', '_docs.pathField').toType() }).toType(),
    output: FT.object({ content: FT.string().toType() }).toType(),
    description: 'read a file',
  }).annotate('docPrelude', '_docs.fsGuide').toType());
  seq.mount('schema', 'fs.write', FT.fn({
    input: FT.object({ p: FT.string().toType(), content: FT.string().toType() }).toType(),
    output: FT.object({ ok: FT.boolean(true).toType() }).toType(),
    description: 'write a file',
  }).annotate('docPrelude', '_docs.fsGuide').toType());
  seq.mount('schema', 'llm.complete', FT.fn({
    input: FT.object({ prompt: FT.string().toType() }).toType(),
    output: FT.object({ text: FT.string().toType() }).toType(),
    description: 'complete a prompt',
  }).toType());
  return seq;
}

describe('vend — selection and budget', () => {
  test('query narrows; maxTools caps; omissions are reported with an expansion token', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs', maxTools: 1 });
    expect(r.tools).toEqual(['fs.read']);
    expect(r.omitted).toEqual(['fs.write']);
    expect(r.expandTokens.some((t) => t.includes('more'))).toBe(true);
    expect(r.text).toContain('[[more : 1 more matching tool');
  });

  test('no query → the whole mounted fn surface', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, {});
    expect(r.tools).toEqual(['fs.read', 'fs.write', 'llm.complete']);
  });

  test('budget overflow drops whole tools, reported, never mid-definition', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { maxTokens: 60 });
    expect(r.tools.length).toBeLessThan(3);
    expect(r.omitted.length + r.tools.length).toBe(3);
    expect(r.text).toContain('[[more :');
  });
});

describe('vend — documentation rules', () => {
  test('a prelude shared by two tools renders exactly once, before definitions', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs', maxTokens: 2_000 });
    const hits = r.text.match(/prelude: _docs\.fsGuide/g) ?? [];
    expect(hits.length).toBe(1);
    expect(r.text.indexOf('prelude:')).toBeLessThan(r.text.indexOf('tool fs.read'));
  });

  test('label-group election picks the variant that fits the budget share', () => {
    const seq = engine({ t: 1_000_000 });
    const generous = vend(seq, { query: 'fs', maxTokens: 2_000 });
    expect(generous.text).toContain('[long]');
    const tight = vend(seq, { query: 'fs', maxTokens: 60 });
    // Under a tight budget the SHORT variant (or none) is elected —
    // never the long one.
    expect(tight.text).not.toContain('[long]');
  });

  test('deep-field docs surface as expansion links naming the field', () => {
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs.read' });
    expect(r.text).toContain('input.p: [[doc:_docs.pathField');
    expect(r.expandTokens.some((t) => t.includes('_docs.pathField'))).toBe(true);
  });
});

describe('the session contract', () => {
  test('vend mounts the session and declares the continue endpoint in the document', () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { ttlMs: 60_000 });
    expect(r.text).toContain(`tool _sessions.${r.sessionId}.continue`);
    expect(r.text).toContain(`_sessions.${r.sessionId}.continue = (ft: string)`);
    const rec = seq.get(`_sessions.${r.sessionId}`) as { expiresAt: number };
    expect(rec.expiresAt).toBe(1_060_000);
  });

  test('continueSession applies ft while live, refuses after expiry, rejects unknown ids', () => {
    const clock = { t: 1_000_000 };
    const seq = engine(clock);
    const r = vend(seq, { ttlMs: 60_000 });

    const live = continueSession(seq, r.sessionId, 'tool notify.send');
    expect(live.ok).toBe(true);
    expect(seq.projection.tools.has('notify.send')).toBe(true);

    clock.t += 61_000;
    expect(continueSession(seq, r.sessionId, 'x = 1')).toEqual({ ok: false, reason: 'expired' });
    expect(continueSession(seq, 'nope', 'x = 1')).toEqual({ ok: false, reason: 'unknown-session' });
  });

  test('the vended document is receivable ft — the loop closes', () => {
    // What the kernel emits, another kernel (or the same one) can read:
    // comments and expansion tokens included, nothing throws.
    const seq = engine({ t: 1_000_000 });
    const r = vend(seq, { query: 'fs', maxTokens: 2_000 });
    const other = new Sequence(() => 1);
    expect(() => receive(r.text, other)).not.toThrow();
    // Not just parseable — the receiving kernel actually GAINS the tools.
    expect(other.projection.tools.has('fs.read')).toBe(true);
    expect(other.projection.tools.has('fs.write')).toBe(true);
  });
});
