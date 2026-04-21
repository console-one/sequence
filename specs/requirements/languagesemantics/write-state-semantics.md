# Write State Semantics

## Problem Context

- **Actor(s)**: Authors (humans, LLMs, or programmatic agents writing state), the kernel (validating and applying writes).
- **Domain**: A typed state store where writes must be validated against schemas, support both replacement and refinement, and enable conditional and self-referential updates.
- **Core Tension**: Two distinct write intentions -- "replace what is here" and "add more information to what is here" -- must coexist. Additionally, writes need conditional activation (deferred until preconditions hold), conditional lifetime (invalidated when postconditions break), provenance tracking, and self-referential access to prior state, all without hidden side effects.

## Requirements

**R1**: An overwrite operation SHALL replace the value at a path entirely, discarding the previous value.
- *Rationale*: Full replacement is needed when the new state is independent of the old.
- *Verifiable by*: After overwriting "Alice" with "Bob", reading the path returns "Bob" with no trace of "Alice" in the current state.

**R2**: An overwrite of a value that does not satisfy the path's declared schema SHALL NOT be applied -- it SHALL be deferred until it can satisfy the schema.
- *Rationale*: Silent acceptance of invalid data would undermine the type system. Silent rejection would lose data. Deferral preserves both safety and the write.
- *Verifiable by*: Writing a negative number to a path constrained to ">= 0" results in a deferred write, not an applied value.

**R3**: A narrowing operation SHALL merge the new value/type with the existing value/type at the path, producing the intersection of both constraint sets.
- *Rationale*: Incremental refinement is the core workflow for building up typed state. Narrowing adds information without discarding existing constraints.
- *Verifiable by*: Narrowing a typed record with a new field value results in the record having both its original constraints and the new value.

**R4**: A narrowing operation that produces a contradiction (the intersection is empty) SHALL be rejected.
- *Rationale*: Contradictory narrowing means the new claim is incompatible with existing state. Applying it would produce an unsatisfiable type.
- *Verifiable by*: Narrowing a string value "active" with "inactive" is rejected, not applied.

**R5**: A delete operation SHALL remove the value at a path while preserving the schema, causing the path to become an unfulfilled requirement.
- *Rationale*: Retraction removes a claim without destroying the structural contract. The schema remains so the system knows what is expected there.
- *Verifiable by*: After deleting a value, the path has no value but its schema still exists and it appears in the pending items list.

**R6**: A conditional-entry guard SHALL defer a write until a specified condition on existing state becomes true.
- *Rationale*: Many real-world state transitions are contingent on preconditions (permissions, predecessor completion, data availability).
- *Verifiable by*: A write guarded on "role = admin" is deferred while role is "viewer"; when role changes to "admin", the write applies automatically.

**R7**: Multiple conditional-entry guards on a single write SHALL be conjunctive -- all conditions MUST be true for the write to apply.
- *Rationale*: Complex preconditions require combining multiple independent conditions.
- *Verifiable by*: A write with two guards applies only when both conditions are true, not when only one is.

**R8**: Conditional-entry guards SHALL support existence checks, equality, inequality, numeric comparisons, and pattern matching.
- *Rationale*: Different domains require different kinds of preconditions.
- *Verifiable by*: Each comparison type (EXISTS, =, !=, <, <=, >, >=, MATCHES) correctly gates a write.

**R9**: A conditional-lifetime guard SHALL keep a value valid only while a specified condition holds. When the condition becomes false, the value SHALL be invalidated and the path SHALL revert to an unfulfilled requirement.
- *Rationale*: Some state is inherently tied to an external condition (session active, resource alive, time window open).
- *Verifiable by*: A value guarded on "session = active" is invalidated when session changes to "inactive", and the path appears as an unfulfilled requirement.

**R10**: When a conditional-lifetime guard breaks, the system SHALL emit an explicit signal (not silently remove the value).
- *Rationale*: Silent invalidation makes it hard to reason about what happened. An explicit signal enables downstream reactions.
- *Verifiable by*: When a lifetime guard breaks, a designated event path is set, observable by subsequent reads.

**R11**: A provenance marker SHALL record the author of a write as metadata on the write, without affecting the value itself.
- *Rationale*: Audit trails require knowing who wrote what, but provenance should not alter the data.
- *Verifiable by*: A write with provenance "admin" stores the value identically to a write without provenance, but the author metadata is retrievable.

**R12**: A self-referential keyword SHALL provide access to the path's value before the current write, enabling updates that depend on prior state.
- *Rationale*: Counters, decrements, and derived updates all require reading the old value within the same write expression.
- *Verifiable by*: A write that sets "counter = previous + 1" when counter is 5 results in counter being 6.

**R13**: Self-referential access SHALL work across fields in a structured object within a single write.
- *Rationale*: A single atomic update to multiple fields (e.g., decrement count and decrement budget) must read the pre-write snapshot for all fields.
- *Verifiable by*: A write that decrements both count and budget in one operation reads the pre-write values for both, not the partially-updated state.

**R14**: Every state-dependent update SHALL use explicit self-referential access. There SHALL be no implicit transition policies or hidden state-machine rules.
- *Rationale*: Explicit updates are auditable and debuggable. Hidden transition logic is a source of surprising behavior.
- *Verifiable by*: The system has no configuration for implicit state transitions; all prior-state-dependent logic is visible at the write site.

## Acceptance Criteria

**AC1** [R1]: Given path "name" = "Alice", when overwritten with "Bob", then reading "name" returns "Bob".

**AC2** [R2]: Given path "score" constrained to ">= 0", when -5 is written, then the write is deferred and reading "score" returns the previous value.

**AC3** [R3]: Given a typed record with field "heartbeat", when narrowed with a concrete heartbeat value, then the record has both the original schema constraints and the concrete value.

**AC4** [R4]: Given a path with value "active", when narrowed with "inactive", then the operation is rejected.

**AC5** [R5]: Given path "session" with a value and schema, when deleted, then the value is absent, the schema remains, and the path appears as an unfulfilled requirement.

**AC6** [R6]: Given a write guarded on "role = admin" and role = "viewer", when role changes to "admin", then the deferred write applies automatically.

**AC7** [R7]: Given a write with two guards, when only one condition is true, then the write remains deferred.

**AC8** [R8]: Given a write guarded on "count > 5", when count is 3, then the write is deferred; when count becomes 6, then it applies.

**AC9** [R9]: Given a value with a lifetime guard on "session = active", when session changes to "inactive", then the value is invalidated and the path becomes an unfulfilled requirement.

**AC10** [R10]: Given a lifetime guard break, when the value is invalidated, then a signal is emitted at a designated event path.

**AC11** [R11]: Given a write with provenance "admin", when the value is read, then it matches a write without provenance; when provenance metadata is inspected, then "admin" is returned.

**AC12** [R12]: Given counter = 5, when a write sets counter to "previous + 1", then counter becomes 6.

**AC13** [R13]: Given an object with count = 10 and budget = 100, when a single write decrements both by 1 using self-reference, then count = 9 and budget = 99 (both read from the pre-write snapshot).

**AC14** [R14]: Given the system's configuration surface, when inspected, then there are no implicit state-transition rules; all state-dependent updates require explicit self-referential writes.
