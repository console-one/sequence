# Part 7: The engine

Everything in parts 1–6 composes into the reason this library exists as
a *standalone* asset: **sequence is a local engine for running many LLM
agents against one governed tool surface.** You boot a kernel, mount
tools and their documentation as data, and the kernel *compiles* a
client-facing surface per agent — an ft document, under that agent's
budget, with a session id and a continuance contract. No framework, no
service: one store, in your process.

```bash
node examples/07-vending.mjs   # the whole arc below, asserted
```

## The shape of it

```js
import { Sequence, vend, continueSession, FT } from '@console-one/sequence';

const kernel = new Sequence();

// Documentation is data — including a label GROUP (variants):
kernel.mount('bind', '_docs.fsGuide.short', 'FS tools operate on the workspace.');
kernel.mount('bind', '_docs.fsGuide.long',  '…the full guide…');

// Tools carry doc associations in their type meta — even on a field
// buried deep in the input shape:
kernel.mount('schema', 'fs.read', FT.fn({
  input: FT.object({ p: FT.string().annotate('doc', '_docs.pathField').toType() }).toType(),
  output: FT.object({ content: FT.string().toType() }).toType(),
  description: 'read a file',
}).annotate('docPrelude', '_docs.fsGuide').toType());
```

Then each agent gets its own compilation of the surface:

```js
const a = vend(kernel, { query: 'fs', maxTokens: 200, ttlMs: 60_000 });
```

`a.text` is an ft document:

```
-- vended by sequence · session slfls0
-- valid while _rt < 1060000 (about 1 minutes)

-- prelude: _docs.fsGuide [long]
-- FS tools operate on the mounted workspace. Paths are absolute. …

fs.read = (p: string) -> { content: string }  -- read a file
tool fs.read
  -- input.p: [[doc:_docs.pathField : docs for fs.read input.p]]

fs.write = (p: string, content: string) -> { ok: true }  -- write a file
tool fs.write

_sessions.slfls0.continue = (ft: string) -> { ok: boolean }  -- issue ft back … refused after expiry
tool _sessions.slfls0.continue
```

Read what the composition rules did there:

- **Prelude transclusion** — both fs tools reference the same guide; it
  rendered once, at the top, not twice inline.
- **Label-group election** — `_docs.fsGuide` is a group (`short`,
  `long`); the variant was elected against the budget's share. Tighten
  `maxTokens` and the short one is chosen instead.
- **Deep-field docs as expansion links** — the doc attached to
  `fs.read`'s `input.p` field surfaces as a `[[doc:… : expand]]` token,
  not a dump. The client asks for it if it matters.
- **Overflow is spoken** — tools that didn't fit become
  `[[more : N more matching tool(s)…]]`, never a silent cut.
- **The session is in the document** — the continue endpoint is itself
  a vended tool; every definition above it is, in effect, an input
  constant for calls at that endpoint, until the stated expiry.

## The loop, and many agents

An agent answers by issuing ft back:

```js
continueSession(kernel, a.sessionId, 'tool notify.send');   // { ok: true } — installed live
// …after the session's window:
continueSession(kernel, a.sessionId, 'x = 1');              // { ok: false, reason: 'expired' }
```

Each agent has its own session, budget, and view of the same kernel —
`vend` twice, manage two agents; vend N times, manage N. Expiry is
structural: the kernel refuses a dead session's ft, no supervision
needed. And because the vended document is *valid ft input* (the
round-trip law from part 2), **a second kernel that receives it gains
the tools** — surfaces propagate between kernels as text.

Transport is deliberately not the kernel's business: the `Environment`
contract (`specs/docs/KERNEL_BOOT.md`) binds `continueSession` to
whatever you run — HTTP, MCP, stdio. The session id is the URL; the
kernel is the state.

The full design and its April-2026 lineage:
[`specs/docs/TOOL_COMPILATION_VENDING.md`](../specs/docs/TOOL_COMPILATION_VENDING.md).
Known v0 boundaries: frame-snapshot validation of tool calls
(toolpersistence.md's design) is not wired yet — continuance validates
liveness, not per-frame consistency; and vended validity is stated as a
comment + session record rather than a per-definition `~survival` curve.
Both are named next steps, not hidden ones.
