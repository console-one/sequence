# Backpressure

## Problem Context

- **Actor(s)**: Producers (submit work items), Workers (process items at a limited rate), the queue (enforces capacity)
- **Domain**: Flow control -- preventing a fast producer from overwhelming a slow consumer by gating submissions on available processing capacity
- **Core Tension**: Capacity must be a constraint on the data flow, not a separate mechanism. Items must never be silently dropped; when capacity is full, submissions must suspend visibly. Adaptive capacity (derived from external conditions) means the limit can shift while items are in-flight.

## Requirements

**R1**: The queue SHALL have three partitions: pending, active, and done. Each item SHALL reside in exactly one partition at any time.
- *Rationale*: Clear partitioning defines the item lifecycle and prevents ambiguity about item state.
- *Verifiable by*: After any operation, each item appears in exactly one partition.

**R2**: The queue SHALL have a configurable capacity limit (minimum 1) specifying the maximum number of items allowed in the active partition simultaneously.
- *Rationale*: The capacity limit is the core backpressure mechanism.
- *Verifiable by*: Setting capacity and confirming it is stored and enforced.

**R3**: Submitting an item when the active partition has fewer items than the capacity limit SHALL succeed immediately, placing the item in the active partition.
- *Rationale*: Below-capacity submissions should proceed without delay.
- *Verifiable by*: Submitting items up to capacity and confirming each enters active immediately.

**R4**: Submitting an item when the active partition is at capacity SHALL cause the item to enter the pending partition and the submission to suspend visibly (not be silently dropped or rejected).
- *Rationale*: No work is lost. The producer is informed that the item is queued, not processed.
- *Verifiable by*: Submitting a (capacity+1)th item and confirming it is visible in pending.

**R5**: Completing an item SHALL atomically move it from the active partition to the done partition.
- *Rationale*: Completion must be atomic to prevent double-processing or lost results.
- *Verifiable by*: Completing an item and confirming it appears in done and is removed from active in one operation.

**R6**: When a completion reduces the active count below capacity, the oldest pending item SHALL automatically move from pending to active without manual intervention.
- *Rationale*: Freed capacity must immediately admit waiting work. FIFO ordering among pending items is fair.
- *Verifiable by*: Completing an item when items are pending, and confirming the oldest pending item enters active.

**R7**: The capacity limit SHALL support being a derived value (based on system load, memory, etc.) that can change at runtime.
- *Rationale*: Adaptive capacity allows the system to respond to changing conditions.
- *Verifiable by*: Changing the derived capacity source and confirming the queue respects the new limit.

**R8**: If the capacity limit decreases below the current active count, already-active items SHALL NOT be preempted. No new items SHALL enter active until the active count naturally falls below the new limit.
- *Rationale*: Preempting in-flight work is destructive. The system must drain gracefully.
- *Verifiable by*: Reducing capacity below active count and confirming active items continue uninterrupted while no new items enter active.

**R9**: Given N total items and capacity C, the system SHALL process all N items with at most C in-flight at any time (drain pattern).
- *Rationale*: Backpressure guarantees bounded concurrency while ensuring all work completes.
- *Verifiable by*: Submitting 10 items with capacity 3 and confirming at most 3 are active at any point, and all 10 eventually reach done.

## Acceptance Criteria

**AC1** [R3]: Given capacity of 3, when submitting items t1, t2, t3, then all three enter the active partition immediately.

**AC2** [R4]: Given capacity of 3 with 3 active items, when submitting t4, then t4 enters the pending partition and is visible as waiting.

**AC3** [R5, R6]: Given t4 pending and active at capacity, when t1 is completed (moved to done), then t4 automatically moves from pending to active.

**AC4** [R5]: Given an active item t1, when t1 is completed, then t1 appears in done and is removed from active atomically.

**AC5** [R7]: Given capacity derived from an external source, when that source changes the value from 3 to 5, then the queue respects the new capacity of 5.

**AC6** [R8]: Given capacity reduced from 3 to 1 with 3 items currently active, when no completions have occurred, then all 3 items remain active and no new items enter active until active count drops below 1.

**AC7** [R9]: Given 10 items submitted with capacity 3, when all items are processed, then at no point are more than 3 items active, and all 10 eventually reach done.

## Open Questions

- Should pending items have a maximum wait time or deadline after which they are expired rather than promoted?
- When capacity decreases and the pending queue grows, should there be a maximum pending queue size or is it unbounded?
