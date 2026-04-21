# React Runtime

## Original Notes

React is how the user sees the constraint store. Every pane, tool result, blocker, and gap is rendered by React components reading from the store. The renderer does not own state -- it projects state. When the store changes, the UI re-renders. When the user clicks something, it submits a statement back to the store. React is the projection engine.

The hard problem is making React's reconciliation efficient when the underlying state is a constraint lattice, not a simple key-value map. The store has gaps, suspensions, non-monotonic updates (eviction), and concreteness levels. All of these must map to visual elements without unnecessary re-renders or stale projections.

## Problem Context

- **Actor(s)**: End user (viewing and interacting); React components (rendering projections); state store (source of truth).
- **Domain**: Rendering a stateful system's data as a responsive UI where the store -- not component state -- is the single source of truth, and the UI must handle gaps, suspensions, eviction, and varying confidence levels.
- **Core Tension**: React's reconciliation assumes simple state diffs, but the underlying data has gaps (missing data), suspensions (in-progress work), non-monotonic updates (eviction), and confidence levels -- all of which must render efficiently and correctly.

## Requirements

**R1**: All domain data displayed by components SHALL be derived from the state store, not component-local state.
- *Rationale*: The store is the single source of truth; local domain state creates split-brain bugs.
- *Verifiable by*: No React component holds domain data in useState/useReducer; all domain reads go through store subscription hooks.

**R2**: Component-local state SHALL be used only for UI-only concerns (animation flags, focus tracking, hover state).
- *Rationale*: UI state (e.g., "is this dropdown open?") is ephemeral and does not belong in the persistent store.
- *Verifiable by*: Audit of component state shows only UI-concern values, never domain entities.

**R3**: Every user action that affects domain state SHALL produce a write to the state store, not a local state mutation.
- *Rationale*: User actions are inputs to the system; routing them through the store ensures they are logged, validated, and visible to all observers.
- *Verifiable by*: Clicking "save" produces a store write visible in the store's log, not just a component state change.

**R4**: Components SHALL re-render only when their subscribed store paths change, not on any store change.
- *Rationale*: Global re-renders on any state change cause performance degradation proportional to total component count.
- *Verifiable by*: Change path `tools.t1.status` -- only components subscribed to that path re-render, measurable via React profiler.

**R5**: Missing data (gaps) SHALL render as visible, interactive elements that identify what is missing and offer a mechanism to resolve it.
- *Rationale*: Gaps are not errors -- they are expected states. Users need to see what is missing and act on it.
- *Verifiable by*: A path with a declared type but no value renders as a visible element (not a blank space, spinner, or error) with a label describing what is needed and an input mechanism.

**R6**: In-progress operations (suspensions) SHALL render as visually distinct from gaps.
- *Rationale*: Users must distinguish "I need to provide something" from "the system is working on something."
- *Verifiable by*: A gap and a suspension render side-by-side with clearly different visual treatments.

**R7**: When state is evicted or a speculative branch is abandoned, the UI SHALL transition the affected components to a placeholder state without throwing errors.
- *Rationale*: Non-monotonic state changes (data disappearing) must not crash the React tree.
- *Verifiable by*: Evict a store entry -- the component that displayed it transitions to a placeholder without a React error boundary catching an exception.

**R8**: Data confidence levels SHALL be visually indicated, with high-confidence data appearing definitive and low-confidence data appearing provisional.
- *Rationale*: Users need to understand which data is final and which is tentative to make informed decisions.
- *Verifiable by*: A state entry with confidence 1.0 renders with full visual weight; an entry with confidence 0.3 renders with reduced opacity or a provisional indicator.

**R9**: Components SHALL be able to render a speculative branch's state embedded within the parent state's rendering.
- *Rationale*: "Preview" views show what-if scenarios alongside the current state.
- *Verifiable by*: A preview component renders a branch's state while surrounding components render the parent state; changes in either are independently reflected.

**R10**: Rapid state changes (10+ within 5ms) SHALL be batched into at most one render cycle, except for interactive actions which SHALL bypass batching for immediate response.
- *Rationale*: Render thrashing degrades performance, but user interactions must feel instant.
- *Verifiable by*: 10 programmatic state changes within 5ms produce one render cycle; a user click triggers an immediate render without waiting for the batch window.

## Acceptance Criteria

**AC1** [R1, R2]: Given a React component tree, when audited, then no component holds domain data in local state -- all domain reads come from the store.

**AC2** [R3]: Given a user clicking a "save" button, when the action completes, then a write is visible in the store log and the UI reflects the change from the store (not local state).

**AC3** [R4]: Given a store change at path `tools.t1.status`, when the change occurs, then only components subscribed to that path re-render (React profiler shows zero re-renders for unrelated components).

**AC4** [R5, R6]: Given a gap at `config.apiKey` and a suspension at `tools.t1`, when rendered, then the gap shows an interactive input element and the suspension shows a distinct in-progress indicator.

**AC5** [R7]: Given a displayed store entry, when it is evicted, then the component transitions to a placeholder state without throwing an exception.

**AC6** [R8]: Given two entries with confidence 1.0 and 0.3 respectively, when rendered, then they are visually distinguishable (e.g., full opacity vs. reduced opacity).

**AC7** [R9]: Given a speculative branch, when a preview component renders it, then surrounding components continue rendering parent state and updates to either are independent.

**AC8** [R10]: Given 10 state changes within 5ms followed by a user click, when rendered, then the 10 changes produce one render cycle and the click produces an immediate separate render.

## FT System Demands

- **Required Primitives**: Path-scoped subscriptions with batching. Structured representations for gaps and suspensions. Confidence metadata per entry.
- **Required Operations**: Graceful transition on eviction (non-monotonic update). Scoped branch rendering (speculative previews).
- **Gaps**: The system must define how confidence levels are determined and propagated to the rendering layer.

## Open Questions

- What is the threshold for "provisional" visual treatment -- confidence < 0.5, or configurable per component?
- Should gap rendering include a priority indicator (e.g., "required" vs. "optional")?
- How should the system handle multiple overlapping speculative branches being previewed simultaneously?
