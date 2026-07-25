# Changelog

## [0.2.0] — unreleased

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
  files + 10 architecture docs from the April 2026 design record) with
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
