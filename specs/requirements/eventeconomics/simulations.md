# Simulations

## Original Notes

We can use simulated inputs over the like fuzzing, I guess, and if we can obtain certain sufficiently quality fuzz criteria, else we can just go over historical logs. The one thing I would say is that I think that discrete event simulation here, at least for the times that things happen and the certain conjugate, like external values that are at the higher or lower ends of probability bands for being true, would be something that is probably very useful in building out alternative branches for the belief framework that can help us figure out what the optimal policy is for action under given different risk scenarios of being wrong.

Not even sure if this would be useful within the kernel itself, but discrete event simulation is incredibly useful for scheduling and building operation simulation models. Even if this was not being implemented here as a use for the kernel, it certainly would be a useful tool entailed by our model to expose on the Excel-like functions that we enable for our customers to build out interpolation models, which are used for scheduling and preference policy determination and simulations. A hundred percent would be used in that, or simulations of, like, what if I forget two, or that this particular processor dies during this particular future world line, or what if I don't have two people working next week? What's the impact? What is the next best plan going to look like? I think a lot of those actually would probably be adopted by the user, especially for operations users, where we might have this whole system and all of its projections ostensibly probably running the business. I think being able to show, like, what if I had a mechanical failure next week and that system is down, we can use this to show very explosive scenarios. I think we do have the simulation model, and what I would like you to do is write out how we would be able to encode it?

Discrete event simulation and Monte Carlo analysis: replaying a base plan or history with injected modifications to explore alternative outcomes, risk profiles, and mitigation strategies. A simulation is a disposable fork -- it inherits the base state, applies injected events at a branch point, and cascades all downstream effects to produce a divergent projection.

Simulations must be fast enough to run many (for Monte Carlo distributions) but faithful enough to produce meaningful results. They are ephemeral -- created, queried, and discarded without leaving artifacts in the base state. Their value is not the individual simulation but the aggregate: distributions across hundreds of runs reveal risk profiles.

## Problem Context

- **Actor(s)**: Operations users exploring risk scenarios (machine failures, staffing shortfalls, demand spikes); analysts building Monte Carlo distributions for risk profiling; planners seeking mitigation strategies for identified threats.
- **Domain**: Discrete event simulation and Monte Carlo analysis -- injecting hypothetical modifications into a baseline state, cascading all downstream effects, and aggregating results across many runs to reveal risk profiles and inform action planning.
- **Core Tension**: Simulations must be disposable (zero side effects on the baseline) yet faithful (same derivation logic as production). They must be fast enough to run hundreds for Monte Carlo aggregation, but each individual run must produce a complete and accurate divergent projection.

## Requirements

**R1**: A simulation SHALL start from a baseline state and apply one or more injected modifications ("what if" events) at a specified branch point.
- *Rationale*: The simulation's value comes from changing specific variables and observing the full downstream cascade. Without a clear baseline and explicit injections, results are not interpretable.
- *Verifiable by*: A simulation created from a baseline with injection "machine-3 status = offline" reports that modification explicitly and uses the baseline for all other values.

**R2**: Injected modifications SHALL cascade through all dependent derived values, producing a complete divergent projection using the same derivation logic as the baseline.
- *Rationale*: A simplified simulation mode that skips derivations would produce misleading results. The user needs to trust that the simulation's profit number is computed exactly as the real system would compute it.
- *Verifiable by*: Injecting machine-3 capacity = 0 cascades through total capacity (300 -> 200), then through revenue (proportional reduction), then through profit (42000 -> 12000).

**R3**: The system SHALL produce an impact comparison between the simulation's projection and the baseline, showing each affected path with its baseline value, simulation value, and delta.
- *Rationale*: The purpose of simulation is to quantify impact. "Profit drops by $30,000" is actionable; a raw projection without comparison is not.
- *Verifiable by*: An impact report shows profit: baseline 42000, simulation 12000, delta -30000; and capacity: baseline 300, simulation 200, delta -100.

**R4**: Simulations SHALL be ephemeral -- they can be created, queried, and discarded without leaving any artifacts in the baseline state.
- *Rationale*: If simulations could modify the baseline, users would be afraid to run them. The guarantee of zero side effects enables free exploration.
- *Verifiable by*: After creating, querying, and discarding 100 simulations, the baseline state is byte-for-byte identical to its state before the simulations.

**R5**: The system SHALL support running multiple simulations with varied injections (Monte Carlo) and aggregating results into a distribution (min, max, mean, percentiles).
- *Rationale*: Individual simulations show point scenarios; aggregate distributions reveal risk profiles ("in 95% of cases, profit stays above $20k"). This is the primary tool for risk-informed decision-making.
- *Verifiable by*: Running 100 simulations with randomized machine failures produces a distribution of profit outcomes with computable mean, min, max, and 5th/95th percentiles.

**R6**: Simulations SHALL be able to surface new problems that do not exist in the baseline (e.g., demand exceeding capacity creates unserviceable orders).
- *Rationale*: The most valuable simulation output is often not metric changes but the discovery of structural problems that only appear under stress. Users need to see not just "profit drops" but "and also, 50 orders cannot be fulfilled."
- *Verifiable by*: A simulation where injected capacity < demand reports an "unserviceable orders" problem that does not exist in the baseline.

**R7**: The system SHALL support identifying potential mitigations for problems surfaced by a simulation, including the action, its feasibility, and which problem it addresses.
- *Rationale*: Risk analysis is only half the value; the other half is action planning. "Machine-3 might fail, and if it does, you could hire a temp worker (feasibility: 70%) or authorize overtime (feasibility: 85%)" turns analysis into decision support.
- *Verifiable by*: Given a simulation with an "unserviceable orders" problem, the system identifies mitigations such as "hire-temp-worker" (feasibility 0.7) and "authorize-overtime" (feasibility 0.85), each linked to the problem they resolve.

**R8**: Simulations SHALL accept injections sourced from historical events (replaying a past incident) as well as synthetic modifications.
- *Rationale*: Replaying an actual past machine failure is a higher-fidelity simulation than a synthetic one. Both input types should use the same mechanism.
- *Verifiable by*: A simulation can be created using an injection sourced from a recorded historical event (e.g., a past machine failure at a specific timestamp), and it produces the same cascade behavior as a synthetic injection.

**R9**: Individual simulations SHALL be fast enough that running hundreds for Monte Carlo aggregation completes in a timeframe acceptable for interactive use.
- *Rationale*: If each simulation takes minutes, Monte Carlo analysis becomes impractical. The system must be designed for high-throughput ephemeral forking.
- *Verifiable by*: 100 simulations with 5 injections each complete within a defined latency budget (specific threshold TBD based on the target use case).

## Acceptance Criteria

**AC1** [R1, R2]: Given a baseline with 3 machines online (capacity 300, revenue 150000, profit 42000), when a simulation injects machine-3 offline (capacity 0), then the simulation reports total capacity 200, reduced revenue, and profit 12000.

**AC2** [R3]: Given the simulation from AC1, the impact comparison shows: capacity delta = -100, profit delta = -30000, with baseline and simulation values for each.

**AC3** [R4]: Given 100 simulations are created, queried, and discarded, then the baseline reports the same values (capacity 300, profit 42000) as before any simulation was run.

**AC4** [R5]: Given 100 Monte Carlo runs with randomized injections (0-3 machines offline), the aggregate results include: mean profit, min profit, max profit, and 5th/95th percentile profit.

**AC5** [R6]: Given a simulation where injected capacity (200) is less than demand (250), the simulation reports an "unserviceable orders" problem that the baseline (capacity 300, demand 250) does not have.

**AC6** [R7]: Given the simulation from AC5 with an "unserviceable orders" problem, the system identifies at least one mitigation action with a feasibility score and a link to the problem it addresses.

**AC7** [R8]: Given a historical record of a machine-3 failure at timestamp T, a simulation using that record as its injection source produces the same cascade as a synthetic injection of machine-3 = offline.

**AC8** [R9]: 100 simulations complete within the defined latency budget (threshold TBD).

## Open Questions

- What is the acceptable latency budget for 100 Monte Carlo simulations in an interactive context? Sub-second? Under 10 seconds?
- How are randomized injections parameterized for Monte Carlo runs -- does the user specify probability distributions for each injectable variable, or does the system derive them from historical variance?
- Should mitigation feasibility scores be user-provided, derived from historical data, or both?
- Can simulations be persisted (promoted from ephemeral to permanent) if the user decides a scenario is worth keeping, or are they always disposable?
