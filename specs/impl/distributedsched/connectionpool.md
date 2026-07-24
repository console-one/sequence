# Connection Pool

Connections are expensive to create and limited in number. Too many exhaust the target; too few create bottlenecks. The pool enforces a hard cap, queues excess requests, and automatically serves them when capacity becomes available. There is no busy-waiting, no retry logic pushed to callers, and no manual lock management.

The core mechanism: a bounded counter gates acquisition. When the count reaches the maximum, subsequent requests suspend. When a connection is released, the oldest pending request resumes automatically. The pool is self-managing.

## The Pool Type

A pool has a configurable maximum, tracks its current active count, and knows its target. The active count is derived from the number of live connections, not manually maintained:

```ft
Pool = {
  maxConnections: number.integer >= 1,
  activeCount: number.integer >= 0,
  target: string,
  full: boolean
}
```

`full` is a derived predicate: `activeCount >= maxConnections`. It is not stored independently -- it evaluates from the current values every time the pool state is read.

## Connection Lifecycle

Each connection tracks its target, when it was acquired, and its current status. A connection exists only while it is active -- releasing it removes the binding:

```ft
Connection = {
  target: string,
  acquiredAt: number,
  status: "active" | "released"
}
```

Connections are acquired against a pool. Acquisition succeeds only when the pool is not full:

```ft
pool1 = Pool
pool1 << { maxConnections: 10, target: "db://primary" }

conn1 = Connection when pool1.full = false
conn1 << { target: pool1.target, acquiredAt: _rt, status: "active" }
```

The `when` condition gates the binding. If `pool1.full` is true, the connection assignment suspends rather than failing. It waits until capacity becomes available.

## Capacity-Gated Suspension

When the pool is full, new acquisition requests do not fail -- they suspend. Suspension is ordered (FIFO). When a connection is released, the oldest suspended request resumes:

```ft
conn11 = Connection when pool1.full = false
```

If `pool1` has 10 active connections, `conn11` suspends. When any active connection is released (its status changes to "released"), `activeCount` decreases, `full` becomes false, and `conn11`'s `when` condition is satisfied. The oldest pending request is the one that resumes -- this is the FIFO fairness guarantee.

## Release and Cascading Invalidation

Releasing a connection invalidates everything conditioned on that connection's existence. Operations that depended on a specific connection being active must terminate or suspend:

```ft
conn3 = Connection
conn3 << { status: "active" }

-- Operations gated on conn3 being active
query1 = ref(conn3) when conn3.status = "active"
```

When `conn3` is released (`status` becomes "released"), `query1`'s condition breaks and the operation invalidates. This prevents operations from continuing against a dead connection.

## Independent Pools

Different targets may have different connection limits. Each pool operates independently -- filling one does not affect another:

```ft
poolA = Pool
poolA << { maxConnections: 5, target: "api://service-a" }

poolB = Pool
poolB << { maxConnections: 20, target: "db://warehouse" }

tool Pool.maxConnections
tool Pool.activeCount
```

Pool A reaching capacity has no effect on Pool B. Their counters, suspensions, and resumptions are entirely separate.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Hard cap enforced | `when pool1.full = false` gates all acquisitions |
| Pool reports full at max | `full` derived from `activeCount >= maxConnections` |
| Excess requests suspend, not reject | `conn11 = Connection when pool1.full = false` suspends |
| FIFO resume on release | Oldest pending request resumes when capacity opens |
| Connection metadata readable | `Connection` has `target`, `acquiredAt`, `status` |
| Dependent ops invalidate on release | `when conn3.status = "active"` breaks on release |
| Independent pools | `poolA` and `poolB` with separate `maxConnections` |
