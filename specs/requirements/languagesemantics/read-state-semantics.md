# Read State Semantics

## Problem Context

- **Actor(s)**: Consumers of kernel state (readers, internal constraint evaluators, host environment code).
- **Domain**: Querying and inspecting a typed, append-only state store that supports live references, historical access, and schema introspection.
- **Core Tension**: The state store is append-only internally, but consumers need a simple "current value at path" model. References, schema inheritance, and historical access add complexity that must be transparent to basic consumers but available to advanced ones.

## Requirements

**R1**: A direct read of a path SHALL return the current value at that path, or a distinguished "absent" result if no value exists.
- *Rationale*: This is the fundamental read operation. Absence must be distinguishable from an explicit null value.
- *Verifiable by*: Reading a path with a value returns that value; reading a nonexistent path returns the absent sentinel, not null.

**R2**: If a path has a reference binding to another path, a direct read SHALL transparently follow the reference and return the target's current value.
- *Rationale*: Consumers should not need to know about indirection. References are a schema concern, not a consumer concern.
- *Verifiable by*: Reading a path that references another path returns the referenced path's value, not the reference itself.

**R3**: Circular reference chains SHALL be detected and SHALL return the absent result rather than causing infinite loops.
- *Rationale*: User-authored schemas may accidentally create cycles. The system must be safe.
- *Verifiable by*: A path referencing a second path that references back to the first returns absent without hanging.

**R4**: A live reference binding SHALL track its source -- when the source value changes, subsequent reads of the reference-bearing path SHALL reflect the updated value.
- *Rationale*: Live references are the mechanism for derived/computed views of shared state.
- *Verifiable by*: After changing the source value, reading the reference-bearing path returns the new value.

**R5**: Inside a state transition, the keyword for "previous value" SHALL return the path's value as it was before the current write operation.
- *Rationale*: Self-referential updates (counters, decrements, deltas) require access to prior state within the same write.
- *Verifiable by*: A write that sets a value to "previous + 1" produces a value one greater than what was there before the write.

**R6**: Schema inspection at a path SHALL return the effective schema, including constraints inherited from ancestor paths.
- *Rationale*: Understanding why a write was accepted or rejected requires seeing the full constraint picture, not just the local declaration.
- *Verifiable by*: A child path whose parent declares a numeric constraint returns that constraint in its effective schema.

**R7**: A raw schema inspection SHALL return only the schema declared directly at the path, excluding inherited constraints.
- *Rationale*: Diagnosing constraint conflicts requires distinguishing local declarations from inherited ones.
- *Verifiable by*: A child path with no local schema declaration returns nothing for raw inspection, even though effective inspection returns the parent's constraint.

**R8**: Enumerating children at a path SHALL return keys from both values and schemas, enabling discovery of paths that are declared but unfilled.
- *Rationale*: Gap discovery depends on knowing that a schema exists at a path even if no value has been written there.
- *Verifiable by*: A path with three children, one of which has only a schema and no value, returns all three keys.

**R9**: A historical read at a specific sequence number SHALL return the value that was at that path at that point in the log.
- *Rationale*: Auditing, debugging, and replay require access to past states, not just the current state.
- *Verifiable by*: After three writes producing values 10, 25, 42, reading at sequence 0 returns 10 and reading at sequence 1 returns 25.

**R10**: Historical reads SHALL respect invalidation -- if a value at a given sequence was later invalidated, the historical read SHALL return absent for that sequence.
- *Rationale*: Invalidated values should not be visible at any point in time.
- *Verifiable by*: A value written at sequence 1 that was subsequently invalidated returns absent for a historical read at sequence 1.

**R11**: After history compaction, historical reads for compacted sequences SHALL return the compacted snapshot value.
- *Rationale*: Compaction collapses history but preserves the last surviving value per path. Historical reads should still return something meaningful.
- *Verifiable by*: After compaction of sequences 0-99, a historical read at sequence 50 returns the snapshot value.

**R12**: The system SHALL provide a prioritized list of missing values -- paths where a schema exists but no value satisfies it.
- *Rationale*: Missing values are the primary driver of action. Prioritization tells the reader what is most important to resolve next.
- *Verifiable by*: A path with a schema but no value appears in the missing values list, ordered by resolution impact.

## Acceptance Criteria

**AC1** [R1]: Given a path "name" with value "Alice", when read, then the result is "Alice". Given a nonexistent path, when read, then the result is absent (not null).

**AC2** [R2]: Given path "mirror" referencing path "source" where source = "hello", when "mirror" is read, then the result is "hello".

**AC3** [R3]: Given path A referencing path B and path B referencing path A, when either is read, then the result is absent and no infinite loop occurs.

**AC4** [R4]: Given path "mirror" referencing "source", when source changes from "v1" to "v2", then reading "mirror" returns "v2".

**AC5** [R5]: Given a counter at value 5, when a write sets it to "previous + 1", then the resulting value is 6.

**AC6** [R6]: Given a parent path declaring a numeric constraint ">= 0" on a child, when inspecting the child's effective schema, then ">= 0" is included.

**AC7** [R7]: Given the same parent-child setup, when inspecting the child's raw schema, then ">= 0" is not included (it is inherited, not local).

**AC8** [R8]: Given path "tasks" with children "t1" (has value), "t2" (has value), "t3" (has schema only), when enumerating keys of "tasks", then all three keys are returned.

**AC9** [R9]: Given values 10, 25, 42 written at sequences 0, 1, 2, when reading at sequence 0, then 10 is returned.

**AC10** [R10]: Given a value written at sequence 1 that was later invalidated, when reading at sequence 1, then absent is returned.

**AC11** [R11]: Given compaction of sequences 0-99, when reading at sequence 50, then the compacted snapshot value is returned.

**AC12** [R12]: Given a path with a declared schema and no value, when the missing values list is queried, then that path appears in the list with its type and priority.
