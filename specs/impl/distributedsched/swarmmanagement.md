# Swarm Management

A shared task board where typed tasks are matched to workers based on capability compatibility. Workers join and leave dynamically. Tasks are claimed exclusively, maintained by liveness, and automatically released when a worker dies. No central dispatcher makes explicit assignments -- matching emerges from type compatibility between task requirements and worker capabilities.

The system is self-organizing: post tasks, register workers, and the matching happens. Unresolvable tasks surface as visible gaps.

## The Task Type

A task has a typed requirement describing what capability is needed to fulfill it. The requirement is the matching key -- without it, workers cannot determine compatibility:

```ft
Task = {
  requirement: string,
  priority: number.integer >= 0,
  status: "unassigned" | "claimed" | "completed",
  assignedTo: string
}
```

A task starts unassigned. Its requirement specifies the capability needed (e.g., "scrape", "parse", "store"). Priority determines urgency when surfacing gaps.

## The Worker Type

A worker registers with a set of capabilities and maintains liveness through heartbeats. Its status reflects whether it is available for task claims:

```ft
SwarmWorker = {
  capabilities: string,
  status: "idle" | "working" | "offline",
  heartbeat: number,
  heartbeatWindow: number
}
```

Liveness is a derived predicate on the heartbeat timestamp, just as in the heartbeating blueprint. A worker whose heartbeat is older than `heartbeatWindow` from the current time is no longer alive and transitions out of eligibility.

## Capability Matching

A task is assignable to a worker if and only if the worker's capabilities include the task's requirement. This is type compatibility, not a central dispatcher's decision:

```ft
task1 = Task
task1 << { requirement: "scrape", priority: 1, status: "unassigned" }

workerA = SwarmWorker
workerA << { capabilities: "scrape", status: "idle", heartbeat: 1000, heartbeatWindow: 5000 }
```

Worker A is compatible with task 1 because its capabilities include "scrape". A worker offering only "parse" would not be compatible.

## Exclusive Claiming

When a worker claims a task, the claim is exclusive. No other worker can simultaneously work on the same task. The claim is maintained by the worker's liveness:

```ft
task1 << { status: "claimed", assignedTo: "workerA" }
```

The claim binding holds while the worker is alive (heartbeat is fresh within the window). If worker A dies (heartbeat expires), the `assignedTo` value is removed and the task's schema remains -- it resurfaces as unassigned work available for other workers.

## Automatic Reassignment

When a claim is released (worker failure or explicit release), the task becomes available for claiming by other compatible workers. No manual intervention required:

```ft
task1 << { status: "unassigned" }
```

If worker B is idle and has compatible capabilities, task 1 can be claimed by worker B. The system re-evaluates compatibility whenever workers join or leave.

## Gap Surfacing

Tasks with no compatible workers currently available surface as visible gaps. The gap includes priority information so operators know what is stuck and how urgent it is:

```ft
task3 = Task
task3 << { requirement: "store", priority: 5, status: "unassigned" }
```

When no online worker offers "store", task 3 appears in obligations as an unresolvable gap with its priority. When a new worker with "store" capability joins the swarm, the gap resolves -- the task becomes claimable and disappears from the gap list.

## Dynamic Self-Organization

Adding a worker makes it immediately eligible for compatible unassigned tasks. Removing a worker releases all its claims and recalculates priorities:

```ft
workerB = SwarmWorker
workerB << { capabilities: "parse", status: "idle", heartbeat: 1000, heartbeatWindow: 5000 }

cap Task.status
cap Task.assignedTo
cap SwarmWorker.capabilities
cap SwarmWorker.heartbeat
```

The swarm adapts to capacity changes in real time. There is no central dispatcher to bottleneck -- matching is a consequence of the type relationships between tasks and workers.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Tasks submitted with typed requirements | `task1 << { requirement: "scrape" }` |
| Workers register typed capabilities | `workerA << { capabilities: "scrape" }` |
| Compatibility via type matching | Worker offered tasks only for capabilities it has |
| Exclusive claiming | Claim binding maintained while worker heartbeat is fresh |
| Auto-release on worker death | Heartbeat expiry removes claim, task becomes unassigned |
| Released tasks available for reassignment | `task1 << { status: "unassigned" }` re-enters pool |
| Unresolvable tasks surface as gaps | Task with no compatible workers appears in obligations with priority |
| New worker immediately eligible | Adding `workerB` with matching capability enables claiming |
| Worker removal releases all claims | All tasks held by removed worker return to unassigned |
