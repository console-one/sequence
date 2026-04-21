# Remote Root Loop Agent

The remote root loop is the most complex agent pattern. It is a long-lived server-side coordinator that receives tasks from multiple sources (users, other agents, cron), plans execution via LLM, dispatches to workers, and tracks results across sessions. Unlike the local root loop, it cannot assume a single user or a single machine.

The tension is being simultaneously persistent (surviving across sessions), multi-source (accepting tasks from heterogeneous origins), and delegating (dispatching to workers rather than executing directly). It must maintain a coherent view of a dynamic, concurrent task landscape without losing track of anything.

---

## Problem Context

- **Actor(s)**: The coordinator agent, users who submit tasks, other agents that submit tasks, scheduled/cron events, worker agents that execute tasks, and operators who monitor the system.
- **Domain**: Server-side task coordination where a long-lived agent receives work from heterogeneous sources, plans execution via LLM, dispatches to a pool of workers, and tracks results to completion.
- **Core Tension**: The coordinator must be simultaneously persistent (surviving restarts), multi-source (accepting from users, agents, cron), and delegating (dispatching, not executing). It must maintain a coherent view of a dynamic, concurrent task landscape where tasks arrive from many sources, workers come and go, and failures must never be silent.

## Requirements

**R1**: The coordinator SHALL have a persistent identity inspectable by any authorized process.
- *Rationale*: In a multi-agent system, other agents and users need to discover and reference the coordinator for task submission and status queries.
- *Verifiable by*: An external process queries the coordinator's identity and receives its agent ID, role, uptime, and status.

**R2**: The coordinator SHALL accept tasks from users, other agents, and scheduled events through a uniform interface.
- *Rationale*: All three source types produce work items. A uniform interface avoids separate code paths for each source type and simplifies routing.
- *Verifiable by*: A user submits a task, an agent submits a task, and a cron event submits a task. All three appear in the task queue with their origin recorded.

**R3**: Each accepted task SHALL have a result tracking record that remains unfulfilled until a concrete result is provided.
- *Rationale*: Tasks are not "done" when dispatched -- they are done when results arrive. The coordinator must track what is still outstanding.
- *Verifiable by*: A task is accepted. Its result status shows unfulfilled. After a worker provides a result, the status transitions to fulfilled.

**R4**: The coordinator SHALL use an LLM to plan task dispatch, matching tasks to available workers based on required and available capabilities.
- *Rationale*: Manual task-to-worker assignment does not scale. LLM-based planning enables intelligent matching and provides inspectable rationale.
- *Verifiable by*: Given a task requiring deployment capabilities and a worker with deployment capabilities, the planner assigns the task to that worker. The dispatch rationale is inspectable.

**R5**: The coordinator SHALL maintain a registry of available workers with their capabilities, status, and liveness.
- *Rationale*: The coordinator needs an accurate view of available compute to make dispatch decisions. Stale worker records lead to dispatching to dead workers.
- *Verifiable by*: A worker registers with its capabilities. Its status is visible in the registry. When the worker stops sending heartbeats, it is marked as unavailable.

**R6**: When a worker completes a task, the result SHALL automatically fulfill the corresponding task's result record. When a worker fails, the failure SHALL be surfaced, not silently lost.
- *Rationale*: Silent failure is the worst outcome in a delegating system. Every dispatched task must resolve to either a result or an explicit failure.
- *Verifiable by*: A worker completes a task and the result fulfills the corresponding record. A worker fails, and the failure reason is surfaced. No task silently disappears.

**R7**: Higher-priority tasks SHALL be serviced before lower-priority tasks when resources are constrained.
- *Rationale*: Not all tasks are equally urgent. Priority ordering ensures the most important work is handled first when workers are scarce.
- *Verifiable by*: Given tasks at priority 0.92 and 0.65 and one available worker, the 0.92 task is dispatched first.

**R8**: The full coordinator state (queued tasks, active workers, fulfilled/pending results) SHALL be inspectable by authorized users and processes at any time without disrupting operation.
- *Rationale*: Operators need visibility into the system's current state for monitoring, debugging, and capacity planning.
- *Verifiable by*: An operator queries the coordinator and receives counts of queued tasks, active workers, and fulfilled/pending results while the coordinator continues processing.

**R9**: The coordinator SHALL survive server restarts by persisting state to durable storage.
- *Rationale*: A long-lived coordinator that loses all state on restart is not actually persistent. Task queue and result records must survive process restarts.
- *Verifiable by*: After a server restart, the coordinator resumes with its task queue and result records intact. In-progress tasks dispatched to still-alive workers continue; tasks dispatched to dead workers are returned to the queue.

**R10**: Completed task history SHALL be archived to prevent unbounded state growth, while remaining retrievable.
- *Rationale*: Completed tasks accumulate over time. Active state must remain bounded for performance, but completed records must be retrievable for auditing.
- *Verifiable by*: After 1000 completed tasks, active state is bounded. A completed task from the archive is retrievable by task ID.

## Acceptance Criteria

**AC1** [R1]: Given a running coordinator, when an external process queries its identity, then the agent ID, role, uptime, and status are returned.

**AC2** [R2]: Given tasks submitted by a user, an agent, and a cron event, when the task queue is inspected, then all three are present with their origin type recorded.

**AC3** [R3]: Given a dispatched task, when the worker has not yet reported, then the task's result status is unfulfilled. When the worker reports a result, the status transitions to fulfilled.

**AC4** [R4]: Given a task requiring specific capabilities and a worker pool with mixed capabilities, when the planner runs, then the task is assigned to a worker with matching capabilities and the rationale is inspectable.

**AC5** [R5]: Given a registered worker, when it stops sending heartbeats beyond the configured threshold, then it is marked as unavailable in the registry.

**AC6** [R6]: Given a worker that fails a task, when the failure is reported, then the task's result record shows the failure reason and the coordinator can decide to retry or reassign.

**AC7** [R7]: Given two tasks (priority 0.92 and 0.65) and one available worker, when the coordinator dispatches, then the 0.92 task is dispatched first.

**AC8** [R8]: Given an active coordinator processing tasks, when an operator queries its state, then the full state (queue, workers, results) is returned without disrupting ongoing processing.

**AC9** [R9]: Given a coordinator with queued tasks and pending results, when the server restarts, then the coordinator resumes with its task queue and result records intact.

**AC10** [R10]: Given 1000 completed tasks, when the active state is measured, then it is bounded. When an archived task is queried by ID, it is retrievable.

## FT System Demands

- The kernel must support representing a long-lived server-side process that accepts work from multiple sources concurrently.
- The type system must support priority-ordered task queues and result tracking that persists across process restarts.
- Worker liveness detection and dispatch planning must be expressible as inspectable, typed operations.

## Open Questions

- What is the heartbeat interval and failure threshold for worker liveness detection?
- What is the retry/reassignment policy for tasks dispatched to workers that fail or go silent?
- Should the coordinator support task cancellation, and if so, how are in-progress tasks at workers handled?
- What is the archival policy (time-based, count-based, or both)?
