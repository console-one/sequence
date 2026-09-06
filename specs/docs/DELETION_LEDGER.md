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
- **Post-write observer hook.** CLOSED 2026-09-05: v2 `Sequence.onInsert(observer)`
  runs after every outer insert settles with the full `InsertResult` — the
  v2 half of HOST_CONTRACT §3's hook (v1 `onBlockApplied`). Observers are
  host-side, never facts, never replayed. First consumer: observatory-app's
  session-contracts (per-session delivery over settled deltas).
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

## What the office design owes the kernel — K1–K11 (2026-09-06)

Source: `observatory-app/docs/MAP-SERVER-REALITY-TARGET.md` §C v4 (C3), from
the kernel audit `observatory-app/docs/_archive/2026-09-05-research/research-kernel.md`
(145 rows: 56 encoded, 44 partial, 39 host seam). The office's low-level
design is now ONE schema mounted through this kernel's `install*` calls plus
six host seams; these are the kernel changes that design needs. Each is a
concrete change to `src-v2/`, not an application layer.

- **K1 · guard bindings.** Guards cannot bind `$author`/`$instancePath`;
  `EmitterCtx.bindings` is declared and always `{}` (`sequence.ts:110–112`,
  `:497`); `Rule.scope` is a literal prefix. Every per-owner law is a
  TypeScript closure re-registered per host. The binding machinery exists
  twice already (`index_spec`'s `bindFrom`, `evaluateConstraint`'s `$var`) —
  route the guard path through it. Laws expressible as data then need no
  per-law code.
- **K2 · visibility in the frame.** `Type.meta.visibility` is enforced by
  `hoist` and ignored by `caseWalk`/`electFrame`/`vend`.
- **K3 · secrets out of the fold.** A secret is a cell guarded only by
  `partition('id')` (`stdlib/auth-session.ts:381–385`); `captureSnapshot` and
  `installCrossSequence` will serialize and forward it. A `secret` type kind
  whose value is never captured, federated, or rendered; the fold holds a
  fingerprint.
- **K4 · refuse unregistered emitters.** `dispatchRule` silently no-ops when
  `emitters.get(r.emit)` is missing (`sequence.ts:494–495`); a logged law a
  host cannot run is ignored, not refused.
- **K5 · rule retraction + enumeration.** `installRule` only pushes
  (`sequence.ts:661–671`); no removal, no listing, no `rules` on
  `SnapshotEntry`.
- **K6 · snapshot carries `time` (and rules).** `SnapshotEntry` has no
  `time`; restored blocks are re-stamped with the restorer's clock, so decay,
  leases, heartbeat age and trends are not replay-stable — although
  `InsertInput.time` exists precisely for faithful replay.
- **K7 · a refusal names its reason.** A refused block is parked with
  `status:'suspended'` and nothing records which rule or constraint refused;
  `Block.cause` is set only for induced blocks.
- **K8 · `installEndpointTool` refuses on a missing secret.** Today it drops
  the header and calls the unauthenticated tier (`tools.ts:773–776`, `:828`).
- **K9 · `index_spec` incremental + negative maintenance.** Re-projects every
  class on every delta and never retracts a fact whose tuple stopped matching
  (`stdlib/index-spec.ts:58–88`).
- **K10 · private oracles.** The watcher index (disjointness) and
  `nextSequence` are private; `_holders.*` posteriors never decay while
  `evidenceDecay` is exported and unused.
- **K11 · small defects.** `limit` documents `<`, implements `<=`
  (`install.ts:62/66/86`); `json.decode` registered twice with disagreeing
  contracts (`tools.ts:536`, `:574`); `auto-wire` header vs code on param
  shape; `_process.workingSet.nextLikely` promised, never written;
  `installCrossSequence` mounts two identities' rules at one fixed path
  (`federation.ts:136–138`).

## Why the flip is allowed

Pre-1.0, and the README says it plainly: APIs can move between minors,
and the CHANGELOG says exactly what did. `./v1` exists so the flip is
an import-path edit, not a rewrite, for anyone not ready.
