# Bidirectional References Between Documents

## Original Notes

Documents reference each other constantly -- a proposal references a brief's budget, a brief links back to the proposal. These references must be live: when the source value changes, every derived value that depends on it recomputes automatically. The hard part is bidirectionality and cascade chains. Two documents can reference each other simultaneously, and changes can propagate transitively through multiple documents without creating infinite loops.

There is no polling, no manual refresh, no stale cache. A reference is a live binding -- read it and you get the current value of the source.

## Problem Context

- **Actor(s)**: Document authors (establishing references), readers (consuming live values), the system (maintaining the dependency index and propagating changes).
- **Domain**: Multi-document workspaces where fields in one document derive their values from fields in other documents.
- **Core Tension**: Bidirectional and transitive references must stay live without creating infinite cascade loops, and without requiring manual refresh or polling.

## Requirements

**R1**: A field in one document SHALL be able to reference a field in another document, resolving to the source field's current value at read time.
- *Rationale*: Cross-document references eliminate manual data duplication and stale copies.
- *Verifiable by*: Changing the source field value causes the referencing field to return the new value on the next read.

**R2**: Two documents SHALL be able to reference each other simultaneously (bidirectional references) without one being designated as primary.
- *Rationale*: Real-world document relationships are often symmetric (proposal references brief, brief references proposal).
- *Verifiable by*: Both directions resolve correctly and independently; changing either source updates the corresponding reference.

**R3**: A derived field SHALL support applying a named computation to a referenced value, recomputing automatically when the source changes.
- *Rationale*: References often need transformation (e.g., formatting a number as currency).
- *Verifiable by*: After the source value changes, the derived field reflects the computation applied to the new value without manual trigger.

**R4**: Changes to a source field SHALL propagate transitively through chains of dependent references (cascade).
- *Rationale*: Multi-step derivation chains (A feeds B feeds C) are common in business documents.
- *Verifiable by*: Changing a root value causes all transitive dependents to update in dependency order.

**R5**: The cascade engine SHALL detect cycles and terminate without infinite looping.
- *Rationale*: Bidirectional references create the possibility of cycles; the system must guarantee termination.
- *Verifiable by*: A cascade triggered by document A does not re-trigger A through a cycle back from document B.

**R6**: The system SHALL automatically maintain a dependency index that maps each source field to all fields that depend on it.
- *Rationale*: Cascade propagation requires knowing which fields to update; manual registration is error-prone.
- *Verifiable by*: Declaring a reference causes an index entry to appear without additional steps.

**R7**: Removing a reference SHALL clear the derived value and remove its entry from the dependency index atomically.
- *Rationale*: Stale index entries would trigger unnecessary cascade propagation or produce errors.
- *Verifiable by*: After removal, the previously referencing field returns no value, and the source field's dependency list no longer includes it.

**R8**: Downstream derivations that depend on an invalidated reference SHALL also become undefined.
- *Rationale*: A chain is only as valid as its links; breaking one link must propagate the invalidation.
- *Verifiable by*: After invalidating a mid-chain reference, all downstream fields in that chain return no value.

## Acceptance Criteria

**AC1** [R1]: Given document A with a budget field set to 50000, and document B referencing that field, when reading the reference in document B, then it returns 50000.

**AC2** [R2]: Given document A referencing document B's title and document B referencing document A's budget, when both values are set, then both references resolve correctly and independently.

**AC3** [R3]: Given a derived field applying a formatting computation to a referenced budget of 75000, when the budget changes, then the derived field reflects the computation applied to the new value.

**AC4** [R4]: Given a chain A.budget -> A.overhead (15% of budget) -> B.totalCost (budget + overhead), when A.budget changes to 100000, then A.overhead becomes 15000 and B.totalCost becomes 115000.

**AC5** [R5]: Given bidirectional references between A and B, when a cascade is triggered by changing A, then the cascade terminates without re-triggering A through B.

**AC6** [R6, R7]: Given a reference from B to A.budget, when the reference is removed, then B's field returns no value and A.budget's dependency list no longer includes B.

**AC7** [R8]: Given a chain A -> B -> C, when the reference from A to B is invalidated, then both B's and C's derived values become undefined.

## Open Questions

- What is the maximum supported cascade chain depth before the system warns or errors?
- How should the system report cycle detection to the user (warning, error, specific cycle path)?
