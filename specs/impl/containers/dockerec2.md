# Docker EC2 Container

The Docker EC2 container is the brain of the distributed system. It runs on persistent infrastructure, claims a root partition for an organization, and acts as the authoritative scheduler for that partition. It manages worker lifecycle (Lambdas, local clients, other nodes), enforces distributed lock agreements, cascades state changes, and archives old state to keep its active memory bounded. Everything downstream depends on this process being alive and authoritative.

The tension is single-point-of-failure vs. clean scheduling. A single orchestrator gives you unambiguous lock arbitration and routing decisions. But if it dies, the entire partition is orphaned until recovery. The architecture trades resilience for simplicity at this layer.

## Root Partition Ownership

The orchestrator claims exclusive ownership of an organizational namespace on boot. No other orchestrator can claim the same partition simultaneously:

```ft
RootPartition = {
  orgId: string,
  ownerId: string,
  claimedAt: number,
  exclusive: boolean
}
```

Exclusivity is enforced: a second orchestrator attempting to claim the same `orgId` is rejected. The claim persists for the lifetime of the orchestrator process.

```ft
orchestrator1 = RootPartition
orchestrator1 << { orgId: "xyz", ownerId: "ec2-abc", claimedAt: prev, exclusive: true }
```

## Worker Registry

The orchestrator maintains a live registry of all connected workers, including their identities, capabilities, connection status, and heartbeat freshness:

```ft
WorkerEntry = {
  workerId: string,
  workerType: "lambda" | "local" | "remote",
  capabilities: string,
  status: "online" | "expired",
  lastHeartbeat: number
}
```

When a worker's heartbeat falls outside the deadline, its status transitions to "expired" and its locks are released. This is automatic -- there is no polling or manual expiration.

```ft
WorkerEntry << {
  status: "online" while lastHeartbeat EXISTS
}
```

The status holds while heartbeat is fresh. When the heartbeat predicate fails (too old relative to the deadline), status reverts and locks break.

## Scheduling and Lock Management

The orchestrator distributes tasks to workers based on their declared capabilities. Locks are heartbeat-gated:

```ft
SchedulerPolicy = {
  strategy: "round-robin" | "capability-match" | "priority",
  taskAssignment: string,
  workerAssignment: string
}
```

```ft
DistributedLock = {
  taskId: string,
  workerId: string,
  valid: boolean while WorkerEntry.status = "online"
}
```

When a worker's status transitions to "expired", its locks break. The task returns to the unassigned pool and is eligible for reassignment to another worker. The orchestrator notifies the new assignee via the socket channel, and the old assignee (if reachable) is informed of revocation.

## Permissions and Sub-Partitions

The orchestrator enforces permissions per partition and supports hierarchical sub-partitions that can be delegated to workers:

```ft
PartitionPermission = {
  partitionPath: string,
  workerId: string,
  access: "read" | "write" | "claim"
}
```

```ft
SubPartition = {
  path: string,
  parentPath: string,
  delegatedTo: string,
  isolated: boolean
}
```

A sub-partition is an isolated region of state. A worker delegated a sub-partition operates within its boundary without affecting sibling partitions. This is how work is hierarchically organized.

## Archival

The orchestrator archives old state to keep its active memory bounded. Archival uses a two-tier strategy: bulk data to object storage and label/index metadata to a queryable database:

```ft
ArchivalConfig = {
  threshold: number,
  dataTarget: string,
  indexTarget: string,
  lastRun: number
}
```

When the active log exceeds the threshold, entries beyond it are moved to external storage and the active log is trimmed. Historical entries are retrievable from the archive but do not burden runtime memory.

## Socket Server

The orchestrator provides a socket-based communication channel for real-time bidirectional messaging with connected workers:

```ft
SocketServer = {
  endpoint: string,
  connectedWorkers: number,
  protocol: string
}
```

Workers register via sockets, heartbeat via sockets, and receive task assignments through the same channel.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Root partition claimed exclusively | `RootPartition` with `exclusive: true`, second claim rejected |
| Worker registry with metadata | `WorkerEntry` with type, capabilities, status, heartbeat |
| Heartbeat-gated lock expiration | `valid: boolean while WorkerEntry.status = "online"` |
| Expired workers lose locks | Status transitions to "expired", locks break |
| Capability-based routing | `SchedulerPolicy` matches task requirements to worker declarations |
| Permissions per partition | `PartitionPermission` with access control |
| Sub-partition isolation | `SubPartition` scoped to boundary, no sibling interference |
| Two-tier archival | `ArchivalConfig` with data target and index target |
| Socket communication | `SocketServer` for registration, heartbeat, and task assignment |
| Cascading state changes | Lock expiration triggers task reclamation and worker notification |
