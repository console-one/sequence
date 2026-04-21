# Feedback

## Original Notes

Partial output is not failure -- it is progress. When a capability produces output that satisfies some properties of an obligation but not all, the system accepts what was provided, narrows the remaining obligation, reprioritizes the gaps, and selects the next capability to execute. This is the feedback loop: produce -> narrow -> reprioritize -> select -> produce again, until the obligation is fully closed or no further progress is possible.

The hard problem is efficiency. Each partial result changes the priority landscape -- resolving "sources" may unblock "content" which may unblock "summary." But recomputing all priorities from scratch on every partial result is prohibitive. Priority updates must propagate only through the affected parts of the conjunction graph (delta propagation), and concreteness must monotonically increase with each valid step.

## Problem Context

- **Actor(s)**: Capabilities (producing partial output), the system (accepting partial results, reprioritizing, selecting next capability), users/LLMs (receiving blocked-status reports and providing missing pieces).
- **Domain**: Incremental obligation fulfillment where multi-property obligations are satisfied step-by-step through a feedback loop of partial results, priority re-evaluation, and capability selection.
- **Core Tension**: Each partial result changes the priority landscape, but recomputing all priorities from scratch is prohibitive. Updates must propagate only through affected dependencies (delta propagation), and progress must be monotonic (partial results never reduce concreteness).

## Requirements

**R1**: When a capability produces output that satisfies some but not all properties of an obligation, the system SHALL accept the satisfied properties and narrow the remaining obligation to only the unsatisfied properties.
- *Rationale*: Partial output is progress, not failure; accepting it avoids re-doing already-completed work.
- *Verifiable by*: After a partial result satisfying 2 of 5 properties, the remaining obligation lists only the 3 unsatisfied properties.

**R2**: After accepting a partial result, the system SHALL report exactly which properties were accepted and which remain.
- *Rationale*: Transparency about partial progress enables informed decision-making by consumers and downstream processes.
- *Verifiable by*: The acceptance report lists specific accepted properties and specific remaining properties by name.

**R3**: The concreteness score SHALL monotonically increase (or remain unchanged) with each valid partial result; it SHALL NEVER decrease.
- *Rationale*: Each valid step adds information; progress must be irreversible to guarantee convergence.
- *Verifiable by*: The concreteness after step N+1 is >= concreteness after step N for every valid partial result.

**R4**: After accepting a partial result, priority updates SHALL propagate only through the affected portion of the dependency graph (delta propagation), not recompute all priorities globally.
- *Rationale*: Global recomputation is O(N) over all unsatisfied properties; delta propagation is O(K) over affected properties, making the loop viable at scale.
- *Verifiable by*: After resolving a property, only unsatisfied properties in the same dependency subgraph have their priorities updated; unrelated obligations retain their previous priorities.

**R5**: After priority updates, the system SHALL select the next capability to execute based on the highest-priority remaining unsatisfied property.
- *Rationale*: Capability selection must be driven by current priorities to make optimal use of available resources.
- *Verifiable by*: The selected capability corresponds to the highest-priority remaining unsatisfied property.

**R6**: Before executing a selected capability, the system SHALL determine what inputs it needs and whether those inputs are currently available.
- *Rationale*: Executing a capability without its required inputs wastes resources and produces no useful output.
- *Verifiable by*: The system reports which inputs are available and which are missing before execution.

**R7**: Missing inputs for a capability SHALL become sub-goals, resolved recursively through the same feedback loop.
- *Rationale*: Complex obligations often require multi-level resolution (to get summary, need content; to get content, need sources).
- *Verifiable by*: A missing input is added as a sub-goal and resolved before the parent capability executes.

**R8**: Recursive sub-goal resolution SHALL have a maximum depth limit; when the limit is reached, the unresolved sub-goal SHALL be surfaced to the user or LLM.
- *Rationale*: Deep chains delay visible progress and may not converge; a depth limit ensures termination.
- *Verifiable by*: A chain exceeding the depth limit stops recursion and surfaces the remaining sub-goal.

**R9**: The feedback loop SHALL terminate when either (a) all required properties are satisfied (full closure) or (b) no available capability can produce any remaining property (blockage).
- *Rationale*: The loop must guarantee termination; running indefinitely is not acceptable.
- *Verifiable by*: The loop ends with status "closed" (all satisfied) or "blocked" (no capability available for remaining properties).

**R10**: When the loop terminates due to blockage, the system SHALL report exactly which properties are unresolvable and why.
- *Rationale*: Users need to know what to provide manually or what new capabilities to install.
- *Verifiable by*: The blockage report lists each unresolvable property and the reason (no matching capability).

## Acceptance Criteria

**AC1** [R1, R2]: Given an obligation with 5 properties, when a capability satisfies 2, then the system accepts those 2, reports them as accepted, and narrows the obligation to the remaining 3.

**AC2** [R3]: Given an obligation with concreteness 0.4 after step N, when a valid partial result is accepted at step N+1, then concreteness is >= 0.4.

**AC3** [R4]: Given 100 total unsatisfied properties and a resolved property affecting a subgraph of 5, when priorities update, then only those 5 are re-evaluated; the other 95 retain their previous priorities.

**AC4** [R5, R6]: Given 3 remaining unsatisfied properties, when priorities are updated, then the system selects the capability for the highest-priority one and reports its input availability.

**AC5** [R7, R8]: Given a capability requiring input that itself requires another capability (chain depth 2), when both levels are resolvable, then the sub-goal is resolved first; when the chain exceeds the depth limit, the sub-goal is surfaced to the user.

**AC6** [R9, R10]: Given an obligation with remaining properties and no matching capability for any of them, when the loop evaluates, then it terminates with status "blocked" and reports which properties are unresolvable.

**AC7** [R9]: Given an obligation where all properties become satisfied through the loop, then the loop terminates with status "closed".

## Open Questions

- What is the appropriate default depth limit for recursive sub-goal resolution?
- When a redundant partial result (providing an already-satisfied property) is received, should it be silently ignored or acknowledged in the report?
