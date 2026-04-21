# Local One-Shot Agent

A one-shot agent takes a structured input, does the work, and produces a result. No ongoing lifecycle, no history, no session. It is fire-and-forget: the caller submits a task, receives a result, and the agent is done. The execution is ephemeral -- there is nothing to resume and nothing to consult.

The value is simplicity. The agent must be self-contained enough to accomplish a task in one pass (potentially chaining multiple capabilities) yet fail explicitly if it cannot. There is no retry loop watching for incomplete results -- one-shot means one chance.

---

## Problem Context

- **Actor(s)**: A caller (user or process) that submits a task, and the one-shot agent that executes it.
- **Domain**: Ephemeral local task execution where a structured input produces a structured output in a single pass, using locally available capabilities (filesystem, shell, LLM).
- **Core Tension**: The agent must be self-contained enough to chain multiple capabilities into a complete result, yet has exactly one chance -- there is no session to resume and no retry loop. Failure must be explicit because there is no one watching for partial results.

## Requirements

**R1**: The agent SHALL accept a structured input consisting of a prompt, a context, and an output schema.
- *Rationale*: The output schema defines the completion condition. Without it, the agent has no way to determine when it is done.
- *Verifiable by*: An agent is created with a prompt, context, and output schema, and all three are accessible before execution begins.

**R2**: The agent SHALL produce a result conforming to the declared output schema, or report a structured failure.
- *Rationale*: Callers depend on either a valid result or an actionable error. Partial, malformed, or empty results are worse than explicit failure.
- *Verifiable by*: On success, the result validates against the output schema. On failure, a structured error is returned with a reason.

**R3**: The agent SHALL have access to locally available capabilities (filesystem, shell, LLM) as typed, discoverable operations.
- *Rationale*: The agent must know what it can do (and what each operation requires) to plan its execution.
- *Verifiable by*: Before execution, the agent can enumerate available capabilities with their input and output types.

**R4**: The agent SHALL automatically determine the sequence of capability invocations needed to satisfy the output schema, based on data dependencies between capability inputs and outputs.
- *Rationale*: The caller provides the goal, not the plan. Requiring manual sequencing defeats the purpose of an autonomous agent.
- *Verifiable by*: Given a task "summarize this file" with file-read and LLM capabilities available, the agent reads the file before invoking the LLM (because the LLM needs the file content as input) without being told the order.

**R5**: After producing a result, the agent's execution context SHALL be fully disposable with no residual state.
- *Rationale*: Ephemeral agents must not leak state across invocations. Each one-shot execution is independent.
- *Verifiable by*: After result extraction, no references to the execution context remain active. A subsequent one-shot agent shares nothing with a prior one.

**R6**: When the agent cannot satisfy the output schema, it SHALL report a structured failure identifying the reason (e.g., missing capability, invalid input, capability error).
- *Rationale*: With no retry loop, silent failure means the caller never knows what went wrong. Structured failure enables the caller to take corrective action.
- *Verifiable by*: A task requiring a capability that is not available produces a failure report identifying the missing capability.

**R7**: Multiple one-shot agents SHALL be executable concurrently with complete isolation between them.
- *Rationale*: Callers may need to fan out work across many agents in parallel. Shared mutable state between agents would introduce coordination complexity and correctness risks.
- *Verifiable by*: Two one-shot agents spawned simultaneously with different inputs produce correct, independent results. One agent's failure does not affect the other.

## Acceptance Criteria

**AC1** [R1]: Given a prompt "Summarize this file", a context containing a file path, and an output schema requiring a summary string, when the agent is created, then all three inputs are accessible before execution begins.

**AC2** [R2]: Given valid input and available capabilities, when the agent executes, then the result conforms to the declared output schema.

**AC3** [R2, R6]: Given a task requiring a capability that is not available, when the agent executes, then a structured failure is returned identifying the missing capability.

**AC4** [R3]: Given an agent with filesystem and LLM capabilities configured, when the agent enumerates its capabilities, then both are listed with their input and output types.

**AC5** [R4]: Given a task requiring file read then LLM invocation, when the agent plans execution, then it sequences the file read before the LLM call based on data dependency.

**AC6** [R5]: Given a completed one-shot agent, when the result is extracted, then no execution state persists and a new agent shares nothing with the completed one.

**AC7** [R7]: Given two one-shot agents spawned simultaneously with different inputs, when both execute, then both produce correct independent results.

## FT System Demands

- The type system must support expressing output schemas as completion conditions that can be checked against a result.
- Capability type signatures (input and output types) must be matchable to enable automatic sequencing based on data dependency.

## Open Questions

- Should there be a timeout on one-shot execution, and if so, what happens when it is exceeded (structured failure, or a different mechanism)?
- Can a one-shot agent spawn sub-agents, or is it strictly single-pass?
