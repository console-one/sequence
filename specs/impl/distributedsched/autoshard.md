# Auto Sharding

A single partition accumulates data until it becomes a bottleneck. The system must detect when a partition is overloaded and split it into children -- without data loss, without interrupting active writers, and without manual intervention. After the split, writers addressing the original partition are seamlessly routed to the correct child.

There are no polling loops. There is no timer-based threshold check. The split fires on the write that crosses the threshold, because the threshold is a predicate on the partition's own state.

## The Partition Type

A partition has a configurable maximum key count and a derived key count. The split condition is not a callback -- it is a predicate on stored values:

```ft
Partition = {
  maxKeys: number.integer >= 1,
  keyCount: number.integer >= 0,
  status: "active" | "splitting" | "split",
  splitPolicy: "range" | "hash"
}
```

The key count is a derived metric computed from the partition's contents, not a manually maintained counter. The split policy determines how keys are distributed to children.

## The Split Trigger

When key count exceeds the threshold, the partition's status transitions. This is a declarative condition -- it fires at the exact moment the predicate becomes true, not on a subsequent check cycle:

```ft
partition1 = Partition
partition1 << { maxKeys: 1000, splitPolicy: "range" }
```

The status transitions to "splitting" when `keyCount > maxKeys`. Writing the 1001st key causes this predicate to hold, which triggers the status change. No polling, no timer -- the write that crosses the threshold is the write that fires the split.

## Child Partitions

After a split, the parent produces two children. Each child is itself a Partition (and can therefore split recursively). The children inherit the parent's configuration:

```ft
ChildPartition = Partition

splitResult = {
  left: ChildPartition,
  right: ChildPartition,
  boundary: string
}
```

The boundary determines which keys route to which child. For range-based splitting, keys below the boundary go left, keys at or above go right. For hash-based splitting, the boundary encodes the modulus assignment.

All original keys must appear in exactly one child -- no duplicates, no losses. This is the data preservation invariant.

## Transparent Routing

After a split, writes directed at the original partition path must land in the correct child. The original path becomes a routing reference, not a data container:

```ft
partition1 << { status: "split" }
partition1 << { router: ref(splitResult) }
```

Writers continue using the original path. The router intercepts and forwards to the appropriate child based on the key and the boundary. Writers do not need to know the split occurred.

## Suspended Operations

Pending operations that existed before the split must survive. They are not discarded -- they are carried forward to the appropriate child partition:

```ft
tool Partition.router
tool ChildPartition.keyCount
```

A suspended operation referencing the original partition is reassociated with whichever child partition owns the relevant keys. The operation remains retrievable and resolvable.

Atomicity of the split is critical: concurrent readers see either the complete pre-split state or the complete post-split state, never a partial view where some keys are missing from both partitions or duplicated across both.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Configurable threshold | `partition1 << { maxKeys: 1000 }` |
| Auto-split on threshold breach | Status transitions to "splitting" when `keyCount > maxKeys` on the crossing write |
| Data preservation across split | `splitResult` contains `left` and `right` whose union equals original keys |
| Transparent routing after split | `router: ref(splitResult)` forwards writes to correct child |
| Declarative trigger, no polling | Condition on stored values, not a timer or poll loop |
| Suspended operations survive | Operations carry forward to child partitions; schema remains so obligations surface |
| Atomic split for readers | Readers see pre-split or post-split state, never an intermediate |
