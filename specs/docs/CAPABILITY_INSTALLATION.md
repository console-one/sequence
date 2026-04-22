# Capability Installation — the substrate's install-side primitive

Status: architectural commitment, 2026-04-21. Foundational. The
third face of one cascade, alongside COMMITMENTS.md (write-side)
and LEARNING_AS_COMPRESSION.md (learning-side).

---

## Summary (for the handoff agent)

**What this document defines.** Capability Installation as the
atomic mount of a four-field record — `{ type, contract, impl,
distribution }` — referred to as the **quadruple**. Installing a
capability is one block; partial installs are rejected; every
installed capability is thereby simultaneously typed, contract-
enforced, holder-bound, and learnable from first invocation.

**Why this document exists.** Three upstream architectural
commitments converge here:

1. **COMMITMENTS.md** — every invocation of any capability is a
   commitment; the in-process fast case and remote orchestration
   case are isomorphic.
2. **LEARNING_AS_COMPRESSION.md** — the substrate's obligation to
   compress its own block log IS its learning loop; commitment
   distributions generalize from scalar latency to conditional
   posterior over declared input-subtype partitions.
3. **The conclusion drawn during the conversation of 2026-04-21**:
   if every invocation elects a commitment and every fulfillment
   updates a posterior, then installation — the moment a
   capability first becomes addressable — must produce the
   complete surface on which both ride. Anything less leaves
   unmanaged holes.

**Two actionable artifacts, defined with explicit per-artifact
requirements in this document:**

- **Artifact 2** — `FT.cap()` builder in `src/builder.ts`.
  Requirements **R-A2.1 – R-A2.8** and acceptance criteria
  **AC-A2.1 – AC-A2.7** below.
- **Artifact 3** — requirements backfill across
  `specs/requirements/capabilities/env-installs.md`,
  `class-installs.md`, and `skill-installs.md`.
  Requirements **R-A3.1 – R-A3.6** and acceptance criteria
  **AC-A3.1 – AC-A3.5** below.

**Load-bearing hypotheses.** Both artifacts rest on eight explicit
hypotheses (**H1 – H8**) enumerated in the next section. Each
requirement is tagged with the hypotheses it depends on. If a
hypothesis is rejected during refactor, the dependent requirements
MUST be re-derived, not silently preserved.

**For the refactor agent:** read this document together with
COMMITMENTS.md and LEARNING_AS_COMPRESSION.md — they form one
architectural set. Do not treat any of them in isolation. If you
find yourself needing to violate a requirement here, trace it to
its hypotheses and argue about the hypothesis, not the
requirement.

---

## Derivation — the hypothesis chain that produced this document

Each hypothesis below was arrived at through the conversation
history that produced this spec and its two siblings. They are
listed in dependency order — later hypotheses assume earlier ones.
Every requirement in this document is tagged with the hypotheses
it depends on; reject a hypothesis, and every dependent
requirement is in play.

### H1 — Prediction IS compression (Solomonoff / MDL).

**Claim.** The shortest program that reproduces an observation
sequence is the best predictive model of the next observation.
Learning and lossless compression of the block log are the same
optimization target.

**Rationale.** Classical information-theory result (Solomonoff /
Kolmogorov / Chaitin). An append-only log that never factors
observed regularities into rules stores the uncompressed history
forever; it is a journal, not a substrate. The substrate's
learning loop is therefore not optional — it is forced by the
append-only commitment.

**What invalidates it.** If the substrate is permitted to grow
linearly without ever promoting regularities into type structure,
H1 is not required. Every other hypothesis here ultimately rests
on H1; rejecting H1 dissolves the frame.

**Requirements it begets.** H1 is the root justification for
LEARNING_AS_COMPRESSION.md and therefore for the `distribution`
field on the quadruple. All requirements naming `distribution`
transitively depend on H1.

### H2 — The block log is dataset AND model.

**Claim.** A capability's sequence carries the full history of
its invocations as ordinary blocks. The learned posterior over
those invocations is itself type-state mounted to the same
sequence. Training data, model, and training pipeline share one
physical artifact.

**Rationale.** Sequence's axioms A2/A3/A9 (the sequence is the
sole authority, append-only, state is projection). Posteriors as
type-state rather than a separate artifact preserves
replayability, federability, and auditability for free.

**What invalidates it.** A design in which the model lives
external to the log (e.g., separate ML artifact store) — would
require separate federation, replay, and audit surfaces. The
invariant the substrate pays for by avoiding this is large.

**Requirements it begets.** The mount-the-distribution-at-install
requirement (R-A2.3, R-A3.2). The posterior lives in the log iff
installation places it there.

### H3 — Every invocation is a commitment.

**Claim.** Per COMMITMENTS.md, code-level computation is the
degenerate fast case of remote work. Installing a capability =
registering a holder candidate for commitments elicited at the
capability's path.

**Rationale.** COMMITMENTS.md is a landed architectural commitment.
It argues the symmetry (§ "Symmetry across delegation kinds"); if
in-process and remote calls look the same through the commitment
primitive, capabilities of any kind install through the same
holder-registration mechanism.

**What invalidates it.** A bifurcated model in which some
capabilities are "tracked" (via commitments) and others are
"fast" (direct function call, no commitment record). COMMITMENTS.md
explicitly rejects this.

**Requirements it begets.** The impl-is-a-holder-candidate shape
of the quadruple (R-A2.7). The "installing a capability" wording
throughout maps to "registering a holder for a typed slot."

### H4 — Commitment `distribution` is N-dimensional conditional, not scalar latency.

**Claim.** The scalar latency prior documented in COMMITMENTS.md
is the 1-D degenerate case of a conditional posterior over
declared input-subtype partitions across any declared `over`
dimensions (time, outputShape, outputValue, ...).

**Rationale.** H1 + the conversation-derived observation that
holder reliability, response-shape expectations, and latency
priors are all projections of the same conditional. One
primitive, many marginals.

**What invalidates it.** A finding that the scalar form is
sufficient in practice — that no capability benefits from
conditioning on input subtype. Calibrate empirically; if true,
the quadruple's `distribution` field reduces to scalar and
several risks disappear.

**Requirements it begets.** The shape of `blueprint.distribution`
(R-A2.5, R-A3.2). The `refinementPolicy` gating (R-A2.5 default
behavior).

### H5 — Laws can read posterior state.

**Claim.** `law.check` constraints can reference paths into
`_commitments.*.distribution.posterior.*` and admit/reject
observations by posterior-predictive quantile. Contract
enforcement becomes evidence-conditioned; it is no longer the
case that admission laws are hardcoded predicates alongside
learned posteriors that go unread.

**Rationale.** LEARNING_AS_COMPRESSION.md § "Laws carry the
posteriors as policy." Laws are serializable constraint sets
(A4); `posteriorAdmit(path, options)` fits that shape without
new primitives.

**What invalidates it.** A decision to keep admission laws
strictly static and treat posteriors as advisory-only
observability. Possible but dilutes the point of having a
learning loop.

**Requirements it begets.** The `contract.laws` field's ability
to reference posterior paths (R-A2.3, R-A3.3). The
`posteriorAdmit` constraint family (out of scope for Artifacts 2
and 3; lands in LEARNING_AS_COMPRESSION.md's Phase 3).

### H6 — Installation is the atomic mount of a quadruple.

**Claim.** Every one of the four fields — type, contract, impl,
distribution — must be mounted in the same atomic block. Partial
installs are rejected. Omission of any field is structurally
unforgeable via a reject-incomplete admission law that the
substrate installs as part of its own bootstrap.

**Rationale.** Each field corresponds to an upstream commitment
(type = A5 type, contract = A4 constraint set + H5 posterior
reads, impl = H3 holder, distribution = H2 + H4 posterior
surface). Any missing field is an unmanaged hole at that
commitment's level. The quadruple is the minimal structurally
complete install.

**What invalidates it.** A domain in which some capabilities
truly do not need a contract or a learning surface — e.g.,
pure-function arithmetic primitives. The escape valve is the
empty / trivial default (R-A2.5, R-A2.6): contract.laws = [] and
distribution = scalar trivial form are legal declarations.
Absence (no field at all) is not.

**Requirements it begets.** The reject-incomplete admission law
(kernel contract item 6; migration Phase 2). The builder's
enforcement that every quadruple field be provided or defaulted
(R-A2.1, R-A2.5, R-A2.6). The backfill of env-installs.md /
class-installs.md / skill-installs.md (R-A3.1 – R-A3.4).

### H7 — Blueprints are data (A4/A5); impls resolve at install time.

**Claim.** The blueprint is a serializable record. It carries an
impl ID (string), not a live function reference. The
environment's impl registry resolves the ID to a callable during
block application.

**Rationale.** Axioms A4 / A5 ("constraints are data",
"types are serializable"). Live functions in the block log would
break replay, federation, and snapshot determinism.

**What invalidates it.** A decision to carry live functions in
blueprints (for ergonomic reasons). Would require re-evaluating
A4 / A5, which are extremely load-bearing.

**Requirements it begets.** Impl-ID resolution behavior
(R-A2.7). The "impl resolution failure after install" risk.

### H8 — Subtype refinement is gated by MDL / Bayes factor.

**Claim.** A proposed subtype refinement is admissible iff its
information gain across the block log exceeds its own description
length cost. This is AIC / BIC / MDL model comparison; it is the
substrate's "learning rate" analog.

**Rationale.** Without this gate, the substrate promotes subtypes
on every marginal wobble, the lattice grows monotonically, and
compression actively loses.

**What invalidates it.** Using a different (non-MDL) criterion —
e.g., a fixed-K top-gain selection, or hand-declared subtypes
only. LEARNING_AS_COMPRESSION.md discusses alternatives; none are
precluded by this spec.

**Requirements it begets.** The `refinementPolicy` field on
`distribution` (R-A2.5 default) and the reject-promotion
admission law (LEARNING_AS_COMPRESSION.md Phase 4; out of scope
for Artifacts 2 and 3 but present in the quadruple's shape).

---

## The insight

Today, installing a capability is an incomplete triple — path,
type signature, impl — with contract wiring, telemetry, and
learning all expected to be bolted on afterward, per-capability,
by hand. Most never are. The result: the substrate hosts
capabilities it cannot enforce, cannot audit, and cannot learn
from, because the artifact that would express those obligations
was never made part of the install.

Installation is not the act of registering an endpoint. It is the
act of committing to host a capability under a contract, with a
learning surface that captures every invocation and an impl that
satisfies the contract's write-authority. If any of those is
absent, the substrate has not installed a capability — it has
adopted an unmanaged hole in its own type state.

The fix is to make installation a single atomic act that binds all
four pieces at once. The blueprint is not "path + type + impl with
options" — it is a **quadruple** in which no component is
optional.

## The primitive

A capability is a mounted **quadruple**:

| Component | Meaning |
|---|---|
| `type` | Input/output signature at the capability's path. Determines the shape of commitments elicited against it. Serializable; no live functions (A5). |
| `contract` | Prerequisites the environment must satisfy for the install to complete, plus admission laws evaluated against every invocation. Laws are serializable constraint sets (A4); they MAY read posterior state to become evidence-conditioned (H5). |
| `impl` | The holder resolution for commitments elicited against the path. Resolved from the environment's impl registry by ID at install time; the blueprint carries the ID, not the live function (H7). |
| `distribution` | The conditional posterior surface from LEARNING_AS_COMPRESSION.md — `over` dimensions, declared subtypes, initial priors, refinement policy (H4). Present at install even if empty; the presence of the field is what makes invocations learnable. |

Install mounts all four atomically as one block. The block is
suspended by where-clauses on unmet prerequisites; it applies, and
the capability exists, only when prerequisites are concrete.

An install block that mounts a subset is rejected. There is no
"install now, add contract later"; there is no "install now, add
distribution later." The quadruple is the unit (H6).

## Install as cascade entry

```
install(blueprint)
  → create block with entries:
      schema   at path                      = blueprint.type
      law      at path                      = blueprint.contract.laws[*]
      cap      at path                      = implId(blueprint.impl)
      schema   at path + '.distribution'    = blueprint.distribution
    where:
      blueprint.contract.prerequisites all concrete
  → mount(block)
    → where-check suspends if prerequisites missing
    → applies atomically when concrete
    → cascade fires once, propagating:
        - the type's ancestors become aware of the new slot shape
        - the impl registration makes the path electable
        - the distribution surface becomes observable
```

No out-of-band registration, no install script, no separate "wire
up telemetry" step. One block; the cascade does the rest.

Invocation thereafter:

1. A path in the caller's ft text expands into an entry against
   the capability's path.
2. The substrate elects a commitment (COMMITMENTS.md) with the
   capability's registered impl as holder.
3. The holder writes the head.
4. On concrete final state, the fulfillment cascade terminal
   updates the distribution's posterior (LEARNING_AS_COMPRESSION.md).
5. Admission laws on the capability may read the posterior and
   reject writes that fall outside the learned predictive
   quantile (H5).

Every invocation is a commitment; every fulfillment updates the
posterior; every admission can be evidence-conditioned. None of
these is instrumented at the capability; all of them fall out of
the quadruple being mounted correctly at install time.

## Symmetry across blueprint kinds

The existing blueprint taxonomy — HTTP endpoint sets, runtime
classes, document-based definitions, tool adapters — converges on
one install shape:

| Blueprint kind | `type` | `contract.prerequisites` | `impl` | `distribution` |
|---|---|---|---|---|
| HTTP endpoint set | Declared request / response shapes | Auth secrets (API keys, OAuth tokens); base URL; rate-limit budget | HTTP client bound to the endpoint | Latency + response-shape posterior |
| Runtime class | Method signatures on the class | Runtime version, native deps | Live class reference (resolved at install) | Per-method latency + output posterior |
| Document-based | Schema declared in the document | Document validity; referenced capabilities available | Deterministic interpreter over the document | Interpretation time + output posterior |
| Tool adapter | Adapter's declared surface | Wrapped tool present in env | Adapter binding | Adapter-call latency + output posterior |

No kind needs a special install path. The shape is the same; the
fields populate differently.

## What this collapses

The substrate today has several ad-hoc install shapes and
afterthoughts. Under the quadruple they become one:

| Today | Under the quadruple |
|---|---|
| `cap` entry registers impl; type mounted separately; contract enforced by scattered `law` mounts elsewhere (if at all) | One install block; type, laws, and impl mount atomically with where-clauses on prerequisites. |
| Telemetry / observation retained per-capability via bespoke wrappers around the impl | `distribution` mount is the observation surface; fulfillment cascade terminal updates it uniformly. No impl wrapping. |
| Secrets wired to capabilities by reference from capability-specific code | `contract.prerequisites: ['state.secrets.openai.key']` gates the install. Secrets are ordinary state; the law references them by path. |
| "Install this capability and don't forget to set up logging" as documentation | No reminder needed. Absent `distribution` = no install. |
| Uninstall as a separate `cap.delete` convention | Uninstall is a block that invalidates the install block and its children. The block log records both. |
| Version reconciliation (env-installs R8) as a session-load chore | The install block carries its blueprint version; reconciliation is a mount-level operation against the recorded version. |

## Kernel implementation contract

What the kernel must provide (load-bearing):

1. **Install block schema** — the substrate recognises a blueprint
   as a canonical `{ path, type, contract, impl, distribution,
   version }` record. An install block contains the mounts derived
   from this record; a block that mounts a subset is rejected.
2. **Atomicity** — install is one `mount(entries[], opts)` call
   (A6, A12). Partial success is not possible; where-clause
   failure suspends the whole block (A3', A7).
3. **Prerequisite gating via where-clauses** — the install block's
   where-clause references prerequisite paths from
   `contract.prerequisites`. Unmet prerequisites suspend; they
   resume via tryResumeSuspended (A11) when prerequisites
   concretize.
4. **Impl resolution at install time** — the environment's impl
   registry resolves the blueprint's impl ID to a live function
   during block application. The ID goes in the block (A4 / A5
   serialisability); the live function is environment-bound (H7).
5. **Cap mount conventions for distribution** — the `distribution`
   field mounts at `path + '.distribution'` as a type-state
   convention LEARNING_AS_COMPRESSION.md recognises. No new
   primitive.
6. **Reject-incomplete admission law** — a built-in substrate law
   that rejects any `cap` mount not accompanied by type +
   contract + distribution at the same path, same block. Makes
   the quadruple structurally unforgeable (H6).

What the kernel does NOT need to know:

- Blueprint kinds (HTTP, runtime class, document, tool adapter).
  Each kind is an install-helper convention that produces a
  quadruple; the kernel sees only the quadruple.
- Impl implementation language, runtime, transport. Resolved to a
  holder (code-level or external per COMMITMENTS.md symmetry).
- Secret storage mechanics. `contract.prerequisites` references
  paths; how those paths become concrete (OS keychain, HSM,
  per-session prompt) is environment-policy.

---

## Artifact 2 — `FT.cap()` builder: requirements and acceptance criteria

**Artifact.** A builder function `FT.cap(blueprint)` in
`src/builder.ts` that accepts the quadruple and returns an install
block suitable for `mount()`.

**Ships in.** Phase 1, step 2 of the Migration Plan below.

**Review ownership.** Author submits PR; reviewer checks PR
against R-A2.1 – R-A2.8 and verifies each AC-A2.x.

### Requirements

**R-A2.1** [H6] — `FT.cap()` SHALL accept a `Blueprint` record with
the fields `{ path, type, contract, impl, distribution, version }`.
It SHALL reject inputs missing `path`, `type`, `impl`, or `version`
with a specific error identifying the absent field. `contract` and
`distribution` are optional at the builder level and default per
R-A2.5 / R-A2.6.
- *Rationale*: the quadruple is the unit; omitted required fields
  must surface at build time, not silently at mount time.
- *Verifiable by*: calling `FT.cap()` with each required field
  omitted in turn and confirming each rejection names the missing
  field.

**R-A2.2** [H6, kernel contract item 2] — `FT.cap()` SHALL return
an install block — an object containing `entries: MountEntry[]`
and `where: Constraint[]` — suitable for passing to `mount()`
without further transformation.
- *Rationale*: installation is atomic (A6, A12); the caller must
  not be required to assemble the block themselves.
- *Verifiable by*: `mount(FT.cap(blueprint))` succeeds with
  prerequisites satisfied; no intermediate assembly step appears
  in test fixtures.

**R-A2.3** [H2, H3, H4, H6, kernel contract items 1, 5] — The
returned block's `entries` SHALL contain exactly four entry
kinds at the blueprint's `path`:
1. one `schema` entry at `path` with value = `blueprint.type`;
2. N `law` entries at `path` with values = `blueprint.contract.laws`
   (N ≥ 0; empty list is legal, absent is not);
3. one `cap` entry at `path` with value = the resolved impl ID;
4. one `schema` entry at `path + '.distribution'` with value =
   `blueprint.distribution`.
- *Rationale*: these are the kernel-level mounts required to mean
  "installed." The exact set makes the builder auditable against
  the kernel contract.
- *Verifiable by*: inspecting the block's entries; confirming op
  / path / value for each of the four entry-kind groups.

**R-A2.4** [H6, kernel contract item 3] — The returned block's
`where` clause SHALL contain one constraint per path listed in
`blueprint.contract.prerequisites`, each asserting that the
prerequisite path is concrete. Order of constraints MUST be
stable across calls given identical input (sorted
lexicographically, for replay determinism).
- *Rationale*: prerequisites gate the install via A3'/A7;
  where-clause suspension is how the substrate defers installs
  until prerequisites concretize.
- *Verifiable by*: building a blueprint with prerequisites
  `['state.secrets.foo']`, mounting it with the prerequisite
  absent → block suspended; mounting again after binding the
  prerequisite → block resumes and applies.

**R-A2.5** [H4, H6 escape valve] — When `blueprint.distribution`
is absent, `FT.cap()` SHALL default it to the trivial scalar
form: `{ over: ['time'], conditional_on: [], posterior: {},
refinementPolicy: { mdlThreshold: Infinity } }`. The builder
SHALL NOT reject an absent `distribution`.
- *Rationale*: Phase 2's reject-incomplete law does not exist
  yet; the builder must produce compliant blocks in the Phase 1
  world. Infinity threshold means no refinement promotion until
  the blueprint opts in — explicit, not implicit.
- *Verifiable by*: calling `FT.cap()` without `distribution` →
  returned block contains a `distribution` schema with exactly
  the specified default values.

**R-A2.6** [H6 escape valve] — When `blueprint.contract` is absent,
`FT.cap()` SHALL default it to `{ prerequisites: [], laws: [] }`.
When `contract` is present but `contract.laws` is absent,
`FT.cap()` SHALL default `laws` to `[]`. Empty lists are
deliberate declarations; absence is converted to empty-list
declaration at build time.
- *Rationale*: same migration reason as R-A2.5; see Phase 2 step
  5. A caller MAY mount with no admission laws; a caller MAY NOT
  silently omit the contract field.
- *Verifiable by*: calling `FT.cap()` without `contract` →
  returned block contains a contract schema with empty
  prerequisites and empty laws.

**R-A2.7** [H7, kernel contract item 4] — `FT.cap()` SHALL resolve
`blueprint.impl` against the environment's impl registry at build
time. If `blueprint.impl` is a string, it is treated as an impl
ID and looked up; if it is a function reference, the builder
SHALL reject with an error instructing the caller to register
the function with the impl registry first and pass the ID. If
the ID does not resolve, the builder SHALL reject with an error
naming the unresolved impl.
- *Rationale*: live functions never enter the log (A4 / A5, H7);
  the block carries only the ID. Ergonomic sugar that accepts
  live functions would violate A4 / A5.
- *Verifiable by*: (a) calling `FT.cap()` with a registered impl
  ID → resolves; (b) calling with an unregistered impl ID →
  rejects naming the ID; (c) calling with a function reference
  → rejects with registration instruction.

**R-A2.8** [H7, env-installs R8] — `FT.cap()` SHALL preserve
`blueprint.version` verbatim onto the resulting install block —
specifically as a property on the `cap` entry's value or in the
block's metadata (implementer's choice, as long as a reader can
extract it by path later). If `version` is absent, the builder
SHALL reject per R-A2.1.
- *Rationale*: env-installs R8 requires version reconciliation
  on session load; the reconciliation mechanism reads the
  recorded version from the install block.
- *Verifiable by*: mounting a blueprint with `version: 'v2'`;
  reading the version back from the installed block via the
  defined extraction path; confirming equality.

### Acceptance criteria

**AC-A2.1** [R-A2.1, R-A2.3] — Given a Blueprint with all fields
present and an impl registered in the environment, when
`FT.cap(blueprint)` is invoked, then it returns a block whose
`entries` contain exactly: one `schema` at `path`, N `law`
entries at `path` (N = len(blueprint.contract.laws)), one `cap`
at `path`, one `schema` at `path + '.distribution'`. No other
entries.

**AC-A2.2** [R-A2.2] — Given a blueprint built via `FT.cap()`,
when `mount(block)` runs with prerequisites satisfied, then the
capability is installed and invocable (`seq.type(path)` resolves
to the blueprint's type; invocation via ft-text expansion
succeeds).

**AC-A2.3** [R-A2.4] — Given a blueprint with prerequisites
`['state.secrets.key']`, when `mount(FT.cap(blueprint))` runs
with that secret absent, then the block suspends with a gap
naming `state.secrets.key`.

**AC-A2.4** [R-A2.4] — Given a suspended install block from
AC-A2.3, when a subsequent mount binds `state.secrets.key`, then
the install block resumes (via `tryResumeSuspended`) and the
capability becomes invocable.

**AC-A2.5** [R-A2.1] — Given a blueprint missing `type`, when
`FT.cap(blueprint)` is invoked, then it rejects with an error
whose message explicitly names `type` as the missing field.
Repeat for `path`, `impl`, `version`.

**AC-A2.6** [R-A2.5, R-A2.6] — Given a blueprint with
`distribution` absent and `contract` absent, when `FT.cap()` is
invoked, then the returned block contains (a) a distribution
schema with `over: ['time']`, `conditional_on: []`,
`refinementPolicy.mdlThreshold: Infinity`, and (b) a contract
with `prerequisites: []` and `laws: []`.

**AC-A2.7** [R-A2.7] — Given a blueprint whose `impl` is a
string naming an unregistered impl ID, when `FT.cap()` is
invoked, then it rejects with an error naming the unresolved
impl. Given a blueprint whose `impl` is a function reference,
when `FT.cap()` is invoked, then it rejects with an error
instructing the caller to register the function and pass the
ID.

---

## Artifact 3 — Requirements backfill: requirements and acceptance criteria

**Artifact.** Updated requirement documents at
`specs/requirements/capabilities/env-installs.md`,
`class-installs.md`, and `skill-installs.md` reflecting the
quadruple's mandatory shape across all blueprint kinds.

**Ships in.** Phase 3, step 8 of the Migration Plan below.

**Review ownership.** Author submits PR editing the three files;
reviewer checks PR against R-A3.1 – R-A3.6 and verifies each
AC-A3.x.

### Requirements

**R-A3.1** [H6] — The existing R4 in
`specs/requirements/capabilities/env-installs.md` SHALL be
extended such that a blueprint MUST declare all six fields:
`type`, `contract`, `impl`, `distribution`, `path`, and
`version`. Omission of any of these fields SHALL cause the
install to fail with a validation error specifically naming the
absent field.
- *Rationale*: the quadruple is the unit; requirement-level
  enforcement makes the install shape mandatory across all
  blueprint kinds. H6 is the load-bearing hypothesis; if H6 is
  rejected, R-A3.1 must be re-derived.
- *Verifiable by*: grepping env-installs.md for the updated R4
  language; confirming it names all six fields; confirming it
  specifies the rejection behavior on omission.

**R-A3.2** [H1, H2, H4] — env-installs.md SHALL add a new
requirement **R9**: "Blueprints SHALL declare a `distribution`
field specifying the conditional posterior surface (per
LEARNING_AS_COMPRESSION.md), which MAY be the trivial scalar
form but MUST be present." The Rationale SHALL reference H1 /
H2 / H4 explicitly.
- *Rationale*: installation without a learning surface is an
  unmanaged hole; an explicit requirement prevents blueprint
  authors from omitting it. Naming the hypotheses in the
  Rationale means a future refactor can trace the requirement
  back to its justifications.
- *Verifiable by*: env-installs.md contains R9 with the quoted
  language; its Rationale names H1, H2, H4.

**R-A3.3** [H5, H6] — env-installs.md SHALL add a new requirement
**R10**: "Blueprints SHALL declare a `contract` field with
`prerequisites: string[]` and `laws: Law[]`. Empty lists are
legal declarations; absence is not. Laws MAY reference posterior
state via path (per LEARNING_AS_COMPRESSION.md) to become
evidence-conditioned."
- *Rationale*: absence vs. empty-list distinction preserves the
  "declared" vs. "forgotten" invariant. H5 is named to make
  posterior-read laws explicitly supported at the requirements
  level.
- *Verifiable by*: env-installs.md contains R10 with the quoted
  language; acceptance criterion below tests empty-list-accepted
  vs. absent-rejected.

**R-A3.4** [H6] —
`specs/requirements/capabilities/class-installs.md` and
`specs/requirements/capabilities/skill-installs.md` SHALL be
extended with requirements equivalent to R4-amended / R9 / R10
from env-installs.md, scoped to their respective blueprint
shapes (runtime classes; skills). Each document's existing
Original Notes SHALL be preserved verbatim per TEMPLATE.md; the
new requirements SHALL be added after existing requirements,
not interleaved.
- *Rationale*: all blueprint kinds converge on the quadruple
  (Symmetry across blueprint kinds table above); requirement-
  level uniformity eliminates kind-specific loopholes. Note on
  Original Notes: per the repo's convention, Original Notes are
  load-bearing — do not edit, only append.
- *Verifiable by*: grepping each of the two files for the three
  added requirements; confirming Original Notes are unchanged.

**R-A3.5** [H6] — The existing **AC2** of env-installs.md (HTTP
endpoint blueprint example providing `api.users.list` and
`api.users.get`) SHALL be amended to include an explicit
`contract.prerequisites` (a plausible API key path, e.g.
`state.secrets.users_api.key`) and `distribution` (latency +
outputShape, one posterior per endpoint or shared across both).
The amendment SHALL be additive — the existing language about
capabilities appearing in the session's capability set is
preserved.
- *Rationale*: examples drive blueprint-author behavior. An AC
  that still shows the old triple misrepresents the requirement
  and will produce downstream code that matches the old shape.
- *Verifiable by*: reading the amended AC2; confirming it
  references `contract.prerequisites` and `distribution`;
  confirming the old capability-set-appearance language is
  retained.

**R-A3.6** [housekeeping] — The Open Questions section of
env-installs.md SHALL be updated: the question "Should blueprint
installation be transactional (all-or-nothing), or can partial
installation be acceptable for multi-capability blueprints?"
SHALL be moved to a new "Resolved Questions" subsection with
the resolution: "All-or-nothing. The quadruple is the unit; a
block that mounts a subset is rejected (H6)."
- *Rationale*: retaining resolved open questions misleads
  readers into thinking the design is undecided; a
  Resolved Questions subsection records the decision without
  losing the historical question.
- *Verifiable by*: grepping env-installs.md; the question no
  longer appears under Open Questions; the Resolved Questions
  subsection contains it with the stated resolution.

### Acceptance criteria

**AC-A3.1** [R-A3.1, R-A3.2, R-A3.3] — Given env-installs.md
after backfill, when parsed, then R4 names all six fields
(type, contract, impl, distribution, path, version); R9 exists
and specifies distribution as mandatory; R10 exists and
specifies contract with prerequisites and laws as mandatory.

**AC-A3.2** [R-A3.2] — Given a test blueprint with
`distribution` omitted, when passed to the install-validator
conforming to env-installs.md R9, then validation fails with
reason explicitly referencing R9.

**AC-A3.3** [R-A3.4] — Given class-installs.md and
skill-installs.md after backfill, when parsed, then both contain
requirements equivalent to R4-amended / R9 / R10 from
env-installs.md, scoped to their blueprint shapes; and the
Original Notes section of each is unchanged byte-for-byte from
pre-backfill.

**AC-A3.4** [R-A3.5] — Given the amended AC2 of env-installs.md,
when the example HTTP endpoint blueprint is inspected, then it
declares a `contract.prerequisites` naming a plausible API key
path and a `distribution` specifying latency + outputShape; and
the original claim that both capabilities appear in the session
capability set is retained.

**AC-A3.5** [R-A3.6] — Given env-installs.md after backfill,
when a reader scans Open Questions, then the transactionality
question is absent; when a reader scans Resolved Questions,
then that question is present with the specified resolution.

---

## Migration plan

Incremental, gated by passing the existing 651 + 269 test
baseline at each step. Artifact 2 lands in Phase 1 step 2;
Artifact 3 lands in Phase 3 step 8.

### Phase 1 — blueprint schema and builder

1. Add the canonical blueprint record type in `type.ts`:
   `Blueprint = { path, type, contract, impl, distribution,
   version }`. Export.
2. **[Artifact 2]** Add `FT.cap(blueprint)` builder in
   `builder.ts` satisfying R-A2.1 – R-A2.8 and AC-A2.1 – AC-A2.7
   above.
3. Write coverage tests matching AC-A2.1 – AC-A2.7 verbatim.

### Phase 2 — the reject-incomplete admission law

4. Install a substrate-level admission law that gates `cap`
   mounts: a `cap` at path P without a matching `schema`, at
   least one `law`, and `distribution` schema at the same path
   in the same block is rejected with a specific reason
   referencing the missing field(s).
5. Migrate existing `cap` mount call sites to the blueprint
   form. Where contract is genuinely absent, mount an explicit
   `contract: { laws: [] }` — empty list is a deliberate
   declaration. Where distribution is absent, mount the trivial
   scalar form per R-A2.5.

### Phase 3 — blueprint-kind helpers and requirements backfill

6. Add install helpers for each blueprint kind:
   `FT.httpCapability`, `FT.runtimeClass`, `FT.documentCap`,
   `FT.toolAdapter`. Each produces a quadruple.
7. Write coverage tests: each helper produces a valid quadruple
   that passes the reject-incomplete law.
8. **[Artifact 3]** Update env-installs.md, class-installs.md,
   skill-installs.md per R-A3.1 – R-A3.6 and AC-A3.1 – AC-A3.5
   above.

### Phase 4 — invocation lifecycle unification

9. Invocation of an installed capability goes through the
   commitment election path from COMMITMENTS.md. Remove any
   remaining special-cased capability-invocation code paths.
10. On fulfillment, the cascade terminal runs posterior updates
    per LEARNING_AS_COMPRESSION.md Phase 2. By this phase, the
    three documents have reached one implementation.

### Phase 5 — uninstall and versioning

11. Uninstall: a block that appends `invalidate` entries against
    the install block's path prefix. Active commitments at the
    path receive revocation via control channel; dependents
    surface the path as unavailable (matches env-installs R7).
12. Versioning: the install block carries `version`. Reinstall
    at a higher version creates a new install block; the
    blueprint carries a `posteriorPolicy` governing whether
    prior observations under the old version continue to inform
    the new version's posterior or are decayed / discarded.

## Risks

- **Over-specification burden on tiny capabilities**. Forcing
  contract + distribution on a one-line capability feels heavy.
  *Mitigation*: defaults. Empty laws and trivial scalar
  distribution are legal and take one line to express. The
  burden is "declare the fields" (two tokens), not "design full
  contracts." See R-A2.5 / R-A2.6.

- **Secret-in-blueprint temptation**. Blueprints are data and
  federable. A developer tempted to put an API key in
  `contract.prerequisites` defeats the point. The prerequisite
  MUST reference a path where the secret lives (`state.secrets.*`)
  and never the secret itself. *Mitigation*: document explicitly;
  enforce via a built-in law rejecting blueprint mounts with
  secret-shaped literal values. Out of scope for Artifact 2;
  deferred to a separate admission law.

- **Impl resolution failure after install**. The impl ID in the
  blueprint may fail to resolve in a new environment (session
  loaded into a different env version; federation to a node
  without the impl). The install block becomes applicable but
  holderless. *Mitigation*: surface as a distinct gap state —
  "installed, holder unresolved"; admission and elections
  behave accordingly. Requires follow-up requirement not
  covered by Artifacts 2 or 3.

- **Distribution reset on impl version change**. When
  `blueprint.version` changes alongside a semantically different
  impl, the accumulated posterior under v1 may be misleading for
  v2. *Mitigation*: `posteriorPolicy` declares behavior:
  `carry`, `decay`, or `reset`. Default `decay`. Lands in
  Phase 5.

- **Uninstall leaving orphan posteriors**. After uninstall, the
  posterior state persists at `_commitments.*.distribution.*`
  under the invalidated path. *Mitigation*: this is a feature
  (historical audit), not a bug. Dedicated readers surface them
  as archived; they do not gate new installs.

- **Quadruple as Procrustean bed for genuinely exotic
  capabilities**. Some capabilities may not fit cleanly — e.g. a
  capability whose impl is the substrate itself (meta-install).
  *Mitigation*: the quadruple admits this: `impl` can be
  `implId('substrate')` resolving to the substrate's own mount
  operation; `contract` and `distribution` still apply. Test
  this at migration time; flag exceptions as requiring
  kernel-level specialisation rather than quadruple bypass.

- **Reject-incomplete law in legacy code migration**. Phase 2's
  admission law will reject pre-migration `cap` mounts that lack
  the quadruple. *Mitigation*: migration order matters — install
  the law AFTER the call-site migration, not before. Tests
  during migration must run with the law disabled; enable it as
  the final step once all call sites are converted.

## Relationship to other architectural commitments

- **COMMITMENTS.md (landed)** — this document's `impl` field
  names the holder candidate; invocations of installed
  capabilities elect commitments with that holder. The install
  IS the registration of a holder candidate for a typed slot.
  Dependency: H3.

- **LEARNING_AS_COMPRESSION.md (landed via this document's
  dependency chain)** — this document's `distribution` field IS
  the conditional posterior surface. Installation mounts the
  initial priors and refinement policy; fulfillment cascade
  terminals update them. Dependency: H1, H2, H4, H5, H8.

- **AXIOMS A4 / A5 (landed)** — constraints and types are
  serializable data. The blueprint is data; impls are resolved
  at install time from the environment. This preserves the
  sequence's "no live functions in the log" invariant.
  Dependency: H7.

- **AXIOMS A6 / A12 (landed)** — mount is the single operation;
  mount takes a block; blocks are atomic. The quadruple mounts
  as one block. Dependency: H6.

- **AXIOMS A3' / A7 (landed)** — where-clauses suspend blocks
  whose preconditions aren't met. Prerequisites are where-clauses
  on the install block; missing secrets or unresolved impls
  suspend the install until they concretize. Dependency: R-A2.4.

- **env-installs.md / class-installs.md / skill-installs.md
  (extending)** — the blueprint shape documented across these
  requirements converges on the quadruple. This document names
  the convergence; Artifact 3 extends each requirement spec
  explicitly.

- **Narrative-is-tool unification (landed)** — a narrative is a
  type with gaps; a capability is a type with an impl. Installing
  a capability is filling certain gaps in the narrative of
  "substrate ability" with a holder. The quadruple makes the
  narrative explicit.

## Reading order for someone arriving at the substrate

1. **AXIOMS.md** — the load-bearing invariants.
2. **ARCHITECTURE.md** — how the pieces fit.
3. **COMMITMENTS.md** — what the substrate does on the write
   side.
4. **LEARNING_AS_COMPRESSION.md** — what the substrate does on
   the observational side.
5. **This document** — what the substrate does on the install
   side, AND the requirements for Artifacts 2 and 3.
6. **KERNEL_REQUIREMENTS.md** — the contract the kernel
   implements.
7. **DSL_REQUIREMENTS.md** — how it surfaces in ft text.

Three documents, three terminal projections of one cascade:
election of new write-leases (COMMITMENTS.md), compression of the
observations that fulfilled the old ones (LEARNING_AS_COMPRESSION.md),
and acquisition of the capabilities that produce both (this
document). One substrate, one log, one loop — three entry points
into the same machine.

---

## Appendix: quick index for the refactor agent

**If you're implementing Artifact 2**, your checklist is:
R-A2.1, R-A2.2, R-A2.3, R-A2.4, R-A2.5, R-A2.6, R-A2.7, R-A2.8
(all required; defaults and escape valves are explicit).
Acceptance: AC-A2.1 through AC-A2.7 (seven tests minimum).

**If you're implementing Artifact 3**, your checklist is:
R-A3.1, R-A3.2, R-A3.3, R-A3.4, R-A3.5, R-A3.6 (all required).
Acceptance: AC-A3.1 through AC-A3.5 (five acceptance criteria).
Two preservation invariants: Original Notes unchanged (R-A3.4)
and the existing AC2 capability-set-appearance claim retained
(R-A3.5).

**If you find yourself wanting to skip a requirement**, trace
it to its hypothesis (H1–H8, listed with each requirement in
brackets). Argue the hypothesis, not the requirement. If the
hypothesis holds, the requirement is load-bearing for the
three-document architectural set and cannot be skipped without
invalidating downstream work.

**If you find yourself wanting to add a requirement**, check
that it derives from a hypothesis H1–H8. If not, either propose
a new hypothesis with rationale and invalidation conditions, or
your candidate requirement is likely out of scope for this
document.
