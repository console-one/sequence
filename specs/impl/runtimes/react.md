# React Runtime

React is how the user sees the constraint store. Every pane, tool result, blocker, and gap is rendered by React components reading from the store. The renderer does not own state -- it projects state. When the store changes, the UI re-renders. When the user clicks something, it submits a statement back to the store. React is the projection engine.

The hard problem is making React's reconciliation efficient when the underlying state is a constraint lattice, not a simple key-value map. The store has gaps, suspensions, non-monotonic updates (eviction), and concreteness levels. All of these must map to visual elements without unnecessary re-renders or stale projections.

## State Projection

Every visible UI element is derived from a read of the constraint store. No component-local state for domain data:

```ft
ProjectionRule = {
  source: "store",
  localStateForDomain: false,
  localStateForUI: boolean
}
```

Component-local state is acceptable only for UI-only concerns (animation flags, focus tracking, hover state). Domain data lives in the store exclusively.

## Statement Submission

Every user action that affects domain state produces a statement submitted to the store:

```ft
UserAction = {
  type: "statement",
  path: string,
  value: string,
  origin: "user"
}
```

Clicking a "save" button results in a statement in the store's log, not a local state change. The store is the single source of truth, and user actions are inputs to the constraint system.

## Selective Re-rendering

The projection layer re-renders only components whose relevant store paths have changed:

```ft
SubscriptionModel = {
  scopedToPath: boolean,
  batchingEnabled: boolean,
  maxBatchMs: number
}
```

A change to path `tools.t1.status` triggers re-render only of components subscribed to that path. Unrelated components do not re-render. This is measurable via React profiler.

## Gap Rendering

Gaps are visible, interactive UI elements. They represent missing information that needs to be provided:

```ft
GapElement = {
  path: string,
  constraint: string,
  inputMechanism: boolean,
  visible: boolean
}
```

A gap at path `config.apiKey` renders a visible element that identifies what is missing and offers a way to resolve it. Gaps are never hidden, never blank spaces, never spinners.

## Suspension Rendering

Suspensions are visually distinct from gaps. They represent in-progress work, not missing input:

```ft
SuspensionElement = {
  operationName: string,
  waitReason: string,
  distinct: boolean
}
```

Users need to distinguish "I need to provide something" (gap) from "the system is working on something" (suspension). The visual treatment is different for each.

## Non-Monotonic Handling

When the store evicts state or a fork is abandoned, previously visible data disappears. The UI handles this gracefully:

```ft
EvictionHandler = {
  fallbackState: "gap" | "placeholder",
  errorOnEviction: false,
  transitionSmooth: boolean
}
```

When a store entry is evicted, the component that displayed it transitions to a gap or placeholder state without throwing a React error.

## Concreteness Visualization

Concreteness levels are rendered visually. Highly concrete state looks definitive; low-concreteness state looks provisional:

```ft
ConcretenessDisplay = {
  threshold: number,
  provisionalTreatment: "opacity" | "border" | "indicator",
  fullConcreteness: number
}
```

A state entry with concreteness 1.0 renders with full visual weight. An entry with concreteness 0.3 renders with reduced opacity or a provisional indicator.

## Fork-Scoped Projections

Components can render a fork's state embedded within components rendering the parent store's state:

```ft
ForkProjection = {
  forkId: string,
  parentVisible: boolean,
  independent: boolean
}
```

A "preview" component renders a fork's state while surrounding UI continues to render parent state. Changes in either are independently reflected.

## Batch Rendering

Rapid state changes are batched to avoid thrashing the render cycle:

```ft
RenderBatching = {
  windowMs: number,
  maxPendingChanges: number >= 0,
  interactiveBypass: boolean
}
```

Ten state changes within 5ms result in at most one React render cycle. Interactive actions (typing, clicking) bypass batching for immediate response.

## What This Validates

| AC | Expressed by |
|----|-------------|
| No domain state in components | `ProjectionRule.localStateForDomain = false` |
| User actions produce statements | `UserAction.type = "statement"` |
| Selective path-scoped re-render | `SubscriptionModel.scopedToPath` |
| Gaps rendered as interactive elements | `GapElement` with input mechanism |
| Suspensions distinct from gaps | `SuspensionElement.distinct` |
| Eviction handled without crash | `EvictionHandler.errorOnEviction = false` |
| Concreteness visually indicated | `ConcretenessDisplay` with treatment |
| Fork projections embedded | `ForkProjection` with independent updates |
| Rapid changes batched | `RenderBatching` reduces render cycles |
