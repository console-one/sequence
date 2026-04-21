# Local Root Loop Agent

A root loop agent is a persistent, long-lived process on the local machine. It survives across individual task completions, continuously monitors for unfulfilled obligations, and maintains state across tasks. It knows what it did before and uses that knowledge. This is the "always at their desk" agent -- it watches its obligation surface and works on the highest-priority item.

The tension is between persistence (maintaining context across tasks) and performance (accumulated state grows over time). History is the root loop's primary advantage over one-shot agents, but unbounded history fills the context window and degrades the LLM's ability to see recent relevant information.

---

## Problem Context

- **Actor(s)**: The root loop agent itself, users who submit tasks and inspect state, and child processes the agent may spawn.
- **Domain**: Persistent local task execution where a long-lived agent continuously monitors for work, executes tasks using full local capabilities, and accumulates useful history across tasks.
- **Core Tension**: History is the agent's primary advantage over one-shot agents, but unbounded history degrades LLM performance. The agent must balance retaining useful context with keeping its active working set bounded. Additionally, new tasks arrive while existing ones are in progress, requiring priority-based scheduling.

## Requirements

**R1**: The agent SHALL have a persistent identity (ID, model, role) that survives across individual task completions and is readable by external processes.
- *Rationale*: Other processes and users reference the agent by ID for task submission and status queries. Identity must outlive any single task.
- *Verifiable by*: After completing a task, the agent's identity is unchanged and queryable by an external process.

**R2**: The agent SHALL continuously monitor for unfulfilled tasks and begin work on the highest-priority item without requiring explicit triggering.
- *Rationale*: The "loop" means the agent drives its own execution. If it requires a manual kick for each task, it is just a one-shot agent with extra steps.
- *Verifiable by*: A new task is added. Without any explicit trigger, the agent detects it and begins work.

**R3**: The agent SHALL accept new tasks while actively working on existing ones, scheduling them by priority.
- *Rationale*: A long-lived agent that blocks on one task at a time wastes its persistence advantage. Task queuing with priority ordering enables responsiveness to urgent work.
- *Verifiable by*: A task is submitted while the agent is processing another. The new task appears in the queue and is eventually addressed according to its priority.

**R4**: The agent SHALL have access to full local capabilities: filesystem operations, shell execution, and LLM invocation.
- *Rationale*: "Root" implies full access to the local environment. The agent must be able to read files, run commands, and invoke the LLM within a single task.
- *Verifiable by*: Within a single task, the agent reads a source file, executes a shell command, and invokes the LLM.

**R5**: The agent SHALL maintain an append-only, ordered history of actions across all turns.
- *Rationale*: History enables the agent to reference prior work when making decisions. Append-only ensures auditability -- turns are never rewritten.
- *Verifiable by*: After N turns, the history contains records of all N turns in chronological order, and no prior turn has been modified.

**R6**: Regardless of total history length, the agent's active context window SHALL remain bounded.
- *Rationale*: Unbounded context degrades LLM performance. Older turns must be compressed or archived while remaining retrievable if needed.
- *Verifiable by*: After 100+ turns, the active context size remains below a configured maximum. Archived turns are retrievable on demand.

**R7**: The result of each capability invocation SHALL be visible to the agent in subsequent turns.
- *Rationale*: Tool results must propagate into the agent's state so that later decisions can be informed by earlier actions.
- *Verifiable by*: A file read in turn N is referenced by the agent in turn N+1.

**R8**: The agent SHALL be able to spawn child tasks for sub-work, with results flowing back to the parent.
- *Rationale*: Complex tasks often decompose into sub-tasks. The parent's task is not complete until all child results are incorporated.
- *Verifiable by*: The agent spawns a child task. When the child completes, its result is incorporated into the parent agent's state. The parent's task is not marked complete until all child results are in.

## Acceptance Criteria

**AC1** [R1]: Given a running root loop agent, when an external process queries its identity, then the agent ID, model, and role are returned.

**AC2** [R1]: Given an agent that has completed a task, when a new task is submitted, then the agent's identity (ID, model, role) is unchanged from before the first task.

**AC3** [R2]: Given an idle agent, when a new task is added, then the agent detects and begins work on it without manual triggering.

**AC4** [R3]: Given an agent actively processing a task, when a higher-priority task is submitted, then the new task appears in the queue and is addressed according to priority.

**AC5** [R4]: Given a task requiring file reading, shell execution, and LLM invocation, when the agent processes the task, then all three capability types are successfully used.

**AC6** [R5]: Given an agent with 50 completed turns, when the history is queried, then all 50 turns are returned in chronological order with no modifications.

**AC7** [R6]: Given an agent with 100+ completed turns, when the context is measured, then it remains below the configured maximum size. When an archived turn is requested, it is retrievable.

**AC8** [R7]: Given a file read in turn N, when the agent processes turn N+1, then the file contents from turn N are available in the agent's context.

**AC9** [R8]: Given a task that spawns two child tasks, when both children complete, then their results are incorporated into the parent agent's state and the parent task can proceed to completion.

## FT System Demands

- The kernel must support representing a continuously running process that monitors for new work and self-schedules.
- The type system must support priority ordering across a dynamic set of pending tasks.
- Context management (compaction, archival, retrieval) must be expressible as a policy, not hardcoded behavior.

## Open Questions

- What is the compaction strategy for older turns (summarization, importance-based pruning, time-decay)?
- Should the agent pause its current task when a significantly higher-priority task arrives, or always complete the current task first?
- What are the resource limits for child task spawning (max depth, max concurrent children)?
