// 07 — The engine: one kernel, many agents, sessions with expiry.
//
// sequence as a standalone tool-compilation engine: boot it, mount
// tools WITH their documentation as data, then vend each agent its own
// budgeted ft document — docs transcluded by rule, a session id, and a
// continue endpoint that refuses ft after the session's structured
// expiry. What one kernel vends, another kernel can receive.
import { Sequence, receive, vend, continueSession, FT } from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('07-vending — the kernel vends its surface to two agents');

let clock = 1_000_000;
const kernel = new Sequence(() => clock);

// Documentation is data on the store: a shared guide with two variants
// (a label group), and a field-level doc.
kernel.mount('bind', '_docs.fsGuide.short', 'FS tools operate on the workspace.');
kernel.mount('bind', '_docs.fsGuide.long',
  'FS tools operate on the mounted workspace. Paths are absolute. Writes are atomic and journaled; reads see the latest committed write.');
kernel.mount('bind', '_docs.pathField', 'Absolute path, must start with /.');

// Tools carry doc ASSOCIATIONS in their type meta — including on a
// field buried inside the input shape.
kernel.mount('schema', 'fs.read', FT.fn({
  input: FT.object({ p: FT.string().annotate('doc', '_docs.pathField').toType() }).toType(),
  output: FT.object({ content: FT.string().toType() }).toType(),
  description: 'read a file',
}).annotate('docPrelude', '_docs.fsGuide').toType());
kernel.mount('schema', 'fs.write', FT.fn({
  input: FT.object({ p: FT.string().toType(), content: FT.string().toType() }).toType(),
  output: FT.object({ ok: FT.boolean(true).toType() }).toType(),
  description: 'write a file',
}).annotate('docPrelude', '_docs.fsGuide').toType());
kernel.mount('schema', 'llm.complete', FT.fn({
  input: FT.object({ prompt: FT.string().toType() }).toType(),
  output: FT.object({ text: FT.string().toType() }).toType(),
  description: 'complete a prompt',
}).toType());

// ── Agent A: fs specialist on a tight budget, 1-minute session.
const a = vend(kernel, { query: 'fs', maxTokens: 200, ttlMs: 60_000 });
console.log('\n── what agent A receives ──');
console.log(a.text);

assert(a.tools.length === 2, 'A got both fs tools under its budget');
assert((a.text.match(/prelude: _docs\.fsGuide/g) ?? []).length === 1,
  'the guide both tools share is transcluded ONCE, as a prelude');
assert(a.text.includes('[[doc:_docs.pathField'),
  'the deep-field doc surfaces as an expansion link, not a dump');
assert(a.text.includes(`tool _sessions.${a.sessionId}.continue`),
  'the document names its own continuance endpoint');

// ── Agent B: everything, generous budget.
const b = vend(kernel, { maxTokens: 4_000 });
assert(b.tools.length === 3 && b.sessionId !== a.sessionId,
  'agent B has its own session over the full surface');

// ── A continues its session: installs a tool by issuing ft back.
const c = continueSession(kernel, a.sessionId, 'tool notify.send');
assert(c.ok === true && kernel.projection.tools.has('notify.send'),
  'ft issued through the session installs into the live kernel');

// ── Expiry is structural, not advisory.
clock += 61_000;
const dead = continueSession(kernel, a.sessionId, 'x = 1');
assert(dead.ok === false && dead.reason === 'expired',
  "after the session's window closes, the kernel refuses its ft");

// ── The loop closes across kernels: a fresh kernel that receives A's
// document GAINS the vended tools.
const other = new Sequence(() => 1);
receive(a.text, other);
assert(other.projection.tools.has('fs.read'),
  'a second kernel receiving the vended document gains the tools');

console.log('PASS');
