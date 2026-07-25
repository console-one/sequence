# sequence

**A local engine for running many LLM agents against one governed tool
surface — built on a type system where types, values, time, and belief
are one continuum.**

[![npm](https://img.shields.io/npm/v/%40console-one%2Fsequence)](https://www.npmjs.com/package/@console-one/sequence)
[![CI](https://github.com/console-one/sequence/actions/workflows/ci.yml/badge.svg)](https://github.com/console-one/sequence/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Mount your tools and their documentation as data. The kernel *compiles*
a surface for each agent — an ft-language document under that agent's
token budget, with docs transcluded by rule, a session id, and a
continue endpoint the kernel enforces to expiry:

```js
import { Sequence, vend, continueSession, FT } from '@console-one/sequence';

const kernel = new Sequence();

// documentation is data — variants included
kernel.mount('bind', '_docs.fsGuide.short', 'FS tools operate on the workspace.');
kernel.mount('bind', '_docs.fsGuide.long',  '…the full guide…');

// tools carry doc links in their types — even on deep API fields
kernel.mount('schema', 'fs.read', FT.fn({
  input: FT.object({ p: FT.string().annotate('doc', '_docs.pathField').toType() }).toType(),
  output: FT.object({ content: FT.string().toType() }).toType(),
  description: 'read a file',
}).annotate('docPrelude', '_docs.fsGuide').toType());

// one compiled surface per agent, under ITS budget
const agent = vend(kernel, { query: 'fs', maxTokens: 200, ttlMs: 60_000 });
```

`agent.text` is a document the LLM acts on — and it is *valid input* to
any sequence kernel:

```
-- vended by sequence · session slfls0
-- valid while _rt < 1060000 (about 1 minutes)

-- prelude: _docs.fsGuide [short]
-- FS tools operate on the workspace.

fs.read = (p: string) -> { content: string }  -- read a file
tool fs.read
  -- input.p: [[doc:_docs.pathField : docs for fs.read input.p]]

_sessions.slfls0.continue = (ft: string) -> { ok: boolean }  -- issue ft back to this kernel (install, narrow, call) — refused after expiry
tool _sessions.slfls0.continue
```

The agent answers by issuing ft back:

```js
continueSession(kernel, agent.sessionId, 'tool notify.send'); // installed, live
// after the session's window: { ok: false, reason: 'expired' } — structural, unsupervised
```

Vend N times, run N agents — each with its own session, budget, and
view of the same kernel. No framework, no service: one store, in your
process. ([Tutorial part 7](doc/part7-the-engine.md) · [`examples/07-vending.mjs`](examples/07-vending.mjs))

## Why this exists

Ordinary type systems can't answer the questions agent systems ask:

- **How complete is this record?** Concreteness is a number (0..1), not
  a boolean — distance-from-done you can rank and budget.
- **How long will this call take?** Cost is a distribution, refined by
  conjugate update as real calls land; `cdfInverse` answers "when is
  this 95% likely done."
- **Can the plan make its deadline?** `planFeasibility` — and with no
  declared dependency model it fails *closed* to a worst-case bound.
- **Who may write this, and what about writes that arrive early?**
  Laws are data the store enforces at admission; `when`-gated writes
  suspend and promote themselves.
- **Under a 500-token budget, what is worth showing this reader?**
  One pipeline — cluster → score → rank → budget → hoist — with
  evictions reported, never silent.

One mechanism carries all of it: an append-only log of typed facts
(`mount` is the only write), a derived projection, and a lattice where
**a value is a maximally concrete type**. There is a text form — the
**ft language** — that round-trips with the store: whatever the kernel
emits, a kernel can receive.

## Install

```bash
npm install @console-one/sequence   # Node 20+
```

## Sixty seconds of the continuum

```js
import { Sequence, receive } from '@console-one/sequence';

const seq = new Sequence();
receive('deploy = { service: string, region: "us-east-1" | "eu-west-1", replicas: number }', seq);

seq.concreteness('deploy');                    // 0.159 — declared, far from done
receive('deploy.region = "ap-south-2"', seq);  // ok: false — "matches none of 2 branches"
receive('deploy.service = "checkout"', seq);
receive('deploy.replicas = 3', seq);
receive('deploy.region = "eu-west-1"', seq);
seq.concreteness('deploy');                    // 1 — the record's value IS its type now
```

Validation, progress tracking, and assignment were never written as
application code — they are one lattice, walked downhill.

## Documentation

**[The tutorial](doc/index.md)** — seven short parts, one running
example each. Every ft block in it is executed by the test suite, so
the pages cannot drift from the kernel.

| Part | What it shows |
|---|---|
| [1 · The continuum](doc/part1-the-continuum.md) | schemas vs values, `=` vs `<<`, obligations, concreteness |
| [2 · The language](doc/part2-the-language.md) | wildcard schemas, structured rejection, `when`-gated writes, hoist round-trip |
| [3 · Time and belief](doc/part3-time-and-belief.md) | learned cost curves, evidence decay, fail-closed plan feasibility |
| [4 · Laws and identity](doc/part4-laws-and-identity.md) | admission laws (governing their own handoff), backward inference |
| [5 · Attention](doc/part5-attention.md) | budgeted rendering with reported evictions |
| [6 · Clauses and claims](doc/part6-clauses-and-claims.md) | `when`/`while` gates, `MATCHES`/`IN`/bounds enforcement, Δt intervals, `~survival` curves, ∀/∈ as `index … over … where` |
| [7 · The engine](doc/part7-the-engine.md) | `vend`, sessions, many agents, kernel-to-kernel propagation |

**Runnable proofs** — each example asserts its claim and exits non-zero
the moment the claim breaks:

```bash
npm run build
npm run examples        # 7 self-asserting demos, fail-fast
node examples/bench.mjs # reproducible numbers — including the honest scaling curve (#1)
```

**Design record** — `specs/docs/` (architecture, axioms, the DSL spec,
[tool compilation & vending](specs/docs/TOOL_COMPILATION_VENDING.md))
and `specs/impl/` (113 requirement files in narrative+ft from the
April 2026 design sessions). `specs/impl/PARSE_LEDGER.json` pins the
designed-but-not-yet-parsed syntax as a **ratchet**: CI fails on
grammar regressions *and* on unrecorded progress.

## Design invariants

1. Types and values are one continuum; a value is a maximally concrete type.
2. `=` overwrites; `<<` narrows (with a monoid at concrete leaves — numbers accumulate).
3. Hoist output is valid ft input — round-trippable, kernel to kernel.
4. Laws, cost curves, docs, readers, sessions: all data on the same log.
5. Compression reports its losses: evictions, omissions, and expansions are spoken, never silent.
6. Honesty fails closed: no dependency model → worst-case bound; no coverage → say so.

## Status

Used in production as the semantic kernel of
[Shared Office](https://www.sharedoffice.ai). Pre-1.0: APIs can move
between minors; the [CHANGELOG](CHANGELOG.md) says exactly what did.
Known issues are tracked openly — including the unflattering ones
([#1](https://github.com/console-one/sequence/issues/1) mount scaling,
[#2](https://github.com/console-one/sequence/issues/2) read coherence).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — the short version: the docs
execute, the examples are proofs, the grammar ledger is a ratchet, and
a parser change is done when a violating value is *refused with a
reason*, not when the syntax parses.

## License

[MIT](LICENSE) © Console One Inc.
