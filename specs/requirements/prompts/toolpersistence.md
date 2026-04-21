# Tool Persistence

## Original Notes

The requirements for tool persistence are pretty precise here: every time that we generate a prompt in a frame to show to an LLM, we need to have a stable snapshot of the gaps and the exact frame of gaps that the tool calls. Those two calls were made consequent to, and that's because we're going to be generating unique input sequences for particular tools that we're showing, like something called expand. We would show, having a unique input type for every single compressed thing in that prompt that could be expanded. We're just going to give each symbol that we have, something compressed that could be expanded, a unique letter, and then say, "Okay, here's the expand tool. Call it with all the unique letters you saw when we showed you the prompt you see in this prompt within these delimiters." The next time that you get this narrative, those will be expanded, but also here's the cost of doing those expansions, and then somehow show how the pipeline that's being used in compressed, relevant to the display that it has, was determined. If possible, how the gaps that it's filling flow back via the backwards inference into something that is ultimately going to result in a loop where it is going to get called again? If we could show that, that would be amazing, and we could show it over time and show that the deadlines, the various task deadlines of work that's on in a shared context, that would be just so insanely sick. Then show, for all of the inputs of tools that it could call, like we're pulling data or function references, which would be relevant to making the determinations of what concrete values to input into those tools. Like, it makes such perfect sense.

---

## Problem Context

- **Actor(s)**: The system (generating prompts and tool sets per frame), the LLM (calling tools scoped to a specific frame), and observers (tracking convergence across frames).
- **Domain**: Frame-scoped tool snapshots for LLM interactions where there is a timing gap between prompt generation and response processing, and state may change in between.
- **Core Tension**: Tool calls from the LLM must be validated against the frame they were generated for, not against the current state -- because state may have changed since the prompt was generated. Additionally, the snapshot should be more than a validation artifact; it should help the LLM reason about priorities, costs, and downstream impact.

## Requirements

**R1**: Every prompt generation SHALL produce a durable, immutable frame snapshot capturing the complete tool context at that moment.
- *Rationale*: Tool calls arrive after prompt generation; the snapshot is the authoritative reference for validating those calls.
- *Verifiable by*: After prompt generation, a snapshot exists that is not modified by subsequent state changes.

**R2**: The frame snapshot SHALL include the mapping between expansion tokens and source paths, the unresolved item surface, the tool definitions, and a timestamp.
- *Rationale*: These four components are the minimum needed to validate tool calls and provide context.
- *Verifiable by*: The snapshot contains all four components and each is queryable.

**R3**: Tool calls from the LLM SHALL be validated against the snapshot of the frame they were generated for, not against the current state.
- *Rationale*: State may change between prompt generation and response processing; validating against stale state would produce incorrect results.
- *Verifiable by*: A tool call referencing a token that exists in its frame's snapshot but not in the current state is accepted (snapshot wins).

**R4**: A stale token (one whose underlying source path no longer exists or has changed since the snapshot) SHALL produce an explicit error rather than silently returning incorrect data.
- *Rationale*: Silent stale data is worse than an explicit error; the LLM can self-correct from errors.
- *Verifiable by*: Calling expand on a token whose path was deleted produces a stale token error, not silent failure.

**R5**: Each expansion token in the prompt SHALL carry an estimated cost (in tokens) so the LLM can make budget-aware expansion decisions.
- *Rationale*: Expanding a 50-token section is cheap; expanding a 1200-token section is expensive. The LLM needs this information to prioritize.
- *Verifiable by*: Each expansion token in the rendered prompt is accompanied by its estimated cost.

**R6**: Each unresolved item in the snapshot SHALL indicate what downstream computations it would unblock when filled (dependency flow).
- *Rationale*: An unresolved item that unblocks many downstream items is more valuable to fill first; this information helps the LLM prioritize.
- *Verifiable by*: The snapshot's unresolved item records include a list of downstream paths that depend on each item.

**R7**: Each tool definition in the snapshot SHALL reference the data sources relevant to its inputs.
- *Rationale*: Showing the LLM where to find information for filling a tool's inputs improves the quality of its responses.
- *Verifiable by*: A tool definition includes references to the data paths informing its input values.

**R8**: Frame snapshots SHALL be persisted and queryable by frame number, enabling tracking of how the unresolved item surface evolves across frames.
- *Rationale*: Convergence analysis requires historical comparison -- which items appeared, which closed, which persisted.
- *Verifiable by*: Querying snapshots for frames 1 through 5 returns all five; comparing them shows which items appeared, closed, or persisted.

**R9**: Each unresolved item in the snapshot SHALL include a concreteness percentage (how close to fully resolved).
- *Rationale*: Partial progress toward resolution is useful context for the interpreter.
- *Verifiable by*: An unresolved item that is half-resolved shows approximately 50% concreteness.

## Acceptance Criteria

**AC1** [R1, R2]: Given a prompt generation event, when the snapshot is inspected, then it contains the token map, unresolved items, tool definitions, and timestamp, and it is immutable.

**AC2** [R3]: Given a tool call referencing frame 3's snapshot, when the current state has diverged from frame 3, then validation uses frame 3's snapshot -- not the current state.

**AC3** [R4]: Given an expansion token whose source path was deleted after the snapshot was taken, when the LLM calls expand with that token, then a stale token error is returned.

**AC4** [R5]: Given a prompt with 3 expansion tokens, when the prompt is rendered, then each token is accompanied by an estimated cost (e.g., "~300 tokens", "~1200 tokens").

**AC5** [R6]: Given an unresolved item at `tasks.t1.output` that unblocks `tasks.t2.input` and `report.summary`, when the snapshot is inspected, then `tasks.t1.output`'s record lists both downstream paths.

**AC6** [R7]: Given a fill-tool for `config.model`, when the snapshot is inspected, then the tool definition references the data sources relevant to choosing a model value.

**AC7** [R8]: Given 5 completed frames, when querying snapshots for frames 1 through 5, then all five are returned and comparison shows which unresolved items appeared, closed, or persisted across frames.

**AC8** [R9]: Given an unresolved item that is partially resolved, when the snapshot is inspected, then the item's concreteness percentage reflects its partial resolution state.

## Open Questions

- What is the retention policy for frame snapshots? Are they retained indefinitely, or subject to compaction after a certain number of frames?
- How are expansion cost estimates computed? Token count of the expanded content? Or something more nuanced (e.g., weighted by relevance)?
- Should the dependency flow (R6) be computed eagerly at snapshot time or lazily when queried?
