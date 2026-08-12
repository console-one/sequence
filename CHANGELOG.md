# Changelog

## [Unreleased]

### Added
- **Time is an input of the transition, not a sample.** v2:
  `InsertInput.time` — a caller passes the instant a fact became true
  on the author's clock. v1: `BlockOpts.time` (honored at the
  outermost mount; nested cascade frames keep the frozen `_rt`) and
  `MountEntry.time`, which `loadEnv` replays — a store rebooted from
  its own entry log keeps history's instants instead of re-stamping
  everything with boot time.
- **The federation wire is honest.** Retractions forward as
  `op:'invalidate'` (un-saying travels; a peer's copy no longer
  outlives the owner's withdrawal). Every `Outgoing` carries a
  per-store monotonic `seq` (a hole = a lost message, detectable) and
  `sentAt` (the authored instant on the sender's clock, which
  `receiveFromPeer` preserves — there is no shared clock). The module
  header now states the scope: same-owner log shipping between one
  sovereign's processes; between sovereigns, vend contracts, never
  state.
- **[The host contract](specs/docs/HOST_CONTRACT.md)** — time,
  identity, durability, distance: what the embedding host must
  provide, declared instead of discovered by incident. And
  **[the glossary](specs/docs/GLOSSARY.md)** — the internal
  vocabulary bridged to its standard names.
- Previously implemented-but-unexported v2 surface is now importable:
  `installTool`, `installBlueprint`, `installBlueprintGapsReader`,
  `installKit`, `installBlueprintOutput`, `installAgentPrompt`,
  `installProposalHandler`, `installRefundRule`, `budgetedEvaluator`,
  `stampSessionToken` (+ `BlueprintGapSpec`, `GapEntry`,
  `SessionLifecycleConfig`, `AuthCapsConfig`). `survival` is now
  exported from the package root, as the README always claimed.

### Changed
- **The v1 engine is now formally dying.**
  [DELETION_LEDGER.md](specs/docs/DELETION_LEDGER.md) consolidates the
  staged migration (S1–S8): v1-engine root exports carry
  `@deprecated`, a `./v1` subpath is the stable alias through the
  transition, the root export flips to v2 at 0.4.0, and the engine is
  deleted the minor after — the shared vocabulary (types, lattice,
  builder, hoister, ft parser) stays at the root throughout. The S6
  section names every capability gap still holding the flip open.
- `src-v2/stdlib.ts` split into concern modules under
  `src-v2/stdlib/` (partition, concreteness, commitments, reliability,
  index-spec, planner, federation, negotiation, blueprint,
  auth-session, render, snapshot, …). The barrel re-exports everything;
  no import path or behavior changes.

- Examples 01–04 now run on the v2 kernel (02–04 were pure shared
  vocabulary; 01 demonstrates the `typeSpecificity` substitution for
  v1's scalar `concreteness`). 05/06/07/bench stay on v1 pending the
  S6 gaps the ledger names — including two found by this port: v2 has
  no scalar concreteness, and v2's vend never reads
  `docPrelude`/`doc` type annotations (text `[[label]]` markers only).

### Fixed
- Doc drift: 0.2.0 dated (it shipped 2026-07-27); part 6's grammar-gap
  figure updated 98 → 14 (the ledger's current state); architecture-doc
  count 10 → 15; a pre-extraction monorepo path in
  `stdlib/taskqueue.ft`.

## [0.2.0] — 2026-07-27

The engine release: sequence becomes a standalone tool-compilation
engine for running many LLM agents against one governed surface.

### Added
- **`vend(kernel, {query, maxTools, maxTokens, ttlMs})`** — compile the
  mounted tool surface into a *receivable* ft document per client:
  documentation transcluded by rule (shared preludes render once;
  label groups elect one variant against the budget; deep-field docs
  surface as `[[doc:…]]` expansion links), overflow reported as an
  `[[more:…]]` token, and the session's continue endpoint declared in
  the document itself.
- **`continueSession(kernel, id, ft)`** — the continuance contract:
  ft applies while the session lives, is refused after its structured
  expiry. A second kernel receiving a vended document gains the tools
  (tested).
- **The clause layer enforces from text**: `MATCHES /re/`,
  `IN { … }` set literals, `>=`/`<=` bounds compile into the checked
  property types; `@[T_out..next_write(p).T_out)` Δt intervals and
  `~survival(exp, r)` reliability suffixes ride predicates; the
  write/read identity clause (`| read(p).content = content …`) parses
  verbatim from the 2026-04 spec; property-level `when`/`while`/
  `onBreak` gates lower to statement gates with lexical sibling
  scoping; `when path = "value"` equality gates; `forall` parses in
  refinement position (admission enforcement still open, and said so).
- **The executable tutorial** (`doc/`, parts 1–7): every ft block is
  run by the test suite; part 7 is the standalone engine story.
- **Runnable examples** (`examples/01–07` + `bench.mjs`): each asserts
  its claim and exits non-zero if it breaks; the bench prints the
  honest mount-scaling curve ([#1](https://github.com/console-one/sequence/issues/1)).
- **The design corpus, recovered** (`specs/impl/`, 113 requirement
  files + 15 architecture docs from the April 2026 design record) with
  `PARSE_LEDGER.json` as a ratchet: grammar regressions fail CI, and so
  does unrecorded progress.
- `prepare` script so git-pinned installs self-build.

### Fixed
- Primitive unions in property position (`status: string | null`) never
  parsed; `{ policy: … }` keys were hijacked by the policy-statement
  parser; MATCHES was unreachable from both predicate sites
  (keyword-vs-IDENT token mismatch); comments inside `[ ]`;
  comma-separated block patches (`m << { a = 0, b = 1 }`).
- `npm audit`: 2 high / 1 low → 0.

### Known issues
- Parent/child reads can disagree after narrowing an object-bind child
  ([#2](https://github.com/console-one/sequence/issues/2)).
- Per-mount cost grows with log length
  ([#1](https://github.com/console-one/sequence/issues/1)); the bench
  measures it.

## [0.1.0] — 2026-07

Initial public release: the kernel (`mount`/projection/cascade), the
type lattice (`compose`, `covers`, `backwardInfer`, concreteness),
distributions and temporal machinery (`cdf`, `conjugateUpdate`,
`evidenceDecay`, `planFeasibility`), admission laws, the ft DSL
(tokenize → parse → walk), hoist/receive round-trip, and the
budgeted render pipeline (`renderForReader`).
