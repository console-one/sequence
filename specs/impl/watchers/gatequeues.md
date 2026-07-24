# Gate Queues

## Original Notes

From conversation audit: "ref gates that pipe to internal blocks with state machine like logic to trigger external callables."

---

Items enter a queue freely. Dequeuing is gated by a concurrency constraint -- maximum active workers. The gate IS the scheduler: when capacity exists, the next item dequeues; when capacity is full, dequeue operations suspend. No dispatcher process, no polling, no external orchestrator. Enqueue is unconditional. Dequeue is conditional. Completion frees capacity and triggers automatic resumption.

The queue has three partitions (pending, active, done) and items flow through them. The only moving part is the count constraint on active.

## The GateQueue Type

A gate queue has a concurrency limit and three item regions:

```ft
Task = {
  payload: string,
  result: string
}

GateQueue = {
  maxActive: number >= 1,
  pending: Task,
  active: Task,
  done: Task
}
```

Items are written as named entries under each region (e.g., `pending.t1`, `active.t2`). Each key holds a Task.

The scheduling constraint -- active count must be below maxActive for a dequeue to proceed -- is behavioral. In prose: moving an item from `pending` to `active` succeeds only when the number of entries in `active` is less than `maxActive`. When active is at capacity, the move suspends and resumes automatically when capacity frees.

## Enqueue (Always Succeeds)

Enqueue is unconditional. The producer is never blocked:

```ft
queue = GateQueue
queue << { maxActive: 2 }

queue << { pending: { t1: { payload: "job-a", result: "" } } }
queue << { pending: { t2: { payload: "job-b", result: "" } } }
queue << { pending: { t3: { payload: "job-c", result: "" } } }
queue << { pending: { t4: { payload: "job-d", result: "" } } }
```

All four items are accepted into pending immediately. No gating on submission.

## Dequeue (Gated on Capacity)

Moving an item from pending to active is atomic and gated:

```ft
-- dequeue t1: atomic move pending -> active (succeeds, active count = 1)
delete queue.pending.t1
queue << { active: { t1: { payload: "job-a", result: "" } } }

-- dequeue t2: atomic move (succeeds, active count = 2 = maxActive)
delete queue.pending.t2
queue << { active: { t2: { payload: "job-b", result: "" } } }
```

A third dequeue would suspend because active count equals maxActive. The suspended intent is preserved.

## Completion and Resumption

Completing an item is an atomic move from active to done:

```ft
-- complete t1: atomic move active -> done
delete queue.active.t1
queue << { done: { t1: { payload: "job-a", result: "done-a" } } }
```

This drops active count to 1 (below maxActive of 2). The suspended dequeue for t3 automatically resumes -- t3 moves from pending to active without manual intervention.

## Worker Capability

Workers are typed functions that process tasks. The schema of the work item and the worker signature match:

```ft
processTask = (task: Task) -> { result: string }
cap processTask
```

## Multiple Independent Queues

Each queue enforces its own limit:

```ft
queueA = GateQueue
queueA << { maxActive: 1 }

queueB = GateQueue
queueB << { maxActive: 5 }
```

Queue A allows 1 active item. Queue B allows 5. They do not interfere.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Enqueue always succeeds | `pending: { t1..t4 }` -- all accepted unconditionally |
| Dequeue gated on capacity | Active count < maxActive for dequeue to proceed |
| Suspended dequeue resumes on completion | Completing t1 frees capacity, t3 resumes |
| Atomic pending -> active move | `delete pending.t1` + `active: { t1 }` together |
| Atomic active -> done move | `delete active.t1` + `done: { t1 }` together |
| Typed worker capability | `processTask = (task: Task) -> { result: string }` |
| Independent queues | Separate `queueA`, `queueB` with different limits |
