# Local Root Loop Agent

A root loop agent is a persistent, long-lived process on the local machine. It survives across individual task completions, continuously monitors for unfulfilled obligations, and maintains state across tasks. It knows what it did before and uses that knowledge. This is the "always at their desk" agent -- it watches its obligation surface and works on the highest-priority item.

The tension is between persistence (maintaining context across tasks) and performance (accumulated state grows over time). History is the root loop's primary advantage over one-shot agents, but unbounded history fills the context window and degrades the LLM's ability to see recent relevant information.

## Agent Identity

The agent has a persistent identity and configuration readable by external processes:

```ft
RootLoopAgent = {
  agentId: string,
  model: string,
  role: string,
  status: "idle" | "working" | "paused"
}
```

```ft
rootAgent = RootLoopAgent
rootAgent << { agentId: "local-root", model: "opus", role: "developer" }
```

Identity persists for the agent's entire lifecycle. Other processes and users reference the agent by its ID.

## Obligation Monitoring

The agent continuously monitors for unfulfilled obligations and acts on them in priority order:

```ft
ObligationSurface = {
  pendingCount: number >= 0,
  highestPriority: number,
  nextAction: string
}
```

When a new obligation is added, the agent detects it and begins work without explicit triggering. This is the "loop" -- the agent drives its own execution based on what needs doing.

## Task Acceptance

New tasks are accepted while the agent is actively working on existing ones:

```ft
TaskQueue = {
  taskId: string,
  description: string,
  priority: number,
  status: "pending" | "active" | "completed"
}
```

A task submitted while the agent is processing another task appears in the obligation surface and is eventually addressed according to priority ordering.

## Full Local Capabilities

The agent has access to filesystem operations, shell execution, and LLM invocation:

```ft
cap RootLoopAgent.filesystem
cap RootLoopAgent.shell
cap RootLoopAgent.llm
```

"Root" implies full access to the local environment. Within a single task, the agent can read source files, execute shell commands, and invoke the LLM.

## Ordered History

The agent maintains an append-only history of actions across turns:

```ft
TurnHistory = {
  turnNumber: number >= 0,
  action: string,
  result: string,
  timestamp: number
}
```

After N turns, the agent's history contains records of all N turns. The LLM can reference prior turns when making decisions. History is never rewritten -- turns are append-only.

## Bounded Context

History growth is actively managed. Regardless of total history length, the active context window remains bounded:

```ft
ContextManagement = {
  maxContextSize: number >= 0,
  totalTurns: number >= 0,
  compactionStrategy: string,
  archiveAccessible: boolean
}
```

After 100+ turns, the agent still operates with bounded context size. Older turns are compressed or archived but remain retrievable if suddenly relevant.

## State Cascade

Each capability invocation updates the agent's state. Subsequent turns see the updated state:

```ft
StateCascade = {
  lastToolResult: string,
  visibleInNextTurn: boolean
}
```

A file read in turn N is visible to the agent in turn N+1. Tool call results automatically propagate to the agent's state.

## Child Task Spawning

The agent can fork child tasks for sub-work. Results flow back to the parent:

```ft
ChildTask = {
  parentAgent: string,
  taskId: string,
  status: "spawned" | "completed" | "failed",
  result: string
}
```

When a child completes, its result is incorporated into the parent agent's state. The parent's obligation is not satisfied until all child results are in.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Persistent across task completions | `RootLoopAgent.status` stays active |
| Inspectable identity and config | `rootAgent` with agentId, model, role |
| Priority-based obligation selection | `ObligationSurface.highestPriority` |
| Tasks accepted while working | `TaskQueue` with concurrent entries |
| Full local capabilities | `cap` declarations for filesystem, shell, llm |
| Ordered history across turns | `TurnHistory` with turn number and timestamp |
| Bounded context despite long history | `ContextManagement` with compaction |
| Tool results visible next turn | `StateCascade.visibleInNextTurn` |
| Child task results flow back | `ChildTask` with result propagation |
