# Remote Root One-Shot Agent

A remote root one-shot agent is a short-lived agent spawned on server infrastructure to handle exactly one task, then archive and terminate. This is the serverless/Lambda-backed pattern for parallelizable work. The orchestrator may spawn hundreds concurrently, so each must be isolated, resource-efficient, and reliably report results back.

The tension: the agent must be self-contained enough to execute a complete multi-step task (deploy, then health-check, then report), yet ephemeral enough to be spawned and discarded cheaply. It plans its own execution autonomously -- the orchestrator dispatches, it does not micromanage.

## Task Identity and Input

Each agent is spawned with a unique task identifier linking it to the originating request, along with its full input and capability set:

```ft
RemoteOneShot = {
  taskId: string,
  input: string,
  capabilities: string,
  spawnedAt: number,
  timeout: number
}
```

The agent's entire context is determined at spawn. It does not discover capabilities or receive additional input after creation.

## Single Output Obligation

The agent has exactly one output obligation -- a structured result that defines completion:

```ft
OneShotObligation = {
  taskId: string,
  schema: string,
  fulfilled: boolean,
  result: string
}
```

```ft
OneShotObligation << { fulfilled: false }
-- agent spawned, obligation unfulfilled
```

Producing a result that conforms to the schema marks the task as complete. The agent is done when the obligation is met.

## Automatic Execution Planning

The agent determines the sequence of capability invocations needed to satisfy the obligation, detecting data dependencies between outputs and inputs:

```ft
ExecutionStep = {
  stepNumber: number >= 0,
  capability: string,
  dependsOn: string,
  status: "pending" | "completed" | "failed"
}
```

Given capabilities "deploy" (produces url, status) and "healthcheck" (requires url, produces healthy), the agent invokes deploy first, then healthcheck with the URL from deploy. The sequencing is automatic -- data dependencies are detected from type compatibility.

## Result Reporting

Upon completing the obligation, the agent reports the result back to the orchestrator. The result is correlated by task ID:

```ft
ResultReport = {
  taskId: string,
  result: string,
  reportedAt: number,
  status: "success" | "failure" | "timeout"
}
```

```ft
tool RemoteOneShot.report
```

The orchestrator receives the result correlated to the original task. After reporting, the agent becomes eligible for cleanup.

## Structured Failure

If the agent cannot satisfy its obligation, it reports a structured failure rather than silently terminating:

```ft
FailureReport = {
  taskId: string,
  reason: string,
  failedStep: string,
  reportedAt: number
}
```

When a capability fails, the orchestrator receives a failure report with the reason, not silence. A silently dead agent is an invisible failure.

## Concurrent Isolation

Many one-shot agents operate simultaneously in complete isolation:

```ft
IsolationGuarantee = {
  sharedState: false,
  independent: boolean,
  maxConcurrency: number >= 0
}
```

10 agents spawned simultaneously with different tasks all complete independently. One agent's failure does not affect others.

## Resource Boundaries

Each agent operates within defined constraints established at spawn time:

```ft
ResourceBounds = {
  timeout: number,
  capabilityScope: string,
  enforced: boolean
}
```

An agent that exceeds its timeout is terminated and reports a failure. The orchestrator constrains each agent's execution scope.

## Execution Archival

Completed agents have their execution record archived before disposal:

```ft
ExecutionRecord = {
  taskId: string,
  input: string,
  steps: string,
  result: string,
  timestamps: string,
  archived: boolean
}
```

After disposal, the full execution history is retrievable from the archive by task ID. Even ephemeral agents produce auditable work.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Spawned with task ID and input | `RemoteOneShot` with taskId, input, capabilities |
| Single output obligation | `OneShotObligation` with schema |
| Automatic dependency sequencing | `ExecutionStep.dependsOn` chains capabilities |
| Result correlated to task ID | `ResultReport.taskId` matches orchestrator |
| Structured failure reporting | `FailureReport` with reason and failed step |
| Concurrent isolated execution | `IsolationGuarantee.sharedState = false` |
| Timeout enforcement | `ResourceBounds.timeout` with forced termination |
| Execution archived after disposal | `ExecutionRecord.archived` |
