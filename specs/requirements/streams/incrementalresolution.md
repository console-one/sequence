# Incremental Resolution

## Original Notes

A value starts as a declared shape with no data -- a gap. Partial contributions arrive over time. The system tracks what is still missing automatically, and dependent operations unblock as resolution progresses. The critical distinction: "no data yet" vs "data present but incomplete" vs "data fully resolved." Dependent operations can wait on specific subsets (just the email field) rather than requiring full resolution.

There is no special "partial write" mode. Data is written via the same mechanism as complete data. Obligations are derived automatically from schemas and current values -- never manually maintained.

## Problem Context

- **Actor(s)**: Data producers (providing partial or complete values); dependent operations (waiting on specific fields or full resolution); the schema enforcement layer (tracking what is still missing).
- **Domain**: Progressively filling in structured data where partial state is normal, the system automatically tracks what remains, and dependent operations unblock as specific fields become available.
- **Core Tension**: Data arrives incrementally from multiple sources and at different times. The system must distinguish "no data yet" from "partial data" from "fully resolved", and dependent operations must be able to wait on specific subsets rather than requiring all-or-nothing resolution.

## Requirements

**R1**: Declaring a schema at a path before any value exists SHALL create a trackable obligation for each required field.
- *Rationale*: The system must automatically know what data is expected, so it can report what is missing.
- *Verifiable by*: Declare a schema with required fields `name` and `email` -- both appear as outstanding obligations.

**R2**: Optional fields SHALL NOT count as obligations.
- *Rationale*: Optional fields are explicitly acceptable to omit; treating them as obligations would create false requirements.
- *Verifiable by*: Declare a schema with optional field `bio` -- `bio` does not appear in the obligations list.

**R3**: Partial data SHALL be accepted and incorporated, with the system automatically tracking which required fields remain unsatisfied.
- *Rationale*: Data arrives incrementally; the system must accept each piece without requiring all fields at once.
- *Verifiable by*: Write `name: "Alice"` to a schema requiring `name` and `email` -- `name` is satisfied, `email` remains as an obligation.

**R4**: When all required fields are present, the path SHALL be considered fully resolved and removed from the obligations list.
- *Rationale*: Full resolution is the completion signal; the path no longer needs attention.
- *Verifiable by*: Write both `name` and `email` -- the path no longer appears in the obligations list, even though optional `bio` is absent.

**R5**: Dependent operations SHALL be expressible as waiting on specific fields, not just full resolution.
- *Rationale*: An operation that only needs the email should not be blocked waiting for unrelated fields.
- *Verifiable by*: A dependent operation waiting on `profile.email` activates as soon as `email` is written, regardless of whether `name` or other fields are present.

**R6**: Dependent operations waiting on full resolution SHALL activate only when all required fields are present.
- *Rationale*: Some operations genuinely need the complete record.
- *Verifiable by*: A dependent operation waiting on the full profile activates only after both `name` and `email` are written.

**R7**: Derived values whose inputs are partially available SHALL NOT compute until all required inputs are present.
- *Rationale*: Computing with missing inputs produces incorrect results or errors.
- *Verifiable by*: A derived value depending on `first` and `last` does not compute when only `first` is provided; it computes after `last` is also written.

**R8**: Obligations SHALL be derived automatically from schemas and current values, never manually maintained.
- *Rationale*: Manual obligation tracking is error-prone and diverges from the actual schema.
- *Verifiable by*: There is no API to manually add or remove obligations -- they are computed from the schema and current state.

## Acceptance Criteria

**AC1** [R1, R2]: Given a schema `{ name: string, email: string, bio?: string }` declared at `profile`, when no values are written, then `name` and `email` appear as obligations, and `bio` does not.

**AC2** [R3]: Given the same schema, when `name: "Alice"` is written, then `name` is satisfied and only `email` remains as an obligation.

**AC3** [R4]: Given the same schema, when `email: "alice@example.com"` is also written, then `profile` is fully resolved and removed from the obligations list, despite `bio` being absent.

**AC4** [R5]: Given a dependent operation waiting on `profile.email`, when `email` is written (before `name`), then the dependent operation activates immediately.

**AC5** [R6]: Given a dependent operation waiting on the full `profile`, when only `name` is written, then the operation does not activate. When `email` is subsequently written, then it activates.

**AC6** [R7]: Given a derived value depending on `first` and `last`, when only `first: "Bob"` is written, then the derived value does not compute. When `last: "Smith"` is written, then it computes.

**AC7** [R8]: Given the system, when the obligation tracking mechanism is inspected, then there is no manual add/remove obligation API -- obligations are purely derived from schemas and current values.

## Open Questions

- Should partially resolved paths have a "resolution progress" metric (e.g., 1 of 3 required fields filled)?
- Can a previously resolved field be un-resolved (e.g., by deletion), and if so, does the path re-enter the obligations list?
- How should circular dependencies between incrementally resolving paths be handled?
