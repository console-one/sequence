# Gate Queues

## Original Notes

From conversation audit: "ref gates that pipe to internal blocks with state machine like logic to trigger external callables."

---

## Problem Context

- **Actor(s)**: Producers (submit items freely), Workers (process items subject to concurrency constraints), the queue (enforces capacity gate)
- **Domain**: Concurrency-limited work scheduling -- items flow through a three-partition lifecycle (pending, active, done) with a gate on the pending-to-active transition that enforces a maximum active worker count
- **Core Tension**: Enqueue must always succeed (producers are never blocked). Dequeue must be gated on capacity. Completion must free capacity and automatically resume suspended dequeues. No external dispatcher, no polling, no orchestrator.

## Requirements

**R1**: The queue SHALL have three partitions: pending, active, and done. Each item SHALL reside in exactly one partition at any time.
- *Rationale*: Clear partitioning defines the item lifecycle.
- *Verifiable by*: After any operation, every item appears in exactly one partition.

**R2**: The queue SHALL have a configurable maximum active limit (minimum 1) specifying the maximum number of items allowed in the active partition simultaneously.
- *Rationale*: The active limit is the concurrency gate.
- *Verifiable by*: Setting a limit and confirming it is enforced.

**R3**: Enqueuing an item SHALL always succeed, placing it in the pending partition. Producers SHALL never be blocked.
- *Rationale*: Submission must be unconditional to decouple producers from consumer throughput.
- *Verifiable by*: Submitting items regardless of active count and confirming all appear in pending.

**R4**: Moving an item from pending to active SHALL succeed only when the number of items currently in active is less than the maximum active limit. This move SHALL be atomic.
- *Rationale*: The capacity gate prevents overcommitment. Atomicity prevents race conditions.
- *Verifiable by*: With max active of 2 and 2 items active, a third dequeue does not proceed.

**R5**: When a dequeue is attempted but the active partition is at capacity, the dequeue intent SHALL be suspended (not rejected) and SHALL resume automatically when capacity becomes available.
- *Rationale*: Suspended intent preserves work ordering; rejection would require the caller to poll or retry.
- *Verifiable by*: A dequeue blocked on capacity proceeds automatically after a completion frees capacity.

**R6**: Completing an item SHALL atomically move it from the active partition to the done partition, attaching a result.
- *Rationale*: Atomic completion prevents items from being lost between partitions.
- *Verifiable by*: Completing an item and confirming it appears in done with a result and is removed from active.

**R7**: When a completion reduces the active count below the maximum active limit, the oldest suspended dequeue SHALL automatically resume.
- *Rationale*: Freed capacity must immediately admit the next waiting item. FIFO ordering is fair.
- *Verifiable by*: Completing an item when dequeues are suspended and confirming the oldest suspended dequeue proceeds.

**R8**: Each work item SHALL have a typed payload and a typed result.
- *Rationale*: Workers need structured input and must produce structured output.
- *Verifiable by*: Enqueueing an item with a payload and confirming the completed item has both payload and result.

**R9**: Workers SHALL be typed functions whose input type matches the item's payload type and whose output type matches the item's result type.
- *Rationale*: Type-safe processing prevents workers from receiving items they cannot handle.
- *Verifiable by*: A worker with mismatched types is not assigned items.

**R10**: Multiple independent queues SHALL be supported, each with its own maximum active limit. Queues SHALL NOT interfere with each other.
- *Rationale*: Different workloads may need different concurrency limits.
- *Verifiable by*: Queue A with max active 1 and queue B with max active 5 enforce their limits independently.

## Acceptance Criteria

**AC1** [R3]: Given a queue with max active 2, when 4 items are enqueued, then all 4 appear in the pending partition.

**AC2** [R4]: Given a queue with max active 2, when items t1 and t2 are dequeued (moved to active), then both succeed. When t3 is dequeued, it does not proceed (active is at capacity).

**AC3** [R5, R7]: Given t3's dequeue suspended from AC2, when t1 is completed (moved to done), then t3 automatically moves from pending to active.

**AC4** [R6]: Given an active item t1, when t1 is completed with result "done-a", then t1 appears in done with payload and result, and is removed from active.

**AC5** [R4]: Given a dequeue operation, when it moves an item from pending to active, then the item is removed from pending and added to active in a single atomic step.

**AC6** [R10]: Given queue A with max active 1 and queue B with max active 5, when queue A is at capacity, then queue B can still dequeue items up to its own limit.

## Open Questions

- Should there be a maximum pending queue size, or is the pending partition unbounded?
- When multiple dequeues are suspended, is FIFO the only resumption order, or should priority be configurable?
- Can the maximum active limit be changed at runtime, and if so, what happens to already-active items if the limit decreases?
