# Job Shop Scheduling

## Problem Context

- **Actor(s)**: Jobs (ordered sequences of operations), machines (resources that process one operation at a time), and a scheduler or dispatcher that assigns operations to machines.
- **Domain**: Manufacturing/operations scheduling -- assigning operations to machines over time subject to ordering and capacity constraints, with the goal of minimizing total completion time (makespan).
- **Core Tension**: Two kinds of constraints interact: precedence (operations within a job must execute in order) and resource exclusivity (each machine processes one operation at a time). Both must hold simultaneously, and contention for shared machines creates bottlenecks that dominate schedule quality.

## Requirements

**R1**: An operation SHALL have a machine assignment, a duration, timing fields (start time and end time), and a status.
- *Rationale*: These are the minimum attributes needed to schedule, execute, and track an operation.
- *Verifiable by*: An operation can be created with machine, duration, and status fields; timing fields begin unset and are filled during execution.

**R2**: A job SHALL consist of an ordered sequence of operations, where the ordering defines the precedence constraint.
- *Rationale*: Job-shop scheduling is defined by the within-job ordering requirement.
- *Verifiable by*: Operations within a job are enumerable in order.

**R3**: An operation SHALL NOT start until its predecessor in the same job has completed.
- *Rationale*: This is the precedence constraint fundamental to job-shop scheduling.
- *Verifiable by*: An operation whose predecessor has status "running" cannot transition to "running" itself.

**R4**: When a predecessor completes, the next operation in the job SHALL become eligible to start.
- *Rationale*: Predecessor completion is the trigger for successor eligibility.
- *Verifiable by*: After a predecessor's status changes to "complete", the successor becomes eligible (its start precondition is satisfied).

**R5**: A machine SHALL process at most one operation at a time.
- *Rationale*: This is the resource exclusivity constraint fundamental to job-shop scheduling.
- *Verifiable by*: While a machine is processing an operation, no other operation can start on that machine.

**R6**: When an operation completes and releases its machine, other operations waiting for that machine SHALL become eligible.
- *Rationale*: Machine release is the trigger for resolving contention.
- *Verifiable by*: After a machine is released, an operation that was waiting for it becomes eligible to start.

**R7**: The makespan SHALL be a derived value equal to the maximum end time across all operations in all jobs.
- *Rationale*: Makespan is the standard objective function for job-shop scheduling.
- *Verifiable by*: After all operations complete, the makespan equals the latest end time among them.

**R8**: The system SHALL report contention -- the number of operations waiting for each machine.
- *Rationale*: Contention visibility identifies bottleneck machines, which is essential for schedule analysis and improvement.
- *Verifiable by*: A machine with 3 operations waiting for it reports a pending count of 3.

**R9**: When multiple operations contend for the same machine, a configurable policy SHALL determine which operation executes next.
- *Rationale*: Different heuristics (shortest processing time, FIFO, priority) produce different schedules with different makespans. The policy should be swappable.
- *Verifiable by*: Under shortest-processing-time, the operation with the shortest duration goes first among contenders.

**R10**: When multiple interchangeable machines of the same type exist, an operation requiring that type SHALL be assignable to any idle instance.
- *Rationale*: Parallel machines increase throughput. The system should exploit available capacity without requiring the caller to name a specific instance.
- *Verifiable by*: An operation requiring machine type "drill" starts on whichever drill instance is idle, without the caller specifying which one.

**R11**: If all instances of a required machine type are busy, the operation SHALL wait until one becomes available.
- *Rationale*: Parallel machines reduce but do not eliminate contention.
- *Verifiable by*: An operation requiring a machine type where all instances are busy does not start until one is released.

**R12**: All policies SHALL produce feasible schedules -- no schedule SHALL violate precedence or exclusivity constraints regardless of the policy chosen.
- *Rationale*: Policies affect quality (makespan), not correctness. Every schedule must be valid.
- *Verifiable by*: Under any configured policy, no operation starts before its predecessor completes and no machine runs two operations simultaneously.

## Acceptance Criteria

**AC1** [R1, R2]: Given a job with three operations on machines A, B, A with durations 5, 3, 2, when the job is created, then all operations are retrievable with their assignments and durations.

**AC2** [R3]: Given operation op2 with predecessor op1, when op1 has status "running", then op2 cannot start.

**AC3** [R4]: Given operation op2 with predecessor op1, when op1 transitions to "complete", then op2 becomes eligible to start.

**AC4** [R5]: Given machine A processing op1, when op3 (also assigned to A) attempts to start, then op3 is blocked.

**AC5** [R6]: Given machine A processing op1 and op3 waiting for A, when op1 completes and releases A, then op3 becomes eligible.

**AC6** [R7]: Given all operations complete with end times 5, 8, 10, then makespan equals 10.

**AC7** [R8]: Given machine A with 3 operations whose predecessors are complete but A is busy, then machine A reports a pending count of 3.

**AC8** [R9]: Given two operations contending for machine A with durations 10 and 3, when the policy is shortest-processing-time, then the duration-3 operation goes first.

**AC9** [R10]: Given two drill instances and one operation requiring "drill" type, when one drill is busy and the other is idle, then the operation starts on the idle drill.

**AC10** [R11]: Given two drill instances both busy, when an operation requires "drill", then it waits until one drill is released.

**AC11** [R12]: Given any scheduling policy, when a schedule is produced, then no precedence or exclusivity constraints are violated.
