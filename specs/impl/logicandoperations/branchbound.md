# Branch and Bound

Combinatorial optimization requires systematically exploring a tree of candidate solutions, pruning subtrees that provably cannot improve on the best-known answer. Traditional implementations use mutable shared state for the bound and a purpose-built solver loop. Here, the bound is a type constraint: each branch narrows the feasible region, and pruning is automatic invalidation when a branch's optimistic estimate cannot satisfy the global bound.

There is no solver. There is only constraint narrowing and conditional liveness.

## The Solution Space

A search node has a feasible range for each variable, a user-provided function that computes the optimistic bound from that range, and an indicator of whether the node has been solved (a concrete feasible value found):

```ft
SearchNode = {
  lowerBound: number,
  upperBound: number,
  optimisticEstimate: number,
  feasibleValue: number
}
```

The optimistic estimate is derived from the range. In a real instance it would be a relaxation (e.g., linear relaxation of an integer program). For the type model, it is a field that recomputes when the bounds narrow.

The feasible value is the result of evaluating the objective at a concrete point within the range. It remains a gap until the node is actually evaluated.

## The Global Bound

The global bound is the best feasible value found so far across the entire tree. All branches can read it. It tightens monotonically (for minimization, it can only decrease):

```ft
globalBound = {
  bestValue: number,
  bestNode: string
}
```

When a node finds a feasible solution better than the current bound, the bound narrows:

```ft
globalBound << { bestValue: 25, bestNode: "node-left-left" }
```

The bound is shared state. Every active branch reads it to determine whether to continue.

## Branching

Branching is forking a node and partitioning its range. Given a parent with X in [0, 100], we create two children:

```ft
leftChild = SearchNode
leftChild << { lowerBound: 0, upperBound: 50 }
```

```ft
rightChild = SearchNode
rightChild << { lowerBound: 50, upperBound: 100 }
```

Each child inherits the parent's constraint structure but with a narrower range. The children's feasible regions are disjoint and together cover the parent's region.

## Pruning via Bound

A branch is alive only while its optimistic estimate can improve on the global bound. For minimization, that means the estimate must be less than or equal to the best known value:

```ft
leftChild << { optimisticEstimate: 10 }
rightChild << { optimisticEstimate: 60 }
```

When the global bound tightens to 25, the right child (estimate 60) cannot improve on it. Pruning is expressed as a liveness condition: the node's task is conditioned on its estimate being competitive.

-- Pruning predicate (expressed in prose because temporal/comparison predicates on cross-references are not yet supported by the parser): A SearchNode is active only while its optimisticEstimate is less than or equal to globalBound.bestValue. When this condition breaks, the node and all its descendants are invalidated. The schema for feasibleValue remains, so an obligation surfaces showing the pruned region.

## Bound Update Cascade

When a feasible solution is found at a leaf node, the bound tightens and pruning cascades:

```ft
globalBound << { bestValue: 15, bestNode: "node-deep-leaf" }
```

After this narrow, every active branch re-evaluates its liveness condition against the new bound. Branches with optimistic estimates worse than 15 are pruned in a single cascade. No branch is visited individually -- the condition on each node references the shared bound, so tightening the bound is sufficient.

## Constraint Tightening and Derived Estimates

When a branch's range narrows further (sub-branching), its optimistic estimate recomputes automatically:

```ft
leftChild << { lowerBound: 3, upperBound: 6 }
```

-- Derived recomputation (prose): The optimisticEstimate field is derived from lowerBound and upperBound via the user-provided relaxation function. When either bound changes, the estimate is recomputed without an explicit recalculation step.

## Exploration Strategy

The exploration order (depth-first, breadth-first, best-first) is a scheduling policy, not a structural property. The same tree of SearchNode instances is explorable in any order. The constraint structure does not change:

```ft
policy exploration: { strategy: "depth-first" }
```

```ft
policy exploration: { strategy: "breadth-first" }
```

Both policies produce the same optimal solution. Depth-first typically prunes more aggressively (it finds feasible solutions sooner, tightening the bound earlier). But the structure of branches, bounds, and pruning conditions is identical.

## Capabilities

The two externally-provided operations: evaluating a node (computing a feasible value within its range) and branching (partitioning a node's range into children):

```ft
tool SearchNode.feasibleValue
tool SearchNode.lowerBound
tool SearchNode.upperBound
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Branch narrows feasible region (AC1) | `leftChild << { lowerBound: 0, upperBound: 50 }` is a strict subset of parent [0,100] |
| Global bound visible to all branches (AC2) | `globalBound << { bestValue: 25 }` is shared state, readable by every SearchNode |
| Branch pruned when estimate is inferior (AC3) | Liveness condition: node active only while optimisticEstimate <= globalBound.bestValue |
| Branch survives when estimate is competitive (AC4) | leftChild with estimate 10 survives bound of 25 |
| Partitioning creates disjoint children (AC5) | leftChild [0,50] and rightChild [50,100] cover parent without overlap |
| Bound update cascades pruning (AC6) | `globalBound << { bestValue: 15 }` invalidates all branches with estimates > 15 |
| Estimate recomputes on constraint tightening (AC7) | Derived field recomputes when lowerBound/upperBound narrow |
| Exploration order is policy, not structure (AC8) | `policy exploration` is swappable; same tree, same optimal solution |
