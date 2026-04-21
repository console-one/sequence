# Context Graph

## Original Notes

The context graph is simply a storage layer for sequences and sequence blocks that are just narratives that are not necessarily being displayed but are used more so for storage. The requirements within the context graph document here are different considerations that need to be made when building out its core functionality or API structure.

## Overview

The context graph is the storage and retrieval layer for narrative state that is not actively displayed. While the Sequence's projection holds the working set -- what is currently visible and actionable -- the context graph holds everything else: prior narratives, background context, reference material, and compressed state that may become relevant again.

The context graph is not a separate system. It is a set of Sequence paths organized for efficient storage, retrieval, and re-expansion. The key operations are: indexing state by structural shape so it can be found later, maintaining backlinks so references can be traversed in both directions, ranking stored content by likely usefulness so the right material surfaces when needed, and marking nodes as stale when their inputs change.

## Scope

The requirements in this directory cover the individual concerns that arise when building the context graph's core functionality:

```ft
ContextGraph = {
  backlinks: ref("./backlinks"),
  indexGeneration: ref("./indexgeneration"),
  dirtyNodeMarking: ref("./dirynodemarking"),
  toolRank: ref("./toolrank"),
  typeIndexing: ref("./typeindexing"),
  distributedAuthority: ref("./distributedauthority"),
  provisionalShard: ref("./provisionalshard")
}
```

**backlinks** — Maintaining the transpose of the forward reference graph so "what references X?" is always answerable without scanning.

**indexGeneration** — Building and maintaining secondary indexes over the state tree based on structural predicates, so subtrees matching a shape can be found without full traversal.

**dirtyNodeMarking** — Propagating staleness through dependency chains when inputs change, distinguishing reference dependencies (re-read) from computed dependencies (re-execute).

**toolRank** — Scoring stored tools and content by selection rate, downstream attribution, and counterfactual value to drive expand/compress decisions during hoisting.

**typeIndexing** — Indexing state by type shape for fast structural queries across the tree.

**distributedAuthority** — Managing authority over context graph partitions across distributed processes.

**provisionalShard** — Handling provisional (speculative) state that may or may not be committed based on downstream resolution.

## Relationship to the Kernel

The context graph sits between the Sequence (which handles active state, mounting, and cascade) and long-term storage. It uses the same primitives -- paths, types, refs, capabilities -- but is optimized for content that is not in the current working set:

```ft
-- Active state: in Sequence projection, hoisted to prompt/UI
-- Context graph: behind refs, expanded on demand via capabilities
-- Cold storage: behind deeper refs, rehydrated via storage capabilities

contextGraph.entry = {
  content: ref("storage.path"),
  lastAccessed: number,
  relevanceScore: number 0..100
}
```

The hoister decides what to expand vs compress based on relevance scores maintained by the context graph. High-relevance entries are expanded into the working set. Low-relevance entries stay compressed behind expansion tokens. The context graph provides the scoring data; the hoister makes the decision.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Narrative state stored when not displayed | Context graph holds refs to content outside working set |
| Content retrievable by structural shape | Index generation provides secondary indexes over state tree |
| Reverse references answerable | Backlinks maintain transpose of forward reference graph |
| Staleness propagates automatically | Dirty node marking cascades through dependency chains |
| Expand/compress driven by learned relevance | Tool rank scores content by selection, attribution, and outcome quality |
| Same primitives as kernel | Paths, types, refs, capabilities -- no separate system |
| Distributed authority supported | Partitions managed across processes |
