# Auto Sharding

A single partition accumulates data until it becomes a bottleneck. The system must detect when a partition is overloaded and split it into children -- without data loss, without interrupting active writers, and without manual intervention. After the split, writers addressing the original partition are seamlessly routed to the correct child.

There are no polling loops. There is no timer-based threshold check. The split fires on the write that crosses the threshold, because the threshold is a predicate on the partition's own state.

## Problem Context

- **Actor(s)**: Partition owners (data stores), writers (producers of key-value data), readers (consumers querying partitions).
- **Domain**: Horizontal partitioning of key-value data stores under write pressure.
- **Core Tension**: Splitting a live partition requires atomicity (no data loss, no duplicates) while maintaining transparent routing so writers do not need to know a split occurred.

## Requirements

**R1**: Each partition SHALL have a configurable maximum key count threshold.
- *Rationale*: Different partitions serve different workloads; a fixed threshold cannot accommodate varying data densities.
- *Verifiable by*: A partition created with threshold T reports T as its maximum key count.

**R2**: The system SHALL trigger a split on the exact write that causes the key count to exceed the configured threshold.
- *Rationale*: Polling-based or timer-based detection introduces latency windows where the partition operates beyond capacity. The triggering write is the natural detection point.
- *Verifiable by*: After writing key N+1 to a partition with threshold N, the partition's status is "splitting" before any subsequent operation is processed.

**R3**: The split SHALL produce exactly two child partitions whose combined key set equals the parent's original key set, with no duplicates and no losses.
- *Rationale*: Data preservation is the fundamental correctness invariant of any partitioning operation.
- *Verifiable by*: The union of keys across both children equals the parent's pre-split key set; the intersection is empty.

**R4**: Each child partition SHALL inherit the parent's configuration (threshold, split policy) and SHALL itself be splittable.
- *Rationale*: Recursive splitting is necessary for sustained growth. Children that cannot split would eventually become the same bottleneck as the parent.
- *Verifiable by*: A child partition, after accumulating keys beyond its inherited threshold, triggers its own split.

**R5**: The system SHALL support both range-based and hash-based split policies.
- *Rationale*: Range splits preserve key ordering (useful for range scans); hash splits distribute load evenly (useful for uniform write pressure). Different workloads need different strategies.
- *Verifiable by*: A range-split places keys below the boundary in the left child and keys at or above in the right. A hash-split distributes keys by modulus assignment.

**R6**: After a split, writes directed at the original partition path SHALL be transparently routed to the correct child partition based on the key and boundary.
- *Rationale*: Writers should not need to discover or track partition topology changes. Transparent routing decouples producers from partition structure.
- *Verifiable by*: A writer using the original partition path successfully writes a key, and the key appears in the correct child partition.

**R7**: Pending operations that existed before the split SHALL be carried forward to the appropriate child partition.
- *Rationale*: In-flight work must not be silently discarded during a structural change. Operations must remain retrievable and resolvable.
- *Verifiable by*: An operation pending against the parent partition before the split is retrievable and resolvable against the correct child partition after the split.

**R8**: The split SHALL be atomic with respect to readers: concurrent readers SHALL observe either the complete pre-split state or the complete post-split state, never a partial view.
- *Rationale*: Partial visibility (some keys missing from both partitions, or duplicated across both) would violate data integrity from the reader's perspective.
- *Verifiable by*: A reader querying during a split never observes a key count less than or greater than the total pre-split key count.

## Acceptance Criteria

**AC1** [R1]: Given a partition created with `maxKeys: 1000`, when the partition configuration is queried, then `maxKeys` reports 1000.

**AC2** [R2]: Given a partition with `maxKeys: 1000` and exactly 1000 keys, when the 1001st key is written, then the partition status transitions to "splitting" before the next operation is processed.

**AC3** [R3]: Given a partition that has completed a split, when the key sets of both children are enumerated, then their union equals the parent's original key set and their intersection is empty.

**AC4** [R4]: Given a child partition produced by a split, when the child accumulates keys beyond its inherited threshold, then the child triggers its own split.

**AC5** [R5, range]: Given a partition with `splitPolicy: "range"` that splits at boundary B, when keys are distributed, then all keys < B are in the left child and all keys >= B are in the right child.

**AC6** [R5, hash]: Given a partition with `splitPolicy: "hash"` that splits, when keys are distributed, then keys are assigned to children by modulus of their hash value.

**AC7** [R6]: Given a split partition, when a writer sends a write to the original partition path with a specific key, then the write lands in the child partition that owns that key.

**AC8** [R7]: Given a pending operation against a parent partition, when the parent splits, then the operation is retrievable and resolvable against the child partition that owns the relevant keys.

**AC9** [R8]: Given a reader querying during an active split, when the reader enumerates keys, then the reader observes either the complete pre-split set or the complete post-split set.

## Open Questions

- **Boundary selection strategy**: For range-based splits, how is the split boundary chosen? Median key? Configurable? This affects balance quality but is not specified.
- **Split-during-split**: If a child partition reaches its threshold while the parent split is still finalizing, should the child split be queued or rejected?
- **Routing overhead**: After many recursive splits, the routing tree may become deep. Is there a rebalancing or flattening mechanism?
