# Semantic Kernel

## Original Notes

Here I'm saying that the semantic kernel here is just going to be what happens if we hoist the entire frame of an organization's process at a single point in time. Instead of giving that to our scheduler with backward inference, we are just going to give it to an LLM to pick the next task or write code to fill in the gaps. That code would just be the merge request for the next state. If that doesn't work, then it's okay; the gaps will change, and we'll just keep sending it to the LLM forever, or until we literally can't call that LLM anymore.

The point I'm trying to make is that I think it's just important that we have an example of this. We show how the system coheres to being able to have a semantic kernel or a knowledge graph network to run your scheduling, and they're both really actually the same thing. The only question is: do you use preference-based greedy optimization or something to fill in your gaps and make the sole determination about what other calls you're going to be making to yourself internally? If you continue to have gaps after that, do you just throw an exception to the user or an administrator, or do you capture that exception by an Alalam and tell it to try to figure things out? You then just give it the full state of the kernel relevant to putting its attention relevant to where that exception occurred.

---

## Problem Context

- **Actor(s)**: An LLM acting as a scheduler, an algorithmic scheduler, human operators for escalation, and the tasks/processes being scheduled.
- **Domain**: Task scheduling and gap resolution in an organizational process, where the system's current state (tasks, their statuses, unresolved items) is rendered and given to an interpreter to decide what to do next.
- **Core Tension**: LLM-based and algorithmic schedulers should be interchangeable over the same data. The resolution loop must converge (close unresolved items) or escalate when stuck -- it must never silently fail or run forever.

## Requirements

**R1**: The complete process state (tasks, statuses, unresolved items) SHALL be renderable as a prompt that an LLM can interpret and act on.
- *Rationale*: The LLM needs the full picture to make scheduling decisions; the state is the prompt.
- *Verifiable by*: A rendered prompt contains all task names, statuses, and unresolved item details.

**R2**: An LLM interpreter and an algorithmic interpreter SHALL operate on the same state structure and produce updates in the same format.
- *Rationale*: Interchangeability means the data model has no interpreter-specific fields; swapping interpreters is a configuration change.
- *Verifiable by*: Switching the interpreter from "llm" to "algorithm" requires no changes to the state schema or update format.

**R3**: Each resolution turn SHALL record the prompt, response, applied updates, validation violations, and remaining unresolved items.
- *Rationale*: Per-turn audit trails enable debugging and convergence analysis.
- *Verifiable by*: After each turn, the turn record contains all five components.

**R4**: Invalid updates (type violations, constraint violations) SHALL produce violation records that feed back into the next turn's prompt.
- *Rationale*: Self-correction requires the interpreter to see what it tried and why it failed.
- *Verifiable by*: A violation from turn N appears in the prompt for turn N+1.

**R5**: The resolution loop SHALL terminate when all unresolved items are resolved (convergence) or when a turn budget is exhausted.
- *Rationale*: Without termination conditions, a stuck loop runs forever.
- *Verifiable by*: The loop status becomes "converged" when unresolved count reaches zero, or "exhausted" when turns reach budget.

**R6**: When an unresolved item persists after N turns, the system SHALL escalate by narrowing the rendered state to the scope of the unresolved item and handing it to a different interpreter.
- *Rationale*: Escalation narrows attention to the problem site and brings in a more capable or specialized resolver.
- *Verifiable by*: After N failed turns on an unresolved item, the system produces a focused prompt scoped to that item's subtree and routes it to a different interpreter.

**R7**: The escalation interpreter SHALL receive a focused prompt scoped to the unresolved item's subtree, not the entire organizational state.
- *Rationale*: Focus improves the escalation interpreter's chance of resolving the item by reducing noise.
- *Verifiable by*: The escalation prompt contains only state relevant to the unresolved item, not unrelated tasks.

**R8**: Tasks SHALL have a status lifecycle: "blocked" when dependencies are unresolved, "ready" when all dependencies are met, "complete" when output is provided.
- *Rationale*: Status tracking enables the interpreter to prioritize work and makes dependencies visible.
- *Verifiable by*: A task with an unresolved dependency has status "blocked"; resolving the dependency transitions it to "ready"; providing output transitions it to "complete".

## Acceptance Criteria

**AC1** [R1]: Given a process with 3 tasks (1 blocked, 1 ready, 1 complete) and 2 unresolved items, when the state is rendered, then the prompt contains all task names/statuses and both unresolved items.

**AC2** [R2]: Given the same state, when interpreted by an LLM and then by an algorithm, then both produce updates in the same format targeting the same state paths.

**AC3** [R3, R4]: Given an interpreter that produces one valid and one invalid update in turn 1, when turn 1 completes, then the turn record includes both the applied update and the violation; the violation appears in the prompt for turn 2.

**AC4** [R5]: Given a budget of 5 turns, when unresolved items reach zero at turn 3, then the loop terminates with status "converged"; when unresolved items remain at turn 5, then the loop terminates with status "exhausted".

**AC5** [R6, R7]: Given an unresolved item that persists for N turns, when escalation triggers, then the escalation prompt is scoped to that item's subtree and routed to a different interpreter (e.g., larger LLM, human, specialist).

**AC6** [R8]: Given a task that depends on another task's output, when the dependency is unresolved, then status is "blocked"; when the dependency is filled, then status transitions to "ready"; when the task's own output is provided, then status transitions to "complete".

## Open Questions

- What value of N triggers escalation? Is it configurable per-process or global?
- When escalation routes to a human, what is the interface? A notification? A focused UI view?
- Should the system support multiple escalation tiers (LLM -> larger LLM -> human)?
