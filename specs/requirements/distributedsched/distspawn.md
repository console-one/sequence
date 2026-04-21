# Distributed Spawn

Spawning a remote worker is asynchronous and uncertain. The orchestrator declares that a worker should exist with certain capabilities, but the worker takes time to boot, may fail to start, and may die after starting. The system must plan around workers that are declared but not yet live, without treating their capabilities as fully available until proven.

The key distinction: a declared capability (schema only) is not a live capability (implementation registered). Declared workers can be included in speculative plans at reduced confidence, but tasks must not be dispatched to them until they confirm readiness.

## Problem Context

- **Actor(s)**: The orchestrator (declares worker intent), the worker process (boots, registers, heartbeats), the scheduler (plans and dispatches tasks).
- **Domain**: Remote worker lifecycle management in distributed systems where boot is asynchronous and failure is common.
- **Core Tension**: The scheduler benefits from knowing about workers as early as possible (for planning), but must not dispatch work to workers that have not confirmed readiness. The gap between declaration and readiness is where incorrect assumptions cause failures.

## Requirements

**R1**: The system SHALL support declaring a worker with a specified capability, runtime type, and boot timeout, without blocking the orchestrator.
- *Rationale*: Worker boot is asynchronous and may take seconds or minutes depending on the runtime. The orchestrator must continue managing other workers and tasks.
- *Verifiable by*: After declaring a worker, the orchestrator can immediately issue further commands without waiting for the worker to boot.

**R2**: A declared-but-not-yet-live worker SHALL be assigned a "spawning" status and a low confidence score.
- *Rationale*: The scheduler needs to distinguish between a declared intent and a confirmed capability. Low confidence prevents the scheduler from relying on unproven workers for critical dispatch.
- *Verifiable by*: A newly declared worker reports status "spawning" and a confidence score significantly below that of an online worker.

**R3**: When a worker confirms readiness (registers its implementation), the system SHALL transition its status to "online" and increase its confidence score.
- *Rationale*: Registration is the proof that the worker is real and capable. This transition unlocks the worker for task dispatch.
- *Verifiable by*: After registration, the worker's status is "online" and its confidence score is high.

**R4**: Tasks SHALL NOT be dispatched to a worker whose status is not "online".
- *Rationale*: Dispatching to a "spawning" or "degraded" worker would result in dropped or failed tasks.
- *Verifiable by*: A task requiring a capability offered only by a "spawning" worker is not dispatched; it remains pending.

**R5**: The scheduler MAY include declared (spawning) workers in speculative planning at their declared confidence level.
- *Rationale*: Speculative planning allows the scheduler to pre-allocate work and reduce latency once workers come online, without committing to dispatch.
- *Verifiable by*: A scheduling plan includes a spawning worker's capability at reduced confidence, but does not mark the task as dispatched.

**R6**: Once online, a worker SHALL maintain liveness through periodic heartbeats. If heartbeats cease, the worker's status SHALL transition to "degraded" and tasks SHALL NOT be dispatched to it.
- *Rationale*: A worker that stops heartbeating may have crashed. Continued dispatch to a dead worker wastes time and drops tasks.
- *Verifiable by*: An online worker that stops heartbeating transitions to "degraded" status; new tasks are not dispatched to it.

**R7**: If a declared worker fails to register within its configured boot timeout, the system SHALL transition it to "offline" status and surface the missing capability as an unfulfilled need.
- *Rationale*: A worker that never boots must not silently remain in "spawning" indefinitely. The system must surface the missing capability so operators or automated recovery can act.
- *Verifiable by*: A worker declared with a 30s boot timeout that does not register within 30s transitions to "offline"; the capability it was supposed to provide is surfaced as unfulfilled.

**R8**: Each worker's runtime type (e.g., lambda, container, local) SHALL be recorded and queryable.
- *Rationale*: Different runtime types have different cost, latency, and failure characteristics. The orchestrator and monitoring systems need this metadata.
- *Verifiable by*: A worker declared with `runtime: "lambda"` reports "lambda" when its runtime type is queried.

## Acceptance Criteria

**AC1** [R1]: Given an orchestrator that declares a worker, when the declaration completes, then the orchestrator can immediately issue a second declaration without blocking.

**AC2** [R2]: Given a newly declared worker, when its status is queried, then it reports "spawning" with confidence <= 30.

**AC3** [R3]: Given a spawning worker that registers its implementation, when its status is queried after registration, then it reports "online" with confidence >= 90.

**AC4** [R4]: Given a task requiring capability "parseData" and only one worker with that capability in "spawning" status, when the scheduler evaluates dispatch, then the task is not dispatched.

**AC5** [R5]: Given a spawning worker with capability "parseData" at confidence 30, when the scheduler generates a speculative plan, then the plan includes "parseData" at reduced confidence.

**AC6** [R6]: Given an online worker that stops sending heartbeats for longer than 5 seconds, when the system evaluates its status, then it transitions to "degraded" and no new tasks are dispatched to it.

**AC7** [R7]: Given a worker declared with `bootTimeout: 30000` that never registers, when 30 seconds elapse, then the worker transitions to "offline" and its declared capability is surfaced as unfulfilled.

**AC8** [R8]: Given a worker declared with `runtime: "lambda"`, when the worker's metadata is queried, then the runtime field reports "lambda".

## Open Questions

- **Recovery from degraded**: Can a degraded worker return to "online" by resuming heartbeats, or must it re-register? This affects recovery latency.
- **Speculative plan commitment**: If a spawning worker comes online while a speculative plan includes it, does the plan automatically activate or does it require re-evaluation?
- **Multiple workers, same capability**: When multiple workers offer the same capability at different confidence levels, how does the scheduler prioritize among them?
