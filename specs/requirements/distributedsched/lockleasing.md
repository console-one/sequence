# Lock Leasing

A lock is a temporary, exclusive write permission over a partition, granted to a remote delegate and maintained by continuous proof-of-life. Three conditions must hold simultaneously for a lock to remain valid: the delegate's capabilities must match the partition's requirements, the offer must be confirmed before its deadline, and the holder must keep heartbeating. When any condition fails, the lock revokes automatically and dependent operations cascade.

There are no manual lock cleanups. There is no possibility of two holders. The lock is a conjunction of conditions -- it exists exactly as long as all conditions hold.

## Problem Context

- **Actor(s)**: Partition owners (offer locks), delegates (accept and hold locks), operations (depend on lock validity).
- **Domain**: Distributed mutual exclusion with lease-based ownership and capability-gated access control.
- **Core Tension**: Locks must provide mutual exclusion (at most one holder) while being automatically cleaned up when the holder fails. The three-way conjunction (capability match + deadline confirmation + heartbeat liveness) is the minimum set of conditions that prevents both unauthorized access and zombie locks.

## Requirements

**R1**: A lock offer SHALL be generated only when the delegate's capabilities match the partition's required capability.
- *Rationale*: Offering a lock to an incapable delegate wastes time and creates a false sense of progress. Capability matching is a precondition, not a post-hoc check.
- *Verifiable by*: A delegate without the required capability never receives an offer for a partition requiring that capability.

**R2**: Each lock offer SHALL have a confirmation deadline. If the delegate does not confirm before the deadline, the offer SHALL be automatically withdrawn.
- *Rationale*: An unconfirmed offer blocks the partition from being offered to another delegate. Deadlines prevent indefinite blocking by unresponsive delegates.
- *Verifiable by*: An offer with a 30-second deadline that is not confirmed within 30 seconds transitions to "withdrawn" status.

**R3**: When a delegate confirms an offer before the deadline, a lock SHALL be granted, giving the delegate exclusive write permission over the partition.
- *Rationale*: Confirmation is the bilateral agreement that establishes the lock. Without it, the delegate has not accepted responsibility.
- *Verifiable by*: After confirmation, a lock record exists with status "active", the confirming delegate as holder, and the target partition.

**R4**: The lock holder SHALL maintain the lock through periodic heartbeats. If heartbeats cease for longer than a configurable heartbeat window, the lock SHALL be automatically revoked.
- *Rationale*: A delegate that crashes while holding a lock must not block the partition indefinitely. Heartbeat-based liveness is the standard lease maintenance mechanism.
- *Verifiable by*: A lock whose holder stops heartbeating for longer than the heartbeat window transitions to "revoked" status.

**R5**: At most one delegate SHALL hold an active lock on a given partition at any time.
- *Rationale*: Mutual exclusion is the fundamental purpose of a lock. Two simultaneous holders would allow conflicting writes.
- *Verifiable by*: While one lock is active on a partition, a second lock request for the same partition does not activate; it waits until the first lock ends.

**R6**: When a lock is revoked, all operations that depended on the lock being active SHALL be invalidated.
- *Rationale*: Operations performed under a lock's authority (writes, routing rules, in-flight tasks) are only valid while the lock holds. Continuing them after revocation risks data corruption.
- *Verifiable by*: An operation conditioned on a lock being active terminates or suspends when the lock is revoked.

**R7**: After a lock is revoked or released, the partition SHALL become available for new lock offers.
- *Rationale*: A partition that remains locked after revocation is permanently inaccessible. The lock lifecycle must be fully renewable.
- *Verifiable by*: After a lock is revoked, a new offer can be generated and confirmed for the same partition.

**R8**: Writes performed under an active lock SHALL be propagated back to the partition owner.
- *Rationale*: The delegate writes on behalf of the partition owner. If writes are not propagated, the owner's state becomes inconsistent.
- *Verifiable by*: A write made by the lock holder is visible to the partition owner after the lock is released or revoked.

## Acceptance Criteria

**AC1** [R1]: Given a partition requiring capability "dataTransform" and a delegate offering only "parseData", when the system evaluates offer eligibility, then no offer is generated for that delegate.

**AC2** [R1]: Given a partition requiring "dataTransform" and a delegate offering "dataTransform", when the system evaluates offer eligibility, then an offer is generated.

**AC3** [R2]: Given an offer with `deadline: 30000` that is not confirmed within 30 seconds, when the deadline elapses, then the offer status transitions to "withdrawn".

**AC4** [R2, R3]: Given an offer with `deadline: 30000` that is confirmed at 15 seconds, when the confirmation is processed, then a lock is created with status "active".

**AC5** [R4]: Given an active lock with `heartbeatWindow: 2000` whose holder stops heartbeating, when 2 seconds elapse without a heartbeat, then the lock status transitions to "revoked".

**AC6** [R4]: Given an active lock whose holder sends heartbeats within the window, when the heartbeat window is evaluated, then the lock remains "active".

**AC7** [R5]: Given an active lock on partition A held by delegate 1, when delegate 2 requests a lock on partition A, then delegate 2's request does not activate until delegate 1's lock ends.

**AC8** [R6]: Given operations conditioned on lock1 being active, when lock1 is revoked, then those operations are invalidated.

**AC9** [R7]: Given a revoked lock on partition A, when a new offer is generated for partition A, then the offer can be confirmed and a new lock can be granted.

**AC10** [R8]: Given a lock holder that writes data to the partition during an active lock, when the lock is released, then the written data is visible to the partition owner.

## Open Questions

- **Offer routing**: When an offer is withdrawn due to deadline expiry, should the system automatically generate a new offer for the next eligible delegate, or wait for an explicit re-offer?
- **Heartbeat window vs. offer deadline**: Should the heartbeat window and offer deadline be independently configurable, or should the heartbeat window always be shorter than the offer deadline?
- **Partial write propagation**: If a lock is revoked mid-write, are partial writes rolled back or committed? This determines the atomicity guarantee of lock-scoped operations.
