# Document History Compaction

## Original Notes

A document accumulates edits over its lifetime -- an append-only log that grows without bound. Compaction collapses old edits into a snapshot, reclaiming space while preserving the current projection exactly. The hard part: suspended operations (pending work that may resume at any time) must survive compaction, and the snapshot at the cutoff boundary must be a valid reconstruction for historical queries.

There are no destructive mutations. Compaction is a structural transformation of the log -- it replaces a range of entries with a single snapshot entry per path, leaving everything after the cutoff untouched.

## Problem Context

- **Actor(s)**: System (automated compaction), administrators (triggering compaction), readers (querying historical state).
- **Domain**: Long-lived document editing with append-only history, where unbounded log growth must be managed without losing correctness.
- **Core Tension**: Reclaiming storage from old edits without breaking suspended operations, schema enforcement, or the guarantee that the current document state is unchanged after compaction.

## Requirements

**R1**: The system SHALL collapse all log entries before a given cutoff position into a single snapshot entry per path, containing the last value written to that path before the cutoff.
- *Rationale*: Unbounded log growth is unsustainable; compaction recovers space by summarizing old history.
- *Verifiable by*: After compaction, the number of entries before the cutoff equals the number of distinct paths (one snapshot each).

**R2**: The document's current state (the value at every path) SHALL be identical before and after compaction.
- *Rationale*: Compaction is an internal optimization; it must be invisible to readers of current state.
- *Verifiable by*: Reading every path before and after compaction produces identical values.

**R3**: Schema declarations SHALL survive compaction regardless of their position relative to the cutoff.
- *Rationale*: Schemas constrain future writes; losing them would silently remove structural enforcement.
- *Verifiable by*: A schema declared before the cutoff still rejects invalid writes after compaction.

**R4**: Suspended operations SHALL survive compaction regardless of their position relative to the cutoff.
- *Rationale*: Suspended operations represent pending work that may resume; discarding them loses user intent.
- *Verifiable by*: A suspended operation created before the cutoff is still listed as pending after compaction.

**R5**: When a suspended operation resumes after compaction, its resumed entry SHALL appear at the current log position, not the original position.
- *Rationale*: Resumed work is new activity in the post-compaction log; backdating it would corrupt ordering.
- *Verifiable by*: The resumed entry's position is greater than the cutoff.

**R6**: Historical queries for positions after the cutoff SHALL return the exact value at the queried position.
- *Rationale*: Post-cutoff history is uncompacted and retains full fidelity.
- *Verifiable by*: Querying a position after the cutoff returns the same value as querying it before compaction occurred.

**R7**: Historical queries for positions before the cutoff SHALL return the snapshot value (last value before cutoff).
- *Rationale*: Fine-grained per-position history before the cutoff is traded for space; this degradation is deterministic.
- *Verifiable by*: All pre-cutoff queries for the same path return the snapshot value.

**R8**: The system SHALL report the count of removed entries and the count of kept entries after compaction.
- *Rationale*: Observability of compaction outcomes supports monitoring and debugging.
- *Verifiable by*: The removed count plus the kept count equals the original total entry count.

## Acceptance Criteria

**AC1** [R1, R2]: Given a document with 100 edits, when compaction runs at a cutoff position, then the current value of every path is unchanged and the pre-cutoff entries are replaced by one snapshot per path.

**AC2** [R6, R7]: Given a compacted document, when a historical query targets a position after the cutoff, then the exact value is returned; when it targets a position before the cutoff, then the snapshot value is returned.

**AC3** [R3]: Given a schema declared at position 2, when compaction runs at cutoff 90, then writes violating that schema are still rejected.

**AC4** [R4, R5]: Given a suspended operation at position 20, when compaction runs at cutoff 90, then the operation is still listed as pending; when it later resumes, its new entry appears at the current position (beyond 90).

**AC5** [R8]: Given compaction of a document, when it completes, then the system reports removed and kept counts that sum to the original entry total.

## Open Questions

- What policies govern automatic cutoff selection (e.g., age-based, size-based, manual trigger)?
- Should the system support configurable retention of pre-cutoff per-position history for specific paths?
