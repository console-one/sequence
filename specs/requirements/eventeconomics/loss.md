# Loss

## Original Notes

I just included this because I don't know if we would normalize all of our loss functions in the same way for different type lattice partitions, or if we would allow pseudo loss functions, or how we would even actually implement an optimization of a concreteness value for a given portion of the lattice or for a given portion of the planned belief space.

Loss is the complement of concreteness: loss = 1 - concreteness. There is no separate loss function framework. Concreteness already returns [0,1] regardless of domain, so loss is automatically normalized and cross-domain comparable. A financial gap and a configuration gap both report loss on the same scale.

The optimization signal is the ranked gap list. Gaps sorted by priority IS gradient descent -- the highest-priority gap is the steepest direction. Filling it produces the largest single reduction in aggregate loss. The system never needs domain-specific loss functions because concreteness is the universal measure of how much is known.

## Problem Context

- **Actor(s)**: Users and automated agents who need to decide what to work on next; the system itself, which must quantify overall completeness and track progress.
- **Domain**: Completeness measurement and optimization prioritization -- quantifying how much is known vs. unknown across a workspace, and directing effort toward the unknowns that matter most.
- **Core Tension**: Completeness must be domain-agnostic (a financial unknown and a configuration unknown should be comparable on the same scale) while also reflecting real-world priority differences (not all unknowns are equally important to resolve).

## Requirements

**R1**: Each data path SHALL have a completeness score in the range [0, 1], where 1 means fully determined and 0 means completely unknown.
- *Rationale*: A universal completeness metric enables cross-domain comparison and aggregate measurement without domain-specific scoring functions.
- *Verifiable by*: A fully populated path reports completeness 1.0; a path with only structural schema and no value reports completeness < 1.0; a completely undefined path reports completeness near 0.

**R2**: Loss at a path SHALL be the complement of completeness: loss = 1 - completeness.
- *Rationale*: Loss provides the inverse view (what is missing) using the same normalized scale, which is more natural for optimization (minimize loss rather than maximize completeness).
- *Verifiable by*: A path with completeness 0.75 reports loss 0.25; a path with completeness 1.0 reports loss 0.0.

**R3**: The system SHALL compute an aggregate loss across all paths in a given scope, weighted by each path's priority.
- *Rationale*: A single aggregate number tells the user "how far from done" a workspace or partition is, with high-priority unknowns contributing more to that number.
- *Verifiable by*: A scope with two paths -- one high-priority at loss 0.8 and one low-priority at loss 0.2 -- reports an aggregate that is closer to 0.8 than to 0.5.

**R4**: The system SHALL rank unresolved paths by priority, where priority reflects downstream impact (how many derived values are blocked by this unknown).
- *Rationale*: The highest-priority unknown is the one whose resolution unblocks the most downstream computation. This ranking is the optimization gradient -- it tells the user or agent what to work on next for maximum progress.
- *Verifiable by*: Given path A (blocks 0 dependents) and path B (blocks 5 dependents), B is ranked higher than A.

**R5**: When an unknown path is resolved, loss at that path SHALL drop to 0, and all dependent paths SHALL recompute their completeness and loss automatically.
- *Rationale*: Resolving an unknown can cascade, unblocking derived values and reducing aggregate loss by more than just the single path's contribution.
- *Verifiable by*: Resolving a path that blocks a derived value causes the derived value's completeness to increase and its loss to decrease.

**R6**: Aggregate loss across successive resolutions SHALL be monotonically non-increasing, assuming no values are retracted and no new unknowns are introduced.
- *Rationale*: If every resolution reduces or maintains aggregate loss, progress is guaranteed. An increase would indicate a bug or an unexpected state change.
- *Verifiable by*: After each of N successive resolutions, aggregate loss is less than or equal to the previous aggregate.

**R7**: Loss and completeness SHALL be cross-domain comparable without normalization -- a financial unknown and a configuration unknown both report on the [0, 1] scale.
- *Rationale*: Cross-domain comparability eliminates the need for domain-specific loss functions, simplifying the system and enabling unified dashboards.
- *Verifiable by*: A financial path at completeness 0.5 and a configuration path at completeness 0.5 both report loss 0.5 and contribute equally to aggregate loss (absent priority differences).

**R8**: The system SHALL track aggregate loss over time, producing a time series that shows optimization progress.
- *Rationale*: Users need to see whether they are making progress, how fast, and whether the trend is healthy.
- *Verifiable by*: After each resolution event, a timestamped loss snapshot is recorded; the series is queryable.

## Acceptance Criteria

**AC1** [R1, R2]: Given path "revenue" at completeness 1.0, then its loss is 0.0. Given path "costs" at completeness 0.25, then its loss is 0.75.

**AC2** [R3]: Given paths "costs" (loss 0.75, priority 0.9) and "config" (loss 0.5, priority 0.1), then aggregate loss is weighted such that "costs" dominates the aggregate.

**AC3** [R4]: Given "costs" blocks "profit" (which in turn blocks "margin"), and "label" blocks nothing, then "costs" is ranked above "label" in the priority list.

**AC4** [R5]: Given "profit" depends on "costs" and "revenue", and "revenue" is complete while "costs" is unknown, when "costs" is resolved, then "profit" becomes computable and its loss drops toward 0.

**AC5** [R6]: Given aggregate loss is 0.6, when "costs" is resolved, then aggregate loss is <= 0.6. When "profit" subsequently resolves, aggregate loss is <= the post-costs value.

**AC6** [R7]: Given a financial path and a system configuration path both at completeness 0.5, both report loss 0.5 with no domain-specific normalization needed.

**AC7** [R8]: After resolving 3 unknowns in sequence, the loss time series contains 3 snapshots with non-increasing aggregate loss values.

## Open Questions

- Should priority be purely derived from downstream dependency count, or should users be able to manually override priority for business reasons?
- If a new unknown is introduced (e.g., a new schema is added with empty fields), how should the aggregate loss time series represent the discontinuity?
- Is there a meaningful distinction between "partially known" (completeness 0.5) due to missing sub-fields vs. due to low-confidence estimates? Should they report differently?
