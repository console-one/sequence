# Type Indexing

## Original Notes

As you can probably see, whenever we are actually mounting tools to a context, all the tool inputs might be typed, those tool types might be serialized, etc., so we also have to index not just tools and narratives but also types and have those types hoisted in at least into blocks that are maybe not shown but existing within the database. This lends itself to two questions or considerations:
1. When we do that hoisting, what types do we use? I guess we use the same model as we use for scope cascading that we got rid of, but the ability that we have to add callable to a certain partition or path within the tree at a certain join point is similar.
2. Any type definitions of anything partitions that are added would probably be defined by some hoist by some capture flag that partition where all of the hoisted types apply. Very much similar to a codebase where all my custom types are only going to get limited to my package, but we could have that type hoisting.
The whole thing is really about reference indexing, so maybe it's not a big deal.

## Overview

Tools have typed inputs. Those types must be stored, serialized, discoverable, and scoped. The type catalog is a persistent, queryable collection of all type definitions known to the system. It supports reverse lookup -- given a type, find all tools that accept it -- and enforces partition-scoped visibility so types from one area do not leak into unrelated areas.

The two key operations are reverse indexing (answering "what can I do with this type of data?") and type hoisting (explicitly making a type from a sub-partition visible at a higher level). Both are analogous to how a codebase manages package-scoped types -- local by default, explicitly exported when needed.

## The Type Definition

A type definition is fully serializable -- no live functions, closures, or runtime-only constructs. It is plain data that can be persisted, transmitted, and deserialized in a different process:

```ft
TypeDefinition = {
  name: string,
  partition: string,
  fields: string,
  serializable: boolean
}
```

`name` identifies the type within its partition. `partition` scopes visibility -- the type is visible to its partition and descendants, not globally. `fields` describes the structural constraints (field names, field types, validation rules). `serializable` is always true for catalog types -- non-serializable types cannot be stored.

## The Type Catalog

The catalog stores type definitions and maintains a reverse index mapping types to the tools that accept them:

```ft
TypeCatalog = {
  types: ref(typeDefinitions),
  reverseIndex: ref(toolReferences),
  typeCount: number.integer >= 0
}
```

`reverseIndex` is derived from tool definitions. When a tool declares input type "QueryInput", the reverse index maps "QueryInput" to that tool. When the tool is removed, the mapping disappears. The reverse index updates automatically -- no manual rebuild.

## Reverse Type Lookup

Given a type, find all tools that accept it. This is the "what can I do with this data?" query:

```ft
-- Query: what tools accept "QueryInput"?
-- Result: [searchTool, filterTool] -- tools whose input type is compatible
```

Compatibility includes subtype relationships. A tool that accepts "Model" (fields: name, provider) also accepts "HighCapModel" (fields: name, provider, maxTokens) because the subtype satisfies all constraints of the parent type plus additional ones.

## Partition Scoping

Types are scoped to their defining partition and its descendants. A type defined in partition A is not visible in unrelated partition B:

```ft
TypeScope = {
  definedIn: string,
  visibleTo: string,
  hoisted: boolean
}
```

`visibleTo` defaults to the defining partition and its descendants. `hoisted` is false by default. When set to true, the type becomes visible at the hoisted-to partition level, making it accessible to sibling partitions.

Scoping prevents name collisions. Two partitions can each define a type called "Config" without conflict, because each is only visible within its own scope.

## Type Hoisting

A type from a sub-partition can be explicitly hoisted to a parent partition. This is opt-in -- types do not automatically propagate upward:

```ft
-- Type "SharedType" defined in partition A.child
-- Hoisted to partition A
-- Now visible to A and all of A's descendants (including A.sibling)
TypeScope << { hoisted: true, visibleTo: "A" }
```

Hoisting is controlled by a capture flag on the partition. Only explicitly hoisted types escape their defining scope. This mirrors how a codebase exports types from a package -- local by default, exported when intentional.

## Context Compression

When types are included in agent prompts or context views, they are compressed to their structural signature. Full metadata is stripped:

```ft
-- Full definition: name="QueryInput", fields={query: string(1..1000), limit?: number(1..100)}, metadata={...}
-- Compressed for context: {query: string, limit?: number}
```

The compressed form conveys the essential structure without consuming unnecessary tokens. Field names and types are preserved. Constraints, metadata, and descriptions are omitted. This is a presentation-layer concern -- the full definition remains in the catalog.

## Subtype Queries

The catalog supports structural subtype checks. Type B is a subtype of type A if B satisfies all of A's constraints and adds more:

```ft
tool TypeCatalog.types
tool TypeCatalog.reverseIndex
tool TypeScope.hoisted
```

Subtype relationships enable type-based tool discovery to work across specificity levels. A search for tools accepting "Model" returns tools accepting "Model" and tools accepting any supertype of "Model".

## What This Validates

| AC | Expressed by |
|----|-------------|
| Type definitions stored and retrievable | `TypeDefinition` in `TypeCatalog` with `serializable: true` |
| Reverse index finds tools by input type | `reverseIndex: ref(toolReferences)` maps types to tools |
| Tool references type by path, not copy | Tools point to catalog entries, not embedded definitions |
| Index updates on tool add/remove | Reverse index derived from tool definitions, auto-updated |
| Types scoped to partition | `TypeScope` with `definedIn` and `visibleTo` |
| Descendants see parent partition types | `visibleTo` includes defining partition's descendants |
| Hoisting makes type visible to siblings | `hoisted: true` extends `visibleTo` to parent partition |
| Context compression strips metadata | Structural signature only -- field names and types |
| Subtype queries supported | Structural subtype check: tighter constraints = subtype |
