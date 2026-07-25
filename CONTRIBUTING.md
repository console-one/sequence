# Contributing

## Setup

```bash
git clone https://github.com/console-one/sequence.git
cd sequence
npm install
git config core.hooksPath .githooks   # pre-commit: tsc --noEmit · pre-push: jest
npm run build && npm test
```

## The rules that are enforced, not aspirational

This repo runs on a few unusual invariants. CI and the hooks hold them;
knowing them up front saves you a red build:

1. **The docs execute.** Every ` ```ft ` block in `doc/*.md` is received
   into a live kernel by `src/test/doc-blocks.test.ts` (blocks fenced
   ` ```ft-rejected ` must *fail* to mount). If you edit a tutorial page,
   the kernel checks your prose.
2. **The examples are proofs.** Each `examples/NN-*.mjs` asserts the
   claim it demonstrates and exits non-zero if the claim breaks. New
   features that change observable behavior should come with one.
3. **The grammar gap is a ratchet.** `specs/impl/` holds the 2026-04
   design corpus (113 requirement files in narrative+ft).
   `specs/impl/PARSE_LEDGER.json` lists the files whose ft the parser
   cannot yet accept. `validate-impl.test.ts` fails on a regression
   (a non-ledgered file stops parsing) **and on silent progress** (a
   ledgered file starts parsing) — strike the entry from the ledger to
   record the win.
4. **Round-trip law.** Anything the kernel emits as ft (`hoist`,
   `vend`) must be valid ft input. Display-only output formats are
   rejected in review.
5. **Enforcement over acceptance.** A parser change is not done when
   the syntax parses — it is done when a violating value is *refused
   with a reason*. Tests should bind a bad value and assert the gap.

## Design-gated areas

New evaluation semantics (special forms, derived-predicate evaluation,
strict comparison ops in refinements) need a maintainer decision first —
open an issue before building. The current list lives at the bottom of
`specs/impl/SYNTAX_SUPPORTED.md`.

## Commit style

Small, reversible commits; `feat(scope):` / `fix(scope):` / `docs:`
prefixes; never `--no-verify`.
