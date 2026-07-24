# Read State Semantics -- How to Reference and Query State

The DSL has a specific set of read operations. These are the ways you say "I want this data" inside ft blocks and at the Sequence API level. Each operation has precise semantics: `get(path)` returns the current value, `ref(path)` creates a live binding that tracks the source, `prev` reads the value before the current mount, `snapshot(path)` copies without tracking, `typeAt(path)` inspects the schema, `keys(path)` enumerates children, `getAt(path, seq)` reads historical state at a specific sequence number.

These operations all resolve against the Sequence's projection -- the derived state computed from the append-only block log. The consumer never interacts with blocks directly. The projection handles reference resolution, schema composition, and gap detection transparently.

## Direct Read -- `get(path)`

The fundamental operation. Give a path, get the current value at that path. If no value exists, the result is absence (distinct from the value `null`). If the path has a `ref` constraint in its schema, the reference is followed transparently -- the consumer gets the target's value, not the reference itself:

```ft
userName = string
userName = "Alice"
-- get("userName") returns "Alice"

-- Path with no value:
-- get("nonexistent") returns absence (undefined), not null
```

Reference resolution follows chains but detects cycles. If `refA` points to `refB` and `refB` points back to `refA`, the system returns `undefined` rather than looping. The visited set tracks which paths have been traversed in the current resolution:

```ft
activeModel = string
activeModel = "claude-3"

currentModel = ref(activeModel)
-- get("currentModel") returns "claude-3" (follows the ref)
-- The consumer does not see the indirection.
```

## Live Reference -- `ref(path)`

A `ref` creates a live binding. Unlike a direct read (which returns a snapshot of the current value), a `ref` means "my value IS whatever is at that path." When the source changes, anything that depends on the ref sees the new value on the next read:

```ft
source = string
source = "original"

mirror = ref(source)
-- get("mirror") returns "original"

source << "updated"
-- get("mirror") now returns "updated"
-- mirror tracks source automatically
```

Refs are declared in the schema, not in values. The schema at `mirror` has a `ref` constraint pointing to `source`. The `get()` method checks for this constraint and follows it. This means refs are structural -- they are part of the type definition, not runtime state.

## Previous Value -- `prev`

Inside an `=` or `<<` statement, `prev` refers to the projection snapshot before the current mount applies. This is how the DSL expresses state transitions -- the new value can depend on the old value:

```ft
counter = number >= 0
counter = 0

-- Increment: new value depends on old
counter = prev + 1
-- counter is now 1

counter = prev + 1
-- counter is now 2
```

The Sequence implements `prev` via `getPrevious(path)`, which walks the block log backward and returns the second-to-last applied value. In cross-class composition, `prev` references the entire composed object's pre-mount state:

```ft
Shop = {
  status: string,
  count: number >= 0,
  budget: number >= 0
}

Shop << { count = prev.count - 1, budget = prev.budget - 10 }
-- prev.count and prev.budget read the snapshot before this mount
```

## Snapshot -- `snapshot(path)`

A snapshot copies the current value without creating a live binding. Unlike `ref`, subsequent changes to the source do not affect the snapshot. This is useful when you need the value at a point in time, not a live feed:

```ft
source = string
source = "v1"

-- snapshot captures current value
-- frozenValue = snapshot(source) means frozenValue = "v1"
-- If source later changes to "v2", frozenValue stays "v1"
```

In the current parser, `snapshot` is not yet a supported keyword. The semantic is expressed through `=` assignment (which copies the value) versus `ref()` (which binds live). An explicit `snapshot()` function would compile to a `bind` mount of the current value at the source path.

## Schema Inspection -- `typeAt(path)`

Reading the type at a path returns the effective schema -- the intersection of the path's own schema with all ancestor schemas. If a parent is an object type with a property constraint for this key, that constraint is included:

```ft
metrics = { count: number >= 0, name: string }
metrics << { count: 500, name: "requests" }

-- typeAt("metrics.count") returns number >= 0
-- The constraint comes from the parent's property definition.
-- typeAt("metrics") returns { count: number >= 0, name: string }
```

The Sequence also exposes `rawTypeAt(path)` which returns only the schema declared directly at that path, without ancestor composition. The distinction matters when diagnosing why a write was rejected:

```ft
-- rawTypeAt("metrics.count") might return nothing (declared on parent)
-- typeAt("metrics.count") returns number >= 0 (inherited from parent)
```

## Key Enumeration -- `keys(path)`

Listing the children at a path returns keys from both values and schemas. This enables discovery -- a consumer can explore the state tree without knowing the structure in advance:

```ft
tasks.t1.status = "running"
tasks.t1.input = "analyze data"
tasks.t2.status = "pending"

-- keys("tasks") returns ["t1", "t2"]
-- keys("tasks.t1") returns ["status", "input"]
-- keys() with no argument returns top-level keys
```

Keys include paths that have schemas but no values. If `tasks.t3` has a schema declared but no value written, `keys("tasks")` still returns `["t1", "t2", "t3"]`. This is how the reader discovers gaps -- paths where a type exists but no value satisfies it yet.

## Historical Read -- `getAt(path, seq)`

Reading at a specific sequence number returns what the path's value was at that point in the log. The method walks the block log backward from the given sequence, skipping invalidated blocks, and returns the first applied value it finds:

```ft
score = number >= 0
score = 10
-- seq 0: score = 10

score << 25
-- seq 1: score = 25

score << 42
-- seq 2: score = 42

-- getAt("score", 0) returns 10
-- getAt("score", 1) returns 25
-- get("score") returns 42 (current)
```

Historical reads respect invalidation. If the block at seq 1 was later invalidated (its `while` condition broke), then `getAt("score", 1)` returns `undefined` -- the invalidated value is not visible at any point in time.

After compaction, historical reads for compacted sequences return the snapshot value. The snapshot contains the last surviving value for each path in the compacted range, so `getAt` for any sequence before the compaction boundary returns the compacted value.

## Gap Detection

Gaps are paths where a schema exists but no concrete value satisfies it. They are discoverable through the Sequence's `gaps()` method, which returns a prioritized list. Each gap includes the path, the type needed, the priority score, and any capabilities that could resolve it:

```ft
output = (data: string) -> { summary: string }
-- "output" has a function type schema but no value.
-- It appears in gaps() with reason "unresolved".

tool searchTool
-- "searchTool" has a capability registered.
-- It does NOT appear in gaps (it has an implementation).

analyzeTool = (data: string) -> { result: string }
-- "analyzeTool" has a function type but no cap registered.
-- It appears in gaps with its type signature.
```

Gaps are prioritized by the conjunction flow: gaps whose resolution would unblock the most suspended computations rank highest. The priority is not static -- it updates on every mount as the dependency graph changes.

## What This Validates

| AC | Expressed by |
|----|-------------|
| `get(path)` returns current value or absence | `get("userName")` returns `"Alice"`; missing path returns `undefined` |
| References followed transparently by `get` | `get("currentModel")` follows `ref(activeModel)` to return target's value |
| Circular references return `undefined`, not infinite loop | Visited set in `get()` detects cycles |
| `ref(path)` creates live binding that tracks source | `mirror = ref(source)` updates when `source` changes |
| `prev` reads pre-mount snapshot | `counter = prev + 1` increments; `prev.count` reads cross-class state |
| `typeAt(path)` returns effective schema with ancestor composition | `typeAt("metrics.count")` inherits `>= 0` from parent property |
| `rawTypeAt(path)` returns only path-local schema | Excludes ancestor constraints for diagnostic purposes |
| `keys(path)` enumerates children from values and schemas | `keys("tasks")` includes `t3` with schema but no value |
| `getAt(path, seq)` returns historical value at sequence point | `getAt("score", 0)` returns `10` even when current is `42` |
| Invalidated blocks excluded from all reads | Invalidated value at seq 1 not visible via `getAt` |
| Gaps are prioritized and discoverable | `gaps()` returns schema-without-value paths sorted by conjunction priority |
