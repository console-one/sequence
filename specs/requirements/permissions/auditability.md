# Auditability

Every state mutation produces an immutable record. The audit trail is not a separate system bolted onto the side -- it IS the primary data log. Records are append-only: once created, never modified. Invalidation of a record creates a new record referencing the original; the original persists unchanged. This gives auditors a complete, tamper-proof chain of events.

The tension is unbounded growth. A long-running system accumulates records forever. Compaction collapses old records into summary snapshots, but must preserve the projection invariant: all current values are identical before and after compaction. The recent audit window remains individually queryable.

## Problem Context

- **Actor(s)**: Auditors, system administrators, compliance processes, and consumers querying historical state.
- **Domain**: Audit logging and provenance tracking for systems that require tamper-proof mutation history.
- **Core Tension**: Complete, immutable audit history is required for trust and compliance, but unbounded record growth is unsustainable -- compaction must be possible without altering observable current state.

## Requirements

**R1**: Every state mutation SHALL produce an immutable, append-only audit record.
- *Rationale*: Tamper-proof history requires that no record is ever modified after creation.
- *Verifiable by*: After N mutations, exactly N records exist, each with monotonically increasing sequence numbers.

**R2**: Each audit record SHALL contain a monotonically increasing sequence number, a timestamp, the operation type, the affected path, and the value.
- *Rationale*: These fields are the minimum needed to reconstruct what happened, when, where, and what changed.
- *Verifiable by*: Every record can be inspected and contains all five fields with valid values.

**R3**: Timestamps SHALL be derived from an injectable clock, not directly from the system clock.
- *Rationale*: Deterministic testing requires controllable time; production uses wall-clock time.
- *Verifiable by*: Tests provide a mock clock and audit records reflect the mock's output.

**R4**: Invalidation of a record SHALL append a new record referencing the original -- the original record SHALL NOT be modified or deleted.
- *Rationale*: Even invalidation events must be auditable; mutating the original would break the immutability invariant.
- *Verifiable by*: After invalidation, both the original and the invalidation record are present in the log.

**R5**: The system SHALL support checkpoint-based queries ("all records since sequence N") and path-prefix filtering.
- *Rationale*: Consumers need efficient access to recent changes and scoped subsets of the log.
- *Verifiable by*: A query with `since=N` returns only records with sequence >= N; a prefix filter returns only records whose path matches.

**R6**: Invalidated records SHALL be excluded from active query results, while remaining present in the raw log.
- *Rationale*: Active consumers need current state, but auditors need the full history including invalidations.
- *Verifiable by*: An active query omits invalidated records; a raw log scan includes them.

**R7**: Compaction SHALL collapse records before a sequence boundary into a summary snapshot, while preserving the projection invariant: all current values are identical before and after compaction.
- *Rationale*: Storage optimization must not alter observable state.
- *Verifiable by*: Reading any path before and after compaction returns the same value.

**R8**: Records at or after the compaction boundary SHALL remain individually queryable.
- *Rationale*: The recent audit window must remain available for operational debugging and compliance.
- *Verifiable by*: After compaction at sequence N, records with sequence >= N are still individually retrievable.

## Acceptance Criteria

**AC1** [R1, R2]: Given three sequential mutations, when the audit log is read, then exactly three records exist with sequence numbers 0, 1, 2 and monotonically increasing timestamps.

**AC2** [R5]: Given records with sequences 0 through 4, when querying with `since=2`, then only records with sequence >= 2 are returned.

**AC3** [R4, R6]: Given record 1 is invalidated by record 3, when performing an active query, then record 1 is excluded; when scanning the raw log, then both records 1 and 3 are present.

**AC4** [R5]: Given records at paths `config.model`, `config.temperature`, and `output.draft`, when filtering by prefix `config.`, then only the two `config.*` records are returned.

**AC5** [R7, R8]: Given compaction at sequence 5, when reading any path, then values are identical to pre-compaction values; records 0-4 are collapsed into a summary; records 5+ remain individually queryable.

**AC6** [R3]: Given a mock clock that returns a fixed timestamp, when mutations occur, then all audit records carry the mock's timestamp.

## Open Questions

(None -- append-only semantics, injectable clock, invalidation-as-new-record, and projection-preserving compaction are fully resolved.)
