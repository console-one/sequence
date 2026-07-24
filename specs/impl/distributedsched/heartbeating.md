# Heartbeating

A distributed system has workers that can die silently. The orchestrator needs to know which workers are alive without polling. The solution: workers publish timestamps, and liveness is a predicate on the stored timestamp vs current time. When the predicate fails, everything conditioned on that worker being alive invalidates automatically.

There are no timers. There is no polling. There is only data and conditions on data.

## The Worker Type

A worker has a heartbeat timestamp and a configurable liveness window. Liveness is derived — it's not a separate field, it's a predicate on the existing fields:

```ft
Worker = {
  heartbeat: number,
  livenessWindow: number,
  alive: boolean | alive = (heartbeat > _rt - livenessWindow)
}
```

`alive` is not stored independently. It's a refinement predicate: `alive` equals the result of comparing the heartbeat timestamp against the clock minus the window. Every time `_rt` advances (every mount), this re-evaluates.

## Tasks Conditioned on Liveness

When a task is assigned to a worker, it lives only as long as the worker is alive. If the heartbeat expires, the task invalidates and surfaces for reassignment:

```ft
Worker << {
  task: string while alive = true
    onBreak events.taskExpired = true
}
```

This is the entire reassignment mechanism. When `alive` becomes false (heartbeat too old), the `while` condition breaks, the task value is removed, and `events.taskExpired` is set. The task's schema still exists — so it reappears in `obligations()` as unassigned work.

## Heartbeat Arrival

Each heartbeat is just a value mount — the worker updates its timestamp:

```ft
worker1 = Worker
worker1 << { livenessWindow = 5000 }
worker1 << { heartbeat = _rt }
worker1 << { task = "process-job-42" }
```

The next heartbeat is another narrow:

```ft
worker1 << { heartbeat = _rt }
```

This updates the timestamp. `alive` re-evaluates to true (heartbeat is fresh). The `while` condition on the task holds. Nothing invalidates.

If no heartbeat arrives and time advances past the window, the next mount (any mount — even a clock tick) causes `alive` to evaluate to false. The task invalidates. The gap surfaces.

## Capabilities

The heartbeat is an externally-provided value — the worker's process loop mounts it. The task assignment is also external — the orchestrator decides which worker gets which task.

```ft
tool Worker.heartbeat
tool Worker.task
```

## What This Validates

The type blocks above express the success conditions for all 8 acceptance criteria:

| AC | Expressed by |
|----|-------------|
| Heartbeat stored and readable | `worker1 << { heartbeat = _rt }` |
| Configurable window | `worker1 << { livenessWindow = 5000 }` |
| Alive within window | `alive = (heartbeat > _rt - livenessWindow)` holds when fresh |
| Dead outside window | Same predicate fails when stale |
| Task invalidated on death | `while alive = true` breaks → task removed |
| Task resurfaces for reassignment | Schema remains → `obligations()` includes it |
| No polling or timers | Liveness is a predicate on stored values, not a callback |
| Continuous heartbeats keep alive | Each `<< { heartbeat = _rt }` refreshes the timestamp |
