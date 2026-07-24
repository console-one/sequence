# Job Shop Scheduling

A set of jobs, each consisting of ordered operations, must be scheduled across machines where each machine processes one operation at a time. The goal is to minimize makespan (total completion time). Two kinds of constraints interact: precedence (operation ordering within a job) and resource exclusivity (one operation per machine at a time). Both are expressed the same way -- as conditions on when a value can exist.

There is no scheduling engine. There is only data that becomes available when its preconditions hold.

## The Operation Type

An operation has a machine assignment, a duration, and timing fields. The start and end times begin as gaps -- they are filled when the operation actually executes:

```ft
Operation = {
  machine: string,
  duration: number >= 0,
  startTime: number >= 0,
  endTime: number >= 0,
  status: "waiting" | "running" | "complete"
}
```

A job is a named sequence of operations. The ordering within the sequence is the precedence constraint:

```ft
job1 = {
  op1: Operation,
  op2: Operation,
  op3: Operation
}
```

```ft
job1 << {
  op1: { machine: "A", duration: 5 },
  op2: { machine: "B", duration: 3 },
  op3: { machine: "A", duration: 2 }
}
```

## Precedence Constraints

An operation within a job cannot begin until the previous operation completes. This is a condition on the start time -- it exists only when the predecessor's status is "complete":

```ft
job1.op2 << { startTime: number >= 0 when job1.op1.status = "complete" }
```

```ft
job1.op3 << { startTime: number >= 0 when job1.op2.status = "complete" }
```

Until `job1.op1` completes, `job1.op2.startTime` cannot be bound. The operation is suspended -- its schema exists (it appears in obligations), but it cannot execute. When `op1.status` becomes "complete", the gate opens and `op2` can begin.

## Machine Exclusivity

A machine can serve one operation at a time. This is mutual exclusion: an operation's claim on a machine holds only while no other operation is using that machine.

```ft
MachineSlot = {
  currentOp: string,
  busy: boolean
}
```

```ft
machineA = MachineSlot
machineA << { currentOp: "job1.op1", busy: true }
```

-- Machine exclusivity predicate (prose): An operation can bind its startTime on machine M only when machineM.busy = false. When an operation claims the machine, machineM.busy becomes true and machineM.currentOp is set to identify the operation. Other operations needing machine M suspend until busy returns to false. When the operation completes (its endTime is set and status becomes "complete"), the machine is released.

## Operation Execution

When an operation's preconditions are met (predecessor complete, machine free), it executes:

```ft
machineA << { currentOp: "job1.op1", busy: true }
job1.op1 << { startTime: 0, status: "running" }
```

When the duration elapses:

```ft
job1.op1 << { endTime: 5, status: "complete" }
machineA << { currentOp: "", busy: false }
```

Releasing the machine (busy: false) allows the next waiting operation to proceed. The successor operation's `when` gate opens because the predecessor is now "complete".

## Makespan

The makespan is the maximum end time across all operations in all jobs. It is a derived value:

```ft
makespan = number >= 0
```

-- Makespan derivation (prose): makespan equals the maximum of all endTime values across all operations in all jobs. It recomputes whenever any operation completes. The makespan is readable at any point -- during execution it reflects partial progress; after all operations complete it is the final schedule length.

## Contention Detection

When multiple operations are waiting for the same machine, contention is visible as the count of suspended operations per machine:

```ft
machineA << { pendingCount: number.integer >= 0 }
```

-- Contention tracking (prose): pendingCount is the number of operations whose preconditions are met except for machine availability. A machine with a high pendingCount is a bottleneck. This value is derived from the set of suspended operations, not manually maintained.

## Scheduling Heuristics

When multiple operations contend for the same machine, a policy determines which goes next:

```ft
policy machineOrdering: { strategy: "shortest-processing-time" }
```

```ft
policy machineOrdering: { strategy: "first-come-first-served" }
```

The policy selects among operations that are ready (predecessor done) and waiting for the machine. Different policies produce different schedules with different makespans, but all produce feasible schedules (no precedence or exclusivity violations).

## Parallel Machines

Multiple machines of the same type are interchangeable. An operation requiring a machine type (not a specific machine) can use any idle machine of that type:

```ft
MachineType = {
  kind: string,
  instances: number.integer >= 0
}
```

```ft
drills = MachineType
drills << { kind: "drill", instances: 2 }
```

-- Parallel machine assignment (prose): An operation requiring machine type "drill" is assignable to any idle drill instance. The system selects an available instance rather than requiring the caller to name a specific machine. If all instances of the required type are busy, the operation suspends until one becomes available.

## Capabilities

The externally-provided operations: starting an operation (claiming a machine and recording start time) and completing an operation (releasing the machine and recording end time):

```ft
cap Operation.startTime
cap Operation.endTime
cap Operation.status
cap MachineSlot.currentOp
cap MachineSlot.busy
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Operations retrievable with machine/duration (AC1) | `job1 << { op1: { machine: "A", duration: 5 }, ... }` |
| Predecessor must complete before successor starts (AC2) | `startTime when job1.op1.status = "complete"` suspends op2 |
| Predecessor completion opens successor gate (AC3) | `op1 << { status: "complete" }` satisfies the when condition |
| Machine exclusivity suspends competing operations (AC4) | Operation suspends when machineM.busy = true |
| Makespan equals last completion time (AC5) | Derived makespan = max of all endTime values |
| Contention reported as bottleneck (AC6) | `machineA << { pendingCount: 3 }` shows bottleneck |
| Shortest-processing-time heuristic selects correctly (AC7) | `policy machineOrdering: { strategy: "shortest-processing-time" }` |
| Operation assigned to idle parallel machine (AC8) | Parallel machine assignment selects any available instance of required type |
