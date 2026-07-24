# Console One Process Kernel Requirements

## Status

Normative. This document is the implementation source of truth for the process kernel.

The purpose of this artifact is to prevent repeated reintroduction of bad secondary abstractions. Any implementation that contradicts this document is wrong, even if it is elegant, extensive, or partially working.

---

# 1. Objective

Implement a single **Process** kernel that can serve as the local reduction engine for:

* agent orchestration
* workspace evolution
* query fulfillment
* scheduling
* conflict minimization
* grammar / parser-like reduction
* UI / terminal / prompt state evolution
* compaction and history retention

The kernel must be sufficiently general that new product surfaces can be defined by adding statement forms, refs, rules, and runtime callables, rather than by inventing new orchestration architectures.

The primary artifact is **requirements**, not code.

---

# 2. Core Thesis

The system is not fundamentally:

* a patch framework
* a graph database
* a version-control wrapper
* a workflow engine
* a parser generator
* an agent framework
* a scheduler with plugins

The system is fundamentally:

> an append-only statement sequence whose reduction is governed by refs over the product of sequence and path space, executed by a local process that resolves, suspends, resumes, and compacts continuation state.

State is a projection.
History is a sequence.
Semantics are statements in that sequence.
Ambiguity is unresolved reference structure in that sequence.
The process is the reducer of that sequence.

---

# 3. Anti-Goals

The implementation must NOT drift into any of the following:

1. A separate parallel "chain system" and "field type system".
2. A separate "patch IR" ontology that competes with statements.
3. A graph framework whose topology becomes more important than the reduction semantics.
4. An abstraction forest of peer interfaces.
5. An implementation that treats snapshots, patches, or merges as more fundamental than statements.
6. A runtime where callable implementations are serialized into state.
7. A model where semantics live authoritatively in materialized state.
8. A design where `where` is a mandatory primitive rather than a derivable statement form.
9. A model where path-only refs or sequence-only refs are considered sufficient.
10. A solution that cannot explain backward inference / hole filling from later statements.

If any implementation introduces one of these, it has gone wrong.

---

# 4. Fundamental Ontology

## 4.1 Only externally meaningful primitives

The kernel shall expose only these primary conceptual objects:

* **Process**
* **Statement sequence**
* **Ref**
* **Gap / hole**
* **Commit**
* **Projection**
* **Runtime callable registry**

Everything else is derivative or internal.

## 4.2 Statements are primary

A statement is the only durable proposal form.
A process evolves by appending statements and reducing them.

The system must not require a second first-class durable representation that competes with statements.

## 4.3 Sequence is primary

A workspace, log, merge queue, chat transcript, plan history, task history, and commit stream are all specializations of the same sequential structure.

The implementation must preserve this unification.

## 4.4 Path and sequence are orthogonal axes

Every nontrivial constraint in the system must be allowed to reference:

* a location in the namespace/path hierarchy
* a location in the sequence/history
* or both simultaneously

This is the irreducible product space of the kernel.

---

# 5. Ref Requirements

## 5.1 Product-space refs are mandatory

A ref source must be expressible over the product of:

* **sequence coordinate**
* **path coordinate**

The implementation must not reduce refs to path-only strings.

## 5.2 Sequence addressing

Refs must support at least:

* current
* absolute sequence position
* previous
* next
* last matching predicate
* first matching predicate
* rolling window / bounded neighborhood

## 5.3 Path addressing

Refs must support at least:

* self
* absolute path
* parent
* child
* sibling
* descendant by pattern

## 5.4 Filtering

Refs must support filtering by statement or value predicates, such as:

* statement op
* path
* role
* mounted semantic condition
* scalar field value
* relative ordering predicate

## 5.5 Backward inference

Refs must support inversion in principle.

Given later concrete statements and unresolved earlier holes, the implementation must be able to derive constraints on what earlier sequence/path locations must contain.

This is non-optional.

## 5.6 Refs are serializable

Refs must be pure data.
No executable function may be required to serialize or persist a ref.

---

# 6. Runtime Boundary

## 6.1 Only runtime callables live outside process reduction

The only thing that may live outside the process reduction model is the set of executable runtime callables loaded into the process.

These include examples like:

* JS functions
* browser hooks
* tool adapters
* LLM wrappers
* scheduler integrations
* terminal/session integrations

## 6.2 Callables are never serialized

Actual callable implementations must never appear in persisted state, sequence history, or refs.
Only callable identifiers and their required argument structures may be serialized.

## 6.3 Everything else is inside Process

The following must live conceptually inside Process, not as peer frameworks:

* sequence reduction
* ref resolution
* gap detection
* backward inference
* compaction
* frontier retention
* local scheduling / self-advance
* local conflict minimization
* state projection
* semantic projection

---

# 7. Process Kernel Requirements

## 7.1 Process responsibility

A Process is the unique local reducer for a bounded partition.

It must:

* hold a retained frontier of reduction-relevant sequence material
* accept appended statements
* resolve product-space refs locally where possible
* suspend unresolved continuations
* resume them when later information closes them
* emit further statements through runtime callables
* compact dead history while preserving recoverability
* project current state and active semantics

## 7.2 Process must be local first

The process is a local engine.
Distributed coordination is an extension built around it, not inside its irreducible semantics.

## 7.3 Process must support leases / authority windows

A process may hold authority over a partition for a bounded interval.
The kernel must support:

* holder identity
* epoch/version of authority
* expiry/heartbeat
* handoff

But this lock model must not distort the core sequence reduction semantics.

## 7.4 Process must support planning / future statements

A statement may be scheduled for a future effective time.
Planned statements are still statements, not a second command model.

## 7.5 Process must halt on local closure

Local reduction proceeds until no further statement is entailed in the currently retained bounding box / frontier.
At that point the process suspends and waits for new observation.

---

# 8. Frontier Requirements

## 8.1 Frontier is the current intermediate

The frontier is not a cache of intermediates.
The frontier is the current partially resolved reduction state.

## 8.2 Frontier contents

The frontier must retain only what is necessary to:

* decide likely next admissible continuations
* close currently unresolved refs/gaps
* preserve active semantic conditions
* support local resumption
* support exact or bounded-uncertainty reconstruction

## 8.3 Frontier movement

When new statements are appended, the frontier may:

* expand
* contract
* rotate toward newly supported continuations
* cool irrelevant regions
* detach dead regions
* rehydrate older sequence slices if needed

## 8.4 Frontier optimization

The frontier is not merely correctness structure.
It is also the retained predictive structure for likely next inputs.

The process may optimize which parts stay resident based on:

* likely next input distribution
* cost of rehydration
* conflict likelihood
* user usefulness
* neighbor/process alignment

But correctness of accepted reductions must remain invariant under retention policy.

---

# 9. Gap / Hole Requirements

## 9.1 Gap meaning

A gap is an unresolved location in the statement sequence where the process does not yet have enough information to make a statement concrete.

## 9.2 Gaps are not a parallel workflow system

Gaps are not tickets or tasks by default.
They are structural holes in reduction.
They may be rendered as actionable surfaces later.

## 9.3 Gaps may occur anywhere

The system must support holes at arbitrary sequence positions, not only at the head.

## 9.4 Gaps must be inferable from later material

If later statements constrain earlier holes, the process must be able to propagate constraints backward.

## 9.5 Gaps must be serializable

A gap must be representable as data such that:

* an LLM can be shown the gap
* a user can fill the gap
* another process can attempt closure
* compaction can preserve the unresolved structure

---

# 10. Reduction Requirements

## 10.1 Reduction is sequence-first

The process must reduce statements in sequence order, while allowing refs to inspect prior/later/path-relative material as permitted by the ref model.

## 10.2 Reduction result

Reduction of a statement may:

* materialize immediately
* remain suspended due to unresolved refs
* emit one or more additional statements
* schedule future statements
* invalidate or cool previously retained frontier material
* produce a commit boundary when a non-exceptional block closes

## 10.3 Reduction must be explainable

Every materialized result must be explainable as:

* which statement(s) closed
* which refs resolved
* which callable(s) ran
* which sequence/path coordinates were read

## 10.4 Runtime callable invocation

When a statement becomes sufficiently concrete, its callable may run.
Its outputs must be statements or scheduling decisions, not arbitrary hidden mutation.

## 10.5 Reduction must support suspension / resumption

If a statement cannot fully reduce now, it remains in the sequence/frontier as suspended rather than being discarded.
Later statements may resume it.

---

# 11. State and Semantics Projections

## 11.1 State is projection only

Current state is not authoritative mutable truth.
It is a projection over materialized statements.

## 11.2 Semantics are projection only

Mounted semantics are not authoritative mutable truth in materialized state.
They are a projection over governing statements.

## 11.3 Separate projections

At minimum the process must support:

* value/state projection
* semantic/governing projection
* sequence/history projection
* gap/frontier projection

These projections may be cached, but caches are not authority.

---

# 12. Push / Patch / Where

## 12.1 Push and patch are not primitive ontology

Push and patch are not the deepest kernel primitives.
They are interpretations of statement forms.

## 12.2 Where is optional / derivable

`where` is not required as a primitive if queue/statement forms can express conditional continuation directly.

Any implementation may compile `where` into ordinary statements / refs / reduction clauses.

## 12.3 Acceptable statement surface

The kernel should tolerate a high-level user/program surface that later compiles to statements, including forms equivalent to:

* push
* patch
* where
* await
* when
* before/after
* OR / choice
* escape-token references such as `<$ ref |`

But none of these should be allowed to fracture the kernel into multiple competing models.

---

# 13. Array / Sequence Requirements

## 13.1 The central sequential type

The only field type that matters centrally is the sequence/array type.

It must support:

* append-only semantics
* refs across positions
* reduction into projected state
* compaction by replacing old sequence sections with reduced summaries plus refs
* hole inference
* state-dependent acceptance of later statements

## 13.2 Sequence constraints must be expressible with refs

The implementation should prefer ref-based sequence constraints over a proliferation of special-purpose sequence operators.

Examples that must be expressible:

* previous element matching predicate
* next element matching predicate
* last element with value less than Q
* rolling window predicates
* first matching ancestor in sequence

## 13.3 Grammar equivalence

The sequence type must be powerful enough to model context-free grammar structure in principle, and useful portions of richer grammar/state transitions when constraints are carried in sequence state.

## 13.4 Type and state are interchangeable views

The implementation must treat type/state distinction as secondary where sequence reduction already carries the same information.

---

# 14. Compaction Requirements

## 14.1 Compaction is mandatory

The kernel must support replacing older statement regions with:

* reduced summaries
* refs to prior chain/storage
* retained gap metadata if unresolved structure still matters

## 14.2 Compaction criterion

Compaction is justified when older material is no longer required to decide admissibility of likely next continuations, except through a summary/ref.

## 14.3 Compaction is dead-code elimination analog

Compaction should be understood as eliminating dead or cooled sequence structure while preserving future reconstruction semantics.

## 14.4 Compaction must preserve backward inference where needed

If a region may still be needed to infer unresolved holes or active semantic conditions, compaction must preserve enough structure to do so.

---

# 15. Conflict Minimization and Optimization

## 15.1 Conflict meaning

Conflict is wasted work: work that violates constraints or later becomes invalid under resolution.

## 15.2 Optimization goal

The process optimizer must locally aim to:

* reduce conflict/waste
* remain causally aligned with neighbors
* preserve likely useful futures when rules allow
* self-advance via defaults or scheduling only when admissible

## 15.3 Predictive frontier

The frontier may maintain weighted expectations over likely next writes / holes / continuations.
This weighting may be used for retention and self-scheduling.

## 15.4 Optimization must not change semantics

Optimization changes retention, ordering, and speculation policy.
It must not alter which reductions are semantically valid.

---

# 16. Distributed Extension Boundary

## 16.1 Out of scope for kernel

The kernel requirements do not require:

* cryptographic peer-to-peer trust
* byzantine fault handling
* final global consensus protocol
* cross-cluster security policy

## 16.2 In scope for kernel

The kernel must be composable enough that distributed concerns can wrap it by:

* partition assignment
* lease/authority routing
* commit propagation
* snapshot and lineage exchange
* conflict mediation between partitions

---

# 17. Internal Code Model Requirements

## 17.1 Single-class bias

The implementation should strongly prefer one principal `Process` class or equivalently singular kernel module.

## 17.2 Low noun count

The implementation must avoid large exported interface forests.
Most structural objects should remain internal records, not independent public architecture.

## 17.3 Internal minimum fields

The implementation must maintain, at minimum:

* sequence / queue
* retained frontier metadata
* planned future statements
* runtime callable registry
* commit history
* projection caches (optional)

## 17.4 Internal minimum methods

The implementation must support operations equivalent to:

* append statement block
* resolve refs locally
* attempt backward inference
* resume suspended reductions
* invoke callable
* emit statements
* compact sequence region
* project state
* project semantics

---

# 18. Acceptance Criteria

An implementation satisfies this requirements document only if it can demonstrate all of the following:

## 18.1 Product-space ref resolution

The process can resolve a ref that simultaneously addresses:

* a prior sequence position
* and a path-relative location

Example class:

* value at previous commit for same path
* value at current commit for parent path
* value at prior matching statement for sibling path

## 18.2 Suspended hole closure

A statement with an unresolved hole may remain suspended, and later appended statements can close it without rewriting the whole system model.

## 18.3 Backward inference

A later concrete statement can constrain an earlier unresolved one using the same ref/reduction model.

## 18.4 Governing projection

Mounted semantics can be reconstructed from governing statements without treating current materialized state as authority.

## 18.5 Compaction with ref segment

A prefix of the sequence can be compacted into a reduced summary plus reference to earlier storage without breaking continued reduction.

## 18.6 Queue/sequence unification

At least two distinct domains can be modeled with the same kernel, e.g.:

* workspace command log
* chat/prompt history
* task merge queue
* UI event stream

## 18.7 Runtime boundary correctness

No callable implementation needs to be serialized to persist or reload the process state/history.

## 18.8 Statement-only continuity

The implementation can explain all externally visible behavior as arising from statement reduction, not from hidden second ontologies.

---

# 19. Implementation Guidance

## 19.1 Build order

The implementation should proceed in this order:

1. statement queue
2. product-space ref model
3. local ref resolution
4. suspended hole model
5. backward inference
6. runtime callable execution
7. projections
8. compaction
9. optimization / retention weighting
10. distributed wrapping

## 19.2 Do not build first

Do not start by building:

* distributed consensus
* graph UI models
* large type registries
* generic workflow DSLs
* patch IR frameworks
* actor systems

These should all wait until the kernel invariants are satisfied.

---

# 20. Derivation of Kernel Requirements

This section explains how the kernel requirements are derived, so future implementation work does not reintroduce accidental abstractions.

The purpose of this section is to answer:

* why these requirements exist
* why they are ordered this way
* what failure each one prevents
* how to tell whether a proposed new abstraction is fundamental or secondary

## 20.1 Derivation method

Every kernel requirement must be derived from the core invariant, not from implementation convenience.

The derivation method is:

1. Start from the invariant.
2. Ask what minimal machinery is logically forced by that invariant.
3. Ask what failure occurs if that machinery does not exist.
4. Define the smallest obligation that prevents that failure.
5. Define what that machinery must not become.

The invariant is:

> A Process is an append-only statement reducer whose refs range over the product of sequence and path space; current state and active semantics are projections of successfully reduced statements; unresolved structure remains suspended as holes until later statements or inference close it.

Everything below is derived from that sentence.

## 20.2 Statement queue

### Why it is required

If the kernel does not begin from one append-only statement sequence, the model splits into competing durable forms such as patches, commands, workflow objects, graph operations, or process instructions.

That split is exactly what has repeatedly caused implementation drift.

### What failure it prevents

Without the statement queue:

* history is not unified
* workspaces and logs become different ontologies
* compaction becomes ad hoc
* hole-filling loses a stable substrate
* reduction no longer has a single input form

### Minimal derived obligation

There must exist one durable append-only queue/sequence of statements.

### What it must not become

It must not become:

* one queue for commands and another for state
* a queue plus a separate authoritative patch store
* a graph runtime that demotes sequence to optional metadata

## 20.3 Product-space ref model

### Why it is required

Statements must be able to constrain each other across both:

* sequence/history
* path/namespace

All major failure modes came from flattening one axis and pretending the other was sufficient.

### What failure it prevents

Without product-space refs:

* carry and output cannot be represented in one model
* earlier holes cannot be constrained by later structure
* path-local logic and sequence-local logic fracture
* prompt/rendering/state semantics split into incompatible projections

### Minimal derived obligation

A ref must be able to address the product of sequence and path space.

### What it must not become

It must not become:

* path-only strings
* sequence-only indices
* executable callbacks instead of serializable refs

## 20.4 Local ref resolution

### Why it is required

Once refs exist, the process must attempt to close them locally before any higher-order escalation, scheduling, or distributed delegation occurs.

### What failure it prevents

Without local ref resolution:

* every unresolved relation becomes a workflow problem
* the process stops being a reducer
* the local kernel becomes dependent on external orchestration too early

### Minimal derived obligation

The process must attempt to resolve refs against its retained frontier and local projections.

### What it must not become

It must not become:

* a remote lookup framework first
* a UI concern
* an LLM-only inference path

## 20.5 Suspended hole model

### Why it is required

Not all refs will close immediately. The system must retain unresolved structure in-place rather than discard it.

### What failure it prevents

Without a suspended hole model:

* partial derivations are lost
* later information cannot resume earlier work
* gap filling becomes external bookkeeping rather than native semantics

### Minimal derived obligation

Statements with unresolved refs remain in the sequence/frontier as suspended hole-bearing structures.

### What it must not become

It must not become:

* a separate ticket/task system by default
* a side table disconnected from the statement substrate
* a UI-only concept

## 20.6 Backward inference

### Why it is required

Later concrete statements can constrain earlier unresolved holes. If the system cannot propagate information backward, the sequence cannot behave as a grammar-like typed continuation structure.

### What failure it prevents

Without backward inference:

* earlier missing segments cannot be inferred from later accepted material
* typed holes remain shallow placeholders rather than structural unknowns
* compaction and reconstruction lose semantic power

### Minimal derived obligation

The process must be able, in principle, to derive earlier constraints from later concrete statements through the same ref/reduction model.

### What it must not become

It must not become:

* a second theorem prover with separate rules from the kernel
* opaque function inversion only possible in handwritten code

## 20.7 Runtime callable execution

### Why it is required

A reduced/closed statement must be able to operationalize into further statements or effects.

### What failure it prevents

Without runtime callable execution:

* closed statements cannot move the system forward
* the kernel remains purely descriptive
* real integrations require hidden side systems

### Minimal derived obligation

Closed-enough statements may invoke registered runtime callables whose outputs are statements, schedules, gaps, or rejections.

### What it must not become

It must not become:

* serialized executable code in state/history
* a general plugin architecture that competes with process semantics

## 20.8 Projections

### Why it is required

If statements are authority, state and active semantics must be reconstructed as views.

### What failure it prevents

Without projections:

* materialized state becomes wrongly authoritative
* semantics drift from governing history
* replay, time slicing, and compaction become unsound

### Minimal derived obligation

The process must support projections for state, semantics, history, and frontier/gap structure.

### What it must not become

It must not become:

* mutable authority outside the statement sequence
* duplicated truth between cache and history

## 20.9 Compaction

### Why it is required

An append-only statement system must eventually compress cooled or dead regions while preserving future recoverability.

### What failure it prevents

Without compaction:

* retained history grows without control
* memory residency becomes impossible
* frontier management cannot converge

### Minimal derived obligation

The process must be able to replace older sequence regions with reduced summaries plus refs to prior material.

### What it must not become

It must not become:

* lossy deletion of still-semantically-active structure
* one-off ad hoc snapshotting outside the sequence model

## 20.10 Optimization / retention weighting

### Why it is required

Only part of the full reduction state can remain hot. The process must choose what to retain based on likely future usefulness and cost.

### What failure it prevents

Without optimization / retention weighting:

* memory usage is unbounded
* rehydration is blind
* predictive utility of the frontier is lost
* process-local self-optimization cannot emerge

### Minimal derived obligation

The process must support retention/cooling/rehydration policy over frontier regions without changing correctness.

### What it must not become

It must not become:

* a second semantic layer that changes admissibility
* a hidden non-replayable cache heuristic that alters outcomes

## 20.11 Distributed wrapping

### Why it is required

Multiple local reducers must compose across partitions, leases, and commit exchange.

### What failure it prevents

Without distributed wrapping:

* the kernel cannot scale beyond one local process
* conflict minimization remains purely local
* authority handoff and lineage exchange are undefined

### Minimal derived obligation

Distributed systems must be able to wrap the local process via partitioning, routing, commit exchange, and authority policies.

### What it must not become

It must not become:

* a reason to distort the kernel's local semantics
* a precondition for defining local reduction correctly

## 20.12 Dependency order

The kernel requirements must be derived and implemented in this order:

1. statement queue
2. product-space ref model
3. local ref resolution
4. suspended hole model
5. backward inference
6. runtime callable execution
7. projections
8. compaction
9. optimization / retention weighting
10. distributed wrapping

This ordering matters because each layer depends on the previous one's invariant.

## 20.13 Test for whether a new abstraction is fundamental

Any proposed new abstraction must answer all of the following:

1. Which kernel failure occurs without it?
2. Which already-derived layer is insufficient without it?
3. Can it be reduced to statements, refs, reduction, projection, compaction, or runtime boundary?
4. Is it durable authority, or only implementation convenience?
5. Can it be expressed as a compiled statement form instead?

If it cannot survive this test, it is secondary and must not become part of the kernel ontology.

## 20.14 Practical derivation rule

When extending the kernel, always derive requirements in this pattern:

* identify the invariant that must be preserved
* identify the smallest missing mechanism
* define the failure if absent
* define the minimum obligation
* define the anti-requirement preventing overgrowth
* add one acceptance example

This document should evolve by this method only.

# 21. Final Non-Negotiable Invariant

If forced to compress the entire kernel to one invariant, it is this:

> A Process is an append-only statement reducer whose refs range over the product of sequence and path space; current state and active semantics are projections of successfully reduced statements; unresolved structure remains suspended as holes until later statements or inference close it.

Any implementation that preserves this invariant may evolve.
Any implementation that loses it will loop forever.
