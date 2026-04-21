# Context Feedback

The LLM feedback loop is the round-trip cycle where the system renders its current state as a prompt, the LLM interprets and responds, the response is parsed into structured statements that update the state, and the updated state is rendered again for the next turn. The state IS the memory -- there is no separate context or memory system.

The hard part is constraint enforcement. When the LLM produces output that violates a constraint (wrong type, out of range, missing required field), that violation must not be silently dropped. It becomes feedback for the next turn -- the LLM sees what it tried, why it failed, and what the system expected. This closes the loop: read, interpret, write, read, with errors surfacing as corrective context rather than silent failures.

## Problem Context

- **Actor(s)**: The LLM (interpreting state and producing responses), the system (rendering state, parsing responses, enforcing constraints), and optionally the user (viewing convergence progress).
- **Domain**: Iterative state resolution via LLM-in-the-loop, where each turn attempts to close unresolved items through structured output.
- **Core Tension**: The LLM will produce constraint violations. Those violations must feed back into the next prompt as corrective context, not be silently dropped. The loop must converge (close unresolved items) or terminate on budget exhaustion -- it must never run forever.

## Requirements

**R1**: Each feedback turn SHALL record the prompt sent, the LLM's response, the statements parsed from the response, and the validation results of applying those statements.
- *Rationale*: Full turn records enable debugging, auditing, and convergence analysis.
- *Verifiable by*: After a turn completes, the turn record contains all four components.

**R2**: Each parsed statement SHALL be validated against the process's type constraints before being applied to state.
- *Rationale*: Unvalidated writes could corrupt state or violate invariants.
- *Verifiable by*: A statement with a value that violates a declared type constraint is rejected, not applied.

**R3**: Rejected statements SHALL produce violation records containing the path, expected type, actual value, and a human-readable message. These violations SHALL be included in the next turn's prompt.
- *Rationale*: Feeding violations back as corrective context enables the LLM to self-correct.
- *Verifiable by*: A violation from turn N appears in the prompt for turn N+1.

**R4**: The system SHALL track unresolved item counts before and after each turn, making convergence (or lack thereof) visible.
- *Rationale*: If the unresolved count is not decreasing, the system is stuck and needs escalation or termination.
- *Verifiable by*: Each turn record includes unresolved counts before and after; the delta is computable.

**R5**: The feedback loop SHALL terminate when all unresolved items are resolved (convergence) or when a turn budget is exhausted.
- *Rationale*: Without a termination condition, a stuck loop runs forever.
- *Verifiable by*: The loop stops when unresolved count reaches zero (status: converged) or turn count reaches budget (status: exhausted).

**R6**: Process state SHALL be the sole memory for the feedback loop -- there SHALL NOT be a separate context or memory store.
- *Rationale*: A single source of truth eliminates synchronization bugs between state and a shadow memory system.
- *Verifiable by*: All values from all previous turns are accessible through state; no external memory store is consulted.

**R7**: Statements that are suspended (precondition not yet met) SHALL automatically resume when a later turn satisfies the precondition.
- *Rationale*: Suspended statements should not require manual retry; they resolve as dependencies are met.
- *Verifiable by*: A statement suspended in turn N is automatically applied after turn M (M > N) satisfies its precondition.

**R8**: Tool calls in the LLM's response SHALL be recorded with tracked status (pending, complete, failed) and their results SHALL be included in the next turn's prompt.
- *Rationale*: Tool call results are part of the feedback loop; the LLM needs to see outcomes to make informed decisions.
- *Verifiable by*: A tool call result from turn N appears in the prompt for turn N+1.

## Acceptance Criteria

**AC1** [R1]: Given a completed turn, when the turn record is inspected, then it contains the prompt, response, parsed statements, and validation results.

**AC2** [R2, R3]: Given a statement that violates a type constraint, when the statement is validated, then it is rejected with a violation record; the violation appears in the next turn's prompt.

**AC3** [R4]: Given turns 1 through 5, when each turn record is inspected, then unresolved counts before and after are present and the convergence trend is visible.

**AC4** [R5]: Given a budget of 10 turns, when unresolved items reach zero at turn 7, then the loop terminates with status "converged"; when unresolved items remain at turn 10, then the loop terminates with status "exhausted".

**AC5** [R6]: Given 5 completed turns, when querying state, then all values from all 5 turns are accessible through state alone -- no separate memory store is used.

**AC6** [R7]: Given a statement suspended at turn 2 because a precondition is unmet, when turn 4 satisfies that precondition, then the statement is automatically applied.

**AC7** [R8]: Given a tool call that completes in turn 3, when the prompt for turn 4 is rendered, then the tool call's result is included.

## Open Questions

- What is the default turn budget? Should it be configurable per-process?
- When the loop exhausts its budget, should remaining unresolved items be escalated automatically or surfaced to the user for manual resolution?
