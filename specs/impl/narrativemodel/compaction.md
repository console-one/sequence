# Document History Compaction

A document accumulates edits over its lifetime -- an append-only log that grows without bound. Compaction collapses old edits into a snapshot, reclaiming space while preserving the current projection exactly. The hard part: suspended operations (pending work that may resume at any time) must survive compaction, and the snapshot at the cutoff boundary must be a valid reconstruction for historical queries.

There are no destructive mutations. Compaction is a structural transformation of the log -- it replaces a range of entries with a single snapshot entry per path, leaving everything after the cutoff untouched.

## The Document Log

A document is an ordered log of entries. Each entry writes a value at a path. The current document state is the projection of the log -- last write to each path wins. Schemas are structural declarations that constrain future writes:

```ft
DocumentLog = {
  entries: {
    path: string,
    value: string,
    position: number.integer >= 0,
    kind: "write" | "schema" | "suspended"
  },
  currentPosition: number.integer >= 0
}
```

The `kind` field distinguishes ordinary writes from schema declarations and suspended operations. This distinction is what compaction uses to decide what to keep.

## The Compaction Snapshot

Compaction takes a cutoff position and collapses all entries before that point into snapshot entries -- one per path, holding the last value written before the cutoff. The snapshot replaces the original entries:

```ft
CompactionResult = {
  compacted: {
    path: string,
    value: string,
    cutoff: number.integer >= 0
  },
  removed: number.integer >= 0,
  kept: number.integer >= 0
}
```

After compaction, the document log contains: the snapshot entries (one per path), all schema entries (regardless of position), all suspended entries (regardless of position), and all entries after the cutoff. The projection is identical -- every readable path returns the same value as before.

## Performing Compaction

Given a document with accumulated edits, compaction mounts a snapshot at the cutoff boundary:

```ft
doc = DocumentLog
doc << { currentPosition: 103 }
```

The compaction operation itself is a transformation on the log. Entries before the cutoff are collapsed, schemas and suspensions are preserved:

```ft
compactionResult = CompactionResult
compactionResult << { removed: 87, kept: 16 }
```

The `removed` and `kept` counts are observability output -- they sum to the original total entry count.

## Schema Preservation

Schema declarations are never compacted. They define the document's structural constraints and must survive indefinitely. A schema declared at position 2 is still enforceable after compaction at position 90:

```ft
schema = {
  path: string,
  constraint: string,
  position: number.integer >= 0
}
```

After compaction, writing a value that violates a schema is still rejected or suspended, identically to pre-compaction behavior.

## Suspension Durability

Suspended operations are pending work -- a write gated on a condition that is not yet met. They must survive compaction regardless of their position relative to the cutoff:

```ft
suspended = {
  path: string,
  value: string,
  condition: string,
  position: number.integer >= 0
}
```

A suspended operation at position 20 survives compaction at cutoff 90. When the condition is later satisfied, the operation resumes and is applied as a new entry in the current (post-cutoff) history. The resumed operation's position is the current position, not the original position -- it appears in the recent, uncompacted portion of the log.

## Historical Queries

Historical queries behave differently depending on whether the queried point is before or after the cutoff:

- After cutoff: exact value at the queried position (full fidelity preserved).
- Before cutoff: snapshot value (last value before cutoff). Fine-grained per-position history is traded for space.

This degradation is deterministic and predictable. The cutoff boundary is the dividing line between compressed history and full-fidelity history.

## Capabilities

Compaction is a system-level operation on the document log. The cutoff selection and the compaction execution are both externally provided:

```ft
cap CompactionResult.removed
cap CompactionResult.kept
cap CompactionResult.compacted
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| 100 edits compacted, projection unchanged | `CompactionResult` with `removed`/`kept` counts; projection invariance is the core property |
| Historical query before cutoff returns snapshot | Snapshot entry holds last value before cutoff; queries before cutoff resolve to it |
| Historical query after cutoff returns exact value | Entries after cutoff are untouched -- full fidelity |
| Schemas survive compaction | Schema entries have `kind: "schema"` and are exempt from collapse |
| Suspended ops survive compaction | Suspended entries have `kind: "suspended"` and are exempt from collapse |
| Resumed suspended op appears in current history | Resumed operation is applied at `currentPosition`, not original position |
| Compaction reports removed and kept counts | `CompactionResult << { removed: 87, kept: 16 }` provides observability |
