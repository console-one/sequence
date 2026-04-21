# Backlinks

## Original Notes

- We can maintain backlinks simply by _tracking_ ref's with specific qualities across states of particular local structure
- Once these are obtained we write to a an index in a partition mirroring the state tree, but exclusively representing backlinks, under the referenced files name
- strength of link should be calculated as something like, probability that the narrative itself gets pulled into context if ref is expanded (because the refs can cover wide ranges)
- and how much the subsequent context from it would dominate if so, across N future interactions ?

## Problem Context

- **Actor(s)**: Any process that writes references between nodes (producer), any process that needs to answer "what points at this node?" (consumer), the context presentation layer that decides what to expand or compress.
- **Domain**: Reverse-reference indexing in a hierarchical state tree. Forward references (A -> B) are produced naturally when state is written. Answering "what references B?" requires maintaining the inverse.
- **Core Tension**: Building the index is straightforward -- it is the transpose of the forward graph. The hard part is scoring link strength. A reference from a tightly coupled, fully concrete path is high-value. A reference from an incidental mention in an abstract context is low-value. Strength determines what gets surfaced automatically vs. what stays hidden.

## Requirements

**R1**: For every forward reference A -> B in the state tree, the system SHALL maintain a corresponding backlink entry B <- A in a dedicated backlink index.
- *Rationale*: Without the inverse, answering "what references B?" requires a full tree scan.
- *Verifiable by*: After a forward reference from path A to path B is created, querying the backlink index for B returns an entry pointing to A.

**R2**: The backlink index SHALL be stored in a separate partition that mirrors the structure of the state tree.
- *Rationale*: Backlinks are metadata about the state tree, not part of the state itself. Mirroring the structure makes lookups O(1) by path.
- *Verifiable by*: A node at path `data.report.input` has its backlinks stored at a predictable mirrored path (e.g., `backlinks.report.input`).

**R3**: The backlink index SHALL update automatically when forward references are added or removed, with no manual rebuild or explicit invalidation required.
- *Rationale*: A stale backlink index is worse than no index -- it gives false answers. Automatic derivation from the forward graph guarantees consistency.
- *Verifiable by*: Adding a forward reference A -> B causes a backlink entry to appear for B. Removing the forward reference causes the backlink entry to disappear. No explicit rebuild call is needed.

**R4**: Each backlink entry SHALL carry a strength score (0-100) derived from at least two factors: the concreteness of the referencing path, and the estimated context cost of expanding the reference.
- *Rationale*: The original notes ask for "probability that the narrative itself gets pulled into context if ref is expanded" and "how much the subsequent context from it would dominate." These map to concreteness (how concrete/resolved is the source?) and expansion cost (how much context would it consume?).
- *Verifiable by*: A backlink from a fully concrete, narrowly scoped path scores higher than a backlink from an abstract, broadly scoped path. A backlink whose source would flood context with low-relevance data scores lower even if the source path is concrete.

**R5**: Strength SHALL inversely correlate with expansion cost: references that would consume disproportionate context relative to their relevance SHALL score lower.
- *Rationale*: High concreteness alone is insufficient. A reference can be concrete but expand to a massive, tangentially related subtree.
- *Verifiable by*: Two backlinks with equal concreteness but different expansion costs produce different strength scores, with the lower-cost link scoring higher.

**R6**: The system SHALL categorize backlinks into three presentation tiers based on configurable strength thresholds: expanded (automatically shown), compressed (reference-only), and decision (user/agent asked whether to expand).
- *Rationale*: Not all backlinks deserve screen or token budget. High-strength links are auto-surfaced, low-strength links are noted but not expanded, and borderline links are presented as choices.
- *Verifiable by*: With thresholds set at 70 (expand) and 30 (compress), a backlink with strength 80 is expanded, strength 20 is compressed, and strength 50 is surfaced as a decision point.

**R7**: Backlink index updates SHALL be incremental: adding or removing a single forward reference SHALL only affect the backlink entries for the referenced node, not trigger a full index rebuild.
- *Rationale*: In a large tree, full rebuilds are prohibitively expensive. Cost must be proportional to changed references, not tree size.
- *Verifiable by*: Adding a reference C -> B updates only the backlink entries for B. Backlink entries for all other nodes remain untouched.

## Acceptance Criteria

**AC1** [R1, R3]: Given a forward reference from `doc.intro` to `data.metrics`, when the reference is created, then querying backlinks for `data.metrics` returns an entry with source `doc.intro`. When the reference is removed, then the entry disappears.

**AC2** [R2]: Given a node at `data.report.input`, when its backlinks are queried, then they are found at the mirrored path in the backlinks partition.

**AC3** [R4, R5]: Given two forward references to the same target -- one from a concrete, low-expansion-cost path and one from an abstract, high-expansion-cost path -- when their backlink entries are compared, then the first has a higher strength score.

**AC4** [R6]: Given configurable thresholds (expand: 70, compress: 30), when a backlink has strength 85, then it is presented as "expanded." When strength is 15, then "compressed." When strength is 50, then "decision."

**AC5** [R7]: Given a tree with 10,000 nodes, when one forward reference is added, then only the target node's backlink entries are updated. No other backlink entries change.

## Open Questions

- **Strength formula**: What is the exact weighting between concreteness and expansion cost? Is it configurable or fixed?
- **Cross-partition backlinks**: If A is in partition X and references B in partition Y, where does the backlink entry live -- in the backlinks partition of X, Y, or both?
- **Decay**: Should backlink strength decay over time if the referencing context becomes stale?
