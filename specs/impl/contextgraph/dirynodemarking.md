# Dirty Node Marking

## Original Notes

Dirty nodes are just nodes that have an option for an input to...

When do we actually do dirty node propagation? That's a really good question.

How do we differentiate between these inputs, especially if constructors are automatically mounted for these inputs for this constructor update or get rebound when they update, versus these ones are always assigned? I wonder if it's the difference between, no, because we're always holding references...

Again, I think this is a difference between, when we do the assignment, whether we are assigning the value that was calculated in that patch or the reference to state under which that patch was computed. It's whether we're doing a read to obtain state or a write to obtain state. I don't know where we zero those two concepts out.

## Overview

When an input changes, some computed values become stale. The system must identify which ones and recompute them -- without the caller doing anything. There are no explicit "mark dirty" calls. There is no manual propagation step.

The core question the user raises is the distinction between two kinds of dependencies. A reference dependency means "my value IS that value" -- when the source changes, you just re-read it. A computed dependency means "my value is DERIVED FROM that value via a function" -- when the source changes, the function must re-execute. Both propagate staleness, but they resolve differently.

## The Dependency Types

A dependency node tracks what it depends on and how to resolve when that dependency changes:

```ft
DependencyNode = {
  path: string,
  kind: "reference" | "computed",
  source: string,
  stale: boolean
}
```

When `kind` is `"reference"`, the node's value is a live reference to `source` -- changes propagate by re-reading, no function invocation. When `kind` is `"computed"`, the node's value is produced by a computation function applied to its inputs. The function must be registered separately. The value resolution strategy is determined entirely by `kind` -- reference nodes follow the pointer, computed nodes execute the registered function.

`stale` is set automatically when the source changes. It is not set by the caller.

## Transitive Propagation

Staleness propagates through dependency chains. If C depends on B and B depends on A, a change to A marks both B and C as stale. B is resolved first (topological order), then C sees B's fresh value:

```ft
nodeA = DependencyNode
nodeA << { path: "doc.body", kind: "reference", source: "input.body", stale: false }

nodeB = DependencyNode
nodeB << { path: "doc.wordCount", kind: "computed", source: "doc.body", stale: false }

nodeC = DependencyNode
nodeC << { path: "report.summary", kind: "computed", source: "doc.wordCount", stale: false }
```

When `input.body` changes, `nodeA` resolves by re-reading (reference). `nodeB` re-executes its computation using the new `doc.body`. `nodeC` re-executes using the new `doc.wordCount`. Order matters -- each node sees fresh inputs, never stale intermediates.

## Short-Circuit on Value Equality

If a recomputation produces the same value as before, downstream nodes are not marked stale. This prevents cascade explosions in large graphs:

```ft
-- nodeB recomputes but produces same value as before
-- nodeC is NOT marked stale, NOT recomputed
nodeB << { stale: false }
```

The comparison is on the output value. If `doc.wordCount` was 42 before the source changed and is still 42 after recomputation, everything downstream of `doc.wordCount` stays clean.

## Missing Computation Functions

A computed dependency whose function is not yet registered cannot resolve. This is not a silent failure -- it surfaces as a gap:

```ft
pendingNode = DependencyNode
pendingNode << { path: "doc.summary", kind: "computed", source: "doc.body", stale: true }
-- computation function "summarize" not registered -- surfaces as gap
```

When the function is later registered, the gap resolves and the value computes. The node transitions from stale-with-gap to fresh-with-value.

## Propagation Trigger

Propagation is automatic on any state mutation. There is no separate "propagate now" call. The caller writes a value; dependents recompute. The next read of any dependent returns the fresh result:

```ft
-- write triggers propagation automatically
nodeA << { stale: false }
cap DependencyNode.value
cap DependencyNode.stale
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Dependents recompute on input change | `stale: boolean` set automatically when source changes |
| Transitive propagation in order | Chain nodeA -> nodeB -> nodeC recomputed in topological order |
| Reference deps resolve by re-read | `value: ref(source) when kind = "reference"` -- no function call |
| Computed deps re-execute function | `kind: "computed"` triggers function re-execution |
| Missing function surfaces as gap | Pending node with no registered function appears in gaps |
| Short-circuit on equal values | Same output after recompute prevents downstream propagation |
| No manual propagation call | Propagation automatic on state mutation |
