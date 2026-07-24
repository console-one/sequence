# Snapshotting

State is built up incrementally through many operations. Keeping the full history is necessary for auditing and replay, but expensive in memory. Snapshotting collapses resolved history into a single materialized state at a specified point -- reducing memory footprint and establishing recovery points. The snapshot must be observationally equivalent to the pre-compaction state: any read that returned a value before compaction returns the same value after.

Snapshotting is elective. The caller decides when and where to compact. The system never automatically discards history.

## The Snapshot Type

A snapshot captures the materialized state at a compaction point. It includes the compaction boundary (which operations were collapsed), the resulting state, and any suspended operations that survived:

```ft
Snapshot = {
  compactedThrough: number.integer >= 0,
  state: ref(materializedState),
  suspendedCount: number.integer >= 0,
  serializable: boolean
}
```

The `compactedThrough` index marks the boundary. Operations before this index are collapsed into `state`. Operations at or after this index remain as individual operations. Suspended operations are never collapsed -- they survive compaction regardless of when they were created.

## Compaction at a Specified Point

The caller controls the compaction boundary. This is not automatic -- it is an explicit request to compact everything before a given operation index:

```ft
snapshot1 = Snapshot
snapshot1 << { compactedThrough: 50 }
```

Operations 0 through 49 are collapsed into the snapshot's materialized state. Operations 50 through the current head remain individually accessible. The caller chooses the boundary based on their retention needs -- different processes may retain different amounts of history.

## Observational Equivalence

The defining property of compaction: reads are identical before and after. If a path returned value V before compaction, it returns value V after compaction. Compaction is a storage optimization, not a semantic change:

```ft
-- Before compaction: name = "Alice", counter = 250, email = "alice@co.com"
-- After compaction: same values, fewer stored operations
snapshot1 << { state: ref(materializedState) }
```

When multiple operations wrote to the same path, the snapshot preserves only the final effective value. If `counter` was written 5 times (1, 2, 3, 4, 5), the snapshot contains only 5. Intermediate values are discarded because they are not observable in the current state.

## Suspended Operations Survive

Suspended operations are pending work -- they are waiting for conditions to be met. Compaction must not discard them. A suspended operation that existed before compaction is still retrievable and resolvable after compaction:

```ft
snapshot1 << { suspendedCount: 3 }
```

Even if a suspended operation was created during the compacted range (e.g., operation 20 out of 50 compacted operations), it carries forward. The suspension's schema still exists in the post-compaction state, so it continues to appear in obligations.

Suspended operations that reference values which were overwritten during compaction see the final (post-compaction) value, not intermediate values. This is consistent with observational equivalence -- the snapshot represents the same state, just more compactly.

## Serialization for Archival

The snapshot output is suitable for external persistence. It can be serialized, stored remotely, and deserialized to recover state:

```ft
snapshot1 << { serializable: true }
tool Snapshot.state
tool Snapshot.compactedThrough
```

A serialized snapshot, when deserialized, produces the same materialized state as the original. This enables recovery points -- the system can be restored to the snapshotted state.

Historical queries for operations that occurred before the compaction point require access to the archived snapshot, not the live state. Compaction discards derivation history from live state; if detailed historical queries are needed, they must reference the archive.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Resolved operations compacted into snapshot | `snapshot1 << { compactedThrough: 50 }` collapses operations 0-49 |
| Observational equivalence maintained | All readable paths return same values before and after compaction |
| Suspended operations survive compaction | `suspendedCount: 3` -- suspensions carry forward, remain pending |
| Only final value preserved for overwritten paths | Intermediate writes discarded; snapshot holds last effective value |
| Caller controls compaction boundary | `compactedThrough` is specified by the caller, not automatic |
| Historical queries require archive | Pre-compaction operation detail not available in live state |
| Snapshot is serializable | `serializable: true` -- output suitable for external persistence |
