# Context Feedback

The LLM feedback loop is the round-trip cycle where the system renders its current state as a prompt, the LLM interprets and responds, the response is parsed into structured statements that update the state, and the updated state is rendered again for the next turn. The state IS the memory -- there is no separate context or memory system.

The hard part is constraint enforcement. When the LLM produces output that violates a constraint (wrong type, out of range, missing required field), that violation must not be silently dropped. It becomes feedback for the next turn -- the LLM sees what it tried, why it failed, and what the system expected. This closes the loop: read, interpret, write, read, with errors surfacing as corrective context rather than silent failures.

## The Feedback Turn

A single turn of the feedback cycle captures everything that happened: the prompt sent, the LLM's response, the statements parsed from the response, and the results of applying those statements.

```ft
FeedbackTurn = {
  frame: number.integer >= 0,
  prompt: string,
  response: string,
  applied: ref(StatementResult),
  violations: ref(Violation),
  gapsBefore: number.integer >= 0,
  gapsAfter: number.integer >= 0
}
```

Each turn records the gap count before and after, making convergence visible. The gap count should decrease over turns. If it does not, the system is stuck.

## Statement Validation

Each parsed statement is validated against the process's type constraints before being applied. Rejected statements produce violations that feed back into the next prompt.

```ft
StatementResult = {
  path: string,
  value: string,
  status: "applied" | "rejected" | "suspended"
}

Violation = {
  path: string,
  expected: string,
  actual: string,
  message: string
}
```

A rejected statement becomes a Violation with the path, expected type, actual value, and a message. This violation is included in the next prompt so the LLM can self-correct.

## The Convergence Loop

The feedback cycle runs as a loop: render state as prompt, send to LLM, parse response into statements, validate and apply, check gaps, repeat. The loop terminates when all gaps are resolved or a budget limit is reached.

```ft
FeedbackLoop = {
  budget: number.integer >= 1,
  turns: ref(FeedbackTurn),
  status: "running" | "converged" | "exhausted",
  currentGaps: number.integer >= 0
}

FeedbackLoop << { status: "converged" when currentGaps = 0 }
FeedbackLoop << { status: "exhausted" when turns.length >= budget }
```

When `currentGaps` reaches zero, the status becomes "converged" and the loop terminates. When the turn count reaches the budget, the status becomes "exhausted" and remaining gaps are surfaced. Without a budget, a stuck loop runs forever.

## State as Memory

The process state is the sole memory. There is no separate context store. Each turn appends to the state, and each prompt reads the current projection. After five turns, all values from all turns are accessible through the state.

```ft
-- No separate memory or context system
-- State grows with each turn: turn N's values are visible at turn N+1
-- Long conversations may need compaction, but compaction operates on the state, not a separate store
```

## Suspended Statement Resumption

A statement may be suspended because its precondition is not yet met. When a later turn satisfies the precondition, the suspended statement resumes automatically.

```ft
StatementResult << { status: "applied" when precondition EXISTS }
```

A suspended statement waiting for a condition transitions to "applied" when that condition is met by a later statement. The system checks suspended statements after each turn's statements are applied.

## Tool Call Tracking

Tool calls in the LLM's response are recorded as individual operations with tracked status.

```ft
ToolCallRecord = {
  name: string,
  args: string,
  status: "pending" | "complete" | "failed",
  result?: string
}
```

Each tool call starts as "pending" and transitions to "complete" (with a result) or "failed" after execution. The next prompt includes the results.

```ft
cap FeedbackLoop.turns
cap FeedbackTurn.applied
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| State rendered as prompt | `FeedbackTurn.prompt` contains values, gaps, capabilities |
| LLM response parsed into statements | `FeedbackTurn.applied` holds parsed `StatementResult` entries |
| Constraint violations fed back | `Violation` records included in next turn's prompt |
| Valid statements update state | `StatementResult` with `status: "applied"` |
| Suspended statements resume | `status: "applied" when precondition EXISTS` |
| Tool calls tracked with status | `ToolCallRecord` with pending/complete/failed lifecycle |
| Convergence via gap count | `FeedbackLoop.status` driven by `currentGaps` and `budget` |
| State is sole memory | No separate memory store; state grows with each turn |
