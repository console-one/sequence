# Task Scheduling

## Problem Context

- **Actor(s)**: Tasks (units of work with preconditions and resource requirements), resources (workers/slots that execute tasks), and the scheduling system that determines which tasks are eligible and which resources serve them.
- **Domain**: Dynamic task scheduling -- determining which tasks are ready to execute based on preconditions and resource availability, adapting in real time as conditions change.
- **Core Tension**: The schedule is not a static plan computed upfront. Tasks become eligible when their preconditions are satisfied and a resource is free. Conditions change continuously (tasks complete, resources fail, new tasks arrive), so the set of eligible tasks must update in real time without recomputing from scratch.

## Requirements

**R1**: A task SHALL have preconditions, a resource requirement, a duration, a status (waiting, schedulable, running, complete), and an output slot.
- *Rationale*: These are the minimum attributes needed to evaluate eligibility, assign resources, track execution, and propagate results.
- *Verifiable by*: A task can be created with all attributes; status begins as "waiting" and output begins unset.

**R2**: A task SHALL transition from "waiting" to "schedulable" when all of its preconditions are simultaneously satisfied.
- *Rationale*: Preconditions gate eligibility. Partial satisfaction is not sufficient.
- *Verifiable by*: A task with two preconditions remains "waiting" when only one is met. It becomes "schedulable" when both are met.

**R3**: Preconditions SHALL be conditions on existing state -- not edges in a separate dependency graph.
- *Rationale*: Data-driven dependencies are more flexible than graph edges. A task depends on the data, not the producer. If another source provides the same data, the task becomes eligible.
- *Verifiable by*: A task with a precondition "inputData exists" becomes schedulable when inputData is provided by any source, not only by a specific predecessor task.

**R4**: A resource SHALL have a status (free, busy, failed) and track which task it is currently serving.
- *Rationale*: Resource state determines which tasks can run and which must wait.
- *Verifiable by*: A resource can be queried for its status and current task assignment.

**R5**: A task's transition from "schedulable" to "running" SHALL require that its required resource has status "free".
- *Rationale*: Resource exclusivity -- a busy resource cannot serve a new task.
- *Verifiable by*: A schedulable task targeting a busy resource does not transition to "running" until the resource becomes free.

**R6**: When a task completes, it SHALL release its resource (setting it to "free") and populate its output.
- *Rationale*: Resource release enables subsequent tasks. Output population satisfies downstream preconditions.
- *Verifiable by*: After a task completes, its resource reports "free" and the task's output is populated.

**R7**: When multiple schedulable tasks require the same resource, a configurable ordering policy SHALL determine which task gets the resource.
- *Rationale*: Different heuristics (shortest-job-first, FIFO, priority) suit different domains. The policy should be swappable.
- *Verifiable by*: Under shortest-job-first, the task with the shortest duration gets the resource. Under FIFO, the task that became schedulable first gets it.

**R8**: New tasks arriving mid-execution SHALL be evaluated immediately against current state.
- *Rationale*: A dynamically arriving task whose preconditions are already satisfied should become schedulable immediately, without a global reschedule.
- *Verifiable by*: A task added whose preconditions are already met becomes "schedulable" immediately upon arrival.

**R9**: When a resource fails, tasks depending on that resource that are "schedulable" or "running" SHALL be suspended.
- *Rationale*: A failed resource cannot serve tasks. Tasks on other resources should be unaffected.
- *Verifiable by*: When a resource transitions to "failed", tasks assigned to it are suspended. Tasks on other resources continue.

**R10**: When a failed resource recovers, suspended tasks SHALL re-evaluate their eligibility.
- *Rationale*: Recovery should restore normal scheduling without manual intervention.
- *Verifiable by*: When a resource transitions from "failed" to "free", previously suspended tasks re-evaluate and, if still eligible, become schedulable.

**R11**: Tasks SHALL support temporal constraints: a "not before" time and a "deadline".
- *Rationale*: Time-sensitive workloads require scheduling within windows.
- *Verifiable by*: A task with "not before T" does not become schedulable until time T, even if all other preconditions are met. A task approaching its deadline is flagged.

**R12**: Temporal constraints SHALL compose with other preconditions -- all must hold simultaneously for the task to become schedulable.
- *Rationale*: Temporal constraints are not special; they are additional conditions alongside data preconditions.
- *Verifiable by*: A task with both a data precondition and a "not before" constraint becomes schedulable only when both are satisfied.

**R13**: For each non-schedulable task, the system SHALL report which preconditions are unmet.
- *Rationale*: Operators need to answer "why isn't this task running?" without manual investigation.
- *Verifiable by*: A waiting task reports a list of its unmet preconditions.

**R14**: Task dependencies SHALL be data-driven: task B depends on task A's output because B has a precondition on A's output existing, not because of a declared edge between A and B.
- *Rationale*: Data-driven dependencies decouple producers from consumers. If the data is provided by a different source, the dependency is still satisfied.
- *Verifiable by*: A task with precondition "taskA.output exists" becomes schedulable when taskA.output is populated, but also becomes schedulable if some other mechanism populates the same data.

## Acceptance Criteria

**AC1** [R1, R2]: Given a task with precondition "taskA complete" and taskA is not yet complete, then the task has status "waiting". When taskA completes, then the task transitions to "schedulable".

**AC2** [R3, R14]: Given a task with precondition "inputData exists", when inputData is provided by an unrelated source (not the expected predecessor), then the task becomes "schedulable".

**AC3** [R4, R5]: Given a schedulable task requiring worker-1, when worker-1 has status "busy", then the task does not run. When worker-1 becomes "free", then the task can transition to "running".

**AC4** [R6]: Given a running task on worker-1, when the task completes, then worker-1 status is "free" and the task's output is populated.

**AC5** [R7]: Given two schedulable tasks requiring worker-1 with durations 10 and 3, when the policy is shortest-job-first, then the duration-3 task gets worker-1. When the policy is FIFO, then the task that became schedulable first gets it.

**AC6** [R8]: Given a system mid-execution, when a new task arrives whose preconditions are already met, then it becomes "schedulable" immediately.

**AC7** [R9, R10]: Given tasks assigned to worker-1, when worker-1 fails, then those tasks are suspended. When worker-1 recovers to "free", then they re-evaluate eligibility.

**AC8** [R11, R12]: Given a task with precondition "data exists" and temporal constraint "not before T=100", when data exists but time is 50, then the task is "waiting". When time reaches 100, then it becomes "schedulable".

**AC9** [R13]: Given a waiting task with two unmet preconditions, when the system is queried, then both unmet preconditions are reported for that task.
