# Thread Delegation

Delegation is not static. A task is delegated to a worker because it is available and capable right now. But if the worker becomes busy, the delegation must automatically break and the system must re-dispatch to another compatible worker. The conditions for delegation can be type-based (structural compatibility between task requirements and worker capabilities) or explicit (deliberate assignment rules). This is reactive delegation -- a continuously maintained conditional binding, not a one-time assignment.

There are no polling loops for condition changes. When a condition fails, re-evaluation is immediate.

## The Delegation Type

A delegation binds a task to a worker, contingent on conditions. The conditions must hold simultaneously for the delegation to remain active:

```ft
Delegation = {
  task: string,
  worker: string,
  mode: "typed" | "explicit",
  status: "active" | "broken" | "redispatching",
  intermediateState: string
}
```

`mode` distinguishes how the delegation was established. "typed" means the system matched based on structural compatibility between the task's requirement and the worker's capability. "explicit" means the scheduler specified a particular worker by name.

## Condition-Maintained Binding

A delegation holds while two conditions are true: the worker has a matching capability, and the worker is idle. Both must hold simultaneously:

```ft
WorkerState = {
  capability: string,
  status: "idle" | "busy" | "offline"
}

workerA = WorkerState
workerA << { capability: "dataTransform", status: "idle" }
```

The delegation's existence is gated on the worker's status. When `workerA.status` is "idle", the delegation can be established:

```ft
delegation1 = Delegation
delegation1 << {
  task: "task-001",
  worker: "workerA",
  mode: "typed",
  status: "active"
}
```

When `workerA.status` changes from "idle" to "busy", the delegation condition breaks and the delegation invalidates.

## Automatic Break and Re-Dispatch

When a delegation condition fails, the delegation breaks and the task is flagged for re-dispatch. The system searches for the next compatible idle worker without manual intervention:

```ft
delegation1 << { status: "broken" }
```

After the break, the system evaluates other workers. If worker B is idle and has a compatible capability, a new delegation is established:

```ft
workerB = WorkerState
workerB << { capability: "dataTransform", status: "idle" }

delegation2 = Delegation
delegation2 << {
  task: "task-001",
  worker: "workerB",
  mode: "typed",
  status: "active"
}
```

Re-dispatch is automatic and reactive. The delegation breaks and re-forms based on the current state of the worker pool.

## Explicit vs Type-Based Matching

Type-based matching selects the worker whose capability structurally satisfies the task's requirement. Explicit matching pins a task to a specific worker by name:

```ft
explicitDelegation = Delegation
explicitDelegation << {
  task: "task-002",
  worker: "workerA",
  mode: "explicit",
  status: "active"
}
```

An explicit delegation does not fall through to other workers. If worker A is busy, the task waits for worker A. It is not re-dispatched to worker B, even if worker B has compatible capabilities. The explicit rule takes precedence.

Type-based delegation, by contrast, will re-dispatch to any compatible idle worker when the current delegation breaks.

## Gap Surfacing

If no compatible worker is available after a delegation breaks, the task surfaces as a visible gap with priority information:

```ft
task1Gap = [[ delegation : task-001 requires dataTransform, no idle workers ]]
```

The gap includes what capability is needed and which workers were considered. When a compatible worker becomes idle, the gap resolves and a new delegation is established.

## State Preservation Across Re-Dispatch

When a task is re-dispatched from one worker to another, any intermediate state accumulated during the previous delegation is preserved. The new worker has access to the partial progress:

```ft
delegation2 << { intermediateState: "partial-result-from-workerA" }

cap Delegation.status
cap Delegation.intermediateState
cap WorkerState.status
```

The intermediate state is not discarded on delegation break. It carries forward to the next delegation, so the new worker can continue from where the previous worker left off rather than starting from scratch.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Delegation contingent on conditions | Delegation exists only while worker status is "idle" |
| Busy worker blocks delegation | Status check prevents assignment to busy workers |
| Auto-break on condition failure | `delegation1 << { status: "broken" }` when worker becomes busy |
| Automatic re-dispatch to next compatible worker | `delegation2` established on `workerB` when `workerA` becomes busy |
| Explicit delegation waits for named worker | `mode: "explicit"` pins to specific worker, no fallthrough |
| Type-based delegation matches structurally | `mode: "typed"` selects by capability compatibility |
| Unresolvable task surfaces as gap | Gap with requirement info when no idle compatible workers exist |
| Intermediate state preserved across re-dispatch | `intermediateState` carries forward to new delegation |
