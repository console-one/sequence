# Compressed -- Dimensionality Management of Probability Functions

## Original Notes

Given that some of these functions that we use to estimate concreteness would have higher and higher fidelity considerations of different conjunctions over different materialized subtypes between T and all of its different potential meets to the function input. We definitely do not want to be showing the entire, let's say, all of those combinations for every function and computing over them in memory for every operation or step of our interpreter. That would be crazy.

We need to figure out a general policy for electing to increase the dimensionality of these probability functions in our server, based off of maybe how close our attention is onto that particular function. We also need to figure out how to train these probability interpreter policy election functions at increasing depth over time, spending more energy doing it depending on what we end up finding to be consistent bottlenecks or not.

---

Full-fidelity probability computation over all conjunction combinations is exponentially expensive. If a type has N unresolved paths and each participates in conjunctions with other paths, the space of possible materializations grows combinatorially. Computing all of this for every interpreter step is not feasible.

The solution is a compressed representation: a single priority score per path that summarizes how much resolving that path would matter for scheduling and type resolution. This is a lossy projection of the full conjunction space, but it is the projection the scheduler actually needs -- a ranked list, not a full probability matrix.

The key insight is that updates are O(delta). When one path changes, only the conjunctions referencing that path need re-evaluation. Small probability changes below a threshold are suppressed entirely. The system expands detail only where priority is high, keeping everything else as a single-number summary.

Over time, the system learns which paths are consistently important. Paths that appear in high-priority conjunctions across sessions accumulate higher baseline priority, so the system pre-allocates attention to proven bottlenecks.

## The Priority Cache

Each path in the system has a priority score derived from its conjunction participation. A path that appears in many high-completion conjunctions (where resolving it would complete the conjunction) scores higher than a path in no conjunctions:

```ft
PathPriority = {
  path: string,
  score: number 0..1,
  conjunctionCount: number.integer >= 0,
  baselinePriority: number 0..1
}
```

The `score` is the current priority. The `baselinePriority` is the learned historical baseline -- accumulated from past sessions and subject to decay so stale history does not dominate.

## Delta Propagation

When a path's value changes, the system updates only the conjunctions that reference it. A reverse index maps each path to its conjunction set. The system walks this set, recomputes each affected conjunction's completion state, and updates the priority scores of the remaining unresolved paths in those conjunctions.

```ft
ConjunctionIndex = {
  pathToConjunctions: ref(conjunctionRegistry),
  changeThreshold: number >= 0
}
```

If a conjunction's probability changes by less than `changeThreshold`, the change is suppressed -- no downstream priority updates occur. This prevents cascading recomputation for insignificant shifts.

When a path is resolved and it participates in a conjunction with other unresolved paths, those remaining paths' priorities increase. They are now closer to completing the conjunction. This is monotonic: resolving a path in a conjunction never decreases the priority of remaining paths in that conjunction.

## Variable Expansion Depth

Priority controls how much detail the system materializes. High-priority paths expand to show sub-paths, types, resolution options. Low-priority paths show only their score -- a single-line summary:

```ft
ExpansionPolicy = {
  depth: number.integer >= 0,
  expandAbove: number 0..1,
  compressBelow: number 0..1
}
```

Paths above `expandAbove` threshold get full detail. Paths below `compressBelow` get minimal summaries. The policy is not static -- as priorities shift (a path gets resolved, other paths become more important), the expansion depth adjusts automatically.

## Priority-Based Gap Ordering

The scheduler consumes the compressed representation directly. Gaps are returned sorted by descending priority score. The scheduler does not need the full conjunction probability matrix -- it needs "what should I resolve next?" and the priority cache answers that:

```ft
gapsByPriority = (gaps: ref(allGaps)) -> { sorted: ref(allGaps) }
tool gapsByPriority
```

## Learning Across Sessions

Paths that are consistently high-priority across sessions accumulate baseline priority. This is stored and subject to exponential decay -- a path that was critical last week but irrelevant this week decays back to neutral:

```ft
baselineUpdate = {
  path: string,
  newBaseline: number 0..1
}
```

The decay prevents stale history from dominating. Current-session evidence always overrides historical baselines. The learning signal is additive: consistent appearance in high-priority conjunctions ratchets the baseline up; absence lets it decay down.

The baseline is always overridable by current evidence. If a historically low-priority path suddenly appears in a critical conjunction, its current-session priority dominates regardless of baseline.

## What This Validates

| AC | Expressed by |
|----|-------------|
| O(delta) update, not O(all conjunctions) | `ConjunctionIndex` reverse-maps paths to affected conjunctions only |
| Priority reflects conjunction participation | `PathPriority.score` derived from conjunction count and completion state |
| Small changes suppressed | `ConjunctionIndex.changeThreshold` filters insignificant probability shifts |
| High-priority paths show detail | `ExpansionPolicy.expandAbove` controls detail expansion |
| Resolving a path increases remaining paths' priority | Monotonic: conjunction completion progress raises co-path priorities |
| Learned baselines from session history | `PathPriority.baselinePriority` with exponential decay |
| Gaps sorted by priority for scheduler | `gapsByPriority` returns sorted gap list from compressed data |
