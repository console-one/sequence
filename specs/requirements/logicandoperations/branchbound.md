# Branch and Bound

## Problem Context

- **Actor(s)**: An optimization engine (or user) exploring a combinatorial search space, and an evaluator that computes feasibility and bounds at individual nodes.
- **Domain**: Combinatorial optimization -- finding the best solution from a large discrete space by systematically exploring and pruning a tree of candidates.
- **Core Tension**: The search space is exponential. Exhaustive exploration is infeasible. The system must prune provably suboptimal subtrees as early as possible, using a globally shared bound that tightens as better solutions are discovered. The bound, the pruning, and the branching must interact correctly to guarantee optimality.

## Requirements

**R1**: The system SHALL represent each search node with a feasible range, an optimistic estimate (relaxation bound), and a slot for a concrete feasible solution.
- *Rationale*: These are the minimal components needed for branch-and-bound: the range defines the subproblem, the estimate enables pruning, and the feasible solution contributes to bound tightening.
- *Verifiable by*: A search node can be created with bounds, has a derived optimistic estimate, and accepts a feasible solution when evaluated.

**R2**: The system SHALL maintain a global bound representing the best feasible solution found so far, visible to all active branches.
- *Rationale*: The global bound is what makes pruning possible. Every branch compares its estimate against this shared value.
- *Verifiable by*: After a feasible solution is found at any node, the global bound reflects that value, and all other nodes can read it.

**R3**: The global bound SHALL tighten monotonically -- for minimization, it SHALL only decrease; for maximization, it SHALL only increase.
- *Rationale*: A bound that loosens would invalidate prior pruning decisions.
- *Verifiable by*: Attempting to update the bound with a worse value has no effect.

**R4**: A branch SHALL be pruned (invalidated) when its optimistic estimate cannot improve on the current global bound.
- *Rationale*: This is the core efficiency mechanism. Pruned branches are provably suboptimal.
- *Verifiable by*: A node with estimate 60 is pruned when the global bound is 25 (minimization). A node with estimate 10 survives.

**R5**: Pruning SHALL cascade -- when the global bound tightens, all branches with inferior estimates SHALL be pruned in a single pass, not visited individually.
- *Rationale*: Cascading avoids the cost of individually checking each branch. Tightening the bound is sufficient.
- *Verifiable by*: Updating the global bound from 25 to 15 prunes all branches with estimates > 15 without iterating over them explicitly.

**R6**: Branching SHALL partition a parent node's range into disjoint children that together cover the parent's entire range.
- *Rationale*: Disjoint coverage guarantees completeness (no solution is missed) and avoids double-counting.
- *Verifiable by*: A parent with range [0, 100] branched into [0, 50] and [50, 100] covers the full range with no overlap.

**R7**: When a branch's range is narrowed (via sub-branching), the optimistic estimate SHALL recompute automatically.
- *Rationale*: A tighter range typically yields a tighter estimate. Stale estimates lead to missed pruning opportunities.
- *Verifiable by*: After narrowing a node's range, its estimate reflects the new range without an explicit recalculation call.

**R8**: The exploration order (depth-first, breadth-first, best-first) SHALL be a configurable policy, independent of the constraint structure.
- *Rationale*: Different exploration strategies have different tradeoffs (depth-first finds bounds quickly, best-first explores promising areas first) but all produce the same optimal solution.
- *Verifiable by*: Switching between exploration policies produces the same optimal solution, though the number of nodes explored may differ.

**R9**: When a branch is pruned, its structural definition (what the subproblem was) SHALL remain available for inspection, even though its values are invalidated.
- *Rationale*: Auditability requires knowing which subproblems were explored and pruned, not just the surviving solution.
- *Verifiable by*: After pruning, the node's range and estimate are still inspectable even though it has no active values.

## Acceptance Criteria

**AC1** [R1]: Given a new search node with range [0, 100], when its optimistic estimate is computed, then the estimate reflects the relaxation of that range.

**AC2** [R2]: Given two active branches, when a feasible solution of value 25 is found at one branch, then the other branch can read the global bound as 25.

**AC3** [R3]: Given a global bound of 25 (minimization), when an attempt is made to update it to 30, then the bound remains 25.

**AC4** [R4]: Given a global bound of 25, when a branch has an optimistic estimate of 60, then that branch is pruned. When a branch has an estimate of 10, then it survives.

**AC5** [R5]: Given 10 active branches with various estimates, when the global bound tightens from 50 to 15, then all branches with estimates > 15 are pruned without individual per-branch checks.

**AC6** [R6]: Given a parent node with range [0, 100], when branched, then the children's ranges are disjoint and their union equals [0, 100].

**AC7** [R7]: Given a node with range [0, 100] and a corresponding estimate, when the range narrows to [3, 6], then the estimate updates to reflect the narrower range.

**AC8** [R8]: Given the same search tree, when solved with depth-first and then best-first exploration, then both produce the same optimal solution.

**AC9** [R9]: Given a pruned branch, when inspected, then its original range and estimate are available.

## Open Questions

- Should the system support restarts (re-activating a pruned branch if the bound loosens due to constraint changes)? Current assumption is no -- monotonic bounds mean pruning is permanent.
- How should the user-provided relaxation function be registered? It is an external capability that the system calls when computing estimates.
