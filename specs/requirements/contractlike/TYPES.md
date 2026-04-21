# Contractlike -- Behavioral Type Definitions

## Problem Context

- **Actor(s)**: External systems (file systems, spreadsheets, LLM providers, databases) and agents that interact with them.
- **Domain**: Behavioral contracts for external system integrations. Each integration exposes operations with structural signatures and cross-operation invariants (e.g., "write then read returns the written value").
- **Core Tension**: External systems have domain-specific behavioral properties (formula cascade, write-read identity, cost models) that must be expressed precisely enough to verify, but generically enough to compose. The type definitions must capture both the structural shape of operations AND the temporal/relational invariants between them.

## Requirements

**R1**: Each contractlike vertical (FileSystem, Spreadsheet, LLM, RDBMS) SHALL define a structural interface specifying every operation's input parameters and return fields with their types and constraints.
- *Rationale*: Without typed operation signatures, agents cannot validate inputs before execution or reason about outputs.
- *Verifiable by*: Each vertical's type definition includes all operations with fully typed parameters and return values.

**R2**: Cross-operation behavioral invariants SHALL be explicitly stated for each vertical.
- *Rationale*: Structural types alone do not capture domain semantics. "Write then read returns the written value" is a behavioral property that the structural type cannot express.
- *Verifiable by*: Each vertical documents its invariants (e.g., write-read identity, insert-query identity, formula cascade) with the temporal scope over which they hold.

**R3**: Behavioral properties that apply across multiple verticals (e.g., auditability, write-read identity) SHALL be defined as reusable, composable types.
- *Rationale*: Auditing, idempotency, and identity relationships recur across file systems, databases, and spreadsheets. Duplicating them per vertical creates inconsistency.
- *Verifiable by*: Cross-cutting types (Auditable, WriteReadIdentity) are defined once and composed with any vertical without modification.

**R4**: Quantified predicates over dependency sets SHALL be expressible for verticals that require them (Spreadsheet formula cascade, RDBMS multi-field update).
- *Rationale*: "All cells derived from A1 recompute" and "all updated columns reflect new values" are universal quantifications over dependency graphs. Without `forall`-style expressiveness, these invariants can only be stated in prose.
- *Verifiable by*: The type system or its extensions can express "for all elements in set S, property P holds" for cascade and multi-field update scenarios.

**R5**: Structural type operators (`keyof`, indexed access, `Partial`) SHALL be available for verticals that require schema-driven operations.
- *Rationale*: RDBMS filter keys must be constrained to valid column names from the row schema. Without structural type operators, filters on nonexistent columns cannot be rejected at the type level.
- *Verifiable by*: A filter referencing a column not in the row schema is rejected as a type error before any query is generated.

**R6**: Each vertical's type definition SHALL be parameterizable over its domain-specific schema (table name + row type for RDBMS, cell reference type for Spreadsheet, cost parameters for LLM).
- *Rationale*: Concrete instances differ in their schemas but share the same behavioral contract. A database of employees and a database of products have identical operation shapes but different row types.
- *Verifiable by*: Multiple concrete instances of the same vertical (e.g., two different database tables) can be created with different schemas while sharing the same behavioral invariants.

## Acceptance Criteria

**AC1** [R1]: Given any vertical's type definition, when an operation is invoked with parameters matching the declared types, then the return value conforms to the declared return type and its constraints.

**AC2** [R2]: Given a write-read identity is declared for a vertical, when a write operation succeeds and a subsequent read targets the same path/key before any intervening mutation, then the read returns the written value.

**AC3** [R3]: Given the Auditable type is composed with FileSystem, when a read or write operation completes, then a history entry exists for that operation permanently.

**AC4** [R4]: Given a spreadsheet where cell A3 depends on A1 via formula, when A1 is written to, then A3's value is recomputed to reflect the new A1 value -- and this holds transitively for all cells in A1's dependency graph.

**AC5** [R5]: Given an RDBMS vertical with row schema `{id, name, salary}`, when a query filter references a field `nonexistent`, then the filter is rejected as a type error before any SQL is generated.

**AC6** [R6]: Given the RDBMS type parameterized with `EmployeeRow`, when a second instance is created with `DepartmentRow`, then both instances independently validate operations against their respective schemas.

## FT System Demands

The four verticals surface these needs beyond the current type system:

| Need | Where | Why |
|------|-------|-----|
| `forall` quantifier in predicates | Spreadsheet (formula cascade), RDBMS (multi-field update) | Cannot express "all derived cells recompute" or "all updated columns reflect changes" without universal quantification |
| `keyof` / indexed access types | RDBMS (filter key validation) | Filter keys must be constrained to valid column names from the row schema |
| Dependency graph traversal | Spreadsheet | Formula cascade requires transitive closure over cell dependencies |
| `Partial` type constructor | RDBMS (update operation) | Update accepts a subset of row fields; all must become optional |
| Error branch in return types | All four verticals | Operations can fail; the return type must express both success and failure branches |

## Open Questions

1. **`forall` quantifier syntax**: What is the concrete syntax for universal quantification in predicates? This blocks formal expression of cascade and multi-field update invariants.
2. **Error representation**: The current design says "no errors in output types." How do operation failures (file not found, constraint violation, API timeout) surface in the type system?
3. **Circular references in latency predicates**: LLM latency depends on `outputTokens` which is unknown before the call. Should latency bounds always reference input parameters (`maxOutputTokens`) rather than output values?
