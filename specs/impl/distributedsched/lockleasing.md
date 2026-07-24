# Lock Leasing

A lock is a temporary, exclusive write permission over a partition, granted to a remote delegate and maintained by continuous proof-of-life. Three conditions must hold simultaneously for a lock to remain valid: the delegate's capabilities must match the partition's requirements, the offer must be confirmed before its deadline, and the holder must keep heartbeating. When any condition fails, the lock revokes automatically and dependent operations cascade.

There are no manual lock cleanups. There is no possibility of two holders. The lock is a conjunction of conditions -- it exists exactly as long as all conditions hold.

## The Lock Offer

A lock begins as an offer. The partition owner proposes a lock to a delegate whose capabilities match the partition's requirements. The offer has a deadline -- if the delegate does not confirm in time, the offer withdraws:

```ft
LockOffer = {
  partition: string,
  delegate: string,
  requiredCapability: string,
  deadline: number,
  status: "pending" | "confirmed" | "withdrawn"
}
```

The offer is generated only when capability matching succeeds. A delegate without the required capability never receives an offer:

```ft
offer1 = LockOffer
offer1 << {
  partition: "partition-A",
  delegate: "delegate-1",
  requiredCapability: "dataTransform",
  deadline: 30000,
  status: "pending"
}
```

The offer targets only delegates whose capability matches `requiredCapability`. No capability match, no offer.

## Deadline Enforcement

If the delegate does not confirm before the deadline, the offer is automatically withdrawn. This is a predicate on time, not a timer callback.

When the current time exceeds the offer's `deadline` and `status` is still "pending", the status transitions to "withdrawn". The partition becomes available for new offers to other delegates. No manual cleanup required.

```ft
offer1 << { status: "confirmed" }
```

The above shows the confirmation path. If confirmation arrives before the deadline, the offer is accepted. If not, the deadline predicate fires and the offer is withdrawn.

## Lock Grant

When the delegate confirms before the deadline, the lock is granted. The delegate gains write permission over the partition:

```ft
Lock = {
  partition: string,
  holder: string,
  heartbeat: number,
  heartbeatWindow: number,
  status: "active" | "revoked"
}
```

```ft
lock1 = Lock
lock1 << {
  partition: "partition-A",
  holder: "delegate-1",
  heartbeat: 1000,
  heartbeatWindow: 2000,
  status: "active"
}
```

The lock exists because the offer was confirmed. The lock's lifecycle is tied to the confirmation event -- no confirmation, no lock.

## Heartbeat Maintenance

A granted lock must be continuously maintained. The holder sends heartbeats. If heartbeats cease, the lock revokes automatically.

The revocation condition: when the heartbeat timestamp is older than `heartbeatWindow` from the current time (`heartbeat < currentTime - heartbeatWindow`), the lock's status transitions to "revoked". No polling -- the predicate on stored values detects the failure.

Each heartbeat refreshes the timestamp:

```ft
lock1 << { heartbeat: 2000 }
```

When the heartbeat is fresh, the lock remains active. When the heartbeat goes stale, the lock revokes and all dependent operations cascade.

## Mutual Exclusion

At most one delegate holds the lock for a given partition. A second request for the same partition suspends until the current lock is released or revoked:

```ft
lock2 = Lock
lock2 << {
  partition: "partition-A",
  holder: "delegate-2",
  heartbeat: 3000,
  heartbeatWindow: 2000,
  status: "active"
}
```

`lock2` cannot activate while `lock1` is active. The mutual exclusion guarantee means the new lock waits for the old lock to end -- `lock1.status` must be "revoked" before `lock2` can proceed. This ensures no two holders exist simultaneously.

## Write Propagation and Cascading Revocation

Writes performed under the lock are propagated back to the partition owner. When a lock is revoked, all operations that depended on it are invalidated:

```ft
writePermission = ref(lock1)

tool Lock.heartbeat
tool Lock.status
tool LockOffer.status
```

Operations conditioned on the lock being active break when the lock revokes. Write permission, routing rules, in-flight tasks -- everything gated on the lock's existence invalidates in the same logical step. After revocation, the partition is available for new lock offers.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Offer generated on capability match | Offers target delegates whose capability matches `requiredCapability` |
| No offer without matching capability | Capability matching is a precondition for offer creation |
| Deadline-based offer withdrawal | Status transitions to "withdrawn" when deadline passes without confirmation |
| Lock granted on confirmation | `lock1` created with `status: "active"` after `offer1.status = "confirmed"` |
| Heartbeat-maintained lock | Lock revokes when heartbeat goes stale beyond `heartbeatWindow` |
| Mutual exclusion (one holder) | `lock2` cannot activate while `lock1.status = "active"` |
| Lock revocation after revoke, new cycle proceeds | Partition available for new offers after `status: "revoked"` |
| Writes propagated to owner | `writePermission = ref(lock1)` ties writes to active lock |
| Cascading invalidation on revocation | Operations gated on lock existence break on revoke |
