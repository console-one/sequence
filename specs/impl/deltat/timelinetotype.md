# Timeline To Type -- Probabilistic Type Branching Over Time

## Original Notes

How we may use some function mounted at some start start time, with a timeline to entail higher resolution information about the attributes of the _type_ describing its output or its output in general.

How we may end up meeting its type with higher fidelity non-concrete classifcations (thats okay and good)

[
  t = 1,
    /*
      Proposition1:
      c1:
        Pp1 = probability process#123456 ENDS AFTER REALTIME < 2090900
        type probmisses = dot([2090900 , REALTIME], process#123456/stack['.conjuctions'])
        type a = probmisses
        type b = 1 - a
        ANY from attach(...) - 60% [c1.a],
        User from getuser(...), 40% @tinfity [c1.b]
    */
  // so ni the future
  type value = any (from Proposition1)
  t = 2090900,
  type value = USER
]

---

When a capability is running and its output is not yet resolved, the output type is not a single thing -- it is a probability-weighted union. Branch A might be "Any" at 60% and branch B might be "User" at 40%. As time passes, the probabilities shift: the longer the capability runs, the more likely the structured result becomes. As evidence arrives (the response starts with a JSON object, or a field like "role" is detected), branches are eliminated entirely.

This is temporal type narrowing. The type starts broad and collapses over time and evidence until only one branch survives. Concreteness increases monotonically -- we only learn more, never less.

The two sources of narrowing are independent. Time shifts probabilities continuously (exponential decay on the "Any" branch, growth on the "User" branch). Evidence eliminates branches discretely (if the result has a "role" field, "Any" cannot be the answer). Both apply simultaneously, and their effects compose.

## The Probabilistic Type

A capability's pending output is a union with per-branch probability annotations. Each branch has a type, a probability, and a time function that governs how its probability evolves:

```ft
ProbBranch = {
  branchType: string,
  probability: number 0..1,
  alive: boolean
}
```

`probability` is a function of elapsed time, not a static number. `alive` indicates whether the branch has been eliminated by evidence. A dead branch has probability 0 and cannot return.

The full probabilistic type is the set of live branches:

```ft
ProbabilisticType = {
  branchCount: number.integer >= 1,
  concreteness: number 0..1,
  collapsed: boolean
}
```

`concreteness` is derived from the branch distribution: one branch at 100% means concreteness = 1.0. Many branches with spread probabilities means lower concreteness. `collapsed` is true when exactly one branch survives.

## Time-Based Probability Shift

At declaration time, each branch has an initial probability. As time passes, the probabilities shift according to declared time functions. The system does not pick these functions -- the capability author declares them as part of the type contract:

```ft
branchAny = ProbBranch
branchAny << { branchType = "any", probability = 0.6, alive = true }

branchUser = ProbBranch
branchUser << { branchType = "User", probability = 0.4, alive = true }
```

At t=0, Any is 60% and User is 40%. As time passes, the time function shifts these (e.g., Any decays exponentially while User grows). The probabilities always sum to 1.0 -- normalization is an invariant, not a manual step.

The time functions use the same interpolation function families from calculations.md: exponential decay, linear, Poisson CDF, etc. No new mechanism is needed.

## Evidence-Based Branch Elimination

When partial evidence arrives that is incompatible with a branch, that branch is eliminated. Elimination is permanent -- once dead, a branch cannot return:

```ft
-- Evidence: result has a "role" field. "Any" cannot guarantee this.
branchAny << { alive = false, probability = 0 }
branchUser << { probability = 1.0 }
```

After elimination, the surviving branches' probabilities are renormalized to sum to 1.0. If Any was at 30% and User at 70% when evidence arrives, User becomes 100%.

With three branches, elimination is sequential. Each elimination renormalizes the survivors. After two eliminations, one branch remains and the type collapses.

## Type Collapse

When exactly one branch survives, the probabilistic type collapses to that branch's type. The output is no longer a union -- it is a concrete (possibly incomplete) type:

```ft
ProbabilisticType << { collapsed = true when branchCount = 1 }
```

The collapsed type may still have unresolved fields (e.g., User with unknown id), but it is no longer probabilistic. The uncertainty about which type was removed; uncertainty about field values may remain.

## Querying the Current State

At any point, the full state of the probabilistic type is queryable: which branches are alive, their current probabilities, and what evidence would eliminate each:

```ft
queryState = (pt: ProbabilisticType) -> {
  liveBranches: number.integer >= 0,
  collapsed: boolean,
  concreteness: number 0..1
}

cap queryState
```

Each live branch reports its type, current probability, and the kind of evidence that would kill it (e.g., "if the result has a 'role' field, this branch dies"). This enables the agent to make informed scheduling decisions: "it's 95% likely to be a User, so start building the User display."

## Monotonic Concreteness

Concreteness never decreases. Time shifts probabilities toward certainty (one branch grows dominant). Evidence eliminates branches (fewer possibilities). Both increase concreteness. There is no mechanism for a branch to come back or for uncertainty to grow:

```ft
-- Concreteness at t2 is always >= concreteness at t1 for t2 > t1
-- This is a behavioral invariant, not expressible as a single ft assignment
```

This invariant is a property of the system, not a field. It holds because time functions are monotonic (designed to converge) and branch elimination is permanent (dead branches stay dead).

## What This Validates

| AC | Expressed by |
|----|-------------|
| Union type with probability-weighted branches | `ProbBranch` with `branchType` and `probability` |
| Probabilities shift with elapsed time | Time functions from calculations.md applied to branch probabilities |
| Probabilities always sum to 1.0 | Normalization invariant after every update |
| Evidence eliminates incompatible branches | `alive = false, probability = 0` on eliminated branch |
| Time-shift and evidence are independent | Both apply; effects compose without conflict |
| Monotonic concreteness | Time converges, elimination is permanent |
| Full state queryable at any point | `queryState` returns live branches, probabilities, concreteness |
| Type collapses when one branch remains | `collapsed = true when branchCount = 1` |
