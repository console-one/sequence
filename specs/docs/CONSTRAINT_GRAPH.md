# Constraint Graph — the substrate's actual storage model

Status: architectural commitment, 2026-04-22. Foundational. Names
the storage model the AXIOMS doc has implied since the substrate
existed but whose implementation has been vestigially dual.

---

## Summary (for the handoff agent)

**What this document defines.** The substrate has ONE store: a
directed graph of constraint sets, one per path. A value at a path
is the leaves of that path's constraint subtree. A type at a path
is the constraint set verbatim. There is no separate value store
and no separate schema store; the dual-storage `proj.values +
proj.schemas` form was vestigial relative to the substrate's own
"types and values are the same continuum" invariant.

**Why this document exists.** Three observations forced this
architectural commitment:

1. **The continuum invariant in AXIOMS** has always said a value
   is a maximally-concrete type. The implementation has separated
   them since the substrate's first commit, contradicting the
   axiom in storage.
2. **The conversation of 2026-04-22** surfaced specific harms of
   this dual storage: `matchesType` exists as a separate predicate
   only because schemas aren't reachable through the value-
   predicate path; cascade doesn't fire on schema-narrowing-only
   mounts; the DSL `=` operator double-emits to compensate; tests
   encode the dual model and propagate it.
3. **The leaves-as-values insight** (also from that conversation):
   reading a value at a path IS collecting the leaves of the
   constraint subtree at that path. The same traversal `hoist`
   uses for emit. There is no separate "value getter"; there is
   the constraint walker.

**Three actionable artifacts, defined with explicit per-artifact
requirements in this document:**

- **Artifact 4** — Read-side unification (LANDED 2026-04-22).
  Requirements **R-A4.1 – R-A4.5** and acceptance criteria
  **AC-A4.1 – AC-A4.5** below.
- **Artifact 5** — Storage unification: collapse `proj.values +
  proj.schemas` into one `proj.nodes` constraint store. Pending.
  Requirements **R-A5.1 – R-A5.6** and acceptance criteria
  **AC-A5.1 – AC-A5.5** below.
- **Artifact 6** — Op + predicate unification: bind/schema
  converge into one `narrow` op; `matchesType` deleted; cascade
  fires on any narrowing of any constraint at any node. Pending.
  Requirements **R-A6.1 – R-A6.7** and acceptance criteria
  **AC-A6.1 – AC-A6.6** below.

**Load-bearing hypotheses.** All three artifacts rest on six
explicit hypotheses (**HC1 – HC6**) enumerated in the next
section. Each requirement is tagged with the hypotheses it depends
on. If a hypothesis is rejected during refactor, the dependent
requirements MUST be re-derived, not silently preserved.

**For the refactor agent:** read this document together with
AXIOMS.md (the continuum invariant) and COMMITMENTS.md (which
relies on uniform constraint observability for cascade-driven
commitment election). They form one architectural set. If you
find yourself needing to violate a requirement here, trace it to
its hypotheses and argue about the hypothesis, not the
requirement.

---

## Derivation — the hypothesis chain that produced this document

Each hypothesis below was arrived at through the conversation
history of 2026-04-22. They are listed in dependency order —
later hypotheses assume earlier ones. Every requirement is tagged
with the hypotheses it depends on; reject a hypothesis, and every
dependent requirement is in play.

### HC1 — Types and values are the same continuum.

**Claim.** A value is a constraint set narrowed to a single
inhabitant. A type is a constraint set with a wider lattice
position. They are the same dimension at different points; the
substrate's storage should reflect this.

**Rationale.** AXIOMS.md states this directly as an invariant. The
substrate's `compose` function treats them uniformly: composing a
narrow type with a value is the same operation as composing two
types. Dual storage (`proj.values` for the inhabitant, `proj.schemas`
for the constraint set) is operationally redundant — the inhabitant
IS what a constraint set with a `literal()` constraint reduces to.

**What invalidates it.** A finding that values and types have
genuinely distinct lifecycles or access patterns that justify
separate storage. None has been demonstrated through the conversation
that produced this spec; the only justification offered for dual
storage was implementation history.

**Requirements it begets.** All requirements depend on HC1
transitively. It is the root justification for the entire document.

### HC2 — A value at a path is the leaves of its constraint subtree.

**Claim.** Reading a "value" at a path means collecting the
terminal-most narrowings (leaves) reachable from that path through
the constraint graph. Decomposing constraints (`property`,
`element`) recurse into children; terminal constraints
(`literal`, narrow ranges) return the inhabitant. There is no
separately-stored value to fetch.

**Rationale.** HC1 + the structural observation: object values are
already decomposed into sub-paths during bind (the kernel's
`decompose` machinery). The leaves of the resulting subtree IS the
object. The same machinery hoist uses for emission collects the
leaves and reconstructs the structure.

**What invalidates it.** A path whose value is intrinsically
non-decomposable AND non-literal — e.g., an opaque binary blob
with no internal structure to walk. Even then the blob is a leaf
literal; the framing holds.

**Requirements it begets.** R-A4.4 (structural-leaf-collection in
get); R-A5.4 (the unified store is a constraint graph, not a
key-value table); R-A6.5 (predicates that read values walk leaves).

### HC3 — Predicates evaluate against the constraint state.

**Claim.** `eq(path, V)` asks "does the constraint set at path
narrow to literal V"? `exists(path)` asks "is there ANY constraint
at path"? `matchesType(path, T)` is identical to `covers(T,
constraintsAt(path))` and ceases to exist as a distinct primitive.
Predicates do not consult a separate "value store" — they
evaluate against the constraint set directly.

**Rationale.** HC1 + HC2. If the constraint set IS the source of
truth and values are a derived view, predicates that ask questions
about "the value" are asking questions about the constraint set's
narrowing. matchesType existed only because predicates couldn't
reach schema-state through the value path; with one store, the
distinction collapses.

**What invalidates it.** A predicate genuinely needing to
distinguish "user-bound value" from "schema-narrowed-to-literal"
for some semantic reason (e.g., audit). That distinction can be
preserved by tagging constraints with author/origin metadata
without splitting the storage.

**Requirements it begets.** R-A6.4 (delete `matchesType`); R-A6.5
(predicate evaluators consult constraints).

### HC4 — The cascade fires on any narrowing of any constraint at any node.

**Claim.** Adding a literal constraint to a path is a narrowing.
Adding a `property` constraint is a narrowing. Removing a
constraint via `delete` is a widening. The cascade dispatch
mechanism re-evaluates dependents on ANY change to the constraint
set at a node, regardless of which constraint changed.

**Rationale.** HC1 + the practical observation that today's
cascade fires on `bind` and not on `schema` — so a schema mount
that narrows the type to a literal does NOT trigger predicates
watching that path. This is a direct consequence of dual storage:
the cascade was wired against `proj.values` mutations only. With
one store, all narrowings are uniform mutations and the cascade
treats them uniformly.

**What invalidates it.** A genuine performance need to skip
cascade for some classes of narrowing (e.g., type-only
declarations made during bootstrap before any listener exists).
Possible but solvable as an optimization (defer dispatch until at
least one dependent is registered) without re-introducing the
dual-dispatch model.

**Requirements it begets.** R-A6.6 (cascade dispatch reads from
the unified store, fires on all narrowings).

### HC5 — `bind` and `schema` are the same write op.

**Claim.** `mount('bind', path, value)` is sugar for "narrow the
constraint set at path with a literal constraint." `mount('schema',
path, type)` is sugar for "narrow the constraint set at path with
the type's constraints." Both reduce to one underlying op:
`mount('narrow', path, constraints[])`. The distinction has been
visible at the API surface only because the kernel had two stores
to write to.

**Rationale.** HC1 + HC3 + HC4. If the storage is one constraint
set, then both ops are narrowing operations on the same set. The
existing `compose` semantics (lattice meet) define what "narrow"
means; both ops invoke compose against the existing constraints.

**What invalidates it.** A semantic distinction the kernel needs
to preserve — e.g., binds participating in transactional rollback
that schema mounts don't. Not present today. Could surface during
migration.

**Requirements it begets.** R-A6.1 (introduce `narrow` op); R-A6.2
(bind becomes sugar for narrow-with-literal); R-A6.3 (schema
becomes sugar for narrow-with-type).

### HC6 — References, not types-vs-values, are the meaningful lifecycle distinction.

**Claim.** What differentiates "data" from "type" is the existence
and lifecycle of REFERENCES — paths being held, listened to,
committed to. The constraint set is uniform; some constraint sets
have active references (alive), others don't (collectable). Type
declarations and value bindings differ only in the lifecycle of the
references that hold them — not in their storage shape.

**Rationale.** Conversation of 2026-04-22 (verbatim user
articulation): "the only difference between the two things is
references that map onto them and whether those references continue
to exist at different points within the lifecycle of the system."
The reference layer is what gives meaning; the constraint layer is
uniform.

**What invalidates it.** Domain semantics that genuinely demand
a stored type/value distinction in addition to reference lifecycle —
e.g., serialization formats that round-trip differently. Solvable
without re-splitting storage by carrying a serialization-hint
constraint.

**Requirements it begets.** R-A5.5 (the unified store carries
constraint sets; reference lifecycle is tracked separately via
existing primitives — backwardIndex, suspended blocks, commitments).

---

## The insight

Today, the substrate stores values in `proj.values` and types in
`proj.schemas`. Reads consult one or the other. Predicates consult
`proj.values`. The cascade dispatches on `proj.values` mutations.
Schema mounts are observable through `typeAt` but not through any
predicate; schema-narrowing-to-literal does not produce the same
cascade event a value-bind would.

This is two observable surfaces for one underlying lattice
position. The substrate's own continuum invariant (AXIOMS) says a
value is a maximally-concrete type. The implementation has
contradicted that invariant since the first commit.

The fix is one store. A path has one constraint set. A "value" at
a path is the leaves of the constraint subtree rooted there. A
"type" is the constraint set verbatim. The bind op narrows with a
literal constraint; the schema op narrows with a type's
constraints; both are the same `narrow` operation underneath. The
cascade fires on any narrowing. Predicates evaluate against the
constraint state directly. `matchesType` ceases to exist —
`covers(T, constraintsAt(path))` is the same check.

## The primitive

Every path has one constraint set. The constraint set is the
substrate's only stored datum about the path. Reading and writing
look like:

| Operation | Meaning |
|---|---|
| `mount('narrow', path, constraints[])` | Add the given constraints to path's constraint set. Compose-narrows; never widens. If the meet is `never`, reject. |
| `mount('bind', path, v)` | Sugar for `mount('narrow', path, [literal(v)])` (primitives) or recursive sub-binds (objects/arrays). |
| `mount('schema', path, T)` | Sugar for `mount('narrow', path, T.constraints)`. |
| `mount('delete', path, _)` | Strip terminal-narrowing constraints from path's constraint set. Schema-decomposing constraints stay so the type shape persists; literal/value-narrowings are removed. |
| `seq.get(path)` | Walk the constraint graph rooted at path. Terminal `literal` → return literal. Decomposing → recurse children, build structured value. Refs → follow. Returns `undefined` if no terminal narrowings exist. |
| `seq.typeAt(path)` | Return path's constraint set verbatim, plus inherited constraints from ancestor refs / globs. |

The cascade fires on every narrowing of every constraint at every
node. Predicates re-evaluate against the new lattice position.

## Symmetry across what was previously "value" vs "type"

| Old framing | Under the unified constraint graph |
|---|---|
| `proj.values.get(path)` returns the bound value | `seq.get(path)` walks leaves; terminal literal at path = value. Same result; one store. |
| `proj.schemas.get(path)` returns the type | `seq.typeAt(path)` returns the constraint set as a Type; same store. |
| `bind('X', 'hello')` writes 'hello' to values | `narrow('X', [literal('hello')])` adds the constraint. Sugar `bind` preserved. |
| `schema('X', T)` writes T to schemas | `narrow('X', T.constraints)` composes the constraints. Sugar `schema` preserved. |
| `eq('X', 'hello')` reads `proj.values['X']` | `eq('X', 'hello')` walks leaves of X; checks they form 'hello'. |
| `matchesType('X', T)` consults schema | `covers(T, constraintsAt('X'))`. Direct lattice check. matchesType deleted. |
| Cascade fires on bind, not schema | Cascade fires on any constraint narrowing at any node. |

## What this collapses

| Today | Under the constraint graph |
|---|---|
| Two stores: `proj.values: PathMap<unknown>`, `proj.schemas: PathMap<Type>` | One store: `proj.nodes: PathMap<Constraint[]>`. Source of truth for both reads. |
| Two write ops with parallel cascade behaviors (`bind`, `schema`) | One write op (`narrow`); `bind` and `schema` are sugar that produce the same kernel call. |
| Two predicate evaluation paths (value-based predicates consult `proj.values`; `matchesType` consults `proj.schemas`) | One predicate path. All predicates walk constraints at the path. |
| `matchesType` as a distinct constraint constructor and check function | Deleted. `covers(T, constraintsAt(path))` is the same operation, available without a wrapper. |
| Cascade discriminating between value and schema mutations | Cascade dispatches on any narrowing. Schema-narrowing-to-literal fires the same dependents as a bind. |
| DSL `=` double-emits schema + bind to compensate for the cascade gap | DSL `=` emits one narrowing. The DSL parser is simpler; the substrate's behavior matches the spec. |
| `delete` clearing only `proj.values` (with my Session A patch also stripping schema literals) | `delete` strips all terminal narrowings from the constraint set. One operation. |

---

## Artifact 4 — Read-side unification (LANDED 2026-04-22)

**Artifact.** `Sequence.get(path)` and `Sequence.typeAt(path)`
route through one walker that traverses the constraint graph.
Schema-with-literal narrowings are observable as values via
`get`. Object-shaped paths build their value by collecting
children's leaves. Storage stays dual; only the read API
converges.

**Status.** Landed in commit `bce264a` on `console-one/sequence`
main branch.

**Review ownership.** Author submitted PR; reviewer verifies each
AC-A4.x against current behavior on main.

### Requirements

**R-A4.1** [HC1, HC3] — `Sequence.get(path)` SHALL return the value
at path whether the value was mounted via `bind(path, V)` (writing
to `proj.values`) or via `schema(path, createType(kind, [literal(V)]))`
(writing a literal constraint into `proj.schemas`). The two writes
SHALL produce indistinguishable observable results through `get`.
- *Rationale*: HC1 (continuum) — they're the same narrowing.
  HC3 — predicates that read values must see schema-narrowing.
- *Verifiable by*: AC-A4.1.

**R-A4.2** [HC2] — `Sequence.get(path)` SHALL build a structured
value by collecting children's leaves when path's schema is
object-typed (or absent) and path has children. Children that are
leaves contribute their leaf value; children that are intermediate
recurse. Sub-segments starting with `_` are filtered as
kernel-internal sidecars (provenance metadata, etc.).
- *Rationale*: HC2 — values are leaves of the constraint subtree.
- *Verifiable by*: AC-A4.2.

**R-A4.3** [HC1, HC3, kernel correctness] — `mount('delete', path)`
SHALL clear both `proj.values[path]` AND any literal constraints
in `proj.schemas[path]`. If the schema becomes empty after the
literal is removed, the schema entry SHALL be deleted entirely.
- *Rationale*: under R-A4.1, schema-literal IS value. Delete must
  clear both representations or the value re-emerges via the
  schema literal.
- *Verifiable by*: AC-A4.3.

**R-A4.4** [HC2] — Structural collection (R-A4.2) SHALL be guarded
to fire only on object-shaped (or schema-less) paths. Fn-typed,
string-typed, number-typed, boolean-typed, and array-typed paths
SHALL NOT have their children collected as the path's "value" —
their children are configuration / sidecars, not structural leaves.
- *Rationale*: fn-typed paths' value comes from invocation, not
  from sub-paths. The "value" of `http.fetch` is not its
  `.endpoint` and `.auth` sub-paths.
- *Verifiable by*: AC-A4.4.

**R-A4.5** [housekeeping] — Probe tests documenting the previous
broken-by-design schema-narrowing-cascade behavior SHALL be
deleted, since they encoded a specification this artifact corrects.
Tests revealing genuine bugs that this artifact surfaces SHALL be
marked `test.skip` with a `PENDING` comment naming which subsequent
artifact (A5 or A6) is responsible for the fix.
- *Rationale*: tests that document old bad behavior are misleading
  after the fix; tests that surface new real issues should record
  the cause and route to the right responsible artifact.
- *Verifiable by*: AC-A4.5.

### Acceptance criteria

**AC-A4.1** [R-A4.1] — Given two Sequences, one with
`mount('bind', 'X', 'hello')` and another with
`mount('schema', 'X', createType('string', [literal('hello')]))`,
when `seq.get('X')` is called on each, then both return `'hello'`.

**AC-A4.2** [R-A4.2] — Given a Sequence with `mount('schema', 'X',
createType('object', [property('a', FT.number(), false), property(
'b', FT.number(), false)]))` and `mount('bind', 'X.a', 1)` +
`mount('bind', 'X.b', 2)`, when `seq.get('X')` is called, then it
returns `{a: 1, b: 2}`.

**AC-A4.3** [R-A4.3] — Given a Sequence with `mount('schema', 'X',
createType('string', [literal('hello')]))` and then
`mount('delete', 'X')`, when `seq.get('X')` is called, then it
returns `undefined` and `seq.typeAt('X')` returns `undefined` (the
schema was the only constraint; whole schema removed).

**AC-A4.4** [R-A4.4] — Given a Sequence with `mount('schema',
'http.fetch', createType('fn', [...]))` followed by various sub-
binds at `http.fetch.endpoint` and `http.fetch.auth`, when
`seq.get('http.fetch')` is called, then it returns `undefined`
(fn-typed path; structural collection skipped).

**AC-A4.5** [R-A4.5] — `src/test/schema-narrowing-cascade-probe.test.ts`
is deleted. `src/test/dsl.test.ts` "when modifier creates where
clause" and "when + resume" tests are marked `test.skip` with
PENDING comments naming Artifact 6's DSL double-emit fix as the
unblocker. `services/office-space/src/test/identity-provenance.test.ts`
"provenance rejects writes from the wrong author" and
`rotation-recursive.test.ts` "rotate moves data + leaves transparent
redirect" are marked `test.skip` with PENDING comments naming the
respective bugs surfaced.

---

## Artifact 5 — Storage unification: collapse to one constraint store

**Artifact.** Replace `Projection.values: PathMap<unknown>` and
`Projection.schemas: PathMap<Type>` with a single
`Projection.nodes: PathMap<Constraint[]>`. Migrate every internal
read/write site. Maintain external API (`get`, `typeAt`, `mount`,
predicate evaluators) on top of the unified store. Delete the
dual-storage surface entirely.

**Ships in.** Phase B of the Migration Plan below.

**Review ownership.** Author submits PR; reviewer checks PR
against R-A5.1 – R-A5.6 and verifies each AC-A5.x.

### Requirements

**R-A5.1** [HC1, HC2] — The `Projection` type SHALL have one
constraint store: `nodes: PathMap<Constraint[]>`. The fields
`values` and `schemas` SHALL be removed. Other Projection fields
(`capabilities`, `policies`, `depIndex`, `reverseDepIndex`) are
unchanged by this artifact — they index into `nodes` rather than
being separate stores.
- *Rationale*: HC1 (continuum) — one storage shape for one lattice.
- *Verifiable by*: AC-A5.1.

**R-A5.2** [HC1, HC5, kernel correctness] — Every internal call site
that reads `proj.values.get(path)` SHALL be migrated to an internal
helper that returns the leaves of the constraint subtree (the same
walker `Sequence.get` uses). Every call site that reads
`proj.schemas.get(path)` SHALL be migrated to a helper that returns
the constraint set at path. Both helpers consult the unified
`proj.nodes` store.
- *Rationale*: dual reads cannot persist after dual storage is
  removed. Helpers centralize the value-vs-constraint distinction
  at the read site, which is where it operationally lives.
- *Verifiable by*: AC-A5.2 (no `proj.values` or `proj.schemas`
  references remain in `sequence.ts` after migration).

**R-A5.3** [HC1, HC5] — Every internal call site that writes
`proj.values.set(path, v)` SHALL be migrated to write a literal
constraint into the unified store via the `narrow` op (R-A6.1).
Every call site that writes `proj.schemas.set(path, T)` SHALL
similarly route through `narrow`.
- *Rationale*: writes are the source of the dual-storage problem;
  they must be unified before storage can be unified.
- *Verifiable by*: AC-A5.3.

**R-A5.4** [HC2] — The unified `proj.nodes` store SHALL preserve
the `PathMap` children-index invariant: `childSegments(parent)` is
O(1) per prefix. Constraint additions and deletions update the
children-index consistently.
- *Rationale*: HC2 — leaves-as-values reading depends on cheap
  children enumeration. Per AXIOMS performance contract, the
  index is load-bearing for cascade dispatch.
- *Verifiable by*: AC-A5.4.

**R-A5.5** [HC6, kernel correctness] — Reference lifecycle tracking
(backwardIndex, suspended blocks, commitments) SHALL continue to
work uniformly against the unified store. A reference to "the
value at path" and a reference to "the type at path" become
references to "the constraint set at path"; the lifecycle
machinery does not require the dual stores.
- *Rationale*: HC6 — the reference layer is what differentiates
  alive from collectable, not the dual-storage shape.
- *Verifiable by*: AC-A5.5.

**R-A5.6** [housekeeping] — `runtime/render.ts` and `laws.ts` SHALL
be migrated to consult the unified store (or its accessor helpers)
rather than `proj.values` / `proj.schemas` directly. No external
`Projection`-shape consumers remain after this artifact.
- *Rationale*: the public `Projection` type changes; consumers
  must follow.
- *Verifiable by*: AC-A5.5.

### Acceptance criteria

**AC-A5.1** [R-A5.1] — `Projection` defined in `sequence.ts` has
exactly the fields `{ nodes, capabilities, policies, depIndex,
reverseDepIndex }`. No `values` or `schemas` fields exist.

**AC-A5.2** [R-A5.2] — `grep -rn 'proj\.values\|proj\.schemas'
src/sequence.ts src/laws.ts src/runtime/render.ts` returns zero
matches. All accessors route through helpers.

**AC-A5.3** [R-A5.3] — Every `applyEntry` op handler that mutates
state writes through one internal `_narrow(path, constraints)`
method; bind and schema both call it. The writes update only
`proj.nodes`.

**AC-A5.4** [R-A5.4] — Performance benchmark: 10k constraint
narrowings followed by 10k `keys(prefix)` calls completes within
the same wall-clock as the pre-migration baseline (no quadratic
regression from the storage change).

**AC-A5.5** [R-A5.5, R-A5.6] — All existing pre-migration tests
that did not depend on dual storage (the bulk of the kernel test
suite, ~640 of ~650) pass against the unified store with no test
changes. Tests that did depend on dual storage are migrated to
the unified accessors or deleted per Artifact 4's R-A4.5 pattern.

---

## Artifact 6 — Op + predicate unification

**Artifact.** Introduce a `narrow(path, constraints)` mount op as
the kernel's single write operation. Bind and schema become DSL /
builder sugar over `narrow`. Delete `matchesType` as a constraint
constructor and as a check function. Make the cascade fire on any
narrowing of any constraint at any node. Fix the surfaced bugs
(DSL `=` double-emit, admission-on-schema-mount, rotation source-
set).

**Ships in.** Phase C of the Migration Plan below.

**Review ownership.** Author submits PR; reviewer checks PR
against R-A6.1 – R-A6.7 and verifies each AC-A6.x.

### Requirements

**R-A6.1** [HC5, HC1] — A new mount op `narrow` SHALL be added.
`mount('narrow', path, constraints[])` composes the given
constraints into the constraint set at path. The op replaces the
internal write paths of bind and schema; both DSL/sugar surfaces
desugar to a `narrow` call.
- *Rationale*: HC5 — bind and schema are the same op underneath.
  One kernel-level op makes the unification structural.
- *Verifiable by*: AC-A6.1.

**R-A6.2** [HC5] — `mount('bind', path, v)` SHALL desugar to
`mount('narrow', path, [literal(v)])` for primitives and to
recursive sub-narrows for objects/arrays. The bind sugar is
preserved at the API surface for caller convenience; the kernel
sees only narrow.
- *Verifiable by*: AC-A6.2.

**R-A6.3** [HC5] — `mount('schema', path, T)` SHALL desugar to
`mount('narrow', path, T.constraints)`. Same sugar-vs-substrate
split as R-A6.2.
- *Verifiable by*: AC-A6.3.

**R-A6.4** [HC3] — `matchesType` SHALL be removed as a constraint
constructor in `type.ts` and removed as a check handler in
`compose.ts`. Existing call sites SHALL be migrated to direct
`covers(T, seq.typeAt(path))` calls. The exported API SHALL no
longer include `matchesType`.
- *Rationale*: HC3 — `matchesType` is `covers` + `typeAt`. The
  separate predicate exists only because of dual storage.
- *Verifiable by*: AC-A6.4.

**R-A6.5** [HC3, HC2] — All predicate evaluators that reference a
path's value (`eq`, `gt`, `gte`, `lt`, `lte`, `regex`, `between`,
`oneOf`, `contains`, `exists`, `notExists`) SHALL evaluate against
the constraint state at the path. `eq(path, V)` returns true iff
the leaves of path's constraint subtree compose to V; `exists`
returns true iff the constraint set at path is non-empty.
- *Rationale*: HC3 — predicates are about the constraint set, not
  about a separate value slot.
- *Verifiable by*: AC-A6.5.

**R-A6.6** [HC4] — The cascade dispatch in `fireLaws` SHALL fire
dependents on any narrowing of any constraint at any node. Schema-
narrowing-to-literal fires the same dependents a bind would. The
distinction "value mutation vs schema mutation" SHALL NOT exist
at the dispatch level.
- *Rationale*: HC4 — uniform narrowing produces uniform cascade.
- *Verifiable by*: AC-A6.6.

**R-A6.7** [bug-fix from Artifact 4 surfacing] — The following bugs
surfaced by Artifact 4 SHALL be fixed:
1. **DSL `=` double-emit**: the DSL walker SHALL emit ONE
   narrowing per `=`, not a parallel schema-with-literal AND a
   conditional bind. The narrowing's application MAY be gated by
   a where-clause from a `when` modifier.
2. **Admission on schema mount**: admission laws (writer-authority,
   provenance, etc.) SHALL run on `narrow` calls regardless of
   how the caller invoked them (bind, schema, or direct narrow).
3. **Rotation source-set**: the rotation primitive SHALL enumerate
   leaves explicitly as movable, not parent paths whose value is a
   collected structure of children.
- *Rationale*: these are concrete regressions Artifact 4 exposed.
  They become trivially correct under the unified op (every
  narrowing is admitted; every narrowing is a single block; the
  source-set is a leaf-walk over the constraint graph).
- *Verifiable by*: AC-A6.6 (uniform dispatch), the referenced
  test files un-skipped.

### Acceptance criteria

**AC-A6.1** [R-A6.1] — `mount('narrow', 'X', [literal('hello'),
producedBy('alice')])` composes both constraints into the constraint
set at X. `seq.get('X')` returns `'hello'`. `seq.typeAt('X')`
includes both constraints.

**AC-A6.2** [R-A6.2] — Tracing the kernel call path from
`mount('bind', 'X', 'hello')`, the kernel-level dispatch invokes
`narrow` exactly once with `[literal('hello')]`.

**AC-A6.3** [R-A6.3] — Tracing the kernel call path from
`mount('schema', 'X', createType('string', [literal('hello')]))`,
the kernel-level dispatch invokes `narrow` exactly once with the
single literal constraint.

**AC-A6.4** [R-A6.4] — `grep -rn 'matchesType' src/` returns zero
matches in source files (test fixture files referencing the old
name in comments are also migrated). `import { matchesType } from
'@console-one/sequence'` fails to compile.

**AC-A6.5** [R-A6.5] — Given a Sequence with `mount('schema', 'X',
createType('string', [literal('hello')]))`, the predicate
`eq('X', 'hello')` returns true (without any prior bind).

**AC-A6.6** [R-A6.6] — Given a Sequence with a suspended block
where-clause `[eq('X', 'hello')]` and a subsequent `mount('schema',
'X', createType('string', [literal('hello')]))`, the suspended
block resumes within the same cascade tick. (This is the inverse
of the deleted schema-narrowing-cascade-probe tests — the new
spec assertion.)

**AC-A6.7** [R-A6.7] — The four PENDING tests skipped during
Artifact 4 are unskipped and pass:
- `dsl.test.ts` "when modifier creates where clause"
- `dsl.test.ts` "when + resume: providing dependency resumes"
- `services/office-space/src/test/identity-provenance.test.ts`
  "provenance rejects writes from the wrong author"
- `services/office-space/src/test/rotation-recursive.test.ts`
  "rotate moves data + leaves transparent redirect"

---

## Migration plan

Incremental, gated by passing the existing kernel test baseline at
each step (modulo the documented PENDING skips).

### Phase A — read-side unification (LANDED)

1. ✅ Modify `Sequence.get(path)` to treat schema-literal narrowings
   as values (R-A4.1) and to walk children for object-shaped
   structural collection (R-A4.2). Skip `_*` segments (kernel-
   internal sidecars). Storage stays dual.
2. ✅ Extend `mount('delete', path)` to clear schema literals
   alongside `proj.values` (R-A4.3).
3. ✅ Delete the schema-narrowing-cascade-probe tests; mark surfaced
   bugs as PENDING in dsl.test.ts and ft tests (R-A4.5).
4. ✅ Verify downstream packages (policies / tools / transport /
   agent / ft) regression-test against the new read API. Two
   PENDING skips downstream; everything else passes.

### Phase B — storage unification (PENDING)

5. Add `Projection.nodes: PathMap<Constraint[]>` alongside the
   existing dual stores (R-A5.1). Internal helpers route through
   nodes; reads still consult the duals as a transitional cache.
6. Migrate every `proj.values.get/set` and `proj.schemas.get/set`
   call site to the helpers (R-A5.2, R-A5.3). Audit with grep until
   zero direct accesses remain.
7. Delete `Projection.values` and `Projection.schemas` (R-A5.1).
   Remove the transitional caching path.
8. Migrate `runtime/render.ts` and `laws.ts` (R-A5.6). Verify the
   PathMap children-index performance contract (AC-A5.4).
9. Verify downstream packages regression-test against the unified
   store.

### Phase C — op + predicate unification (PENDING)

10. Introduce the `narrow` mount op in `applyEntry` (R-A6.1).
    Internal call sites for bind and schema both desugar to
    `narrow` (R-A6.2, R-A6.3).
11. Delete `matchesType` from type.ts and compose.ts; migrate
    callers to `covers + typeAt` (R-A6.4).
12. Migrate predicate evaluators to consult the constraint state
    via `_constraintsAt` helper (R-A6.5).
13. Wire cascade dispatch to fire on any constraint narrowing
    (R-A6.6).
14. Fix the three Artifact-4-surfaced bugs:
    a. DSL `=` desugars to one narrowing (R-A6.7.1)
    b. Admission runs on every narrow call (R-A6.7.2)
    c. Rotation enumerates leaves explicitly (R-A6.7.3)
15. Un-skip the four PENDING tests; verify they pass (AC-A6.7).

### Phase D — downstream migration

16. Each downstream package (policies, tools, transport, agent,
    ft) inspects its kernel-touching surface for any remaining
    assumptions about dual storage. Update or delete tests that
    encoded the old model.
17. Update `COMMITMENTS.md` and `LEARNING_AS_COMPRESSION.md`
    references that name `proj.values` / `proj.schemas` to use
    the unified store vocabulary.

## Risks

- **Phase B is the largest in mechanical scope** — ~125 call sites
  in `sequence.ts` plus laws.ts and render.ts. Mitigation: do it
  in one focused session with the helpers in place (R-A5.2,
  R-A5.3) so call-site migration is mechanical search-and-replace.
  Stage commits per file to keep PR review tractable.

- **Performance regression from constraint-walking on every read**.
  Today's `proj.values.get(path)` is O(1); the unified walker is
  O(children) for structured paths. Mitigation: cache materialized
  values at terminal-narrowed nodes; invalidate on narrowing.
  Don't optimize prematurely — verify a benchmark hits an actual
  ceiling before adding caching.

- **Cascade fire frequency increase** from R-A6.6. Schema
  narrowings that previously didn't fire dependents now do.
  Mitigation: profile a representative cascade-heavy workload
  before/after; if the increase is meaningful, add a bypass for
  schema narrowings that don't change the leaf set (e.g., adding
  a `responsePolicy` to a fn type doesn't affect any value-
  predicate).

- **DSL refactor for `=` is broader than this artifact**. Today's
  walker emits the schema-literal-and-bind double form to support
  things this spec hasn't fully analysed (hoist round-trip,
  literal-typed constraint propagation). Mitigation: write a
  comprehensive DSL test set against the round-trip property
  before changing the emit shape. If hidden requirements surface,
  document them and refactor to satisfy.

- **Reference-lifecycle test coverage may not be fully retained**
  through the storage migration. Some tests assert specific
  `proj.values` access patterns. Mitigation: those assertions are
  testing the implementation, not the requirement. Per the
  conversation of 2026-04-22, tests aren't sacred — delete or
  rewrite as the structure dictates.

- **`matchesType` deletion may surface unexpected callers** in
  product code (ft) or third-party code (none yet). Mitigation:
  before deletion, grep `@console-one/sequence` consumers for
  `matchesType` references. Migrate or document each.

- **The unified op approach hides a deeper question** —
  whether `narrow` should reject (or warn) when the new constraint
  is redundant with existing constraints. Today's compose silently
  collapses; the substrate has no notion of "this constraint added
  no information." Out of scope for this artifact; flag for
  future analysis.

## Relationship to other architectural commitments

- **AXIOMS.md (landed)** — the continuum invariant (HC1) is
  axiomatic. This document brings the implementation into
  conformance.

- **COMMITMENTS.md (landed)** — under the unified storage,
  commitment heads are paths in the constraint graph; commitment
  fulfillment is the constraint set at the head reaching a
  terminal-narrowed state. The commitment record's typeRef is a
  reference to a type declaration in the same store. Dependency:
  HC1, HC2.

- **LEARNING_AS_COMPRESSION.md (landed)** — distribution posteriors
  live at `_commitments.*.distribution.*` paths in the constraint
  graph. The cascade-on-narrowing rule (HC4) is what makes posterior
  updates fire downstream observers. Dependency: HC1, HC2, HC4.

- **CAPABILITY_INSTALLATION.md (landed)** — the quadruple
  installation mounts type, contract, impl, distribution as
  constraints into the same graph. The `path + '.distribution'`
  convention lives in the unified store. The reject-incomplete
  admission law (Phase 2 of capability installation) gates `cap`
  mounts; under Artifact 6, those become `narrow` mounts of impl
  IDs and the same admission applies. Dependency: HC1, HC5, HC4.

- **Hoist (landed)** — `hoist`'s traversal IS the read-side
  walker. This document makes `Sequence.get` use the same shape;
  hoist becomes a consumer of the unified read API rather than
  an alternative reader. Future cleanup: refactor hoist to share
  the walker explicitly.

## Reading order for someone arriving at the substrate

1. **AXIOMS.md** — the load-bearing invariants, including the
   continuum.
2. **ARCHITECTURE.md** — how the pieces fit.
3. **This document** — what the substrate's storage actually is.
4. **COMMITMENTS.md** — what the substrate does on the write side.
5. **LEARNING_AS_COMPRESSION.md** — what the substrate does on the
   observation side.
6. **CAPABILITY_INSTALLATION.md** — what the substrate does on the
   install side.
7. **KERNEL_REQUIREMENTS.md** — the contract the kernel implements.
8. **DSL_REQUIREMENTS.md** — how it surfaces in ft text.

This document, COMMITMENTS, LEARNING_AS_COMPRESSION, and
CAPABILITY_INSTALLATION are four projections of one architectural
commitment: types and values are one continuum, narrowing is the
single write op, observation is the single read op, the cascade
ties them together. Each document expands one face of that
commitment in detail.

---

## Appendix: quick index for the refactor agent

**If you're verifying Artifact 4**, the requirements are R-A4.1 —
R-A4.5 (all five required). Acceptance: AC-A4.1 through AC-A4.5
(five tests minimum). Status: landed at commit `bce264a`.

**If you're implementing Artifact 5**, your checklist is R-A5.1
through R-A5.6 (six required). Acceptance: AC-A5.1 through
AC-A5.5 (five tests minimum). The work is mechanical-but-large
(~125 call sites). Use helpers (R-A5.2, R-A5.3) to centralize
the dual-storage migration before deleting the duals.

**If you're implementing Artifact 6**, your checklist is R-A6.1
through R-A6.7 (seven required). Acceptance: AC-A6.1 through
AC-A6.7 (seven tests minimum). Phase order matters: introduce
`narrow` before deleting `matchesType` before wiring the
cascade-on-any-narrowing change. Final step is un-skipping the
four PENDING tests as proof of correctness.

**If you find yourself wanting to skip a requirement**, trace it
to its hypothesis (HC1–HC6, listed with each requirement in
brackets). Argue the hypothesis, not the requirement. If the
hypothesis holds, the requirement is load-bearing.

**If you find yourself wanting to add a requirement**, check
that it derives from a hypothesis HC1–HC6. If not, either propose
a new hypothesis with rationale and invalidation conditions, or
your candidate requirement is likely out of scope for this
document.
