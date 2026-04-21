# AWS Lambda Container

## Original Notes

We want to create a container for the process to run in an AWS Lambda. This would obviously have certain limitations because AWS Lambda doesn't enable you to have persistent memory for a long period of time or persistent memory beyond certain size thresholds. You can't really rely on it to have a good single-threaded scheduler and other things, but it would be really strong for managing one-shot agent narratives that we might want to have highly parallelized but running in sequence in very rapid scale-up and scale-down notation.

We would like to create an AWS Lambda image type with the ability to have certain tools that are required for a certain LLM to run with a certain tool recipe that can run on AWS Lambda. It would just be a central orchestrator, probably running on Docker EC2, able to fan out work to like 100 of them, let's just say, and just do big-time scheduling.

If any of the, we probably would, on boot, have the AWS Lambda image set up its process environment. Its process would then try to claim a lock while we're setting up the snapshot environment. We're setting up the sockets to register the content-addressable ID of that Lambda to mount its process log at some location in the distributed server. If anybody wants to call this agent, they would call that process in the distributed server, like `send message` or whatever. That `send message` in the distributed server would just write to the socket store, which would eventually come to this agent. We would set up the rules within the process for this agent to update some local value for: heartbeat, send heartbeat, claim lock, extend lock, claim every N seconds -- to basically send heartbeats through that socket, which the central server would then receive and patch to the partition dedicated to this process's agent's last lock claim time. And it would be like when this agent's facade is mounted. It would be mounted with the condition to tear it down and remove the agent's hold on locks if that heartbeat isn't sent. And like D scale the jobs from it, et cetera. The second it's in, like, the server, when it sets up on the server, it's going to send its contract for all the different types of requests that could be sent to it. It could potentially handle its capabilities and then the orchestration server. It looks at those capabilities, figures out what function types it has that are undefined based on conjugates or whatever, and uses that information that the agent exists to update the probabilities and the resolution path for all the functions that would be enabled because this agent is available to now handle those types of task requests.

Those functions would be like if the agent registered under the orchestration server, saying, "Hey, orchestration server, I can do read and write to the file system for data type X." The orchestration server has internally some definition of the probability that it could mount a function for reading and writing to just data type X. Using the identity equivalences, adding that agent and that agent's constraints might create a new shortest path for any plan that requires that as a prerequisite. And so, as part of that entire rebalancing process, it might then start sending some of its tasks to the agent. Or it might just include the agent in a round-robin queue that gets the next request for that particular function anytime it's called.

---

A Lambda worker is an ephemeral compute unit that boots, does one job, and dies. The orchestrator needs to treat it as a reliable capability provider for the duration of its lifecycle without assuming it will live forever. The hard part is the lifecycle: register identity, declare capabilities, prove liveness via heartbeat, hold locks on assigned work, and have all of that unwind automatically when the worker disappears. Every Lambda is a temporary extension of the orchestrator's capability surface.

The boot sequence is load-bearing: identity must exist before a lock can be claimed, a lock before a heartbeat proves anything, a heartbeat before capabilities are meaningful, and capabilities before work can arrive. Get the order wrong and work arrives at an unprepared worker.

## Problem Context

- **Actor(s)**: Lambda worker (ephemeral compute), central orchestrator (persistent scheduler on EC2), callers requesting task execution.
- **Domain**: Distributed task execution using AWS Lambda as massively parallel, ephemeral compute backing a central orchestrator.
- **Core Tension**: The worker is ephemeral (Lambda dies at any time) but must behave as a reliable capability provider while alive. The orchestrator must detect death quickly and reassign work without data loss or duplicate execution.

## Requirements

**R1**: Each Lambda worker SHALL have a content-addressed identity derived from its configuration, unique within the orchestrator's worker pool.
- *Rationale*: The orchestrator must distinguish workers and detect restarts vs. new instances.
- *Verifiable by*: Two workers with identical configuration produce the same identity; different configurations produce different identities.

**R2**: Worker boot SHALL proceed through a fixed phase sequence: identity registration, lock acquisition, heartbeat establishment, capability declaration, ready.
- *Rationale*: Each phase depends on the prior (e.g., capabilities are meaningless without a heartbeat proving liveness). Out-of-order boot leads to work arriving at an unprepared worker.
- *Verifiable by*: A worker that has not completed phase N cannot enter phase N+1. Work is not routed to a worker not in "ready" phase.

**R3**: A worker SHALL send periodic heartbeats to the orchestrator at a configurable interval.
- *Rationale*: The orchestrator has no other mechanism to detect worker liveness in a serverless environment.
- *Verifiable by*: Heartbeat messages arrive at the orchestrator at the configured interval while the worker is alive.

**R4**: The orchestrator SHALL treat a worker as dead if no heartbeat is received within the configured liveness window.
- *Rationale*: Lambda can be killed at any time. Stale workers must be detected promptly to reassign their work.
- *Verifiable by*: A worker that stops heartbeating is marked dead within one liveness window duration.

**R5**: All locks held by a dead worker SHALL be automatically released.
- *Rationale*: Locked tasks on a dead worker would be permanently stuck without automatic release.
- *Verifiable by*: After a worker is marked dead, its previously locked tasks are available for reassignment.

**R6**: A worker SHALL declare its capabilities (typed function signatures with input/output types) during boot.
- *Rationale*: The orchestrator must know what each worker can do to route tasks correctly.
- *Verifiable by*: After boot, the orchestrator's capability registry includes the worker's declared functions.

**R7**: When a new worker registers capabilities, the orchestrator SHALL re-evaluate which pending tasks are now resolvable.
- *Rationale*: A new capability may create resolution paths for previously unresolvable tasks. The original notes describe this as creating "a new shortest path for any plan that requires that as a prerequisite."
- *Verifiable by*: A pending task with no eligible worker becomes assignable after a worker registers the matching capability.

**R8**: The orchestrator SHALL distribute tasks across eligible workers using a fair scheduling policy (e.g., round-robin) when multiple workers declare the same capability.
- *Rationale*: Prevents hot-spotting a single worker and ensures even utilization across the Lambda fleet.
- *Verifiable by*: Given N workers with the same capability and M tasks, each worker receives approximately M/N tasks.

**R9**: Workers SHALL communicate with the orchestrator via a persistent socket channel for heartbeats, capability declaration, and task receipt.
- *Rationale*: A single bidirectional channel simplifies the protocol and reduces connection overhead for short-lived workers.
- *Verifiable by*: All worker-orchestrator interactions (heartbeat, capability registration, task assignment) occur over the same socket connection.

**R10**: The system SHALL support at least 100 concurrent Lambda workers connected to a single orchestrator.
- *Rationale*: The original notes explicitly call for "fan out work to like 100 of them" for parallel task execution.
- *Verifiable by*: 100 workers simultaneously registered and receiving task assignments without orchestrator degradation.

## Acceptance Criteria

**AC1** [R1]: Given a Lambda worker booting with a specific configuration, when it registers with the orchestrator, then its identity is a deterministic hash of that configuration.

**AC2** [R2]: Given a worker that has registered identity but not established a heartbeat, when a task matching its capabilities is submitted, then the task is NOT routed to that worker.

**AC3** [R3, R4]: Given a worker with a 5-second liveness window, when the worker stops sending heartbeats, then the orchestrator marks it dead within 5 seconds.

**AC4** [R5]: Given a worker holding locks on 3 tasks, when the worker is marked dead, then all 3 tasks become available for reassignment to other workers.

**AC5** [R6, R7]: Given a pending task requiring capability "read-filesystem-X" with no eligible worker, when a new worker boots and declares "read-filesystem-X", then the task becomes assignable to that worker.

**AC6** [R8]: Given 3 workers with identical capabilities and 9 incoming tasks, when all tasks are routed, then each worker receives 3 tasks.

**AC7** [R10]: Given 100 Lambda workers booting simultaneously, when all complete registration, then the orchestrator tracks all 100 and routes tasks to them without errors.

## Open Questions

- **Lock contention during reassignment**: When a dead worker's tasks are released, should they be re-queued at the front or back of the pending queue?
- **Capability versioning**: If a worker declares the same capability with different type signatures than existing workers, should they be treated as the same or different capabilities?
- **Graceful shutdown**: Should there be a protocol for a Lambda nearing its timeout to voluntarily release locks before forced death?
