# Remote Root Loop Agent

The remote root loop is the most complex agent pattern. It is a long-lived server-side coordinator that receives tasks from multiple sources (users, other agents, cron), plans execution via LLM, dispatches to workers, and tracks results across sessions. Unlike the local root loop, it cannot assume a single user or a single machine.

The tension is being simultaneously persistent (surviving across sessions), multi-source (accepting tasks from heterogeneous origins), and delegating (dispatching to workers rather than executing directly). It must maintain a coherent view of a dynamic, concurrent task landscape without losing track of anything.

## Coordinator Identity

The coordinator has a persistent identity inspectable by any authorized process:

```ft
RemoteRootLoop = {
  agentId: string,
  role: string,
  uptime: number >= 0,
  restartCount: number >= 0,
  status: "running" | "planning" | "idle"
}
```

In a multi-agent system, other agents and users need to discover and reference the coordinator. Identity enables routing and observability.

## Multi-Source Task Acceptance

Tasks arrive from users, other agents, and scheduled events:

```ft
IncomingTask = {
  taskId: string,
  origin: string,
  originType: "user" | "agent" | "cron",
  request: string,
  priority: number,
  submittedAt: number
}
```

Each task carries its origin (for routing results back) and its request (for planning). All three source types are treated uniformly once accepted.

## Result Obligations

Each accepted task has a result obligation that remains unfulfilled until a concrete result is provided:

```ft
ResultObligation = {
  taskId: string,
  fulfilled: boolean,
  result: string,
  failureReason: string
}
```

```ft
ResultObligation << { fulfilled: false }
-- task accepted but not yet complete
```

Tasks are not "done" when dispatched -- they are done when results arrive. The obligation surface tracks what is still outstanding.

## LLM-Based Planning

The coordinator uses an LLM to plan task dispatch, matching tasks to available workers:

```ft
DispatchPlan = {
  taskId: string,
  assignedWorker: string,
  rationale: string,
  planTimestamp: number
}
```

Given a task requiring deployment capabilities and a worker with deployment capabilities, the planner assigns the task to that worker. The rationale is inspectable for transparency.

## Worker Registry

The coordinator tracks available workers with their capabilities and status:

```ft
WorkerStatus = {
  workerId: string,
  capabilities: string,
  status: "idle" | "busy",
  currentTask: string,
  lastHeartbeat: number
}
```

Worker discovery can be static configuration, dynamic registration, or both. The registry is the coordinator's view of available compute.

## Task Dispatch and Result Routing

Tasks are sent to workers, and worker results flow back to fulfill obligations:

```ft
Dispatch = {
  taskId: string,
  workerId: string,
  dispatchedAt: number,
  status: "dispatched" | "in-progress" | "completed" | "failed"
}
```

When a worker completes a task, the result automatically fulfills the corresponding obligation. When a worker fails, the failure is surfaced (not silently lost) and the task may be retried or reassigned.

## Priority Ordering

Higher-priority tasks are serviced first when resources are constrained:

```ft
PriorityQueue = {
  taskCount: number >= 0,
  highestPriority: number,
  lowestPriority: number
}
```

Given tasks at priority 0.92 and 0.65 and one available worker, the 0.92 task is dispatched first.

## Observability

The full agent state is inspectable by authorized users and processes at any time:

```ft
AgentView = {
  queuedTasks: number >= 0,
  activeWorkers: number >= 0,
  fulfilledObligations: number >= 0,
  pendingObligations: number >= 0
}
```

An operator can view the current queue, worker states, and dispatch plan without disrupting operation.

## State Persistence

The coordinator survives server restarts by persisting state to durable storage:

```ft
StatePersistence = {
  durable: boolean,
  lastCheckpoint: number,
  recoverable: boolean
}
```

After a server restart, the agent resumes with its task queue and obligation surface intact. In-progress tasks are either resumed (if workers are still alive) or returned to the queue.

## History Archival

Completed task history is archived to prevent unbounded growth:

```ft
TaskArchive = {
  archivedCount: number >= 0,
  activeCount: number >= 0,
  retrievable: boolean
}
```

After 1000 completed tasks, active state is bounded and older completed tasks are retrievable from the archive.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Persistent across sessions | `RemoteRootLoop` survives task completions |
| Multi-source task acceptance | `IncomingTask.originType` from user/agent/cron |
| Tasks carry origin and request | `IncomingTask` with typed fields |
| Result obligation tracking | `ResultObligation` with fulfilled/unfulfilled |
| LLM-based dispatch planning | `DispatchPlan` with rationale |
| Worker result fulfills obligation | `Dispatch.status` transitions to "completed" |
| Priority ordering | `PriorityQueue` with highest-first dispatch |
| Full state inspectable | `AgentView` with queue, workers, obligations |
| Worker failure surfaced | `ResultObligation.failureReason` populated |
| Survives server restart | `StatePersistence.recoverable` |
| History archived and retrievable | `TaskArchive.retrievable` |
