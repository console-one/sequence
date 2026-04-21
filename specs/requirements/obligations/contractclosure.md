# Contract Closure

## Original Notes

An obligation exists when a schema is declared at a path but no value satisfies it. Closure is the act of providing a value that passes the type-check against that schema. The successful write IS the proof step -- there is no separate "close" operation. The tension is that closure is not always permanent: conditional closures can reopen when their predicates break, and capabilities with preserved properties impose a stronger identity conservation check on top of basic type satisfaction.

The hard part is the boundary between strict and permissive. Too strict and valid outputs are rejected. Too loose and invalid outputs pollute the state. The type-check at closure time is the single enforcement point for the entire obligation contract.

## Problem Context

- **Actor(s)**: Capabilities (producing values to satisfy obligations), the system (validating values, recording proof, monitoring conditions), auditors (reviewing the proof trail).
- **Domain**: Obligation lifecycle management where typed requirements must be satisfied by validated values, with support for conditional and revocable closures.
- **Core Tension**: Closure validation must be strict enough to prevent invalid values from polluting state, but not so strict that valid outputs are rejected. Additionally, some closures are conditional and must reopen automatically when their conditions break.

## Requirements

**R1**: An obligation SHALL exist whenever a schema is declared at a path but no value satisfying that schema has been provided.
- *Rationale*: Obligations make missing work explicit and queryable.
- *Verifiable by*: Declaring a schema at a path with no value causes that path to appear in the open obligations list.

**R2**: Providing a value that passes the full type-check against the schema SHALL close the obligation.
- *Rationale*: Closure is the natural result of satisfying the typed requirement; no separate close operation is needed.
- *Verifiable by*: After a valid value is provided, the obligation no longer appears in the open obligations list.

**R3**: Providing a value that fails the type-check SHALL leave the obligation open and produce a structured violation report; the state SHALL remain unchanged.
- *Rationale*: Partial or invalid values must not pollute state; the rejection must be atomic.
- *Verifiable by*: After an invalid value is submitted, the obligation remains open, no value is stored, and the violation report identifies the failing constraints.

**R4**: Each successful closure SHALL produce an immutable, sequenced proof record containing at minimum a sequence number, the path, and a timestamp.
- *Rationale*: Proof records create an audit trail of how obligations were satisfied.
- *Verifiable by*: After closure, a proof record exists with a unique sequence number, the obligation path, and a timestamp.

**R5**: A conditional closure (one gated on an external predicate) SHALL reopen automatically when the predicate becomes false.
- *Rationale*: Values that are valid only under certain conditions must not remain accepted when those conditions change.
- *Verifiable by*: After the gating condition breaks, the obligation reappears in the open obligations list.

**R6**: Reopening of conditional closures SHALL be automatic, requiring no manual intervention.
- *Rationale*: Manual monitoring of condition predicates is unreliable; the system must enforce this.
- *Verifiable by*: Removing the gating condition causes the obligation to reopen without any explicit user action.

**R7**: For capabilities that declare preserved properties, closure SHALL perform an identity conservation check: each preserved property in the output MUST equal the corresponding property in the input.
- *Rationale*: Some capabilities must not corrupt data they are supposed to pass through unchanged; this is a stronger check than type satisfaction alone.
- *Verifiable by*: A closure where a preserved property in the output differs from the input is rejected with an identity conservation violation (distinct from a type error).

**R8**: The obligation's concreteness score SHALL increase toward 1.0 with each valid closure step and SHALL start near 0 when open.
- *Rationale*: Concreteness provides a quantitative measure of how close an obligation is to being fully satisfied.
- *Verifiable by*: The concreteness score after closure is higher than before, and a fully closed obligation has concreteness approximately 1.0.

**R9**: Proof records SHALL survive log compaction; the closure fact (which step closed which obligation) SHALL be preserved even if intermediate log entries are archived.
- *Rationale*: The audit trail must remain valid regardless of storage optimization.
- *Verifiable by*: After compaction, the proof record for a closed obligation is still retrievable.

## Acceptance Criteria

**AC1** [R1, R2]: Given a schema declared at a path with no value, when a value passing the type-check is provided, then the obligation closes and no longer appears in the open list.

**AC2** [R3]: Given an open obligation, when a value failing the type-check is submitted, then the obligation remains open, no value is stored, and a violation report is produced.

**AC3** [R4]: Given a successful closure, when the proof trail is queried, then a proof record exists with a sequence number, path, and timestamp.

**AC4** [R5, R6]: Given a conditional closure gated on a predicate (e.g., "api key exists"), when the predicate becomes false (api key is removed), then the obligation reopens automatically.

**AC5** [R7]: Given a capability with a preserved property, when the output's preserved property differs from the input, then closure is rejected with an identity conservation violation.

**AC6** [R8]: Given an open obligation with concreteness near 0, when a valid value is provided, then the concreteness increases toward 1.0.

**AC7** [R9]: Given a closed obligation, when log compaction runs, then the proof record for that closure is still retrievable.

## Open Questions

- When a conditional closure reopens, should the previously satisfying value be retained as "stale" or fully removed? (This may be a workspace-level policy.)
- What is the maximum depth of identity conservation checks for nested preserved properties?
