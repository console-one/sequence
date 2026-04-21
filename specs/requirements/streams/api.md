# Stream API

## Original Notes

A stream is an ordered, append-only sequence of typed items under a common path prefix. Chat messages, event logs, agent interaction records -- they all reduce to the same pattern: indexed children under a prefix with a schema constraining their shape. The design constraint is that streams must NOT be a special-cased type. They emerge from existing primitives: path hierarchy, schema declaration at a prefix, and sequential index convention.

The hard part is not the data model (it's trivially an indexed collection). The hard part is that schema enforcement, enumeration, random access, and multi-stream isolation must all work without introducing any stream-specific operations.

## Problem Context

- **Actor(s)**: Producers (writing stream items); consumers (reading/enumerating stream items); the schema enforcement layer.
- **Domain**: Ordered, append-only collections of typed items (chat messages, event logs, agent records) that must be expressible using general-purpose primitives, not special-cased stream types.
- **Core Tension**: Streams are a fundamental data pattern, but they must emerge from existing primitives (path hierarchy, schema, indexed children) without introducing stream-specific operations -- otherwise the system grows special cases for every collection type.

## Requirements

**R1**: A stream SHALL be represented as a path prefix with a declared schema, where items are children at sequential integer indices.
- *Rationale*: Streams are not a special type; they emerge from path hierarchy and schema enforcement applied to indexed children.
- *Verifiable by*: Declaring a schema at prefix `messages` and writing items at `messages.0`, `messages.1`, `messages.2` -- all items are retrievable and schema-validated.

**R2**: The schema declared at the prefix SHALL be enforced on every child written under that prefix.
- *Rationale*: Schema enforcement at the prefix prevents invalid items from entering the stream.
- *Verifiable by*: Writing an item to `messages.3` that violates the prefix schema (e.g., wrong field type) is rejected.

**R3**: Conforming items SHALL be accepted and retrievable at their declared index.
- *Rationale*: This is the basic correctness property of an append-only indexed collection.
- *Verifiable by*: Write `{ role: "user", content: "Hello" }` to `messages.1` -- reading `messages.1` returns that exact item.

**R4**: Enumerating children at the prefix SHALL return all item indices in order.
- *Rationale*: Consumers need to iterate over the stream in insertion order.
- *Verifiable by*: After writing items at indices 0, 1, 2, listing children at `messages` returns `["0", "1", "2"]` in order.

**R5**: Random access by index SHALL return the item at that specific index.
- *Rationale*: Consumers need to access specific items without iterating the entire stream.
- *Verifiable by*: Reading `messages.1` returns the item at index 1 without reading indices 0 or 2.

**R6**: Multiple streams under different prefixes SHALL be fully independent, with separate schemas and no shared state.
- *Rationale*: An event stream and a log stream must not interfere with each other.
- *Verifiable by*: Write items to `events` and `logs` with different schemas -- reading `events` returns only event items; reading `logs` returns only log items. A schema violation in one has no effect on the other.

**R7**: No stream-specific operations SHALL be required -- only path hierarchy, schema declaration, and value writes.
- *Rationale*: Special-cased types proliferate complexity; streams must compose from existing primitives.
- *Verifiable by*: The implementation of streams uses only general-purpose path, schema, and write operations -- no "append", "stream create", or "stream read" API exists.

## Acceptance Criteria

**AC1** [R1, R3]: Given a schema declared at `messages` with fields `role: string` and `content: string`, when items are written at `messages.0`, `messages.1`, `messages.2`, then all three items are retrievable at their respective indices.

**AC2** [R2]: Given the same schema, when an item with `role: 123` (wrong type) is written to `messages.3`, then the write is rejected.

**AC3** [R4]: Given items at indices 0, 1, 2, when children at `messages` are enumerated, then the result is `["0", "1", "2"]` in order.

**AC4** [R5]: Given items at indices 0, 1, 2, when `messages.1` is read directly, then only the item at index 1 is returned.

**AC5** [R6]: Given streams `events` (schema: kind, timestamp) and `logs` (schema: level, message), when items are written to both, then reading `events` returns only event items and reading `logs` returns only log items.

**AC6** [R7]: Given the complete stream implementation, when its API surface is audited, then no stream-specific operations exist -- only general-purpose path, schema, and write operations are used.

## Open Questions

- Should streams support deletion of individual items, or is the append-only invariant absolute?
- How should sparse indices be handled (e.g., writing to index 5 without indices 3 and 4)?
- Should there be a count operation, or is enumerating children and counting the result sufficient?
