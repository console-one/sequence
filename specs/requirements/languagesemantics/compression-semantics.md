# Compression Semantics

## Problem Context

- **Actor(s)**: The kernel (state manager and renderer), the reader (LLM, human, or UI with limited attention/token budget).
- **Domain**: Presenting large state to capacity-constrained readers without losing recoverability or hiding critical information.
- **Core Tension**: The kernel may hold far more state than a reader can absorb in a single view. The system must decide what to show and what to compress, while ensuring compressed content is recoverable and that critical signals (unfulfilled requirements, structural contracts) are never hidden.

## Requirements

**R1**: When total state exceeds the rendering budget, the renderer SHALL replace low-priority content with summary placeholders that preserve the content's structural signature.
- *Rationale*: Readers with limited capacity need a prioritized view, but must still understand the shape of what was hidden.
- *Verifiable by*: Rendered output stays within the configured budget, and each placeholder conveys the structure and metadata of the compressed content.

**R2**: Compression SHALL be reversible -- compressed content MUST remain in the kernel's state and be recoverable on demand.
- *Rationale*: Compression is a view concern, not a data concern. No information is lost.
- *Verifiable by*: Requesting expansion of a placeholder produces the full content that was compressed.

**R3**: The renderer SHALL score every state path using a composite of signals including proximity to unfulfilled requirements, dependency importance, concreteness, temporal urgency, and learned engagement priors.
- *Rationale*: A single-signal priority (e.g., recency alone) would hide critical content. Multiple signals ensure the most actionable content survives.
- *Verifiable by*: Paths needed to resolve a top unfulfilled requirement score higher than disconnected, fully-concrete paths with no urgency.

**R4**: Structural declarations (schemas, capability registrations) SHALL survive compression -- only values are removed from the rendered view.
- *Rationale*: Schemas define the interface contract. Hiding them would prevent the reader from understanding what actions are possible.
- *Verifiable by*: After compressing a subtree, its schema signature is present in the placeholder and its capability registrations remain discoverable.

**R5**: Unfulfilled requirements within compressed content SHALL be surfaced in the rendered output regardless of compression.
- *Rationale*: The reader must always know what work remains, even if surrounding context is hidden.
- *Verifiable by*: An unfulfilled requirement inside a compressed subtree still appears in the pending items section of the rendered output.

**R6**: The rendering budget (maximum items, maximum depth, scoring weights) SHALL be configurable.
- *Rationale*: Different readers have different capacity constraints (an LLM token window vs. a terminal screen vs. a mobile UI).
- *Verifiable by*: Changing the budget parameters changes which content is compressed without altering the underlying state.

**R7**: After each state change, the renderer SHALL re-score all paths and update which content is visible vs. compressed.
- *Rationale*: A state change may make previously low-priority content critical (e.g., a new unfulfilled requirement references it).
- *Verifiable by*: Writing a new unfulfilled requirement that references a compressed path causes that path to be promoted to visible in the next render.

**R8**: The renderer SHALL report which paths were evicted and which were promoted after each state change.
- *Rationale*: Visibility changes are significant events -- the reader or host may need to react to them.
- *Verifiable by*: The state-change result includes lists of evicted and promoted paths.

**R9**: History compaction (permanent removal of old log entries) SHALL be a separate concern from rendering compression and SHALL respect preservation policies.
- *Rationale*: Compaction is irreversible data management; compression is reversible view management. Conflating them risks permanent data loss.
- *Verifiable by*: A path marked for preservation is never removed by compaction, even if it is routinely compressed in rendering.

## Acceptance Criteria

**AC1** [R1]: Given state with 200 paths and a budget of 50, when rendered, then the output contains at most 50 fully-rendered paths and the remainder appear as placeholders with path count, pending item count, and score metadata.

**AC2** [R2]: Given a compressed subtree, when the reader requests expansion, then the next render includes the full content of that subtree.

**AC3** [R3]: Given two paths where path A is needed to resolve a top unfulfilled requirement and path B has no dependencies, when scoring occurs, then path A scores higher than path B.

**AC4** [R4]: Given a subtree with a schema and capability registrations that is compressed, when the placeholder is rendered, then the schema signature appears in the placeholder description and the capabilities remain listed.

**AC5** [R5]: Given an unfulfilled requirement nested inside a compressed subtree, when rendering occurs, then it appears in the output's pending items section.

**AC6** [R6]: Given a budget of 50 items, when the budget is changed to 100, then the next render shows up to 100 paths and fewer placeholders.

**AC7** [R7]: Given a compressed path, when a new unfulfilled requirement references that path, then the next render promotes that path to visible.

**AC8** [R8]: Given a state change that causes scoring changes, when the change result is returned, then it includes the lists of evicted and promoted paths.

**AC9** [R9]: Given a path marked with a preservation policy, when compaction runs, then that path's history is retained even though it may be compressed in rendering.
