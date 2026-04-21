# Expansion Semantics

## Problem Context

- **Actor(s)**: Authors (humans writing specifications), the renderer (producing views of state), readers (LLMs or humans consuming rendered views and responding).
- **Domain**: Round-trippable representation of incomplete or compressed state in a single unified format that serves authoring, rendering, and response.
- **Core Tension**: The system needs a single syntax that works for three different use cases: (1) humans marking intentional stubs in specs, (2) the renderer compressing large state, and (3) readers requesting more detail. If these use different formats, translation layers multiply and round-tripping breaks.

## Requirements

**R1**: The system SHALL support a placeholder syntax that represents "there is more here" within the standard input/output format.
- *Rationale*: Both authors and the renderer need a way to mark incomplete content without breaking the format.
- *Verifiable by*: A placeholder parses successfully and is treated as an unfulfilled requirement.

**R2**: Placeholders SHALL support both unlabeled (bare description) and labeled (addressable) forms.
- *Rationale*: Authors writing stubs may not need addressability, but the renderer and readers need to reference specific placeholders for targeted expansion.
- *Verifiable by*: An unlabeled placeholder creates an unfulfilled requirement; a labeled placeholder creates an unfulfilled requirement and is addressable by its label.

**R3**: When the renderer compresses a subtree, the resulting placeholder SHALL carry sufficient metadata (path count, unfulfilled item count, score) for the reader to decide whether expansion is worthwhile.
- *Rationale*: Without metadata, the reader cannot make informed decisions about what to expand.
- *Verifiable by*: Renderer-generated placeholders include structural metadata in their description.

**R4**: Expansion SHALL be a read operation -- requesting expansion of a placeholder MUST NOT alter the underlying state.
- *Rationale*: Expansion changes the view, not the data. The reader is asking to see more, not to modify anything.
- *Verifiable by*: Before and after expansion, the kernel's state is identical; only the rendered output differs.

**R5**: Expansion SHALL be additive -- expanding a placeholder MUST NOT compress anything that was previously visible.
- *Rationale*: Expanding one area should not unexpectedly hide another area the reader was relying on.
- *Verifiable by*: After expanding a placeholder, all previously visible paths remain visible.

**R6**: When a reader fills a placeholder with concrete content, the system SHALL accept it as a normal state write that resolves the corresponding unfulfilled requirement.
- *Rationale*: The round-trip is: render placeholder, reader fills it, system accepts the fill. No special "fill" operation should be needed.
- *Verifiable by*: Writing concrete content at a placeholder's path replaces the unfulfilled requirement with the concrete content.

**R7**: When a reader partially fills a placeholder (provides structure but leaves sub-placeholders), the system SHALL accept the structure and create new unfulfilled requirements for the remaining placeholders.
- *Rationale*: Incremental refinement is the normal workflow. Not everything can be filled in one pass.
- *Verifiable by*: After partial fill, the filled structure is concrete and the sub-placeholders appear as new unfulfilled requirements.

**R8**: Unfulfilled requirements inside compressed placeholders SHALL be surfaced separately in the rendered output.
- *Rationale*: The reader must always know what work remains, even within compressed areas.
- *Verifiable by*: An unfulfilled requirement hidden inside a compressed placeholder still appears in the pending items section.

**R9**: A configurable depth limit SHALL control at what nesting level the renderer begins generating placeholders.
- *Rationale*: Different readers have different capacity for nested detail. Depth control lets the system adapt.
- *Verifiable by*: Setting depth to 1 compresses all nested content to placeholders; setting depth to 3 shows three levels of nesting.

**R10**: A configurable item budget SHALL cap the total number of fully-rendered paths, compressing excess content to placeholders regardless of depth.
- *Rationale*: Even shallow state can exceed the reader's capacity if there are many top-level items.
- *Verifiable by*: With an item budget of 50, the output contains at most 50 fully-rendered paths.

**R11**: The format used by authors for writing, by the renderer for output, and by readers for responses SHALL be the same format.
- *Rationale*: A single format eliminates translation layers and ensures true round-trippability.
- *Verifiable by*: Output from the renderer is parseable as input, and input from authors renders correctly as output.

## Acceptance Criteria

**AC1** [R1]: Given an input containing a placeholder, when parsed, then it produces an unfulfilled requirement at the corresponding path.

**AC2** [R2]: Given a labeled placeholder, when a reader references that label, then the system can resolve which path to expand.

**AC3** [R3]: Given a renderer-compressed subtree, when the placeholder is emitted, then it includes path count, unfulfilled item count, and score.

**AC4** [R4]: Given a compressed placeholder, when the reader requests expansion, then the kernel's state before and after the request is identical.

**AC5** [R5]: Given visible paths A and B and compressed placeholder C, when C is expanded, then A and B remain visible.

**AC6** [R6]: Given a placeholder at path X, when the reader writes concrete content at path X, then the unfulfilled requirement is resolved and the concrete content is stored.

**AC7** [R7]: Given a placeholder at path X, when the reader writes structure containing sub-placeholders at X, then the structure is stored and the sub-placeholders become new unfulfilled requirements.

**AC8** [R8]: Given an unfulfilled requirement inside a compressed placeholder, when rendered, then it appears in the pending items section of the output.

**AC9** [R9]: Given depth set to 1, when rendering a nested state tree, then only top-level values are shown and all deeper content is replaced with placeholders.

**AC10** [R10]: Given an item budget of 50 and 200 paths, when rendered, then at most 50 paths are fully rendered.

**AC11** [R11]: Given rendered output, when that output is provided as input, then it parses without error and produces equivalent state.
