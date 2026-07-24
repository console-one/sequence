# Cancel, Update, Close

An active operation is one whose lifetime condition currently holds. There is no "status" flag to toggle -- liveness is derived from whether the declared condition is true. The three lifecycle transitions (update, cancel, close) must be distinct in semantics but expressed through existing mechanisms: write, invalidation, and condition-break. Cancel is unilateral revocation. Close is graceful self-termination. Update is just another write.

No separate "update", "cancel", or "close" primitives exist. Reactions to lifecycle changes are declarative (condition-based), never procedural (callback-based).

## The Operation Type

An operation has a value, a lifetime condition, and an optional closure signal path. It is active while the condition holds:

```ft
Operation = {
  value: string,
  status: "active" | "closed" | "cancelled",
  closureSignal: boolean
}
```

The `status` field is what the lifetime condition references. The `closureSignal` is written when the operation terminates, enabling downstream reactions.

## Lifetime-Conditioned Operations

An operation's values are observable only while its lifetime condition holds. When the condition breaks, the values vanish from the observable state:

```ft
task = Operation
task << { value: "initial payload" }
task << { status: "active" }
task.value = "initial payload" when task.status = "active"
```

As long as `status` equals `"active"`, the task's value is observable. The moment status changes, the `when` condition breaks and the value disappears.

## Update

Update is just a write to the same path. No special operation:

```ft
task << { value: "updated payload" }
```

The new value supersedes the old one. The lifetime condition is unaffected -- the operation continues under the same liveness rules.

## Close

Close is graceful: the operation terminates itself by writing a value that breaks its own lifetime condition. The closure signal fires for downstream reactions:

```ft
task << { status: "closed" }
-- status is no longer "active", so the when condition breaks
-- task.value disappears from observable state
task << { closureSignal: true }
```

The closure signal is a separate path. Downstream operations condition on it.

## Cancel

Cancel is unilateral revocation -- an external force removes the operation entirely. Unlike close, cancel does not go through the operation's own lifecycle rules:

```ft
delete task.value
task << { status: "cancelled" }
```

The operation's contributions are removed from observable state. The cancellation is recorded (status becomes "cancelled") so it is distinguishable from close in the audit trail.

## Downstream Reactions

A downstream operation gates on the closure signal. It suspends until the upstream operation terminates, then resumes automatically:

```ft
cleanup = { action: "archive" } when task.closureSignal EXISTS
```

When `task.closureSignal` is written (by close), the `when` condition is satisfied and `cleanup` becomes active. This is purely declarative -- no callbacks, no polling.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Operation active while condition holds, inactive when it breaks | `task.value = "initial payload" when task.status = "active"` |
| Update is a new write to the same path | `task << { value: "updated payload" }` |
| Cancel removes contributions and records cancellation | `delete task.value` + `task << { status: "cancelled" }` |
| Close breaks lifetime condition, writes closure signal | `task << { status: "closed" }` + `task << { closureSignal: true }` |
| Downstream operation resumes on closure signal | `cleanup = { action: "archive" } when task.closureSignal EXISTS` |
| Cancel vs close distinguishable in audit trail | `status: "cancelled"` vs `status: "closed"` |
