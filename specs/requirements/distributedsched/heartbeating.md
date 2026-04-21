# Heartbeating

A distributed system has workers that can die silently. The orchestrator needs to know which workers are alive without polling. The solution: workers publish timestamps, and liveness is a predicate on the stored timestamp vs current time. When the predicate fails, everything conditioned on that worker being alive invalidates automatically.

There are no timers. There is no polling. There is only data and conditions on data.

## Problem Context

- **Actor(s)**: Workers (publish heartbeat timestamps), the orchestrator (reads liveness and assigns tasks), tasks (depend on worker liveness).
- **Domain**: Failure detection in distributed systems where workers can crash without sending explicit shutdown signals.
- **Core Tension**: Detecting worker death without polling requires that liveness be a continuously-evaluated condition rather than an event. The system must react to the *absence* of a signal (no heartbeat) as reliably as it reacts to the *presence* of a signal.

## Requirements

**R1**: Each worker SHALL publish a heartbeat timestamp representing its most recent proof of liveness.
- *Rationale*: A timestamp is the minimal, sufficient liveness signal. It can be compared against the current time to determine freshness without maintaining connection state.
- *Verifiable by*: A worker that publishes a heartbeat has a readable, current timestamp recorded.

**R2**: Each worker SHALL have a configurable liveness window defining the maximum acceptable age of a heartbeat.
- *Rationale*: Different workers have different heartbeat frequencies and tolerance for latency. A tight window detects failures quickly but may false-positive on slow networks; a wide window is tolerant but slow to detect failures.
- *Verifiable by*: A worker configured with a 5-second liveness window is considered alive when its heartbeat is less than 5 seconds old, and dead when it is 5 or more seconds old.

**R3**: A worker SHALL be considered alive if and only if its heartbeat timestamp is within the liveness window of the current time.
- *Rationale*: Liveness is a derived condition, not stored state. This ensures it is always consistent with the actual heartbeat data and cannot become stale or contradictory.
- *Verifiable by*: A worker with a fresh heartbeat (within the window) reports alive; the same worker with a stale heartbeat (outside the window) reports dead, with no explicit status change needed.

**R4**: Tasks assigned to a worker SHALL remain assigned only while the worker is alive.
- *Rationale*: A task assigned to a dead worker is stuck. Automatic invalidation frees the task for reassignment.
- *Verifiable by*: A task assigned to a worker that becomes dead is no longer assigned to that worker.

**R5**: When a worker's liveness fails and a task is invalidated, the task's definition SHALL be preserved so it can be reassigned.
- *Rationale*: The task itself is not faulty; only its assignment is. Discarding the task would lose work.
- *Verifiable by*: After a task is invalidated due to worker death, the task is visible as unassigned work available for reassignment.

**R6**: Successive heartbeats from a living worker SHALL refresh the timestamp and maintain the alive status.
- *Rationale*: Continuous heartbeating is the mechanism that keeps the liveness predicate true. Without refresh, every worker would eventually appear dead.
- *Verifiable by*: A worker that sends heartbeats at intervals shorter than its liveness window remains continuously alive.

**R7**: Liveness evaluation SHALL NOT require polling or timer-based checks. It SHALL be evaluated as a condition on stored data whenever the state is read.
- *Rationale*: Polling introduces latency between failure and detection. A condition on stored data evaluates at read time, giving the freshest possible answer.
- *Verifiable by*: No periodic timer or polling loop exists for liveness checks; liveness is computed from the heartbeat timestamp and current time at read time.

## Acceptance Criteria

**AC1** [R1]: Given a worker that sends a heartbeat, when the worker's heartbeat timestamp is queried, then it reflects the most recently published value.

**AC2** [R2]: Given a worker with `livenessWindow: 5000`, when the heartbeat is 4 seconds old, then the worker is alive; when it is 6 seconds old, then the worker is dead.

**AC3** [R3]: Given a worker whose heartbeat was published 3 seconds ago with a 5-second window, when liveness is evaluated, then the worker is alive. Given the same worker after 6 seconds with no new heartbeat, liveness evaluates to dead.

**AC4** [R4]: Given a worker with an assigned task, when the worker's heartbeat expires beyond the liveness window, then the task is no longer assigned to that worker.

**AC5** [R5]: Given a task invalidated by worker death, when unassigned work is queried, then the task appears as available for reassignment.

**AC6** [R6]: Given a worker sending heartbeats every 2 seconds with a 5-second liveness window, when liveness is evaluated continuously, then the worker remains alive throughout.

**AC7** [R7]: Given the system implementation, when the liveness check mechanism is inspected, then no periodic timer or polling loop is present; liveness is derived from stored data at evaluation time.

**AC8** [R4, R5]: Given a worker with an assigned task that dies (heartbeat expires), when the task is invalidated and then a new worker becomes available, then the task can be reassigned to the new worker.

## Open Questions

- **Clock skew**: In a distributed system, worker clocks and orchestrator clocks may diverge. Should the liveness window account for expected clock skew, or must clocks be synchronized externally?
- **Grace period**: Should there be a configurable grace period between "heartbeat expired" and "task invalidated" to tolerate transient network partitions?
- **Heartbeat source**: Must the heartbeat originate from the worker itself, or can a proxy or sidecar heartbeat on the worker's behalf?
