# Live Collaborative Editing

## Original Notes

Multiple writers contribute to the same document simultaneously. Each edit is recorded in a deterministic, append-only log with editor attribution. The hard problem is conflict detection: when a writer submits an edit based on stale state (an outdated version), the edit must be suspended -- not silently applied -- so the writer can see what changed and resubmit. No last-write-wins. No silent overwrites. Every conflict is surfaced.

There are no locks. There is optimistic concurrency: write freely, but the system catches you if your assumptions about current state are wrong.

## Problem Context

- **Actor(s)**: Multiple concurrent editors (submitting edits), readers (viewing document state and history), auditors (reviewing edit attribution).
- **Domain**: Collaborative document editing where multiple writers operate simultaneously with optimistic concurrency control.
- **Core Tension**: Concurrent edits must be detected and surfaced as conflicts (not silently resolved with last-write-wins), while maintaining a deterministic, auditable history of all changes with editor attribution.

## Requirements

**R1**: All edits to a document SHALL be recorded in a deterministic, append-only, ordered log.
- *Rationale*: The log is the single source of truth for document history and audit.
- *Verifiable by*: After N edits, the log contains exactly N entries in submission order.

**R2**: Each edit SHALL carry the identity of the editor who submitted it.
- *Rationale*: Accountability requires knowing who made each change.
- *Verifiable by*: Every entry in the edit log includes the editor's identity, and querying attribution returns the correct editor.

**R3**: Each editable path SHALL have a sequential version counter, incremented with every successful edit.
- *Rationale*: Version counters enable stale-state detection for optimistic concurrency.
- *Verifiable by*: After three successful edits to a path, the version counter for that path equals 3.

**R4**: An edit submitted against a stale version (a base version that no longer matches the current version) SHALL be suspended, not applied.
- *Rationale*: Silent last-write-wins overwrites lose work; suspended edits preserve user intent and surface the conflict.
- *Verifiable by*: When editor B submits against version 1 but the current version is 2, the edit is suspended, the document content is unchanged, and the edit is listed as pending.

**R5**: A writer with a suspended edit SHALL be able to read the current state, reconcile, and resubmit against the current version.
- *Rationale*: Conflict resolution requires the writer to see what changed and make an informed decision.
- *Verifiable by*: After suspension, the writer reads the current version, resubmits against it, and the edit succeeds.

**R6**: The log SHALL support historical queries, returning the exact value at any path at a specific position in the log.
- *Rationale*: Historical access enables diffing, auditing, and rollback analysis.
- *Verifiable by*: Querying a path at position 3 returns the value that was written at position 3.

**R7**: The log SHALL be immutable after write: edits are never removed, modified, or reordered.
- *Rationale*: Immutability guarantees the log is a reliable audit trail.
- *Verifiable by*: After 5 writes, all 5 entries are present in the log in original order, including entries whose values have been superseded by later writes.

**R8**: Diff computation between the current and previous values at a path SHALL be supported.
- *Rationale*: Writers and reviewers need to see what changed between versions.
- *Verifiable by*: After an edit changes a path's value, both the current and previous values are readable for comparison.

## Acceptance Criteria

**AC1** [R1, R2]: Given two editors (Alice and Bob) submitting edits, when both edits are recorded, then the log contains both entries in order with correct editor attribution.

**AC2** [R3, R4]: Given editor A successfully editing at version 1 (version becomes 2), when editor B submits against version 1, then editor B's edit is suspended and the document is unchanged.

**AC3** [R4, R5]: Given editor B's suspended edit, when B reads the current state and resubmits against version 2, then the edit succeeds and the version advances to 3.

**AC4** [R6]: Given a document with edits at positions 1 through 5, when querying position 3, then the exact value written at position 3 is returned.

**AC5** [R7]: Given 5 edits to a document, when inspecting the log, then all 5 entries are present in original order, including superseded values.

**AC6** [R8]: Given an edit that changes a path from "Draft A" to "Draft B", when computing a diff, then both the previous value ("Draft A") and current value ("Draft B") are available.

## Open Questions

- Should there be a time limit on how long a suspended edit is retained before it expires?
- How should three-way conflicts (three editors all submitting against the same stale version) be presented to each editor?
