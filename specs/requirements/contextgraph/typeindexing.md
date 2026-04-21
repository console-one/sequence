# Type Indexing

## Original Notes

As you can probably see, whenever we are actually mounting tools to a context, all the tool inputs might be typed, those tool types might be serialized, etc., so we also have to index not just tools and narratives but also types and have those types hoisted in at least into blocks that are maybe not shown but existing within the database. This lends itself to two questions or considerations:
1. When we do that hoisting, what types do we use? I guess we use the same model as we use for scope cascading that we got rid of, but the ability that we have to add callable to a certain partition or path within the tree at a certain join point is similar.
2. Any type definitions of anything partitions that are added would probably be defined by some hoist by some capture flag that partition where all of the hoisted types apply. Very much similar to a codebase where all my custom types are only going to get limited to my package, but we could have that type hoisting.
The whole thing is really about reference indexing, so maybe it's not a big deal.

## Problem Context

- **Actor(s)**: Tools that declare typed inputs/outputs, the type catalog that stores and indexes definitions, processes that query "what can I do with this data type?", partition owners who control type visibility.
- **Domain**: Type cataloging and reverse-lookup for a system where tools have typed interfaces. The catalog must support two key operations: reverse indexing (given a type, find all tools that accept it) and scoped visibility (types are local to their defining partition by default, explicitly exported when needed).
- **Core Tension**: Types must be discoverable (so the system can answer "what tools accept this data?") but also scoped (so types from one partition do not leak into unrelated partitions). The original notes draw the analogy to package-scoped types in a codebase: local by default, explicitly exported when intentional.

## Requirements

**R1**: All type definitions used by tools SHALL be stored in a persistent, queryable type catalog.
- *Rationale*: Tool interfaces are typed. Those types must be discoverable even when the tool is not currently running. The catalog is the source of truth for type metadata.
- *Verifiable by*: After a tool registers with input type "QueryInput", the type definition for "QueryInput" is retrievable from the catalog.

**R2**: Type definitions in the catalog SHALL be fully serializable -- no live functions, closures, or runtime-only constructs.
- *Rationale*: Types must be persistable, transmittable across processes, and deserializable in a different runtime environment.
- *Verifiable by*: A type definition can be serialized to a storage format, deserialized in a separate process, and used for type checking.

**R3**: The catalog SHALL maintain a reverse index mapping each type to the set of tools that accept it as input.
- *Rationale*: The reverse index answers "what can I do with this data?" -- a core discovery operation. Without it, finding compatible tools requires scanning all tool definitions.
- *Verifiable by*: Given a tool declaring input type "QueryInput", querying the reverse index for "QueryInput" returns that tool. When the tool is removed, the mapping disappears.

**R4**: The reverse index SHALL update automatically when tools are added or removed. No manual rebuild SHALL be required.
- *Rationale*: A stale reverse index returns wrong answers. Automatic derivation from tool registrations guarantees consistency.
- *Verifiable by*: Adding a new tool with a known input type causes it to appear in the reverse index. Removing the tool causes it to disappear. No rebuild call is needed.

**R5**: Reverse index queries SHALL respect structural subtype relationships: a query for type A SHALL also return tools that accept any supertype of A (since A satisfies the supertype's constraints).
- *Rationale*: A tool accepting "Model" (fields: name, provider) should also accept "HighCapModel" (fields: name, provider, maxTokens) because the subtype has all required fields plus more.
- *Verifiable by*: A tool accepting "Model" is returned when querying for "HighCapModel" (which is a subtype of "Model").

**R6**: Type definitions SHALL be scoped to their defining partition and its descendants by default. Types from one partition SHALL NOT be visible in unrelated partitions.
- *Rationale*: Prevents name collisions and unintended coupling. Two partitions can each define a type called "Config" without conflict.
- *Verifiable by*: A type "Config" defined in partition A is visible within A and A's children. It is NOT visible in unrelated partition B.

**R7**: A type from a sub-partition SHALL be explicitly exportable ("hoisted") to a parent partition, making it visible to sibling partitions. Hoisting SHALL be opt-in; types SHALL NOT propagate upward automatically.
- *Rationale*: The original notes describe this as analogous to exporting types from a package. Local by default, exported when intentional.
- *Verifiable by*: A type defined in partition A.child is NOT visible in A.sibling. After the type is explicitly hoisted to partition A, it becomes visible in A.sibling.

**R8**: When types are included in context views (e.g., agent prompts), they SHALL be compressible to their structural signature (field names and types only), stripping metadata, descriptions, and constraints.
- *Rationale*: Full type definitions consume excessive tokens in prompts. The structural signature conveys the essential information. The full definition remains available in the catalog for deeper inspection.
- *Verifiable by*: A type with fields, constraints, and description is compressed to field names and types only. The compressed form is smaller than the full definition.

## Acceptance Criteria

**AC1** [R1, R2]: Given a tool registering with input type "QueryInput" containing fields {query: string, limit: number}, when the catalog is queried, then the type definition is returned and is fully serializable.

**AC2** [R3, R4]: Given two tools (searchTool and filterTool) both accepting type "QueryInput", when the reverse index is queried for "QueryInput", then both tools are returned. When filterTool is removed, then only searchTool is returned.

**AC3** [R5]: Given a tool accepting type "Model" (fields: name, provider), when the reverse index is queried for "HighCapModel" (fields: name, provider, maxTokens), then the tool is returned because "HighCapModel" is a structural subtype of "Model".

**AC4** [R6]: Given type "Config" defined in partition A and a separate partition B, when partition B queries for type "Config", then no result is returned.

**AC5** [R7]: Given type "SharedType" defined in partition A.child, when A.sibling queries for it, then it is NOT found. After "SharedType" is hoisted to partition A, when A.sibling queries again, then it IS found.

**AC6** [R8]: Given a type with 5 fields, 3 constraints, and a description (200 characters total), when compressed for context, then the output contains only field names and types (under 100 characters).

## Open Questions

- **Cross-partition references**: If a tool in partition A declares an input type defined in partition B (not hoisted), should this be an error at registration time or a runtime resolution failure?
- **Type versioning**: When a type definition changes, should old tools referencing the previous version be invalidated, or should versions coexist?
- **Compression levels**: Should there be multiple compression levels (e.g., names-only, names+types, names+types+constraints) rather than a single compressed form?
