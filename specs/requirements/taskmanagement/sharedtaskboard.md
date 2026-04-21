# Shared Task Board

## Problem Context

- **Actor(s)**: Multiple processes (workers/participants) sharing a single task board, a board configuration that enforces work-in-progress limits
- **Domain**: Collaborative work management -- a kanban-style board where tasks flow through columns (todo, doing, done) with mutual exclusion on claims and a configurable cap on concurrent work
- **Core Tension**: Multiple processes must see a consistent view of the board at all times. Work-in-progress limits must be enforced atomically -- no process should be able to exceed the WIP cap, even under concurrent access.

## Requirements

**R1**: A board task SHALL have an identity, a status (one of: todo, doing, done), a title, typed input, typed output, and an assignee.
- *Rationale*: These fields define the minimal work item for a shared board with ownership tracking.
- *Verifiable by*: Creating a task with all fields and confirming each is retrievable.

**R2**: The board SHALL have a configurable work-in-progress (WIP) limit specifying the maximum number of tasks allowed in "doing" status simultaneously.
- *Rationale*: WIP limits prevent overcommitment and are a core kanban constraint.
- *Verifiable by*: Setting a WIP limit and confirming it is stored and enforced.

**R3**: All processes connected to the board SHALL see the same set of tasks and statuses at any given time.
- *Rationale*: Shared visibility is the fundamental property of a shared board. No private copies, no stale views.
- *Verifiable by*: Process A adds a task; process B can immediately read it.

**R4**: Adding a task to the board SHALL be unconditional for well-formed data. The task enters with status "todo".
- *Rationale*: Submission should never be blocked; gating happens at the claim step.
- *Verifiable by*: Submitting a valid task and confirming it appears with status "todo".

**R5**: A task missing required fields (e.g., title) SHALL be rejected at submission time.
- *Rationale*: The board must enforce its schema to prevent malformed tasks.
- *Verifiable by*: Submitting a task without a title and confirming rejection with an indication of the missing field.

**R6**: Moving a task from "todo" to "doing" SHALL require that the task's current status is "todo" and SHALL atomically set the status to "doing" and record the claiming process as assignee.
- *Rationale*: Conditional transitions prevent double-claiming.
- *Verifiable by*: Claiming a "todo" task and confirming status becomes "doing" with the correct assignee.

**R7**: If two processes attempt to claim the same "todo" task concurrently, exactly one SHALL succeed and the other SHALL be informed the task is no longer available (or be deferred until it becomes available again).
- *Rationale*: Mutual exclusion under concurrent access.
- *Verifiable by*: Two simultaneous claims on the same task; one succeeds, the other fails or is deferred.

**R8**: Moving a task from "todo" to "doing" SHALL be blocked when the number of tasks currently in "doing" equals the WIP limit.
- *Rationale*: The WIP limit must be enforced atomically to prevent overcommitment.
- *Verifiable by*: With WIP limit of 2 and 2 tasks already "doing", a third claim is blocked.

**R9**: When a "doing" task completes and the WIP count drops below the limit, any blocked claims SHALL be automatically unblocked.
- *Rationale*: Freed capacity should immediately allow waiting work to proceed without manual intervention.
- *Verifiable by*: Completing a task when a claim is blocked on WIP limit, and confirming the blocked claim proceeds.

**R10**: Completing a task SHALL atomically set its status to "done" and attach typed output.
- *Rationale*: Completion requires a result; the WIP count must decrease atomically.
- *Verifiable by*: Completing a task and confirming status is "done", output is attached, and WIP count has decreased.

**R11**: Board columns ("todo", "doing", "done") SHALL be projections filtered by status, not separate containers. A task SHALL appear in exactly one column at all times, and the union of all columns SHALL equal the complete task set.
- *Rationale*: Single source of truth prevents tasks from being lost or duplicated across columns.
- *Verifiable by*: Querying each column and confirming every task appears exactly once and the union is the full set.

**R12**: The active count (number of tasks in "doing") SHALL be derived from the actual task statuses, not maintained as a separate manually-updated counter.
- *Rationale*: Derived counts cannot drift out of sync with reality.
- *Verifiable by*: The active count always equals the number of tasks with status "doing" after any operation.

## Acceptance Criteria

**AC1** [R3, R4]: Given two processes connected to the board, when process A adds a valid task, then process B sees the task with status "todo" immediately.

**AC2** [R5]: Given a task submission missing the title field, when submitted, then it is rejected with an indication of the missing field.

**AC3** [R6]: Given a "todo" task, when process A claims it, then the task status becomes "doing" and process A is recorded as assignee.

**AC4** [R7]: Given a "todo" task, when process A and process B attempt to claim it simultaneously, then exactly one succeeds and the other is informed or deferred.

**AC5** [R8]: Given a WIP limit of 2 and 2 tasks already in "doing", when a third claim is attempted, then it is blocked.

**AC6** [R9]: Given a blocked claim from AC5, when one of the "doing" tasks completes, then the blocked claim proceeds automatically.

**AC7** [R10]: Given an active task assigned to process A, when process A completes it with typed output, then status becomes "done", output is attached, and the active count decreases by 1.

**AC8** [R11]: Given tasks in various statuses, when querying each column, then every task appears in exactly one column and the union is the full task set.

**AC9** [R12]: Given any sequence of claims and completions, when querying the active count, then it always equals the number of tasks with status "doing".

## Open Questions

- Can a task be moved back from "doing" to "todo" (unclaimed)? If so, does the WIP count decrease?
- Should there be a timeout on "doing" tasks that auto-returns them to "todo"?
- Can the WIP limit be changed while tasks are in-flight? If it drops below the current active count, what happens to already-active tasks?
