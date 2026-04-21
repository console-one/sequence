# Remote Root One-Shot Agent

A remote root one-shot agent is a short-lived agent spawned on server infrastructure to handle exactly one task, then archive and terminate. This is the serverless/Lambda-backed pattern for parallelizable work. The orchestrator may spawn hundreds concurrently, so each must be isolated, resource-efficient, and reliably report results back.

The tension: the agent must be self-contained enough to execute a complete multi-step task (deploy, then health-check, then report), yet ephemeral enough to be spawned and discarded cheaply. It plans its own execution autonomously -- the orchestrator dispatches, it does not micromanage.

---

## Problem Context

- **Actor(s)**: An orchestrator that spawns and collects results, the one-shot agent itself, and the server infrastructure that hosts it.
- **Domain**: Ephemeral server-side task execution (serverless/Lambda pattern) where an orchestrator fans out work across many short-lived agents that execute independently, report results, and terminate.
- **Core Tension**: Each agent must be self-contained enough to execute a complete multi-step task autonomously (the orchestrator dispatches, it does not micromanage), yet ephemeral enough to be spawned and discarded cheaply at high concurrency. Failure of one agent must not affect others, and silent termination must never occur.

## Requirements

**R1**: Each agent SHALL be spawned with a unique task identifier, its full input, its available capabilities, and a timeout, all determined at spawn time.
- *Rationale*: The agent's entire context is fixed at creation. It does not discover capabilities or receive additional input after spawning. The task ID links results back to the orchestrator's request.
- *Verifiable by*: An agent is spawned with a task ID, input, capability set, and timeout. All four are accessible immediately after creation and do not change.

**R2**: The agent SHALL have exactly one structured output schema that defines the completion condition.
- *Rationale*: A single, unambiguous completion condition prevents the agent from producing partial or unbounded output. "Done" means the output conforms to the schema.
- *Verifiable by*: An agent produces a result. The result validates against the declared output schema.

**R3**: The agent SHALL automatically determine the sequence of capability invocations needed to satisfy the output schema, detecting data dependencies between capability outputs and inputs.
- *Rationale*: The orchestrator dispatches a task, not a plan. The agent must autonomously figure out the execution order based on what each capability produces and consumes.
- *Verifiable by*: Given capabilities "deploy" (produces URL and status) and "healthcheck" (requires URL, produces healthy/unhealthy), the agent invokes deploy first, then healthcheck with the URL from deploy, without being told the order.

**R4**: Upon completion or failure, the agent SHALL report a structured result back to the orchestrator, correlated by task ID.
- *Rationale*: The orchestrator needs to match results to the tasks it dispatched. Without correlation, results from hundreds of concurrent agents cannot be routed.
- *Verifiable by*: An agent completes and reports a result. The orchestrator receives it and matches it to the original task by task ID.

**R5**: If the agent cannot satisfy its output schema, it SHALL report a structured failure identifying the reason and the failed step, rather than silently terminating.
- *Rationale*: A silently dead agent is an invisible failure in a system with hundreds of concurrent agents. The orchestrator must know what failed and why.
- *Verifiable by*: A capability fails during execution. The orchestrator receives a failure report containing the reason and the step that failed.

**R6**: Concurrently executing agents SHALL be fully isolated from each other, with no shared mutable state.
- *Rationale*: At high concurrency (tens to hundreds of agents), any shared state becomes a correctness and performance bottleneck. Isolation ensures one agent's behavior cannot corrupt another.
- *Verifiable by*: 10 agents spawned simultaneously with different tasks all complete independently. One agent's failure does not affect the others' execution or results.

**R7**: Each agent SHALL operate within resource boundaries (timeout, capability scope) established at spawn time. Exceeding the timeout SHALL result in termination and a structured failure report.
- *Rationale*: Unbounded execution in a serverless environment wastes resources and blocks the orchestrator. Timeouts enforce predictable resource consumption.
- *Verifiable by*: An agent exceeds its timeout. It is terminated and the orchestrator receives a timeout failure report.

**R8**: The full execution record (input, steps taken, result, timestamps) SHALL be archived before the agent is disposed, and retrievable by task ID afterward.
- *Rationale*: Even ephemeral agents must produce auditable records. Post-mortem debugging and compliance require access to what happened.
- *Verifiable by*: After an agent is disposed, its full execution record is retrievable from the archive by task ID.

## Acceptance Criteria

**AC1** [R1]: Given a spawn request with task ID, input, capabilities, and timeout, when the agent is created, then all four are accessible and immutable.

**AC2** [R2]: Given an agent that completes execution, when the result is checked against the output schema, then it validates successfully.

**AC3** [R3]: Given capabilities "deploy" and "healthcheck" with a data dependency (healthcheck requires deploy's URL output), when the agent plans execution, then deploy runs before healthcheck without manual sequencing.

**AC4** [R4]: Given a completed agent, when the orchestrator receives the result report, then the task ID in the report matches the original dispatch.

**AC5** [R5]: Given a capability failure during execution, when the agent reports back, then the report contains the failure reason and the step that failed.

**AC6** [R6]: Given 10 agents spawned simultaneously, when one fails, then the other 9 are unaffected and produce correct results.

**AC7** [R7]: Given an agent with a 30-second timeout, when execution exceeds 30 seconds, then the agent is terminated and the orchestrator receives a timeout failure.

**AC8** [R8]: Given an agent that has been disposed, when the archive is queried by task ID, then the full execution record (input, steps, result, timestamps) is returned.

## FT System Demands

- The type system must support expressing capability signatures with typed inputs and outputs to enable automatic dependency detection and sequencing.
- The kernel must support ephemeral execution contexts that can be cleanly disposed after result extraction.

## Open Questions

- What is the maximum concurrency the infrastructure should support (and how does it interact with cost limits)?
- Should the orchestrator be notified of intermediate step completions (progress), or only the final result/failure?
- What is the retention policy for archived execution records?
