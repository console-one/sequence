# Partition Futures

## Original Notes

These are just like future facts that we're highly confident about that we're going to use to split any of our dimensions by which we assume we will be able to allocate work into the future. Let's say I have 10 employees on my payroll or whatever. I assume that maybe 90% of them show up every week, and we don't know who; that's a hidden Markov variable or something. We just partition and assume that there will be 9 people next week. We don't know who; it's an undetermined function. I don't know how we would actually model that, but the partitionfutures are basically saying that if you had to estimate for next year the total sales volume of a set of department stores in the US, you could choose to partition that by department store and then forecast for each, or you could choose to do it for total. This is just mapping the type topology of the actual things that you're planning to some type of forecast functions that you use to interpret later on.

Planning topology: choosing how to decompose future unknowns into structured partitions. The choice of partitioning itself affects what can be known and at what confidence level. Finer partitions give more detail but more gaps -- each sub-partition is an independent unknown. Coarser partitions have fewer gaps but less resolution. The system must support both and make the information cost visible.

Some variables within a partition are structurally undetermined. "9 of 10 employees will show up next week" is a known aggregate with unknown distribution -- the total is confident, but which 9 is a hidden variable. Both the aggregate confidence and per-element uncertainty must be representable simultaneously.

## Partition Declaration

A forecast domain can be decomposed into partition elements. Each element tracks its own concreteness independently:

```ft
PartitionElement = {
  name: string,
  forecast: number,
  schema: string
}

Partition = {
  domain: string,
  granularity: string,
  elements: ref(PartitionElement)
}
```

The partition is a user choice -- the same domain (e.g., "US total sales") can be partitioned by store, by region, or kept as a single total. Each element has its own forecast value (which may be concrete or a gap) and its own concreteness.

## Per-Store vs Total Partitioning

Different partition granularities produce different concreteness profiles for the same underlying unknown:

```ft
-- Fine partition: by store
byStore = Partition
byStore << { domain: "us-sales", granularity: "store" }

byStore.elements.nyc = PartitionElement
byStore.elements.nyc << { name: "NYC", forecast: 50000 }

byStore.elements.la = PartitionElement
byStore.elements.la << { name: "LA", forecast: [[ unknown ]] }

byStore.elements.chi = PartitionElement
byStore.elements.chi << { name: "CHI", forecast: [[ unknown ]] }

-- Coarse partition: total
byTotal = Partition
byTotal << { domain: "us-sales", granularity: "total" }

byTotal.elements.total = PartitionElement
byTotal.elements.total << { name: "US Total", forecast: [[ unknown ]] }
```

NYC has a forecast value (higher concreteness). LA and CHI are gaps (lower concreteness). The by-store partition has three elements, two of which are gaps. The by-total partition has one element which is a gap. Even though both have the same "amount" of missing information, the fine partition's aggregate concreteness is lower because uncertainty multiplies across independent unknowns.

## Aggregate Concreteness Across Partitions

The aggregate concreteness of a partition reflects the combined certainty of all its elements. Finer partitions with more gaps produce lower aggregate concreteness:

```ft
PartitionConcreteness = {
  partition: ref(Partition),
  aggregate: number 0..1
}

storeConcreteness = PartitionConcreteness
storeConcreteness << { partition: ref(byStore) }

totalConcreteness = PartitionConcreteness
totalConcreteness << { partition: ref(byTotal) }
```

The aggregate computation is a behavioral predicate. For a partition with N elements, aggregate concreteness reflects the product (or analogous combination) of individual element concreteness values. Three elements at 0.3 each produce an aggregate around 0.03. One element at 0.3 produces an aggregate of 0.3. This makes the information cost of finer partitioning visible -- more elements means more unknowns to fill.

## Undetermined Sub-Components

Some partition structures have a known aggregate but unknown distribution. "9 of 10 employees will be present" is a constraint where the total is confident but individual assignments are gaps:

```ft
Headcount = {
  expected: number.integer >= 0,
  slots: ref(EmployeeSlot)
}

EmployeeSlot = {
  employeeId: string,
  present: boolean
}

staffing = Headcount
staffing << { expected: 9 }

staffing.slots.e1 = EmployeeSlot
staffing.slots.e1 << { employeeId: "e1", present: [[ unknown ]] }

staffing.slots.e2 = EmployeeSlot
staffing.slots.e2 << { employeeId: "e2", present: [[ unknown ]] }
```

The expected headcount (9) has high concreteness -- it is a confident estimate based on historical attendance. Each individual slot's present field is a gap -- we do not know which specific employees will be absent. The aggregate is more certain than any individual element. This pattern (known total, unknown distribution) is the "hidden Markov variable" the original notes describe -- the system models it as an aggregate constraint with per-element gaps.

## Derived Values from Partition Assumptions

Downstream values cascade from partition-level assumptions. If expected headcount is 9 and hours per week is 40, capacity computes automatically:

```ft
Capacity = {
  headcount: ref(Headcount),
  hoursPerWeek: number,
  totalHours: number
}

weeklyCapacity = Capacity
weeklyCapacity << { headcount: ref(staffing), hoursPerWeek: 40 }
```

totalHours = headcount.expected * hoursPerWeek = 9 * 40 = 360. This derivation is a behavioral predicate. When the headcount assumption changes, capacity recomputes. The concreteness of totalHours reflects the concreteness of headcount.expected -- derived values inherit the uncertainty of their inputs.

## Partition Topology Change

Switching partition granularity is exploratory and non-destructive. Data entered at the old granularity is preserved where applicable:

```ft
-- Switch from by-store to by-region
byRegion = Partition
byRegion << { domain: "us-sales", granularity: "region" }

byRegion.elements.east = PartitionElement
byRegion.elements.east << { name: "East", forecast: ref(byStore.elements.nyc.forecast) }

byRegion.elements.west = PartitionElement
byRegion.elements.west << { name: "West", forecast: [[ unknown ]] }
```

The East region inherits NYC's forecast value via ref. The West region is a new gap. Aggregate concreteness recomputes for the new topology. The by-store partition still exists -- both topologies can coexist, and the user can compare their concreteness profiles.

## Capabilities

The partition topology and individual forecasts are user-provided:

```ft
cap Partition.granularity
cap Partition.elements
cap PartitionElement.forecast
cap Headcount.expected
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Partition elements independently addressable | `byStore.elements.nyc`, `.la`, `.chi` each with own forecast |
| Per-element concreteness tracking | NYC has value (higher), LA/CHI are gaps (lower) |
| Finer partition has lower aggregate concreteness | 3 gaps at 0.3 each vs 1 gap at 0.3 |
| Known aggregate with unknown distribution | `staffing << { expected: 9 }` with per-slot gaps |
| Derived values cascade from assumptions | `weeklyCapacity.totalHours` = headcount * hoursPerWeek |
| Topology switchable with data preserved | `byRegion.elements.east << { forecast: ref(byStore.elements.nyc.forecast) }` |
| Information cost of partition choice visible | Aggregate concreteness comparison between fine and coarse partitions |
