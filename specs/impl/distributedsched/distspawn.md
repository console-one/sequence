# Distributed Spawn

Spawning a remote worker is asynchronous and uncertain. The orchestrator declares that a worker should exist with certain capabilities, but the worker takes time to boot, may fail to start, and may die after starting. The system must plan around workers that are declared but not yet live, without treating their capabilities as fully available until proven.

The key distinction: a declared capability (schema only) is not a live capability (implementation registered). Declared workers can be included in speculative plans at reduced confidence, but tasks must not be dispatched to them until they confirm readiness.

## The Worker Type

A worker progresses through a lifecycle: spawning, online, degraded, offline. Each state is a concrete value, not a flag in a bitmask:

```ft
Worker = {
  capability: string,
  runtime: "lambda" | "container" | "local",
  status: "spawning" | "online" | "degraded" | "offline",
  confidence: number 0..100,
  heartbeat: number,
  bootTimeout: number
}
```

`confidence` reflects how much the system trusts this worker's availability. A spawning worker has low confidence (the capability is declared but unproven). An online worker has high confidence (implementation registered, heartbeat active).

## Spawn Declaration

Declaring a spawn records the intent. The worker exists as a schema with a capability type but no implementation. Status is "spawning" and confidence is low:

```ft
worker1 = Worker
worker1 << {
  capability: "parseData",
  runtime: "lambda",
  status: "spawning",
  confidence: 30,
  bootTimeout: 30000
}
```

The declaration is non-blocking. The orchestrator continues immediately. The worker's capability appears in planning queries at reduced confidence -- useful for scheduling but not for dispatch.

## Registration and Status Transition

When the worker boots and registers its implementation, status transitions automatically. Confidence increases. Tasks can now be dispatched:

```ft
worker1 << { status: "online", confidence: 90 }
worker1 << { heartbeat: 1000 }
```

The transition from "spawning" to "online" is the proof that the worker is real. Before this, the capability is speculative. After this, it is authoritative.

## Health Maintenance

Once online, the worker must maintain liveness through continuous heartbeats. If heartbeats cease, status degrades automatically.

The degradation condition is: when the heartbeat timestamp is older than 5 seconds from the current time (`heartbeat < currentTime - 5000`), the worker's status narrows to "degraded" and tasks are no longer dispatched to it. No polling, no timer -- the predicate on stored values detects staleness.

Each heartbeat refreshes the timestamp:

```ft
worker1 << { heartbeat: 2000 }
```

## Boot Timeout

If a declared worker fails to boot within its timeout, the system surfaces this as a gap. A spawn that never completes must not silently remain in "spawning" forever.

The timeout condition is: when the current time exceeds the spawn time plus `bootTimeout` and no heartbeat has been received, the worker transitions to "offline". The intended capability surfaces as a gap -- visible work that has no available provider.

## Capabilities and Planning

The spawn system exposes capabilities for external processes to query and for the orchestrator to manage:

```ft
tool Worker.capability
tool Worker.status
tool Worker.heartbeat
```

Speculative planning includes spawning workers at their declared confidence. Actual dispatch requires `status = "online"`. This two-tier approach lets the scheduler plan ahead while preventing execution against non-existent workers.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Spawn declaration with status "spawning" | `worker1 << { status: "spawning", capability: "parseData", runtime: "lambda" }` |
| Declared vs live confidence difference | `confidence: 30` when spawning, `confidence: 90` when online |
| Auto-transition on registration | `worker1 << { status: "online" }` on implementation registration |
| Health degradation on missed heartbeats | Status narrows to "degraded" when heartbeat timestamp goes stale |
| Speculative planning at reduced confidence | Spawning worker included in plans at `confidence: 30` |
| Runtime metadata readable | `runtime: "lambda"` stored and queryable |
| Boot timeout surfaces gap | Worker transitions to "offline" when boot timeout elapses without registration |
