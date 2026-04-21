# Editable Ranges Within a Document

## Original Notes

A document is not uniformly editable. A contract has a locked header and signature but an editable body. The system must enforce per-section editability as a structural constraint -- not a UI hint -- so that writes to locked sections are suspended (never silently dropped), concurrent writers are protected by exclusive edit locks, and editability can change over time (unlocking a section causes pending writes to resume).

The key insight: editability is a predicate on the section, and writes are gated by that predicate. A suspended write is not lost work -- it is a continuation waiting for the predicate to become true.

## Problem Context

- **Actor(s)**: Document authors (setting editability), concurrent writers (editing sections), administrators (locking/unlocking sections).
- **Domain**: Structured documents with per-section access control, where some sections must be protected from modification while others remain freely editable.
- **Core Tension**: Writes to locked sections must not be silently lost (they are suspended as pending work), editability must be enforceable at the data layer (not just UI), and concurrent writers need exclusive access coordination.

## Requirements

**R1**: Each section of a document SHALL have an independently queryable editability status (editable or locked).
- *Rationale*: Consumers (writers, UI, agents) must be able to inspect editability before or after attempting a write.
- *Verifiable by*: Querying a section's editability returns its current status accurately.

**R2**: A write to a locked section SHALL be suspended as pending work, not silently dropped or rejected with data loss.
- *Rationale*: Suspended writes preserve user intent; the work resumes automatically when the section is unlocked.
- *Verifiable by*: After a write to a locked section, the write appears in a pending/suspended list and the section content is unchanged.

**R3**: A write to an editable section SHALL be applied immediately.
- *Rationale*: Editable sections have no access barrier; writes should take effect without delay.
- *Verifiable by*: The section content reflects the written value after the operation.

**R4**: Sections SHALL support subdivision into independently addressable and editable sub-sections.
- *Rationale*: Real documents have fine-grained structure (e.g., intro, analysis, conclusion within a body section).
- *Verifiable by*: Writing to one sub-section does not affect the content of sibling sub-sections.

**R5**: The system SHALL support exclusive edit locks per section, granting write permission to a single holder at a time.
- *Rationale*: Concurrent writers need coordination to prevent conflicting edits.
- *Verifiable by*: While writer A holds the lock, writer B cannot apply writes to that section.

**R6**: Lock transfer SHALL be atomic: the previous holder's lock-conditional writes SHALL be invalidated in the same operation that grants the lock to the new holder.
- *Rationale*: There must never be a moment where two writers hold the same lock, and stale conditional writes must not persist.
- *Verifiable by*: After lock transfer from A to B, writer A's conditional edits are removed from the document and writer B's writes succeed.

**R7**: A section MAY declare a maximum content length (size budget); writes exceeding the budget SHALL be suspended.
- *Rationale*: Some sections have structural size constraints (e.g., a title field limited to 200 characters).
- *Verifiable by*: A write exceeding the budget is suspended, and the section content remains within budget.

**R8**: Unlocking a previously locked section SHALL cause all suspended writes to that section to be re-evaluated and applied if valid.
- *Rationale*: Suspended writes represent deferred intent; unlocking should fulfill them automatically.
- *Verifiable by*: After unlocking, the section content updates to reflect the previously pending write.

**R9**: Editability enforcement SHALL operate at the data layer, identically for UI-originated and programmatic writes.
- *Rationale*: Enforcement that only works in the UI is bypassable and unreliable.
- *Verifiable by*: A programmatic write to a locked section is suspended, same as a UI-originated write.

## Acceptance Criteria

**AC1** [R1]: Given a document with title (locked), body (editable), and signature (locked), when querying editability, then title and signature report locked and body reports editable.

**AC2** [R2, R3]: Given an editable body section, when a write is submitted, then it applies immediately; given a locked title section, when a write is submitted, then it is suspended and the title is unchanged.

**AC3** [R4]: Given a body section with sub-sections (intro, analysis, conclusion), when writing to analysis, then intro and conclusion are unchanged.

**AC4** [R5, R6]: Given writer A holding a lock on body, when the lock transfers to writer B, then writer A's conditional edits are removed and writer B can write successfully.

**AC5** [R7]: Given a section with a 200-character budget, when a 250-character write is submitted, then it is suspended and the section remains within budget.

**AC6** [R8]: Given a locked title with a pending write, when the title is unlocked, then the pending write is applied and the title content updates.

## Open Questions

- What happens when multiple suspended writes exist for the same section at unlock time -- are they applied in order, or does only the latest apply?
- Should size budget violations produce a specific diagnostic message, and if so, what information should it contain?
