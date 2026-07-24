# Labelled Task Queue

A task queue is a typed region where work items enter with a schema, get claimed exclusively by workers, and exit with results. The queue enforces ordering, prevents double-claiming, and respects deadlines -- all through the constraint structure, not through a separate scheduler. Labels are not decorative tags; they are schema constraints that narrow the task's type, adding deadlines or required fields that the label implies.

The hard part is that priority must not be an explicit field. Priority is derived from the task's structural properties -- how concrete its inputs are, how many downstream tasks depend on its completion. A task with all inputs ready and three blocked dependents naturally outranks one whose inputs are half-specified and no one is waiting for.

## The Task Type

A task has an identity, a lifecycle status, typed input and output, an optional assignee, and an optional deadline. Labels narrow the schema -- a label like "urgent" adds a deadline constraint that the task must satisfy:

```ft
Task = {
  id: string,
  status: "pending" | "active" | "done" | "expired",
  input: ref(taskInput),
  output: ref(taskOutput),
  assignee: string,
  deadline: number >= 0,
  labels: string
}
```

The `status` field is the lifecycle gate. Transitions are conditional -- you can only claim a pending task, and only the assignee can complete an active task. `input` and `output` are refs to typed schemas defined per task type, so the queue enforces that work items carry the right shape of data in and out.

## Enqueuing

Enqueuing is an unconditional write. If the data satisfies the task schema, it enters the queue immediately as pending:

```ft
task1 = Task
task1 << {
  id: "task-001",
  status: "pending",
  input: ref(taskInput)
}
```

No gating on enqueue -- submission always succeeds for well-formed data. A task missing required fields (like `id`) would fail schema validation and suspend, surfacing the missing field as a gap.

## Claiming (Dequeue)

Claiming is conditional. A worker can only claim a task whose status is currently "pending". The claim atomically sets the status to "active" and records the worker's identity:

```ft
task1 << { status: "active" when status = "pending" }
task1 << { assignee: "worker-A" }
```

The `when` gate on `status = "pending"` is the mutual exclusion mechanism. If worker B attempts to claim the same task after worker A already has, B's claim suspends because the status is no longer "pending". No locking service needed -- the condition on the data IS the lock.

## Exclusive Hold and Release

While a task is active, only the assignee can complete it. The hold persists until the worker writes a result:

```ft
task1 << {
  status: "done" when status = "active",
  output: ref(taskOutput)
}
```

Completion transitions the task to "done" and attaches typed output. When a task transitions out of "active", any suspended claims on it resume automatically -- they re-evaluate their conditions against the new state.

## Deadline Enforcement

Tasks can carry deadlines. When the current time exceeds a task's deadline and the task is still pending, it expires automatically. Deadline expiration is a predicate on stored values, not a timer:

```ft
task1 << { deadline: 1000 }
task1 << { status: "expired" when status = "pending" }
```

When the deadline predicate fires, status transitions to "expired" and the task no longer appears as claimable work. The expiration is visible -- it surfaces as a state change, not a silent removal.

## Labels as Schema Constraints

A label narrows the task type. Labeling a task "urgent" is not cosmetic -- it adds a deadline constraint that the task must satisfy:

```ft
task1 << { labels: "urgent" }
task1 << { deadline: 3600000 }
```

The label "urgent" implies a deadline (e.g., 1 hour). A task labeled "urgent" that lacks a deadline, or whose deadline has already passed, violates the constraint implied by the label. Labels compose -- applying multiple labels narrows the schema further.

## Derived Priority

Priority is not a field on the task. It emerges from two structural properties: how concrete the task's input is (more concrete = more actionable) and how many downstream tasks depend on its completion (more dependents = higher impact). The system's gap ordering naturally surfaces the most actionable, highest-impact tasks first.

Tasks with fully concrete input and many blocked dependents appear at the top of the obligation surface. Tasks with partially specified input appear lower. No explicit priority values, no manual triage.

## Capabilities

The queue operations -- enqueuing, claiming, completing, and deadline management -- are externally provided:

```ft
tool Task.status
tool Task.assignee
tool Task.output
tool Task.deadline
tool Task.labels
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Schema-violating task rejected | Task missing `id` fails schema validation, suspends |
| Valid task enqueued immediately | `task1 << { status: "pending" }` -- unconditional write |
| Claim transitions pending to active | `status: "active" when status = "pending"` |
| Double-claim suspends | Second worker's `when status = "pending"` fails, suspends |
| Suspended claim resumes on release | Condition re-evaluates when status changes |
| Completion attaches typed output | `output: ref(taskOutput)` written with status "done" |
| Derived priority from concreteness | Gap ordering surfaces fully-concrete tasks first |
| Labels narrow schema | `labels: "urgent"` adds deadline constraint |
| Deadline expiration | Status transitions to "expired" when deadline predicate fires |
