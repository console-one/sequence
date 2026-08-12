# The Deletion Ledger — one engine, one vocabulary

Two engines in one package is a migration state, not an architecture.
This ledger is the consolidated, tracked plan for finishing the
migration: the v2 kernel becomes the package, the v1 engine is deleted,
and the shared language layer — which was never "v1" — survives as the
common vocabulary it always was. Stages were previously prose scattered
across file headers (`receive-calls.ts`, `tools.ts`, `index.ts`); this
document supersedes those notes as the authority.

## The end state

- **One engine**: the v2 kernel (`insert`, rules + emitters). The
  package root exports it.
- **One language layer**: `type.ts`, `compose.ts`, `builder.ts`,
  `hoist.ts`, and the ft pipeline (`dsl/tokenizer|parser|ast|extract`,
  plus `walker.toType`) — imported by the engine, not owned by it.
- **Zero v1**: `src/sequence.ts`, `laws.ts`, `statement.ts`, `env.ts`,
  `vend.ts`, `commitments.ts`, `rotation.ts`, `runtime/render.ts`, and
  the v1-coupled half of `walker.ts` (`walk`/`receive` mount into the
  v1 class) are deleted.

## Stages

| Stage | What | Status |
|---|---|---|
| S1 | ft write side executes on v2 (`receive-calls`) | **done** |
| S2 | definition receiver + base tools on v2 (`receive-doc`, `tools`) | **done** |
| S3 | env storage adapters on v2 (`env/`) | **done** |
| S4 | transport server re-points to v2 (lives outside this repo) | pending, external |
| S5 | root v1-engine exports carry `@deprecated`; `./v1` subpath added as the stable alias; this ledger published | **done (this change)** |
| S6 | capability-gap closure (below) — every v1 feature has a v2 answer or a recorded waiver | open |
| S7 | surface migration: examples 01–07 and the tutorial run on v2; doc-blocks execute against the engine the docs describe; known consumers re-point | **in progress** — 01/02/03/04 ported (02–04 were pure shared vocabulary; 01 substitutes `typeSpecificity` for the scalar-concreteness gap). 05 blocked on `law()`+rejection shape, 06/bench on `renderForReader`, 07 partially on doc-transclusion meta — all named above |
| S8 | the flip: root export becomes v2 (0.4.0); `./v1` keeps the old engine for one minor; engine files deleted the minor after, shared vocabulary stays at root | open |

Gate for every stage: full suite green, and the docs-execute tests run
against whichever engine the documentation claims to describe.

## S6 — the capability gaps, named

What still keeps v1 alive, feature by feature:

- **`receive` (full-language walk).** v2's `receiveDocument` accepts
  the definition subset; the full statement grammar (`where`/`in`
  scopes, `index … over`, readers, classes) mounts only into v1. This
  is the load-bearing gap: the tutorial's ft blocks execute through it.
  Closing it = a v2 walk, measured by running `doc-blocks` against v2.
- **`loadEnv` (boot story).** v2 has storage adapters and
  snapshot/restore but no single boot call (replay + snapshots +
  impls). Small, must exist before S8.
- **`renderForReader`.** NOT parity today, verified: v2's
  `hoistForReader(seq, name)` reads a pre-installed `_readers.*`
  config and returns `{text, paths, gaps}` — no per-call weights, no
  cluster→score→rank pipeline, no `clusters`/`evicted` in the result.
  `electFrame` is the architectural successor but a different call
  shape (declared concern walk). Either port the v1 pipeline contract
  or migrate consumers to `electFrame` and waive — a decision, not a
  verification.
- **Scalar `concreteness(path)`.** v1's certainty/feasibility
  composite has no v2 counterpart — v2 only has the time-conditioned
  `concretenessDistribution`. Consumers wanting the scalar use
  `typeSpecificity(seq.typeAt(p))` + boundness today (example 01 now
  demonstrates the substitution). Decide: add the scalar to v2, or
  document the substitution as the answer.
- **Doc transclusion via type metadata.** v1's vend reads
  `.annotate('docPrelude'|'doc', path)` type-meta and emits shared
  preludes once + `[[doc:…]]` deep-field links. v2's `electFrame`
  discovers docs ONLY by scanning `[[label]]` markers in description
  text — nothing in `src-v2/` reads the annotation meta, and no
  deep-field mechanism exists. Example 07's transclusion assertions
  are unportable until this is closed or the annotation route is
  formally retired in favor of text markers.
- **Structured rejection on v2 `insert`.** v1's `MountResult` carries
  `ok`/`gaps` (refused-with-a-reason, the package's own invariant #6);
  v2's `InsertResult` is `{block, changes, suspended}` — a suspended
  write and a refused write are indistinguishable to the caller, and
  law-style rejection reasons have no field to land in. Porting the
  law tests (example 05) requires this shape first.
- **`rotate` (tiered storage with redirects).** No v2 equivalent.
  Decide: port as a stdlib feature, or waive with rationale.
- **`law()` admission/read rules.** v2 guards + writer-authority claim
  parity; the v1 law tests (incl. "laws govern their own handoff") must
  be ported to prove it.
- **`promoteRefinements` (learning).** v2's refinement + MDL gate is
  the successor mechanism; confirm the v1 promotion tests have v2
  counterparts, then waive.
- **v1 `vend`/`commitments`/`elect` namesakes.** v2 owns these
  concepts already; deletion here is consumer re-pointing only.

## Why the flip is allowed

Pre-1.0, and the README says it plainly: APIs can move between minors,
and the CHANGELOG says exactly what did. `./v1` exists so the flip is
an import-path edit, not a rewrite, for anyone not ready.
