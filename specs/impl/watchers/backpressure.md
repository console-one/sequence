# Backpressure

A fast producer will overwhelm a slow consumer unless you gate submissions on available capacity. The traditional answer is a bounded queue with rejection or an external rate limiter. Both are wrong here -- capacity is a constraint on the data model, not a separate mechanism. When in-flight work reaches the limit, new submissions suspend. When a worker completes, suspended submissions resume. No orchestrator, no retry logic, no dropped work.

The hard part is adaptive capacity. A fixed limit is a constant. A derived limit (based on system load, memory, etc.) means the gate can shift under already-active items, temporarily violating the invariant. The system must handle this without preempting active work.

## The Backpressure Type

A backpressure-controlled queue has three regions (pending, active, done), a capacity limit, and the constraint that active count must stay at or below capacity. Items flow pending -> active -> done, with the pending -> active transition gated:

```ft
BackpressureQueue = {
  capacity: number >= 1,
  pending: string,
  active: string,
  done: string
}
```

Items are written as named entries under each region (e.g., `active.t1`, `pending.t4`). The regions are partitions, not arrays -- each item has a unique key.

The capacity invariant -- active count never exceeds capacity -- is a behavioral predicate that cannot be expressed in the parser's syntax. In prose: a write to `active` succeeds only when the count of entries in `active` is less than `capacity`. When the count equals `capacity`, the write suspends instead of rejecting, and the suspended intent is preserved in the gap surface.

## Submitting and Gating

The first N submissions (up to capacity) proceed immediately. The (N+1)th suspends:

```ft
queue = BackpressureQueue
queue << { capacity: 3 }

-- first three accepted immediately
queue << { active: { t1: "job-a" } }
queue << { active: { t2: "job-b" } }
queue << { active: { t3: "job-c" } }

-- fourth suspends: active count = capacity
queue << { pending: { t4: "job-d" } }
```

The fourth item lands in pending because the gate on active is full. It stays visible as an obligation -- not silently dropped.

## Completion and Resumption

Completing an item is an atomic move from active to done. This frees capacity, which automatically resumes the oldest suspended submission:

```ft
-- complete t1: atomic move active -> done
delete queue.active.t1
queue << { done: { t1: "result-a" } }
```

After this, active count drops to 2 (below capacity of 3). The suspended t4 automatically moves from pending to active. No manual intervention. The resumption ordering (FIFO among suspended items) is a behavioral property: the oldest suspended submission resumes first.

## Adaptive Capacity

The capacity limit can be a derived value. When the derived value changes, the gate adjusts:

```ft
queue << { capacity: ref(derivedCapacity) }
```

If capacity drops below the current active count, already-active items are not preempted -- but no new items enter active until the count naturally falls below the new limit.

## Capabilities

Submission and completion are external operations:

```ft
cap queue.active
cap queue.done
```

## Drain Pattern

Processing a batch with backpressure: submit all items, and they flow through at the capacity rate. Given 10 items and capacity 3, at most 3 are in-flight at any time. Each completion admits the next pending item.

## What This Validates

| AC | Expressed by |
|----|-------------|
| First 3 items accepted immediately | `active: { t1, t2, t3 }` writes succeed below capacity |
| 4th item suspends visibly | `pending: { t4 }` -- suspension preserved as gap |
| Completion resumes suspended item | `delete queue.active.t1` frees capacity, t4 resumes |
| Atomic completion | `delete active.t1` + `done: { t1 }` in one operation |
| Adaptive capacity adjusts gate | `capacity: ref(derivedCapacity)` -- gate follows derived value |
| Drain processes all items | At most `capacity` in-flight at any time, all eventually complete |
