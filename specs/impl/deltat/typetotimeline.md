# Type To Timeline -- Scheduler Resolution Depth for Time-Based Probability

## Original Notes

Here, I think a lot of the answers might be able to be inferred from the contents of the event economics folder, or at least comments that I made there. This is what principle process would we be using to determine how to update the probability of certain sub-branches at a particular type being different from the highest-level partition in terms of completion time or in terms of probability being concrete at a certain point in time, etc.?

If I have some assumption about some function that can either take in A or B, like it takes in an object of, I don't know, user type as its input, but I know that that function's duration is going to be super different if that user type is either an admin or a customer. At what point do we change the internal scheduler's resolution depth of the potential values of that user type to break it out into probabilities, if that is probably to either an A or B user type or an admin type, which would be determined based off of some other conjugate and then search, and then maybe use the search for that other conjugate during back inference to cut the branch path depending on whatever we find?

It sounds like a lot, but it's like what time-based type over time interpolation policy mount process do we obtain in order to optimally schedule without loading the system with so much unnecessary type information that it becomes incoherent? We might already be doing this by virtue of the algorithm; maybe not. Having that written out clearly in this file and the mathematics that's used to do it would be, I think, very useful.

---

The scheduler has a choice: treat an input as a single coarse type ("user"), or expand it into sub-types with separate time profiles ("admin: 5s, customer: 45s"). Expanding everything is exponentially expensive and makes the system incoherent. Not expanding hides order-of-magnitude scheduling differences. The system needs a principled trigger for when expansion is worth the cost.

The trigger is divergence. If a capability's time estimate varies significantly based on which sub-type an input turns out to be, that input is flagged as time-divergent. The scheduler expands only time-divergent inputs, keeping everything else compressed. After expansion, backward inference traces how to resolve the sub-type, and resolution collapses the expanded paths back to a single estimate.

This integrates with the compressed priority system: a time-divergent input gets elevated priority in the gap list because resolving it has outsized scheduling value.

## Time Profiles and Divergence

A capability can have multiple time profiles -- one per input sub-type. The divergence is the absolute difference between the fastest and slowest profiles:

```ft
TimeProfile = {
  subType: string,
  estimatedDuration: number >= 0,
  margin: number >= 0
}
```

The scheduler compares profiles to detect divergence:

```ft
DivergenceAnalysis = {
  input: string,
  fastEstimate: number >= 0,
  slowEstimate: number >= 0,
  divergence: number >= 0,
  significant: boolean
}
```

`divergence` is the difference between `slowEstimate` and `fastEstimate`. `significant` is true when `divergence` exceeds the configured threshold. Only significant divergences trigger sub-type expansion.

## The Significance Threshold

Expansion is gated by a threshold. If the time profiles differ by less than the threshold, the input stays compressed -- no sub-type probabilities are computed:

```ft
SchedulerConfig = {
  divergenceThreshold: number >= 0
}
```

An input whose sub-types produce estimates within 10% of each other (e.g., 10s vs 11s) is not expanded. An input whose sub-types produce estimates differing by 10x (e.g., 5s vs 45s) is expanded. The threshold is configurable and may be adaptive in future versions.

```ft
analysis = DivergenceAnalysis
analysis << { input = "user.role", fastEstimate = 5, slowEstimate = 45, divergence = 40 }
analysis << { significant = true when analysis.divergence >= 5 }
```

## Sub-Type Expansion

When an input is flagged as time-divergent, the scheduler expands it into probability-weighted sub-type paths. Each path has its own time estimate:

```ft
ExpandedPath = {
  subType: string,
  probability: number 0..1,
  timeEstimate: number >= 0,
  margin: number >= 0
}

adminPath = ExpandedPath
adminPath << { subType = "admin", probability = 0.3, timeEstimate = 5, margin = 1 }

customerPath = ExpandedPath
customerPath << { subType = "customer", probability = 0.7, timeEstimate = 45, margin = 10 }
```

This is demand-driven expansion. Only the flagged input gets sub-type breakdowns. All other inputs remain as single compressed scores. The system never pre-computes all sub-type probabilities for all inputs.

## Backward Inference for Resolution

Once an input is flagged, the scheduler uses backward inference to find how to resolve the sub-type. It traces backward through the type graph to find capabilities that produce the disambiguating information:

```ft
ResolutionPlan = {
  targetInput: string,
  resolvingCapability: string,
  estimatedResolutionCost: number >= 0
}

plan = ResolutionPlan
plan << { targetInput = "user.role", resolvingCapability = "lookupUser", estimatedResolutionCost = 2 }
```

The resolution plan is actionable: the agent can invoke `lookupUser` to resolve `user.role`, collapsing the divergent paths. The plan includes the estimated cost of resolution itself, enabling the scheduler to weigh "time to resolve" against "scheduling value of knowing."

## Branch Collapse After Resolution

When the sub-type is resolved, non-matching paths are eliminated. The scheduler collapses to a single time estimate:

```ft
-- After resolving user.role = "admin"
adminPath << { probability = 1.0 }
customerPath << { probability = 0, subType = "eliminated" }
```

The scheduler now shows a single estimate: 5s +/- 1s. The customer path is gone. The divergence is resolved. This is the same branch elimination mechanism from timelinetotype.md, applied to scheduling paths instead of output types.

## Priority Integration

Time-divergent inputs feed into the compressed priority system. An input with 40s of scheduling divergence gets higher priority than an input with 1s of divergence:

```ft
divergentPriority = {
  path: string,
  schedulingValue: number >= 0,
  priority: number 0..1
}

tool analysis.significant
tool plan.resolvingCapability
```

The scheduler presents divergent inputs as high-value resolution targets: "Resolving user.role would narrow the time estimate from 5-45s to either 5s or 45s."

## What This Validates

| AC | Expressed by |
|----|-------------|
| Detect time-divergent inputs | `DivergenceAnalysis` compares fast/slow estimates |
| Threshold gates expansion | `significant = true when divergence >= threshold` |
| Below-threshold inputs not expanded | No sub-type breakdown unless `significant` is true |
| Backward inference produces resolution plan | `ResolutionPlan` with `resolvingCapability` and cost |
| Resolution collapses to single estimate | Eliminated paths get probability 0; one path remains |
| Divergent paths shown before resolution | `ExpandedPath` entries with probabilities and estimates |
| Single estimate after resolution | One path at probability 1.0 with margin |
| Priority integration | `divergentPriority` feeds scheduling value into gap ordering |
| Demand-driven: only divergent inputs expanded | Non-divergent inputs have no sub-type breakdown |
