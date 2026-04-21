# Partition Futures

## Original Notes

These are just like future facts that we're highly confident about that we're going to use to split any of our dimensions by which we assume we will be able to allocate work into the future. Let's say I have 10 employees on my payroll or whatever. I assume that maybe 90% of them show up every week, and we don't know who; that's a hidden Markov variable or something. We just partition and assume that there will be 9 people next week. We don't know who; it's an undetermined function. I don't know how we would actually model that, but the partitionfutures are basically saying that if you had to estimate for next year the total sales volume of a set of department stores in the US, you could choose to partition that by department store and then forecast for each, or you could choose to do it for total. This is just mapping the type topology of the actual things that you're planning to some type of forecast functions that you use to interpret later on.

Planning topology: choosing how to decompose future unknowns into structured partitions. The choice of partitioning itself affects what can be known and at what confidence level. Finer partitions give more detail but more gaps -- each sub-partition is an independent unknown. Coarser partitions have fewer gaps but less resolution. The system must support both and make the information cost visible.

Some variables within a partition are structurally undetermined. "9 of 10 employees will show up next week" is a known aggregate with unknown distribution -- the total is confident, but which 9 is a hidden variable. Both the aggregate confidence and per-element uncertainty must be representable simultaneously.

## Problem Context

- **Actor(s)**: Planners and analysts who need to forecast future values across structured dimensions (stores, regions, teams); the system that must track per-element and aggregate confidence.
- **Domain**: Planning topology -- decomposing future unknowns into partitions at varying granularity, where the choice of granularity itself has information-theoretic consequences.
- **Core Tension**: Finer partitions give more detail but introduce more individual unknowns (each element is a separate forecast). Coarser partitions have fewer unknowns but less actionable resolution. The system must support both simultaneously and make the information cost of each decomposition visible and comparable.

## Requirements

**R1**: A forecast domain SHALL be decomposable into named partition elements, each tracking its own forecast value and confidence independently.
- *Rationale*: Different elements within a domain (e.g., different stores) may have different levels of information available. Independent tracking prevents one well-known element from masking unknowns in others.
- *Verifiable by*: A partition "us-sales" with elements NYC (forecast known), LA (forecast unknown), CHI (forecast unknown) reports distinct confidence levels per element.

**R2**: The same forecast domain SHALL be partitionable at multiple granularities (e.g., by store, by region, total), and these decompositions SHALL coexist.
- *Rationale*: Users need to compare the information profiles of different decomposition strategies to decide which granularity is most useful for their planning purpose.
- *Verifiable by*: A "us-sales" domain exists simultaneously as a by-store partition (3 elements) and a by-total partition (1 element), each with its own confidence profile.

**R3**: The system SHALL compute aggregate confidence for a partition as a function of all its elements' individual confidences, such that partitions with more unknowns produce lower aggregate confidence.
- *Rationale*: This is the core information-cost signal. A partition with 3 elements, 2 unknown, is less informative than a single-element partition where that element is partially known. The user must see this tradeoff quantitatively.
- *Verifiable by*: A partition with 3 elements (one known, two unknown) reports lower aggregate confidence than a partition with 1 element that is partially known, for the same underlying domain.

**R4**: The system SHALL support representing a known aggregate with an unknown distribution across elements (e.g., "9 of 10 employees will attend, but which 9 is unknown").
- *Rationale*: Many planning problems have confident totals but uncertain breakdowns. The system must represent both the high-confidence aggregate and the per-element uncertainty simultaneously, without one collapsing the other.
- *Verifiable by*: A staffing model with expected headcount 9 (high confidence) and 10 individual employee attendance slots (each unknown) reports high confidence on the aggregate and low confidence on each slot.

**R5**: Derived values that depend on partition-level assumptions SHALL automatically recompute when those assumptions change.
- *Rationale*: If expected headcount changes from 9 to 7, downstream capacity calculations must update without manual intervention.
- *Verifiable by*: Changing expected headcount from 9 to 7 causes weekly capacity (headcount * hours) to update from 360 to 280 automatically.

**R6**: Switching partition granularity SHALL be non-destructive -- data entered at the old granularity is preserved and can be referenced from the new topology.
- *Rationale*: Users explore different decompositions as part of planning. Losing data when switching granularity would punish exploration.
- *Verifiable by*: After switching from by-store to by-region, the NYC store forecast value is still accessible and can be referenced as input to the East region's forecast.

**R7**: The system SHALL make the information cost of partition granularity visible by allowing side-by-side comparison of aggregate confidence across different decompositions of the same domain.
- *Rationale*: Without this comparison, users cannot make an informed decision about which granularity to plan at. The system should answer "is it worth decomposing by store, or is a regional total sufficient?"
- *Verifiable by*: The user can query and compare aggregate confidence for the by-store, by-region, and by-total partitions of the same domain in a single view.

## Acceptance Criteria

**AC1** [R1]: Given partition "us-sales" with elements NYC (forecast = 50000), LA (unknown), CHI (unknown), then NYC reports high confidence and LA/CHI report low confidence.

**AC2** [R2]: Given "us-sales" decomposed as by-store (3 elements) and by-total (1 element), both partitions exist simultaneously and are independently queryable.

**AC3** [R3]: Given by-store has 1 known and 2 unknown elements, and by-total has 1 partially-known element, then by-store's aggregate confidence is lower than by-total's aggregate confidence.

**AC4** [R4]: Given staffing with expected headcount 9 and 10 employee slots each marked unknown, then the aggregate headcount confidence is high while each individual slot's confidence is low.

**AC5** [R5]: Given weekly capacity = headcount * 40 hours, when expected headcount changes from 9 to 7, then weekly capacity updates from 360 to 280.

**AC6** [R6]: Given NYC forecast = 50000 in the by-store partition, when a by-region partition is created with element "East" referencing NYC's forecast, then East's forecast is 50000 and the by-store partition's NYC data is unchanged.

**AC7** [R7]: Given three partition granularities for "us-sales" (by-store, by-region, by-total), the user can query all three aggregate confidence values and compare them.

## Open Questions

- How should the system handle the case where a finer partition's elements are individually known but their sum disagrees with a coarser partition's known total? Which takes precedence?
- For the "known aggregate, unknown distribution" pattern, should the system enforce that per-element values must sum to the aggregate, or is the aggregate merely informational?
- Is there a practical limit to the number of coexisting granularities for a single domain?
