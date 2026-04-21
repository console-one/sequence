# Thread Delegation

Delegation is not static. A task is delegated to a worker because it is available and capable right now. But if the worker becomes busy, the delegation must automatically break and the system must re-dispatch to another compatible worker. The conditions for delegation can be type-based (structural compatibility between task requirements and worker capabilities) or explicit (deliberate assignment rules). This is reactive delegation -- a continuously maintained conditional binding, not a one-time assignment.

There are no polling loops for condition changes. When a condition fails, re-evaluation is immediate.

## Problem Context

- **Actor(s)**: Tasks (require specific capabilities), workers (offer capabilities, have availability states), the delegation system (maintains conditional bindings), the scheduler (may make explicit assignments).
- **Domain**: Dynamic task-to-worker binding in systems where worker availability changes continuously and tasks must be re-routed without manual intervention.
- **Core Tension**: Static assignment (dispatch once, forget) fails when workers become unavailable. Reactive delegation requires continuous condition monitoring, but polling is expensive and introduces detection latency. The binding must break and reform automatically based on current state.

## Requirements

**R1**: A delegation SHALL bind a task to a worker, contingent on conditions that must hold simultaneously for the delegation to remain active.
- *Rationale*: Delegation is not a fire-and-forget operation. It is a conditional relationship that must be continuously valid.
- *Verifiable by*: A delegation exists with status "active" only while all its conditions hold; when any condition fails, the status is no longer "active".

**R2**: The system SHALL support two delegation modes: type-based (automatic matching by capability compatibility) and explicit (pinned to a specific named worker).
- *Rationale*: Type-based matching is flexible and adapts to pool changes; explicit pinning is necessary when a task must go to a specific worker (e.g., for data locality or stateful processing).
- *Verifiable by*: A type-based delegation matches any compatible worker; an explicit delegation targets only the named worker.

**R3**: For type-based delegations, when the bound worker's condition fails (e.g., worker becomes busy), the system SHALL automatically re-dispatch the task to the next compatible idle worker.
- *Rationale*: The purpose of reactive delegation is to keep tasks moving toward completion despite worker unavailability.
- *Verifiable by*: When worker A becomes busy, a type-based delegation to worker A breaks and a new delegation is established to idle worker B (if B has a compatible capability).

**R4**: For explicit delegations, when the named worker is unavailable, the task SHALL wait for that worker rather than being re-dispatched to another.
- *Rationale*: Explicit delegation is a deliberate choice. Re-dispatching would violate the explicit assignment contract.
- *Verifiable by*: When the explicitly named worker is busy, the task waits; it is not assigned to another worker even if compatible workers are idle.

**R5**: A delegation SHALL only be established to a worker that is idle and has a capability matching the task's requirement.
- *Rationale*: Assigning to a busy worker would overload it. Assigning to an incapable worker would fail execution.
- *Verifiable by*: A delegation is never established to a worker whose status is "busy" or whose capabilities do not match the task requirement.

**R6**: When a delegation breaks and no compatible idle worker is available, the task SHALL be surfaced as a visible gap indicating the required capability and the absence of eligible workers.
- *Rationale*: Operators need to know when tasks are stuck so they can add capacity or adjust priorities.
- *Verifiable by*: A task with a broken delegation and no available compatible worker appears in the gap list with its capability requirement.

**R7**: When a task is re-dispatched from one worker to another, any intermediate state accumulated during the previous delegation SHALL be preserved and accessible to the new worker.
- *Rationale*: Discarding partial progress forces the new worker to restart from scratch, wasting the work already done.
- *Verifiable by*: After re-dispatch, the new worker can read the intermediate state produced by the previous worker.

**R8**: Condition evaluation SHALL NOT use polling or timer-based checks. When a condition changes, the effect on delegations SHALL be evaluated immediately.
- *Rationale*: Polling introduces latency between condition change and delegation break. Immediate evaluation ensures tasks are not stuck on unavailable workers while a poll interval elapses.
- *Verifiable by*: When a worker transitions from "idle" to "busy", the delegation breaks without waiting for a polling interval.

## Acceptance Criteria

**AC1** [R1]: Given a delegation to worker A conditioned on worker A being idle, when worker A transitions to "busy", then the delegation status is no longer "active".

**AC2** [R2, R3]: Given a type-based delegation to worker A, when worker A becomes busy and worker B (compatible, idle) is available, then a new delegation to worker B is established for the same task.

**AC3** [R2, R4]: Given an explicit delegation to worker A, when worker A becomes busy and worker B (compatible, idle) is available, then the task waits for worker A; no delegation to worker B is established.

**AC4** [R5]: Given a worker that is "busy" with a matching capability, when a delegation is attempted, then the delegation is not established.

**AC5** [R5]: Given a worker that is "idle" without a matching capability, when a delegation is attempted, then the delegation is not established.

**AC6** [R6]: Given a broken delegation where no compatible idle workers exist, when gaps are queried, then the task appears with its capability requirement listed.

**AC7** [R7]: Given a task re-dispatched from worker A to worker B with intermediate state "partial-result", when worker B inspects the delegation, then "partial-result" is accessible.

**AC8** [R8]: Given a worker that transitions from "idle" to "busy" at time T, when the delegation status is checked at time T, then the delegation is already broken (no polling delay).

## Open Questions

- **Intermediate state conflict**: If the new worker produces its own intermediate state, is it merged with the previous worker's state or does it replace it?
- **Re-dispatch limit**: Should there be a maximum number of re-dispatches before the task is marked as failed rather than continuing to bounce between workers?
- **Explicit-to-typed fallback**: Should explicit delegations have an optional fallback to type-based matching after a configurable timeout, for cases where the named worker is down for an extended period?
