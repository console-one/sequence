# Loss

## Original Notes

I just included this because I don't know if we would normalize all of our loss functions in the same way for different type lattice partitions, or if we would allow pseudo loss functions, or how we would even actually implement an optimization of a concreteness value for a given portion of the lattice or for a given portion of the planned belief space.

Loss is the complement of concreteness: loss = 1 - concreteness. There is no separate loss function framework. Concreteness already returns [0,1] regardless of domain, so loss is automatically normalized and cross-domain comparable. A financial gap and a configuration gap both report loss on the same scale.

The optimization signal is the ranked gap list. Gaps sorted by priority IS gradient descent -- the highest-priority gap is the steepest direction. Filling it produces the largest single reduction in aggregate loss. The system never needs domain-specific loss functions because concreteness is the universal measure of how much is known.

## Loss Per Path

Loss at a single path is the complement of its concreteness. A fully concrete value has loss 0. A gap has loss proportional to how undetermined it is:

```ft
PathLoss = {
  path: string,
  concreteness: number 0..1,
  loss: number 0..1
}
```

Loss = 1 - concreteness. This is not stored as a separate field -- it is a derived projection. The ft block expresses the structure; the derivation (loss = 1 - concreteness) is a behavioral predicate. A path with concreteness 1.0 has loss 0.0. A schema-only gap with concreteness 0.25 has loss 0.75. A completely unknown path has loss approaching 1.0.

## Aggregate Loss Across a Partition

Aggregate loss combines the losses of all paths in a partition, weighted by each gap's priority. High-priority gaps contribute more to aggregate loss:

```ft
GapEntry = {
  path: string,
  loss: number 0..1,
  priority: number 0..1
}

PartitionLoss = {
  gaps: ref(GapEntry),
  aggregateLoss: number 0..1
}
```

Aggregate loss is the priority-weighted sum of individual losses, normalized to [0,1]. The actual weighting formula is a behavioral predicate: aggregate = sum(loss_i * priority_i) / sum(priority_i). Filling a high-priority gap reduces aggregate loss more than filling a low-priority one.

## Gap Ranking as Optimization Gradient

The gap list sorted by priority is the optimization gradient. The first gap in the list is the one whose resolution produces the steepest descent in aggregate loss:

```ft
-- Example: a partition with three paths
revenue = PathLoss
revenue << { path: "revenue", concreteness: 1, loss: 0 }

costs = PathLoss
costs << { path: "costs", concreteness: 0.25, loss: 0.75 }

profit = PathLoss
profit << { path: "profit", concreteness: 0.2, loss: 0.8 }
```

Revenue is concrete (loss 0). Costs is a gap (loss 0.75). Profit is blocked because it depends on costs (loss 0.8 -- higher than costs because it compounds the dependency). The gap list ranks costs first because filling it also unblocks profit, producing a cascade that reduces aggregate loss by more than filling any other single gap.

Priority is not arbitrary assignment -- it reflects downstream impact. A gap that blocks 10 derived values has higher priority than one that blocks none. The priority computation is a behavioral predicate: it counts or weighs the number and importance of downstream dependents.

## Cascade on Gap Resolution

When a gap is filled, loss drops to 0 at that path and all downstream dependents recompute their loss:

```ft
-- Fill the costs gap
costs << { concreteness: 1, loss: 0 }

-- profit was blocked by costs; now it can compute
-- profit.loss drops because its input is no longer a gap
profit << { concreteness: prev, loss: prev }
```

Filling costs causes profit to resolve (revenue - costs = concrete value). Profit's concreteness jumps toward 1.0, and its loss drops toward 0. The aggregate loss for the partition decreases. This cascade is automatic -- the same ref-driven recalculation that powers spreadsheet formulas powers loss propagation.

## Loss Over Time

Tracking aggregate loss across successive gap-fills shows optimization progress:

```ft
LossSnapshot = {
  timestamp: number,
  aggregateLoss: number 0..1
}
```

Each time a gap is filled, a snapshot records the new aggregate loss. The sequence should be monotonically non-increasing -- every gap-fill reduces or maintains aggregate loss. If aggregate loss increases, something went wrong (a value was retracted, or a new gap appeared). Loss trending down = making progress.

## Capabilities

Gap priority is derived, not set manually. Loss is computed, not stored. The only external input is the gap resolution itself:

```ft
cap GapEntry.path
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Fully concrete value has loss 0 | `revenue << { concreteness: 1, loss: 0 }` |
| Schema-only gap has loss > 0 | `costs << { concreteness: 0.25, loss: 0.75 }` |
| Partition-level aggregate loss | `PartitionLoss` with priority-weighted `ref(GapEntry)` |
| Gaps ranked by priority (gradient) | costs ranked first because it unblocks profit cascade |
| Cross-domain normalization | concreteness returns [0,1] regardless of domain, so loss does too |
| Filling gap cascades loss reduction | `costs << { concreteness: 1 }` causes profit.loss to drop |
| Loss decreases monotonically with gap-fills | `LossSnapshot` sequence is non-increasing |
