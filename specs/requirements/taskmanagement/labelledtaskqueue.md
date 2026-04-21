# Labelled Task Queue

## Problem Context

- **Actor(s)**: Producers (submit work items), Workers (claim and process items), Labels (metadata that carries constraint implications)
- **Domain**: Work distribution -- routing typed work items through a lifecycle with exclusive claiming, deadline enforcement, and label-driven schema narrowing
- **Core Tension**: Priority must emerge from structural properties (input readiness, downstream dependency count) rather than being an explicit, manually-maintained field. Labels must impose real constraints (e.g., deadlines) rather than being decorative tags.

## Requirements

**R1**: A task SHALL have an identity, a lifecycle status, typed input, typed output, an optional assignee, an optional deadline, and zero or more labels.
- *Rationale*: These are the minimal fields for a work item that moves through a lifecycle with exclusive ownership and deadline tracking.
- *Verifiable by*: Creating a task with all fields and confirming each is retrievable.

**R2**: Task status SHALL be one of: pending, active, done, or expired.
- *Rationale*: These four states cover the complete lifecycle of a work item including timeout handling.
- *Verifiable by*: Attempting to set status to an invalid value is rejected.

**R3**: The system SHALL accept any well-formed task into the queue immediately with status "pending".
- *Rationale*: Enqueue should be unconditional for valid data; the queue never refuses well-formed work.
- *Verifiable by*: Submitting a schema-valid task and confirming it appears with status "pending" without delay.

**R4**: A task missing required fields (e.g., identity) SHALL be rejected at submission time.
- *Rationale*: The queue must enforce its schema to prevent malformed work items from entering.
- *Verifiable by*: Submitting a task without an id and confirming rejection with an indication of the missing field.

**R5**: A worker SHALL only be able to claim a task whose status is "pending", and claiming SHALL atomically set the status to "active" and record the worker's identity as assignee.
- *Rationale*: Exclusive claiming prevents double-processing and establishes who is responsible for the work item.
- *Verifiable by*: Claiming a pending task and confirming status is "active" and assignee is the claiming worker.

**R6**: If two workers attempt to claim the same pending task concurrently, exactly one SHALL succeed and the other SHALL be informed that the task is no longer available.
- *Rationale*: Mutual exclusion must hold under concurrent access.
- *Verifiable by*: Two simultaneous claim attempts on the same task; one succeeds, the other fails or is deferred.

**R7**: Only the assigned worker SHALL be able to complete an active task.
- *Rationale*: The worker who claimed the task owns it through completion.
- *Verifiable by*: A different worker attempting to complete the task is rejected.

**R8**: Completing a task SHALL atomically set its status to "done" and attach typed output.
- *Rationale*: Completion is meaningful only with a result; partial completion (status without output) is invalid.
- *Verifiable by*: Completing a task and confirming both status="done" and output are present.

**R9**: When a task has a deadline and the current time exceeds that deadline while the task is still "pending", the system SHALL transition its status to "expired".
- *Rationale*: Stale work items must be removed from the claimable set automatically.
- *Verifiable by*: Setting a deadline in the past on a pending task and confirming it transitions to "expired".

**R10**: Expired tasks SHALL NOT be claimable.
- *Rationale*: Workers should not pick up work that has already timed out.
- *Verifiable by*: Attempting to claim an expired task and confirming the claim fails.

**R11**: Applying a label to a task SHALL impose the constraints implied by that label on the task's schema.
- *Rationale*: Labels are not decorative; "urgent" means a deadline constraint is enforced, not merely annotated.
- *Verifiable by*: Labeling a task "urgent" and confirming a deadline constraint is now required. A task labeled "urgent" without a deadline (or with an already-passed deadline) is in violation.

**R12**: Multiple labels SHALL compose -- each label adds its constraints, and the task must satisfy all of them.
- *Rationale*: Labels are additive constraints, not mutually exclusive categories.
- *Verifiable by*: Applying two labels with different constraints and confirming the task must satisfy both.

**R13**: Task priority SHALL be derived from structural properties: input completeness (how ready the task is to be worked on) and downstream dependency count (how many other tasks are blocked waiting for this one).
- *Rationale*: Derived priority avoids manual triage and stale priority values. The most actionable, highest-impact tasks surface first.
- *Verifiable by*: A task with complete input and three dependents ranks above a task with incomplete input and no dependents.

**R14**: Deadline expiration SHALL be visible as a status change, not a silent removal.
- *Rationale*: Consumers and auditors must be able to see that a task expired rather than having it disappear.
- *Verifiable by*: An expired task is still queryable with status "expired".

## Acceptance Criteria

**AC1** [R3]: Given a well-formed task with all required fields, when submitted to the queue, then it appears with status "pending" immediately.

**AC2** [R4]: Given a task missing its id field, when submitted to the queue, then submission fails with an indication of the missing field.

**AC3** [R5]: Given a pending task, when a worker claims it, then the task status becomes "active" and the worker is recorded as assignee.

**AC4** [R6]: Given a pending task, when two workers attempt to claim it concurrently, then exactly one succeeds and the other is informed the task is unavailable.

**AC5** [R6]: Given an active task already claimed by worker A, when worker B attempts to claim it, then worker B's attempt fails or is deferred.

**AC6** [R8]: Given an active task assigned to worker A, when worker A completes it with typed output, then status becomes "done" and output is attached.

**AC7** [R9]: Given a pending task with a deadline of T, when the current time exceeds T, then the task's status transitions to "expired".

**AC8** [R11]: Given a task with no deadline, when the label "urgent" is applied, then a deadline constraint is imposed and the task is in violation until a deadline is provided.

**AC9** [R12]: Given a task with labels "urgent" and "reviewed", when both labels imply distinct constraints, then the task must satisfy both constraints simultaneously.

**AC10** [R13]: Given task A with complete input and 3 blocked dependents, and task B with incomplete input and 0 dependents, when ordering by derived priority, then task A ranks above task B.

**AC11** [R14]: Given a task that expired, when querying the task, then it is still present with status "expired".

## Open Questions

- What is the mapping from label names to implied constraints? Is it a fixed registry or user-definable?
- When a claimed task's deadline expires while active, should it expire (preempting the worker) or only expire if still pending?
- Should dependent tasks be explicitly declared, or inferred from typed input/output relationships?
