# Scheduling as Type Entailment

A task is "scheduled" when all its preconditions are satisfied and a resource can serve it. The schedule is not a pre-computed plan -- it is the sequence of entailments that emerges from constraint satisfaction in real time. When conditions change (task completes, resource fails, new task arrives), the schedulable set updates automatically.

There is no scheduler. There is only state and conditions on state.

## The Task Type

A task has preconditions, a resource requirement, and a status. The preconditions are typed constraints on the task's context -- they must all hold before the task can execute:

```ft
Task = {
  resourceNeeded: string,
  duration: number >= 0,
  status: "waiting" | "schedulable" | "running" | "complete",
  output: string
}
```

A task's status is "waiting" until all preconditions are met and a resource is free, at which point it becomes "schedulable". Execution transitions it to "running", then "complete" when it finishes.

## Preconditions as Typed Constraints

Preconditions are expressed as `when` conditions. A task becomes schedulable only when its conditions hold:

```ft
taskB = Task
taskB << { resourceNeeded: "worker-1", duration: 5 }
taskB << { status: "schedulable" when taskA.status = "complete" }
```

The precondition "taskA must be complete" is a condition on existing state, not an edge in a separate dependency graph. Until `taskA.status` equals "complete", taskB remains "waiting". The moment the condition is satisfied, taskB transitions to "schedulable".

Multiple preconditions compose:

```ft
taskC = Task
taskC << { status: "schedulable" when taskA.status = "complete" }
```

-- Multi-precondition conjunction (prose): A task with multiple preconditions (e.g., predecessor complete AND input data available AND config validated) becomes schedulable only when ALL conditions hold simultaneously. Each condition is a separate `when` gate, and all must be satisfied.

## Resource Availability

Resources are typed slots. A task requiring a resource suspends until that resource is free:

```ft
Resource = {
  status: "free" | "busy",
  currentTask: string
}
```

```ft
worker1 = Resource
worker1 << { status: "free" }
```

A task claims a resource by binding it:

```ft
worker1 << { status: "busy", currentTask: "taskB" }
taskB << { status: "running" }
```

-- Resource gating (prose): A task's transition from "schedulable" to "running" requires both that all its preconditions are met AND that its required resource has status "free". If the resource is busy, the task remains schedulable but does not execute. When the resource becomes free, the next eligible task claims it.

When a task completes, it releases the resource:

```ft
taskB << { status: "complete", output: "result-data" }
worker1 << { status: "free", currentTask: "" }
```

## Resource Contention

When multiple tasks need the same resource, contention is resolved by a scheduling policy:

```ft
taskD = Task
taskD << { resourceNeeded: "worker-1", duration: 10 }
taskD << { status: "schedulable" when config.validated = "true" }
```

```ft
taskE = Task
taskE << { resourceNeeded: "worker-1", duration: 3 }
taskE << { status: "schedulable" when config.validated = "true" }
```

Both tasks are schedulable and both need worker-1. The ordering policy determines which goes first:

```ft
policy taskOrdering: { strategy: "shortest-job-first" }
```

```ft
policy taskOrdering: { strategy: "fifo" }
```

```ft
policy taskOrdering: { strategy: "priority" }
```

Under "shortest-job-first", taskE (duration 3) goes before taskD (duration 10). Under "fifo", whichever became schedulable first goes first. The policy is swappable without changing the constraint structure.

## Real-Time Adaptation

The schedulable set updates automatically when conditions change. A new task arriving mid-schedule is immediately evaluated:

```ft
taskF = Task
taskF << { resourceNeeded: "worker-2", duration: 7 }
taskF << { status: "schedulable" when inputData EXISTS }
```

If `inputData` already exists, taskF is immediately schedulable. If not, it waits. No recomputation of the entire schedule is needed -- only taskF's own conditions are checked.

When a resource fails, tasks depending on it suspend:

```ft
worker1 << { status: "failed" }
```

-- Resource failure handling (prose): When a resource transitions to "failed", all tasks with resourceNeeded matching that resource that are currently "schedulable" or "running" are suspended. Tasks on other resources are unaffected. When the resource recovers (status returns to "free"), suspended tasks re-evaluate.

## Temporal Constraints

Tasks can have time-based conditions -- "not before" and "deadline":

```ft
taskG = Task
taskG << { resourceNeeded: "worker-1", duration: 4 }
```

-- Temporal gating (prose): A task with a "not before time T" constraint does not become schedulable until the current time reaches T, even if all other preconditions are met. A task with a deadline D is flagged when the current time approaches D and has not yet completed. Temporal constraints compose with other preconditions -- all must hold simultaneously.

## Task Dependencies via Output Binding

Dependencies are data-driven, not edge-driven. Task B depends on task A's output because B has a precondition on A's output binding:

```ft
taskH = Task
taskH << { status: "schedulable" when taskA.output EXISTS }
```

This is not "taskH depends on taskA" as a graph edge. It is "taskH needs taskA.output to exist." If some other mechanism provided the same data, taskH would still become schedulable. The dependency is on the data, not the producer.

## Scheduling Observability

Every task's status and blocking reasons are inspectable:

```ft
scheduleView = {
  taskA: Task,
  taskB: Task,
  taskC: Task,
  taskD: Task,
  taskE: Task
}
```

-- Observability (prose): For each task that is not yet schedulable, the system reports which preconditions are unmet. "taskB: waiting for taskA.status = complete" or "taskD: waiting for worker-1 to be free". The user can answer "why isn't this task running?" by inspecting the gap surface.

## Capabilities

The externally-provided operations: completing tasks, updating resource status, and providing input data:

```ft
tool Task.status
tool Task.output
tool Resource.status
tool Resource.currentTask
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Task schedulable when preconditions met and resource free (AC1) | `status: "schedulable" when taskA.status = "complete"` plus resource free |
| Task suspended when resource busy (AC2) | Resource gating: task remains schedulable but does not run until resource.status = "free" |
| Precondition on data binding triggers schedulability (AC3) | `status: "schedulable" when config.validated = "true"` |
| Resource exclusivity suspends competing tasks (AC4) | Two tasks needing worker-1; one claims it, other suspends |
| Ordering policy selects among schedulable tasks (AC5) | `policy taskOrdering: { strategy: "shortest-job-first" }` |
| New task evaluated immediately on arrival (AC6) | `taskF << { status: "schedulable" when inputData EXISTS }` -- checked against current state |
| Temporal constraint prevents early scheduling (AC7) | Not-before-T constraint holds task in "waiting" until time T |
| Status and blocking reasons inspectable (AC8) | Gap surface shows unmet preconditions per task |
| Output binding satisfies downstream dependency (AC9) | `taskH << { status: "schedulable" when taskA.output EXISTS }` |
