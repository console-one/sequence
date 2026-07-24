# Simulations

## Original Notes

We can use simulated inputs over the like fuzzing, I guess, and if we can obtain certain sufficiently quality fuzz criteria, else we can just go over historical logs. The one thing I would say is that I think that discrete event simulation here, at least for the times that things happen and the certain conjugate, like external values that are at the higher or lower ends of probability bands for being true, would be something that is probably very useful in building out alternative branches for the belief framework that can help us figure out what the optimal policy is for action under given different risk scenarios of being wrong.

Not even sure if this would be useful within the kernel itself, but discrete event simulation is incredibly useful for scheduling and building operation simulation models. Even if this was not being implemented here as a use for the kernel, it certainly would be a useful tool entailed by our model to expose on the Excel-like functions that we enable for our customers to build out interpolation models, which are used for scheduling and preference policy determination and simulations. A hundred percent would be used in that, or simulations of, like, what if I forget two, or that this particular processor dies during this particular future world line, or what if I don't have two people working next week? What's the impact? What is the next best plan going to look like? I think a lot of those actually would probably be adopted by the user, especially for operations users, where we might have this whole system and all of its projections ostensibly probably running the business. I think being able to show, like, what if I had a mechanical failure next week and that system is down, we can use this to show very explosive scenarios. I think we do have the simulation model, and what I would like you to do is write out how we would be able to encode it?

Discrete event simulation and Monte Carlo analysis: replaying a base plan or history with injected modifications to explore alternative outcomes, risk profiles, and mitigation strategies. A simulation is a disposable fork -- it inherits the base state, applies injected events at a branch point, and cascades all downstream effects to produce a divergent projection.

Simulations must be fast enough to run many (for Monte Carlo distributions) but faithful enough to produce meaningful results. They are ephemeral -- created, queried, and discarded without leaving artifacts in the base state. Their value is not the individual simulation but the aggregate: distributions across hundreds of runs reveal risk profiles.

## The Simulation Type

A simulation starts from a baseline, branches at a specific point, and injects modified events. Everything downstream recomputes:

```ft
Injection = {
  path: string,
  originalValue: string | number,
  injectedValue: string | number
}

Simulation = {
  name: string,
  baseline: ref(Plan),
  branchPoint: number,
  injections: ref(Injection),
  ephemeral: true
}
```

The simulation references the baseline plan and records what was injected. The `ephemeral: true` marker indicates that the simulation is disposable -- it does not persist by default. The injections are the "what if" modifications: setting a machine offline, reducing headcount, introducing a delay.

## Event Injection and Cascade

Injecting an event into a simulation cascades through all dependent values, producing a complete divergent projection:

```ft
-- Baseline: 3 machines online, capacity = 300, revenue = 150000, profit = 42000
baseline = Plan
baseline << { name: "production" }

-- Simulation: machine-3 fails
sim1 = Simulation
sim1 << { name: "machine-failure", baseline: ref(baseline), branchPoint: 1 }

sim1.injections.m3 = Injection
sim1.injections.m3 << { path: "machines.m3.status", originalValue: "online", injectedValue: "offline" }

sim1.injections.m3cap = Injection
sim1.injections.m3cap << { path: "machines.m3.capacity", originalValue: 100, injectedValue: 0 }
```

Setting machine-3 to offline with capacity 0 cascades through total capacity (300 to 200), revenue (proportional reduction), and profit (42000 to 12000). The cascade uses the same derivation rules as the base system -- there is no simplified simulation mode. Every ref in the simulation resolves exactly as it would in production.

## Impact Comparison

The simulation's projection is compared against the baseline to quantify impact:

```ft
ImpactDiff = {
  path: string,
  baselineValue: number,
  simulationValue: number,
  delta: number
}

sim1.impact.profit = ImpactDiff
sim1.impact.profit << { path: "profit", baselineValue: 42000, simulationValue: 12000, delta: -30000 }

sim1.impact.capacity = ImpactDiff
sim1.impact.capacity << { path: "capacity", baselineValue: 300, simulationValue: 200, delta: -100 }
```

The impact diff shows what changed and by how much. The percentage calculation (-71% profit, -33% capacity) is a behavioral predicate derived from the delta and baseline values. The user sees "if machine-3 fails, profit drops by $30,000" as structured, queryable data.

## Simulation Disposal

Simulations are discarded after querying. The baseline state is never affected:

```ft
-- After querying sim1's results
delete sim1
-- baseline is unchanged: profit still 42000
```

Discarding a simulation releases its resources and leaves no artifacts. The base state is read-only from the simulation's perspective. Running 100 Monte Carlo simulations and discarding them all produces zero side effects on the baseline.

## Monte Carlo: Multiple Simulations with Aggregated Results

Running many simulations with varied injections produces a distribution of outcomes:

```ft
MonteCarloRun = {
  simulationCount: number.integer >= 1,
  baseline: ref(Plan),
  results: ref(SimulationResult)
}

SimulationResult = {
  runId: number.integer >= 0,
  profit: number,
  capacityShortfall: number >= 0
}

monteCarlo = MonteCarloRun
monteCarlo << { simulationCount: 100, baseline: ref(baseline) }
```

Each run injects randomized modifications (0-3 machines offline, varied failure times, different demand levels). The results are collected into a distribution. The actual randomization and aggregation (min, max, mean, percentiles) are behavioral predicates -- the ft block establishes the structure for collecting and referencing results. The distribution reveals the risk profile: "in 95% of cases, profit stays above $20k."

## Gap Surfacing in Simulations

Simulations can create new gaps that do not exist in the baseline. When capacity drops below demand, unserviced orders surface as a gap:

```ft
-- Simulation where capacity < demand
sim1.gaps.shortfall = GapEntry
sim1.gaps.shortfall << { path: "orders.unserviced", loss: 0.9 }
```

The gap has high priority because unserviced orders have immediate downstream impact. This gap exists only in the simulation -- the baseline has no shortfall. The user sees not just metric changes but new structural problems created by the scenario.

## Mitigation Search

Within a simulation that has created gaps, the system can identify available actions that would resolve them:

```ft
Mitigation = {
  action: string,
  feasibility: number 0..1,
  resolvesGap: ref(GapEntry)
}

sim1.mitigations.temp = Mitigation
sim1.mitigations.temp << { action: "hire-temp-worker", feasibility: 0.7, resolvesGap: ref(sim1.gaps.shortfall) }

sim1.mitigations.overtime = Mitigation
sim1.mitigations.overtime << { action: "authorize-overtime", feasibility: 0.85, resolvesGap: ref(sim1.gaps.shortfall) }
```

Mitigations are capabilities that could fill the simulation's gaps. Feasibility reflects how realistic the action is. The mitigation search turns risk analysis into action planning -- "machine-3 might fail, and if it does, here is what you can do about it."

## Historical Replay as Simulation Input

Simulations can replay recorded historical events rather than synthetic injections:

```ft
sim1.injections.historical = Injection
sim1.injections.historical << { path: "machines.m3.status", originalValue: "online", injectedValue: "offline" }
```

The injection references a historical event (an actual past machine failure) rather than a synthetic one. The simulation replays that exact scenario. Both historical replay and synthetic fuzzing use the same Injection type -- the source of the injected value is metadata, not a structural difference.

## Capabilities

Simulation creation and injection are user-driven. The cascade and comparison are system-derived:

```ft
tool Simulation.name
tool Simulation.branchPoint
tool Injection.path
tool Injection.injectedValue
tool MonteCarloRun.simulationCount
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Injection cascades through all dependents | m3.capacity = 0 cascades to total capacity, revenue, profit |
| Impact comparison quantifies divergence | `ImpactDiff << { delta: -30000 }` |
| Simulations are disposable, base unaffected | `delete sim1` leaves baseline unchanged |
| Monte Carlo aggregates across N simulations | `MonteCarloRun << { simulationCount: 100 }` with `SimulationResult` collection |
| New gaps surfaced by injected scenarios | `sim1.gaps.shortfall << { path: "orders.unserviced" }` |
| Mitigation search identifies resolution actions | `Mitigation << { action: "hire-temp-worker", feasibility: 0.7 }` |
| Historical events usable as simulation inputs | Injection with values from recorded past events |
