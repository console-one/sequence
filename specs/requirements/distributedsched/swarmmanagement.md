# Swarm Management

A shared task board where typed tasks are matched to workers based on capability compatibility. Workers join and leave dynamically. Tasks are claimed exclusively, maintained by liveness, and automatically released when a worker dies. No central dispatcher makes explicit assignments -- matching emerges from type compatibility between task requirements and worker capabilities.

The system is self-organizing: post tasks, register workers, and the matching happens. Unresolvable tasks surface as visible gaps.

## Problem Context

- **Actor(s)**: Tasks (posted with typed capability requirements), workers (register with typed capabilities, claim tasks, heartbeat), operators (observe unresolvable gaps).
- **Domain**: Decentralized task scheduling in dynamic worker pools where capacity changes continuously.
- **Core Tension**: Without a central dispatcher, matching must emerge from the data itself. Workers come and go unpredictably; the system must release claims from dead workers and surface unresolvable tasks without manual intervention.

## Requirements

**R1**: Each task SHALL declare a typed capability requirement specifying what kind of worker can fulfill it.
- *Rationale*: Without typed requirements, there is no basis for matching. The requirement is the contract between the task and potential workers.
- *Verifiable by*: A task created with requirement "scrape" can be queried and reports "scrape" as its requirement.

**R2**: Each worker SHALL register with a set of typed capabilities describing what kinds of tasks it can perform.
- *Rationale*: Capabilities are the worker's side of the matching contract. Without them, the system cannot determine which worker can handle which task.
- *Verifiable by*: A worker registered with capability "scrape" can be queried and reports "scrape" as its capability.

**R3**: A task SHALL be assignable to a worker if and only if the worker's capabilities include the task's requirement.
- *Rationale*: Type-based matching is the mechanism that replaces a central dispatcher. Incorrect matching (assigning to an incapable worker) produces failures.
- *Verifiable by*: A worker with capability "scrape" can claim a task requiring "scrape"; a worker with only "parse" cannot.

**R4**: Task claims SHALL be exclusive: at most one worker SHALL hold a claim on a given task at any time.
- *Rationale*: Duplicate execution wastes resources and may cause data corruption if the task has side effects.
- *Verifiable by*: While worker A holds a claim on a task, worker B cannot simultaneously claim the same task.

**R5**: A claim SHALL be maintained by the claiming worker's liveness (heartbeat within the configured window). If the worker dies, the claim SHALL be automatically released.
- *Rationale*: A dead worker cannot complete its claimed task. Holding the claim indefinitely blocks the task from being fulfilled.
- *Verifiable by*: A worker that stops heartbeating has its claimed task released back to the unassigned pool.

**R6**: When a claim is released (due to worker death or explicit release), the task SHALL become available for claiming by other compatible workers.
- *Rationale*: Released tasks represent undone work. They must re-enter the assignable pool.
- *Verifiable by*: After a claim is released, another compatible worker can claim the same task.

**R7**: Tasks with no compatible online workers SHALL be surfaced as visible, prioritized gaps.
- *Rationale*: Operators need to know which tasks are stuck and how urgent they are. Without visibility, unresolvable tasks are silently lost.
- *Verifiable by*: A task requiring "store" when no online worker offers "store" appears in the gap list with its priority.

**R8**: When a new worker joins with a capability matching an existing unresolvable task, the task SHALL become claimable and disappear from the gap list.
- *Rationale*: Gap resolution must be automatic. Otherwise, operators must manually re-evaluate every gap when capacity changes.
- *Verifiable by*: A task stuck as a gap due to missing "store" capability becomes claimable when a worker with "store" joins.

**R9**: When a worker leaves or dies, all of its claimed tasks SHALL be released simultaneously.
- *Rationale*: Partial release (some tasks released, some stuck) would create inconsistent state.
- *Verifiable by*: A worker holding claims on 3 tasks that dies has all 3 tasks released to the unassigned pool.

**R10**: Each task SHALL have a priority, and gaps SHALL be surfaced in priority order.
- *Rationale*: Not all unresolvable tasks are equally urgent. Priority ordering lets operators focus on what matters most.
- *Verifiable by*: Given two unresolvable tasks with priorities 1 and 5, the priority-5 task appears first in the gap list.

## Acceptance Criteria

**AC1** [R1, R2, R3]: Given a task requiring "scrape" and a worker offering "scrape", when matching is evaluated, then the task is assignable to the worker.

**AC2** [R3]: Given a task requiring "scrape" and a worker offering only "parse", when matching is evaluated, then the task is not assignable to the worker.

**AC3** [R4]: Given a task claimed by worker A, when worker B attempts to claim the same task, then worker B's claim is rejected or queued.

**AC4** [R5]: Given a worker holding a claim that stops heartbeating beyond its window, when liveness is evaluated, then the claim is released.

**AC5** [R6]: Given a released task and a compatible idle worker, when matching is re-evaluated, then the worker can claim the task.

**AC6** [R7]: Given a task requiring "store" with priority 5 and no online worker offering "store", when gaps are queried, then the task appears with priority 5.

**AC7** [R8]: Given a task stuck as a gap requiring "store", when a worker with "store" capability joins, then the task becomes claimable and leaves the gap list.

**AC8** [R9]: Given a worker holding claims on 3 tasks that dies, when the worker's death is detected, then all 3 tasks are released to the unassigned pool.

**AC9** [R10]: Given unresolvable tasks with priorities 1, 3, and 5, when the gap list is queried, then tasks appear ordered by descending priority (5, 3, 1).

## Open Questions

- **Multi-capability tasks**: Can a task require multiple capabilities simultaneously (e.g., "scrape" AND "parse")? If so, must a single worker satisfy all, or can multiple workers collaborate?
- **Worker preference**: When multiple compatible workers are available, is there a preference order (least loaded, closest, most recently active)?
- **Claim timeout**: Should claims have a maximum duration, after which they are released even if the worker is alive? This would prevent slow workers from blocking tasks indefinitely.
