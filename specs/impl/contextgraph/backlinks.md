# Backlinks

## Original Notes

- We can maintain backlinks simply by _tracking_ ref's with specific qualities across states of particular local structure
- Once these are obtained we write to a an index in a partition mirroring the state tree, but exclusively representing backlinks, under the referenced files name
- strength of link should be calculated as something like, probability that the narrative itself gets pulled into context if ref is expanded (because the refs can cover wide ranges)
- and how much the subsequent context from it would dominate if so, across N future interactions ?

## Overview

Forward references are produced naturally when state is written -- A references B. But answering "what references B?" requires the inverse. The backlink index is the transpose of the forward reference graph, stored in a separate partition that mirrors the state tree structure. Each backlink carries a strength score representing how likely expanding that reference would be to pull useful context.

The hard part is not building the index. It is scoring the links. A reference from a fully concrete, tightly coupled path is high-strength. A reference from an abstract, incidental mention is low-strength. Strength determines whether the backlink is auto-expanded into context, compressed to a reference, or surfaced as a decision point.

## The Backlink Entry

A single backlink records who is pointing at a node, how concrete the reference is, and how much it would dominate context if expanded:

```ft
BacklinkEntry = {
  source: string,
  concreteness: number 0..100,
  expansionCost: number >= 0,
  strength: number 0..100
}
```

`source` is the path of the node doing the referencing. `concreteness` measures how resolved the referencing path is -- a fully concrete ref scores higher than an abstract or partial one. `expansionCost` estimates how much context the source would consume if expanded. `strength` is the composite score derived from concreteness and expansion cost.

Strength is inversely related to expansion cost: a reference that, when expanded, floods context with low-relevance data scores lower even if the reference itself is concrete. The formula combines both signals -- high concreteness and low expansion cost produce high strength.

## The Backlink Index

The index lives in a dedicated partition mirroring the state tree. For a node at path `data.report.input`, its backlinks are at `backlinks.report.input`. The index is a derived projection -- it updates automatically when forward references change:

```ft
BacklinkIndex = {
  partition: "backlinks",
  entries: ref(forwardRefs),
  count: number.integer >= 0
}
```

`entries` is a live reference to the forward reference graph's transpose. When a forward ref `A -> B` is added, the entry `B <- A` appears in the backlink index automatically. When the forward ref is removed, the backlink disappears.

No manual rebuild. No explicit "mark dirty" call. The index is always consistent with the forward reference graph because it is derived from it.

## Strength-Based Presentation

Strength drives the expand/compress decision. Three bands:

```ft
BacklinkPresentation = {
  expandThreshold: number 0..100,
  compressThreshold: number 0..100,
  mode: "expanded" | "compressed" | "decision"
}
```

Backlinks above `expandThreshold` are auto-expanded into context -- the user sees the related material without searching. Below `compressThreshold`, they are compressed to a reference ("this exists" but not consuming tokens). Between the two thresholds, they are surfaced as decision points -- the system asks rather than deciding.

## Incremental Updates

When a single forward reference changes, only the affected backlink entry updates. Adding `C -> B` does not recompute the backlinks for nodes other than B:

```ft
-- Forward ref added: C -> B
-- Only backlinks.B is updated to include C
-- All other backlink entries unchanged
```

Removing a forward ref works the same way. The cost of updating the backlink index is proportional to the number of changed references, not the size of the tree.

## Capabilities

The backlink index is readable by any process that needs reverse-reference information. Strength thresholds are configurable:

```ft
cap BacklinkIndex.entries
cap BacklinkPresentation.expandThreshold
cap BacklinkPresentation.compressThreshold
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Forward ref A->B produces backlink B<-A | `entries: ref(forwardRefs)` -- index is transpose of forward graph |
| Each forward ref produces exactly one backlink | One-to-one mapping between forward refs and backlink entries |
| Backlinks stored at mirrored path | `partition: "backlinks"` -- separate partition, same path structure |
| Index updates on ref add/remove | Live reference to forward graph -- adds and removes propagate |
| Concrete path has higher strength | `concreteness: number 0..100` factors into strength score |
| High-strength backlinks expanded | `mode: "expanded"` when strength exceeds expandThreshold |
| Low-strength backlinks compressed | `mode: "compressed"` when strength below compressThreshold |
| Mid-range backlinks as decision points | `mode: "decision"` between the two thresholds |
