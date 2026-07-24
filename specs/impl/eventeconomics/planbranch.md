# Plan Branching

## Original Notes

Planned branch is like we're running a plan or we're doing some sort of confidence conjugation mapping to build out the central plan for tasks or how we're going to meet tasks in the future. If we want to basically start to assume that our sort of median expectations are wrong, we can create a p1 plan, which is derivative from the p0 plan but branches out on this conjugate at this point in time with a different assumption. We then use that kind of logic to explore, I guess, different catastrophe scenarios in the belief space. I feel like that's sort of how most optimizers work, but I don't know if I'm necessarily modeling it correctly. I just thought it was worth adding here.

Scenario analysis: forking a base plan at specific assumption points to explore alternative futures and comparing their outcomes. A branch is a copy-then-modify operation -- it inherits the base plan's entire state, then diverges by substituting one or more assumptions. Derived values recompute independently within each branch.

The purpose of branching is comparison. The user needs to see exactly where branches differ (the divergence points) and what downstream effects those differences cause. Branches are independent enough to diverge meaningfully but related enough to enable structured comparison.

## The Base Plan

A plan has named paths with values and derived computations. This is the reference state that branches diverge from:

```ft
Plan = {
  name: string,
  revenue: ref(QuarterlyForecast),
  costs: ref(CostStructure),
  profit: number
}

QuarterlyForecast = {
  q1: number,
  q2: number
}

CostStructure = {
  fixed: number
}

p0 = Plan
p0 << { name: "base" }

p0.revenue = QuarterlyForecast
p0.revenue << { q1: 100000, q2: 110000 }

p0.costs = CostStructure
p0.costs << { fixed: 80000 }
```

Profit is derived: profit = revenue.q2 - costs.fixed. In the base plan, profit = 110000 - 80000 = 30000. The derivation is a behavioral predicate. The ft block establishes the structure and values; the computation cascades automatically through refs.

## Branch Creation

A branch starts from the base plan's current state and substitutes specific assumptions. The branch is independent -- changes to it do not affect the base:

```ft
-- Pessimistic branch: revenue drops 30%
p1 = Plan
p1 << { name: "pessimistic" }

p1.revenue = QuarterlyForecast
p1.revenue << { q1: 100000, q2: 77000 }

p1.costs = CostStructure
p1.costs << { fixed: 80000 }

-- Optimistic branch: revenue grows 20%
p2 = Plan
p2 << { name: "optimistic" }

p2.revenue = QuarterlyForecast
p2.revenue << { q1: 100000, q2: 132000 }

p2.costs = CostStructure
p2.costs << { fixed: 80000 }
```

Each branch is a full Plan instance. p1 has revenue.q2 = 77000, so p1.profit derives to -3000. p2 has revenue.q2 = 132000, so p2.profit derives to 52000. p0.profit remains 30000. The branch creation is a fork: the base state is copied, then specific paths are narrowed with different values.

## Divergence Records

Each branch explicitly records where it diverges from the base. The divergence record tracks which paths were changed and what the base values were:

```ft
Divergence = {
  path: string,
  baseValue: number,
  branchValue: number
}

p1.divergence = Divergence
p1.divergence << { path: "revenue.q2", baseValue: 110000, branchValue: 77000 }

p2.divergence = Divergence
p2.divergence << { path: "revenue.q2", baseValue: 110000, branchValue: 132000 }
```

The divergence record makes it traceable -- "p1 assumes revenue drops 30% in Q2" is visible as structured data, not buried in the numbers. Multiple divergence points can be recorded if a branch changes several assumptions.

## Cross-Branch Comparison

Comparing branches shows divergence points and their downstream effects:

```ft
BranchComparison = {
  branches: ref(Plan),
  divergences: ref(Divergence)
}

comparison = BranchComparison
comparison << { branches: ref(p0) }
```

The comparison identifies all paths where branch values differ and traces the effect chain from divergence point to final outcomes. For p0/p1/p2, it shows: revenue.q2 diverges (110k / 77k / 132k), and downstream profit diverges (30k / -3k / 52k). The comparison is a derived view -- it references the branches and computes the diffs.

## Catastrophe Detection

Branches where obligations cannot be met (costs exceed revenue, capacity below demand) surface as new gaps:

```ft
-- p1 has negative profit: costs exceed revenue
-- This surfaces as a gap that p0 does not have
p1 << { profit: ref(p1.revenue) }
```

When p1.profit derives to -3000, the system detects that a financial obligation is unmet. This surfaces as a gap with high priority in p1's gap list but does not appear in p0's gap list. The detection is automatic -- negative profit or unmet constraints produce gaps through the normal concreteness machinery, not through special-case checking.

## Branch Independence

Modifying one branch never affects another. Each branch maintains its own state and its own derived values:

```ft
-- Change costs in p1
p1.costs << { fixed: 90000 }

-- p1.profit re-derives to -13000
-- p0.profit remains 30000
-- p2.profit remains 52000
```

Independence is structural: each branch is a separate Plan instance with its own refs. There is no shared mutable state between branches. The base plan is never modified by branch operations.

## Capabilities

Branch creation and assumption substitution are user actions:

```ft
tool Plan.name
tool Plan.revenue
tool Plan.costs
tool Divergence.path
tool Divergence.branchValue
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Branch inherits base state with changed assumption | p1 has all p0 values except revenue.q2 = 77000 |
| Derived values recompute independently per branch | p0.profit = 30000, p1.profit = -3000, p2.profit = 52000 |
| Comparison identifies divergence points | `Divergence << { path: "revenue.q2", baseValue: 110000, branchValue: 77000 }` |
| Divergence traceable to specific path and values | Divergence record stores path, baseValue, branchValue |
| Catastrophe scenarios surface as new gaps | p1 negative profit creates gap not present in p0 |
| Multiple branches coexist without interference | Changing p1.costs does not affect p0 or p2 |
