# Snapshotting

State is built up incrementally through many operations. Keeping the full history is necessary for auditing and replay, but expensive in memory. Snapshotting collapses resolved history into a single materialized state at a specified point -- reducing memory footprint and establishing recovery points. The snapshot must be observationally equivalent to the pre-compaction state: any read that returned a value before compaction returns the same value after.

Snapshotting is elective. The caller decides when and where to compact. The system never automatically discards history.

## Problem Context

- **Actor(s)**: The caller (decides when to snapshot), the storage system (maintains operation history and materialized state), downstream consumers (read current state and may need historical queries).
- **Domain**: State compaction and recovery in append-only or event-sourced systems where history grows without bound.
- **Core Tension**: Memory efficiency demands discarding old operations, but correctness demands that compaction never changes observable state. Additionally, pending operations (not yet resolved) must survive compaction even if they originated in the compacted range.

## Requirements

**R1**: The caller SHALL control the compaction boundary by specifying an operation index through which to compact.
- *Rationale*: Only the caller knows the appropriate retention window. Different processes may need different amounts of history. Automatic compaction risks discarding history that is still needed.
- *Verifiable by*: A caller specifies compaction through index 50; operations 0-49 are collapsed and operations 50+ remain individually accessible.

**R2**: The snapshot SHALL be observationally equivalent to the pre-compaction state: every read that returned a value before compaction SHALL return the same value after compaction.
- *Rationale*: Compaction is a storage optimization, not a semantic change. If reads return different values, the system has silently corrupted its state.
- *Verifiable by*: For every readable path, the value returned before compaction equals the value returned after compaction.

**R3**: For paths written multiple times in the compacted range, the snapshot SHALL preserve only the final effective value.
- *Rationale*: Intermediate values are not observable in the current state. Preserving them would defeat the purpose of compaction.
- *Verifiable by*: A path written 5 times with values [1, 2, 3, 4, 5] in the compacted range has only value 5 in the snapshot.

**R4**: Pending (suspended, unresolved) operations SHALL survive compaction, regardless of when they were created.
- *Rationale*: A pending operation represents work that is not yet complete. Discarding it would silently lose in-flight work.
- *Verifiable by*: A pending operation created during the compacted range is still retrievable and resolvable after compaction.

**R5**: Pending operations that reference values overwritten during compaction SHALL see the final (post-compaction) value, not intermediate values.
- *Rationale*: Consistency with observational equivalence. The snapshot represents the same state -- pending operations should see the same view as any other reader.
- *Verifiable by*: A pending operation referencing a path that was overwritten 3 times sees only the final value after compaction.

**R6**: The snapshot output SHALL be serializable for external persistence and recoverable by deserialization.
- *Rationale*: Snapshots serve as recovery points. If they cannot be persisted and restored, they only reduce live memory and do not protect against process crashes.
- *Verifiable by*: A snapshot serialized to an external store, then deserialized, produces the same materialized state as the original snapshot.

**R7**: Historical queries for operations that occurred before the compaction point SHALL require access to the archived snapshot, not the live state.
- *Rationale*: Compaction discards derivation history from live state. If detailed pre-compaction queries are needed, they must reference the persisted archive.
- *Verifiable by*: After compaction, attempting to query individual operations before the compaction point from live state fails; querying from the archived snapshot succeeds.

## Acceptance Criteria

**AC1** [R1]: Given 100 operations in history, when the caller compacts through index 50, then operations 0-49 are collapsed into the snapshot and operations 50-99 remain individually accessible.

**AC2** [R2]: Given paths A, B, C with values "x", "y", "z" before compaction, when compaction completes, then reading A, B, C returns "x", "y", "z" respectively.

**AC3** [R3]: Given a path written with values [10, 20, 30] in the compacted range, when the snapshot is inspected, then only value 30 is present for that path.

**AC4** [R4]: Given 3 pending operations created during the compacted range, when compaction completes, then all 3 pending operations are still retrievable.

**AC5** [R5]: Given a pending operation referencing a path overwritten from "old" to "new" during compaction, when the pending operation reads the path after compaction, then it sees "new".

**AC6** [R6]: Given a snapshot, when it is serialized to an external store and then deserialized, then the deserialized state is identical to the original snapshot's materialized state.

**AC7** [R7]: Given compaction through index 50, when a query for operation 25 is made against live state, then it fails; when made against the archived snapshot, then it succeeds.

## Open Questions

- **Incremental compaction**: Can compaction be performed incrementally (compact 0-25, then later 25-50), or must the full range be compacted in a single operation?
- **Compaction during active writes**: What happens if new operations are appended while compaction is in progress? Must compaction lock the system, or can it operate concurrently?
- **Snapshot chaining**: Can a new snapshot be created that references a previous snapshot rather than re-materializing the full state?
