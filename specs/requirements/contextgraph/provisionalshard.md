# Provisional Shard

## Original Notes

I think this is supposed to be when we boot up or replicate, let's say, some of the core context graph functions at a sub-partition and just replicate it. Any data that we had within that range, let's say that our context, we have a node in our context graph operating on primary key elements A through Z in partition Andrew's metric history, employee activities, or whatever. That chart, we spun up a new instance of the organization process model to operate solely at that shard. That shard is getting a lot of requests; it should be able to, on an update of its page, spawn the request for, or call a function that can create an end with an image with its own image at a new, the next timestamp. Or at some future point in time that exists on some server environment that is created. Right after it gets created, it gets the request to claim certain work, because we can know exactly what that shard is going to have in it with its policies, its snapshot, and all that, and its initial data, which we're going to load onto it. The shard should be able to get set up and start working right away. It would then send a message back to the parent saying, "I want to claim this lock now. I'm going to start taking requests for this sub-partition." At which point the parent can start re-indexing it, reset sending its traffic. Once all of its tasks are done for the data that it has remaining on that shard, it can downscale. I don't know why I use the word provisional here; maybe you could think of another use case, but that was the idea for this.

## Problem Context

- **Actor(s)**: Parent process (owns the full partition), child shard process (takes ownership of a sub-range), clients sending requests that need to be routed to the correct owner.
- **Domain**: Dynamic horizontal scaling of a stateful partition. When a sub-range of a partition is under heavy load, the parent spawns a child shard to handle it. The shard receives a snapshot and starts processing immediately, with zero warm-up.
- **Core Tension**: There must never be a gap in ownership. The parent handles the sub-range until the shard explicitly claims it. And the shard's work must merge back before the shard terminates so nothing is lost. The handoff in both directions (parent -> shard, shard -> parent) must be seamless.

## Requirements

**R1**: The parent process SHALL be able to spawn a child shard for a specified sub-range of its partition.
- *Rationale*: Hot sub-ranges degrade parent performance. Offloading them to a dedicated process restores throughput.
- *Verifiable by*: The parent successfully creates a child shard targeted at a specific key range (e.g., "N-Z").

**R2**: The shard SHALL receive the parent's schemas, policies, and a data snapshot for the sub-range at creation time, enabling it to process requests immediately with zero warm-up.
- *Rationale*: The original notes emphasize "it should be able to get set up and start working right away." Re-deriving configuration from scratch adds unacceptable latency.
- *Verifiable by*: A shard begins processing requests within one operation cycle of creation. It does not need to fetch configuration or replay history.

**R3**: The parent SHALL continue handling all requests for the sub-range until the shard explicitly claims ownership via a lock.
- *Rationale*: If the parent stops before the shard is ready, requests for the sub-range would be dropped. No gap in service is acceptable.
- *Verifiable by*: Between shard creation and lock claim, requests for the sub-range are still handled by the parent.

**R4**: The shard SHALL explicitly claim a lock on the sub-range, signaling to the parent that it is ready to accept traffic.
- *Rationale*: The claim is the handoff signal. The parent can then redirect traffic and stop processing the sub-range locally.
- *Verifiable by*: After the shard claims the lock, the parent redirects sub-range traffic to the shard. Before the claim, no traffic is redirected.

**R5**: Once the shard claims the lock and becomes active, requests for the sub-range SHALL be routed to the shard, not the parent.
- *Rationale*: Dual processing would produce inconsistent state. Exactly one process owns the sub-range at any time.
- *Verifiable by*: After lock claim, the parent does not process sub-range requests. All such requests reach the shard.

**R6**: When load subsides, the shard SHALL enter a draining phase: it completes remaining queued work but rejects new requests, which are forwarded back to the parent.
- *Rationale*: The shard cannot disappear mid-work. Draining ensures all in-flight tasks complete.
- *Verifiable by*: During draining, the shard's queue depth decreases to zero. New requests for the sub-range are handled by the parent.

**R7**: After draining, the shard's results SHALL be merged back into the parent's state before the shard terminates.
- *Rationale*: The shard performed work on behalf of the parent's partition. That work must not be lost when the shard dies.
- *Verifiable by*: After merge, the parent's state for the sub-range reflects all work the shard performed. No data is missing.

**R8**: After merge, the shard SHALL release its lock and become eligible for termination. Traffic for the sub-range SHALL return to the parent.
- *Rationale*: The shard's lifecycle is complete. The parent resumes full ownership of the sub-range.
- *Verifiable by*: After lock release, the parent handles sub-range requests again. The shard process can be safely terminated.

**R9**: The shard lifecycle SHALL progress through a strict phase sequence: initializing -> claiming -> active -> draining -> merged. No backward transitions.
- *Rationale*: Each phase has preconditions from the prior phase. Backward transitions would violate invariants (e.g., re-activating after merge would process with stale state).
- *Verifiable by*: Attempting to move a "draining" shard back to "active" is rejected.

## Acceptance Criteria

**AC1** [R2]: Given a parent with configuration and data for range "A-Z", when it spawns a shard for "N-Z", then the shard receives schemas, policies, and data for "N-Z" and is ready to process within one cycle.

**AC2** [R3, R4]: Given a newly created shard that has not yet claimed its lock, when a request for "N-Z" arrives, then the parent handles it.

**AC3** [R4, R5]: Given a shard that has claimed its lock on "N-Z", when a request for "N-Z" arrives, then it is routed to the shard, not the parent.

**AC4** [R6]: Given an active shard with 5 queued tasks, when draining begins, then the 5 tasks complete and new requests for the sub-range go to the parent.

**AC5** [R7]: Given a shard that processed 100 tasks during its active phase, when it merges and terminates, then the parent's state for the sub-range reflects all 100 task results.

**AC6** [R8]: Given a shard that has merged, when it releases its lock, then the parent handles sub-range requests again and the shard process is terminated.

**AC7** [R9]: Given a shard in "draining" phase, when an attempt is made to transition it back to "active", then the attempt is rejected.

## Open Questions

- **Spawn trigger**: What condition triggers shard creation -- a load threshold, manual decision, or policy-driven heuristic?
- **Multiple shards**: Can the parent spawn multiple shards for different sub-ranges simultaneously? Can sub-ranges overlap?
- **Merge conflicts**: If the parent has processed state changes for the sub-range between shard creation and lock claim (during the overlap period), how are those reconciled during merge?
