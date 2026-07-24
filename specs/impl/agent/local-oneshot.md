# Local One-Shot Agent

A one-shot agent takes a structured input, does the work, and produces a result. No ongoing lifecycle, no history, no session. It is fire-and-forget: the caller submits a task, receives a result, and the agent is done. The execution is ephemeral -- there is nothing to resume and nothing to consult.

The value is simplicity. The agent must be self-contained enough to accomplish a task in one pass (potentially chaining multiple capabilities) yet fail explicitly if it cannot. There is no retry loop watching for incomplete results -- one-shot means one chance.

## Task Input

The agent accepts a structured input consisting of a prompt (what to do) and a context (what to do it with):

```ft
OneShotInput = {
  prompt: string,
  context: string,
  outputSchema: string
}
```

The output schema is declared before execution begins. It defines the completion condition -- what "done" looks like. Without it, the agent has no termination criterion.

## Output Obligation

The output obligation is a typed shape that must be filled:

```ft
OneShotObligation = {
  schema: string,
  fulfilled: boolean,
  result: string
}
```

```ft
OneShotObligation << { fulfilled: false }
-- obligation exists but is empty; surfaces in obligations()
```

The agent works toward filling this obligation. When the result conforms to the schema, the obligation is fulfilled and the agent is complete.

## Local Capabilities

The agent has access to local capabilities (filesystem, shell, LLM) as typed, invocable operations:

```ft
LocalCap = {
  name: string,
  inputType: string,
  outputType: string,
  available: boolean
}
```

```ft
tool LocalCap.name when available = true
```

Each capability is discoverable with its input and output types. The agent can reason about what it can do and what each operation requires.

## Automatic Capability Chaining

The agent automatically determines the sequence of capability invocations needed to satisfy the output obligation. The user provides the goal, not the plan:

```ft
ExecutionPlan = {
  steps: number >= 0,
  derived: boolean,
  manualSequencing: false
}
```

Given a task "Summarize this file" with capabilities for file reading and LLM invocation, the agent reads the file before invoking the LLM (because the LLM needs the file content as input). The chaining is derived from type compatibility between capability outputs and inputs.

## Ephemeral Lifecycle

Once the output obligation is met, the execution context is disposable:

```ft
OneShotLifecycle = {
  status: "created" | "executing" | "completed" | "failed",
  ephemeral: boolean,
  residualState: false
}
```

After result extraction, no references to the execution context remain active. No state persists across invocations. Each one-shot agent is independent and shares nothing with prior or future agents.

## Structured Failure

If the agent cannot satisfy the obligation, it reports a structured failure rather than producing a partial or empty result:

```ft
OneShotFailure = {
  reason: string,
  missingCapability: string,
  inputError: string
}
```

A task with insufficient capabilities produces a failure description identifying which capability was missing. Silent failure is worse than explicit failure because there is no retry loop.

## Concurrent Spawning

Multiple one-shot agents operate concurrently and independently:

```ft
ParallelExecution = {
  agentCount: number >= 0,
  isolated: boolean,
  sharedState: false
}
```

Two one-shot agents spawned simultaneously with different inputs produce correct, independent results. No shared mutable state between them.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Structured input with prompt and context | `OneShotInput` with typed fields |
| Output obligation declared before execution | `OneShotObligation.schema` inspectable |
| Capabilities discoverable with types | `LocalCap` with input/output types |
| Automatic capability sequencing | `ExecutionPlan.derived`, no manual sequencing |
| Ephemeral -- no residual state | `OneShotLifecycle.residualState = false` |
| Structured failure on missing capability | `OneShotFailure` with reason |
| Concurrent independent execution | `ParallelExecution.isolated` |
