# Tool Injection

## Original Notes

I say tool injection because every time we have a content-addressable location, we are displaying like an array where we might show a symbol at the top of the array saying like you can push to this array under these terms by just calling like by sending a patch or this kind of data to this particular tool name, which is only valid within the scope of this context I'm showing you. What I'm saying is like optionality for the LLM to enter in inputs, which are used and useful for concreteness that flows downstream to concreteness resolution back into the prompt for the next cycle where it's going to view that outcome. I don't think they should be shown as just like generic refs that I'm using when I'm explaining how the system would work principally. I think that they would look like tools that were just generating at hoist time, and then what the LLM responds with is then just like the union of all potential statements in that combined set of arguments that could be called for every function that could be called to resolve gaps.

Coherent stable tools would also be shown, but the point is that I guess the LLM is not going to be calling global functions at any point. It's going to be calling functions that are only dereferenceable within that local scope to something that is like versioned and persistent via some mapping which we create when we do the hoist.

---

## Problem Context

- **Actor(s)**: The LLM (calling tools to fill slots and expand compressed content), the system (generating tool definitions from current state, validating tool calls), and persistent capabilities (stable tools that persist across turns).
- **Domain**: Dynamic tool generation for LLM interaction, where available tools are derived from the current process state rather than a fixed global registry.
- **Core Tension**: The LLM needs callable tools to fill unresolved slots and expand compressed content, but those tools must be scoped to the current turn's state. A global tool registry would create stale reference risks because state changes between turns.

## Requirements

**R1**: The tool set available to the LLM SHALL be generated from the process's current state at prompt-render time -- not from a fixed global registry.
- *Rationale*: State evolves between turns; tools must reflect the current state to avoid stale references.
- *Verifiable by*: The tool set changes between turns as unresolved items are filled and new ones appear.

**R2**: Each unresolved item in the current state SHALL produce a corresponding fill-tool whose input schema is derived from the item's type constraints.
- *Rationale*: The LLM sees the exact valid input range as part of the tool definition, reducing invalid submissions.
- *Verifiable by*: An unresolved item expecting a number between 100 and 8000 produces a fill-tool whose input schema enforces that range.

**R3**: When an unresolved item is filled, its corresponding fill-tool SHALL be removed from the next turn's tool set.
- *Rationale*: Tools for resolved items are meaningless; their presence would confuse the LLM.
- *Verifiable by*: A fill-tool present in turn N is absent in turn N+1 after its item is filled.

**R4**: Persistent capability tools (stable tools that exist regardless of state changes) SHALL appear in every turn's tool set.
- *Rationale*: Some capabilities (e.g., search, compute) are always available and must persist.
- *Verifiable by*: A persistent capability tool appears in every turn's tool set regardless of state changes.

**R5**: Compressed sections of the prompt SHALL produce expansion tools that accept only the valid expansion tokens from the current render.
- *Rationale*: Expansion tokens are render-specific; tokens from a previous turn may reference content that no longer exists.
- *Verifiable by*: An expansion tool accepts a token from the current render and rejects a token from a previous render.

**R6**: Each tool call SHALL be validated against the current turn's tool set. A call referencing a tool name not in the current set SHALL be rejected.
- *Rationale*: Prevents the LLM from calling stale tools from previous turns.
- *Verifiable by*: A tool call with a name not in the current turn's tool set produces a rejection error.

**R7**: Each tool call SHALL map to one or more structured state updates. Fill-tool calls produce value bindings at the target path; capability calls execute and store results; expansion calls return expanded content.
- *Rationale*: Tool calls must have deterministic effects on state so outcomes are predictable and auditable.
- *Verifiable by*: After a fill-tool call, the target path has the provided value; after a capability call, the result is stored; after an expansion call, expanded content is returned.

**R8**: All tool categories (fill-tools, capability tools, expansion tools) SHALL be presented to the LLM in a uniform callable interface.
- *Rationale*: A uniform interface reduces cognitive load for the LLM; it does not need to distinguish between tool categories syntactically.
- *Verifiable by*: The LLM sees a single list of tools with consistent schema; it does not need to use different calling conventions for different categories.

## Acceptance Criteria

**AC1** [R1, R2]: Given 3 unresolved items in the current state, when the tool set is generated, then 3 fill-tools exist with input schemas matching each item's type constraints.

**AC2** [R2]: Given an unresolved item expecting a string matching `^(gpt-4|claude)$`, when the fill-tool is generated, then its input schema enforces that regex constraint.

**AC3** [R3]: Given a fill-tool for `config.model` in turn 1, when `config.model` is filled in turn 1, then the fill-tool is absent from turn 2's tool set.

**AC4** [R4]: Given a persistent capability tool "search", when turns 1 through 5 complete, then "search" appears in every turn's tool set.

**AC5** [R5]: Given expansion tokens A, B, C in the current render, when the expansion tool is called with token A, then expanded content is returned; when called with a token from a previous render, then the call is rejected.

**AC6** [R6]: Given the current turn's tool set contains tools X, Y, Z, when the LLM calls tool W (not in the set), then the call is rejected with "tool not found in current scope".

**AC7** [R7]: Given a fill-tool call for path `config.model` with value "gpt-4", when the call is processed, then `config.model` has value "gpt-4" in state.

**AC8** [R8]: Given fill-tools, capability tools, and expansion tools in the same turn, when presented to the LLM, then all appear in a single uniform tool list.

## Open Questions

- Should the tool set include metadata about why each fill-tool exists (e.g., what downstream work it unblocks)?
- When a fill-tool call is rejected due to constraint violation, should the rejection message include the valid range?
