# Docker EC2 Container

## Original Notes

(No original notes were captured for this component. The requirements below are derived from the architectural description of the Docker EC2 orchestrator role.)

## Problem Context

- **Actor(s)**: Orchestrator process (single EC2 instance per organization), downstream workers (Lambda, local nodes, remote nodes), administrators.
- **Domain**: Central coordination of a distributed system -- the orchestrator owns a partition of organizational state and acts as the authoritative scheduler, lock arbiter, and state manager for all connected workers.
- **Core Tension**: A single orchestrator gives clean, unambiguous lock arbitration and routing decisions, but is a single point of failure. If it dies, the entire partition is orphaned until recovery. The design trades resilience for scheduling simplicity.

## Requirements

**R1**: The orchestrator SHALL claim exclusive ownership of an organizational partition on boot. No other orchestrator process SHALL hold the same partition simultaneously.
- *Rationale*: Dual ownership would produce conflicting lock decisions and split-brain scheduling.
- *Verifiable by*: A second orchestrator attempting to claim the same org partition is rejected.

**R2**: The orchestrator SHALL maintain a live registry of all connected workers, including worker type (Lambda, local, remote), declared capabilities, connection status, and last heartbeat timestamp.
- *Rationale*: Scheduling and lock decisions require accurate knowledge of the worker pool.
- *Verifiable by*: Querying the registry returns current metadata for all connected workers.

**R3**: When a worker's heartbeat exceeds its deadline, the orchestrator SHALL automatically transition that worker to "expired" status and release all locks held by that worker.
- *Rationale*: Dead workers holding locks would block task reassignment indefinitely.
- *Verifiable by*: A worker that stops heartbeating has its status set to "expired" and its locked tasks become available without manual intervention.

**R4**: The orchestrator SHALL route tasks to workers based on declared capabilities, matching task requirements to worker declarations.
- *Rationale*: Tasks must only be assigned to workers that can actually execute them.
- *Verifiable by*: A task requiring capability X is never assigned to a worker that did not declare X.

**R5**: The orchestrator SHALL support configurable scheduling strategies (e.g., round-robin, capability-match, priority-based).
- *Rationale*: Different workloads benefit from different scheduling policies. The strategy should not be hardcoded.
- *Verifiable by*: Changing the scheduling strategy changes the order in which eligible workers receive tasks.

**R6**: When a lock expires due to worker death, the orchestrator SHALL notify the new assignee of the task and, if the original worker is reachable, notify it of lock revocation.
- *Rationale*: Prevents duplicate execution -- the old worker must know its lock was revoked, and the new worker must know it now owns the task.
- *Verifiable by*: After lock expiration, the replacement worker receives the task assignment and the original worker (if reconnected) receives a revocation notice.

**R7**: The orchestrator SHALL enforce access permissions per partition path, controlling which workers can read, write, or claim locks within specific regions of the state tree.
- *Rationale*: Not all workers should have access to all organizational state. Permission boundaries prevent unauthorized state mutation.
- *Verifiable by*: A worker with "read" permission on a path is rejected when attempting to write to that path.

**R8**: The orchestrator SHALL support hierarchical sub-partitions that can be delegated to specific workers, with isolation between sibling sub-partitions.
- *Rationale*: Work can be hierarchically organized -- a delegated sub-partition allows a worker to operate within a boundary without affecting siblings.
- *Verifiable by*: A worker delegated sub-partition A cannot read or write state in sibling sub-partition B.

**R9**: The orchestrator SHALL archive old state when the active log exceeds a configurable size threshold, using a two-tier strategy: bulk data to object storage and index/label metadata to a queryable database.
- *Rationale*: Unbounded state growth degrades runtime performance. Historical data must remain retrievable but not burden active memory.
- *Verifiable by*: After archival, the active log size is below the threshold, and archived entries are retrievable from external storage.

**R10**: The orchestrator SHALL provide a socket-based communication channel for real-time bidirectional messaging with workers (registration, heartbeat, task assignment).
- *Rationale*: Workers need a persistent channel for low-latency interaction with the orchestrator.
- *Verifiable by*: Workers can register, heartbeat, and receive task assignments over a single socket connection.

## Acceptance Criteria

**AC1** [R1]: Given an orchestrator holding partition "org-xyz", when a second orchestrator attempts to claim "org-xyz", then the second claim is rejected and the first retains exclusive ownership.

**AC2** [R2, R3]: Given a worker with a 10-second heartbeat deadline, when 10 seconds pass without a heartbeat, then the worker's registry status is "expired" and all its locks are released.

**AC3** [R4, R5]: Given two workers (W1 with capability A, W2 with capabilities A and B) and a task requiring capability B, when the task is scheduled, then it is assigned only to W2.

**AC4** [R6]: Given worker W1 holding a lock on task T, when W1 is marked expired and T is reassigned to W2, then W2 receives the assignment notification and W1 (if reconnectable) receives a revocation notice.

**AC5** [R7]: Given worker W1 with "read" permission on path "/data/reports", when W1 attempts to write to "/data/reports/q1", then the write is rejected.

**AC6** [R8]: Given sub-partitions "/data/shard-a" delegated to W1 and "/data/shard-b" delegated to W2, when W1 attempts to read "/data/shard-b", then the read is denied.

**AC7** [R9]: Given an active log of 10,000 entries and a threshold of 5,000, when archival runs, then entries beyond the threshold are moved to external storage and the active log contains at most 5,000 entries. Archived entries remain queryable.

## Open Questions

- **Orchestrator failover**: What happens when the EC2 orchestrator dies? Is there a standby, or does the partition remain orphaned until manual recovery?
- **Partition handoff**: Can partition ownership be transferred between orchestrators without downtime?
- **Archival granularity**: Is archival all-or-nothing past the threshold, or can specific subtrees be selectively archived?
