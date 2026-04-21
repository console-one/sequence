# JSON Patch Converter

Patches are how the system describes changes to typed state without transmitting the full state. A patch is minimal: it carries the delta, not the whole. It references the prior state by version, targets a specific path, and applies changes in one of two modes -- overlay (merge into existing) or replace (swap out the subtree). Patches can reference the previous value at a path, support range operations, and distinguish between persistent and transient values.

The hard part: patches must be simultaneously minimal, precise, and expressive, while working universally across any typed structure. And they must cleanly separate what persists from what is ephemeral.

## Problem Context

- **Actor(s)**: Processes that produce state changes; consumers that need to apply or inspect deltas; routing infrastructure that dispatches patches by path.
- **Domain**: Incremental state synchronization -- representing and applying minimal, atomic changes to typed hierarchical data structures.
- **Core Tension**: Patches must be small (proportional to the change, not the structure), precise (unambiguous about what changed and how), atomic (all-or-nothing application), and universal (work across any typed structure). Supporting both merge semantics (overlay) and full replacement semantics, previous-value references, and transient intermediate values adds significant complexity to what appears to be a simple concept.

## Requirements

**R1**: A patch SHALL reference the prior state it applies to, by version identifier (content hash or sequence number), NOT by including the full prior state.
- *Rationale*: Patches must be proportional to the size of the change, not the size of the structure. A one-field change in a 1000-field structure must produce a patch with one entry plus metadata, not a full copy.
- *Verifiable by*: A patch changing one field in a 1000-field structure contains only that field's change and a version reference, not a copy of all 1000 fields.

**R2**: A patch SHALL specify one of two modes: **overlay** (merge changes into existing state, preserving unmentioned fields) or **replace** (delete everything at the target path and substitute the patch contents as the entire new value).
- *Rationale*: "Edit a field" and "reset a section" are fundamentally different operations. Overlay is additive; replace is destructive. Conflating them leads to data loss.
- *Verifiable by*: Given state `{a: 1, b: 2, c: 3}`, an overlay patch `{b: 20}` produces `{a: 1, b: 20, c: 3}`, while a replace patch `{b: 20}` produces `{b: 20}`.

**R3**: The patch mode SHALL be explicitly declared per patch. There SHALL be no implicit default mode.
- *Rationale*: An implicit default creates ambiguity -- did the producer intend overlay or replace? Forcing explicit declaration prevents accidental data loss.
- *Verifiable by*: Constructing a patch without specifying a mode is rejected as invalid.

**R4**: Patch values MAY reference the previous value at the target path using a `prev` keyword. Arithmetic and transformations on previous values (e.g., `prev.count + 1`) SHALL be computed during patch application.
- *Rationale*: Incremental updates ("add 1 to the counter") should not require the producer to know the current absolute value. The patch carries the expression, not the precomputed result.
- *Verifiable by*: Given state `{count: 5}`, a patch with change `{count: prev.count + 1}` produces `{count: 6}`.

**R5**: References to previous values that do not exist (the field was absent) SHALL produce an error, NOT silently resolve to null or zero.
- *Rationale*: Silent null coercion hides bugs. If a patch references `prev.count` and `count` was never set, this is an error that must be surfaced.
- *Verifiable by*: A patch referencing `prev.nonexistent` on a structure where `nonexistent` has no value produces a typed error.

**R6**: A single patch SHALL support modifying values at multiple paths simultaneously, and all changes SHALL apply atomically.
- *Rationale*: Many real-world changes are multi-field (e.g., update a user's name and email together). Partial application -- where the name updates but the email does not -- creates inconsistent state.
- *Verifiable by*: A patch modifying fields A and B is applied. An observer sees either {old A, old B} or {new A, new B}, never {new A, old B}.

**R7**: If any individual change within a multi-path patch fails (type mismatch, invalid path, prev-ref error), the entire patch SHALL fail with no changes applied.
- *Rationale*: Atomicity requires all-or-nothing. A patch that partially applies leaves the structure in a state the producer never intended.
- *Verifiable by*: A patch with changes `{a: 10, b: "invalid_for_number_field"}` fails entirely -- neither `a` nor `b` is modified.

**R8**: Patches SHALL distinguish between persistent values (become part of durable state) and transient values (exist only during patch application as intermediate computations).
- *Rationale*: Intermediate values (e.g., `temp = prev.value * 2`) are useful for computing final results but should not pollute the durable state.
- *Verifiable by*: A patch declares `temp` as transient and `result = temp + 1` as persistent. After application, `result` exists in the final state but `temp` does not.

**R9**: Patches SHALL support range-based deletions and modifications that target all keys within a lexicographic range.
- *Rationale*: Bulk changes ("delete all keys from b to d") should not require enumerating every key individually. Range operations enable efficient bulk mutations.
- *Verifiable by*: Given state `{a:1, b:2, c:3, d:4, e:5}`, a range deletion from "b" to "d" (inclusive) produces `{a:1, e:5}`.

**R10**: Every patch SHALL declare its minimal path prefix -- the deepest common ancestor of all its changes. This prefix SHALL be computed automatically, never broader than necessary.
- *Rationale*: Efficient routing requires knowing a patch's scope without inspecting its contents. A process watching `a.x` can skip a patch with prefix `a.b` entirely.
- *Verifiable by*: A patch affecting `a.b.c` and `a.b.d` has minimal path prefix `a.b`. A process watching `a.x` can determine from the prefix alone that this patch is irrelevant.

## Acceptance Criteria

**AC1** [R1]: Given a 1000-field structure, when one field changes, then the patch contains one change entry plus a version reference, totaling far less than the full structure.

**AC2** [R2]: Given state `{a: 1, b: 2, c: 3}` at version "v1", when an overlay patch `{b: 20}` is applied, then the result is `{a: 1, b: 20, c: 3}`.

**AC3** [R2]: Given state `{a: 1, b: 2, c: 3}` at version "v1", when a replace patch `{b: 20}` is applied, then the result is `{b: 20}`.

**AC4** [R4, R5]: Given state `{count: 5}`, when a patch with `{count: prev.count + 1}` is applied, then the result is `{count: 6}`.

**AC5** [R5]: Given state `{a: 1}` (no field `count`), when a patch references `prev.count`, then the patch fails with an error indicating the field does not exist.

**AC6** [R6, R7]: Given a patch modifying `{name: "Bob", email: "bad_type_for_number"}` where `email` is typed as `number`, when the patch is applied, then neither `name` nor `email` is modified.

**AC7** [R8]: Given a patch with transient `temp = prev.x * 2` and persistent `result = temp + 1`, when applied to state `{x: 5}`, then the result contains `{x: 5, result: 11}` and no `temp` field.

**AC8** [R9]: Given state `{a:1, b:2, c:3, d:4, e:5}`, when a range deletion from "b" to "d" (inclusive) is applied, then the result is `{a:1, e:5}`.

**AC9** [R10]: Given a patch affecting `a.b.c` and `a.b.d`, when the minimal path prefix is computed, then it is `a.b`.

## Open Questions

1. **Conflict resolution**: When two patches target the same path with different values, which wins? Is it last-writer-wins, or is there a conflict resolution protocol?
2. **Version validation**: If a patch references `prev: "v3"` but the current state is at v5, should the patch be rejected (stale), rebased, or applied with a warning?
3. **Range boundary semantics**: Are range boundaries always inclusive? Should exclusive boundaries be supported (e.g., delete keys from "b" up to but not including "d")?
4. **Nested prev references**: Can a prev reference reach into nested structures (e.g., `prev.address.city`)? If so, what happens when intermediate levels are absent?
