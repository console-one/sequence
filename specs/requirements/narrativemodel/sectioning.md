# Document Sections as Segmented Types

## Original Notes

A document is not flat text -- it has structure. A report has a header, body, and footer. Each section has its own type, size budget, and mutability rules. The header is short and may be locked after approval. The body is long and freely editable. The footer is short and immutable once signed. These constraints must be enforced structurally at the data layer, not left to the UI to police.

Locking is not a separate mechanism -- it is a tightening of the type constraint to a literal. A locked footer's schema constrains its value to exactly its current content, making any different value invalid by definition.

## Problem Context

- **Actor(s)**: Document authors (defining sections), editors (writing section content), administrators (locking sections), automated agents (guided by mutation policies).
- **Domain**: Structured documents where each section has independent size limits, mutability rules, and permitted transformation types, all enforced at the data layer.
- **Core Tension**: Structural constraints (size budgets, locking, mutation policies) must be enforced at the data layer -- not the UI -- so that no write path can bypass them, while still supporting sections with very different access and size profiles in the same document.

## Requirements

**R1**: A document SHALL be composed of named, ordered sections, each independently addressable by path.
- *Rationale*: Sections are the structural unit for applying different constraints to different parts of a document.
- *Verifiable by*: Writing to one section does not affect the content of other sections.

**R2**: Each section SHALL enforce a maximum content length (size budget) at write time.
- *Rationale*: Size budgets prevent sections from exceeding their structural allocation.
- *Verifiable by*: A write within budget succeeds; a write exceeding budget is rejected before the content is stored.

**R3**: A write exceeding a section's size budget SHALL be suspended, not silently truncated or rejected with data loss.
- *Rationale*: The writer's intent must be preserved so it can be revised or the budget adjusted.
- *Verifiable by*: After an oversized write, the section content is unchanged and the write is listed as pending.

**R4**: Locking a section SHALL constrain its value to exactly its current content; any write of different content SHALL fail validation.
- *Rationale*: Locking provides immutability for approved or signed sections.
- *Verifiable by*: After locking a footer, writing different text fails; writing the identical text is a no-op.

**R5**: Lock enforcement SHALL be structural, operating identically for UI and programmatic writes.
- *Rationale*: Enforcement that only works in the UI is bypassable and unreliable.
- *Verifiable by*: A direct programmatic write to a locked section is rejected, same as a UI write.

**R6**: The system SHALL support enumerating all section names for a document in their declared order.
- *Rationale*: Section enumeration supports navigation, table-of-contents generation, and structural overview.
- *Verifiable by*: Querying a document's sections returns all names in declared order.

**R7**: Sections MAY declare permitted mutation types (e.g., "expand", "compress") as inspectable metadata.
- *Rationale*: Mutation policies guide automated agents and UI affordances about what transformations are appropriate.
- *Verifiable by*: A section's declared mutation type is readable by agents and UI components.

## Acceptance Criteria

**AC1** [R1]: Given a document with header, body, and footer sections, when writing to body, then header and footer are unchanged.

**AC2** [R2, R3]: Given a body section with a 4000-character budget, when a 3000-character write is submitted, then it succeeds; when a 4001-character write is submitted, then it is suspended and the content is unchanged.

**AC3** [R4, R5]: Given a footer with content "Confidential - Internal Use Only" that is locked, when a write of "Changed text" is submitted (from any source), then it fails validation; when the identical text is written, it is a no-op.

**AC4** [R6]: Given a document with header, body, and footer, when enumerating sections, then the result is [header, body, footer] in that order.

**AC5** [R7]: Given a body section with mutation type "expand", when an agent queries the section's metadata, then "expand" is returned.

## Open Questions

- Can a section's size budget be changed after creation, and if so, what happens to content that already exceeds the new budget?
- Should mutation policies be enforceable constraints or advisory metadata?
