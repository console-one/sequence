# Tool Injection

## Original Notes

I say tool injection because every time we have a content-addressable location, we are displaying like an array where we might show a symbol at the top of the array saying like you can push to this array under these terms by just calling like by sending a patch or this kind of data to this particular tool name, which is only valid within the scope of this context I'm showing you. What I'm saying is like optionality for the LLM to enter in inputs, which are used and useful for concreteness that flows downstream to concreteness resolution back into the prompt for the next cycle where it's going to view that outcome. I don't think they should be shown as just like generic refs that I'm using when I'm explaining how the system would work principally. I think that they would look like tools that were just generating at hoist time, and then what the LLM responds with is then just like the union of all potential statements in that combined set of arguments that could be called for every function that could be called to resolve gaps.

Coherent stable tools would also be shown, but the point is that I guess the LLM is not going to be calling global functions at any point. It's going to be calling functions that are only dereferenceable within that local scope to something that is like versioned and persistent via some mapping which we create when we do the hoist.

---

The tools available to the LLM are not a fixed global registry. They are generated from the process's current state at prompt-render time. Gaps become fill-tools, capabilities become compute-tools, compressed sections become expand-tools. The tool set changes every turn as the state evolves: a gap that exists in turn 1 may not exist in turn 2 (it was filled), and new gaps may appear.

The LLM never calls global functions. Every tool call is resolved against the scoped tool set generated for the current turn. Tool schemas are derived from the gap's type constraints -- if a gap expects a number between 100 and 8000, the fill-tool's input schema enforces that range. The LLM sees the exact valid input range as part of the tool definition.

## The Tool Types

Tools come in three categories, all presented uniformly to the LLM. A gap-fill tool fills a gap with a value. A capability tool invokes a persistent registered capability. An expansion tool expands a compressed section of the prompt.

```ft
GapFillTool = {
  name: string,
  targetPath: string,
  inputSchema: string,
  constraints: string
}

CapabilityTool = {
  name: string,
  inputSchema: string,
  persistent: true
}

ExpansionTool = {
  name: string,
  validTokens: string
}
```

Gap-fill tools have a target path (where the value goes) and an input schema derived from the gap's type constraints. Capability tools are persistent -- they appear in every turn. Expansion tools accept only the valid tokens from the current render.

## Scoped Tool Set

The complete tool set for a turn is the union of all three categories, scoped to the current state. Tools from previous turns are not valid.

```ft
TurnToolSet = {
  gapFills: ref(GapFillTool),
  capabilities: ref(CapabilityTool),
  expansion: ref(ExpansionTool),
  turnFrame: number.integer >= 0
}
```

The turnFrame identifies which render this tool set belongs to. A tool call referencing a name not in the current turn's tool set is rejected.

## Tool Generation from Gaps

Each unfilled gap produces a gap-fill tool. The tool's input schema matches the gap's type constraints.

```ft
-- Example: 3 gaps produce 3 gap-fill tools
-- gap at config.model (string /^(gpt-4|claude)$/) -> fill_config_model with constrained string input
-- gap at config.maxTokens (number 100..8000) -> fill_config_maxTokens with range-constrained number input
-- gap at tasks.t1.output (string) -> fill_tasks_t1_output with string input
```

When a gap is filled, its corresponding tool disappears from the next turn's tool set. Gap-fill tools are projections of the current state, not static registrations.

## Tool Call Mapping

Each tool call maps to one or more structured state updates. A gap-fill call produces a value binding at the gap's path. A capability call executes and stores the result. An expansion call returns content.

```ft
ToolCallResult = {
  toolName: string,
  updates: ref(StateUpdate)
}

StateUpdate = {
  path: string,
  value: string
}
```

The LLM's response is the union of all potential statements across all called tools. Each tool call decomposes into specific state updates.

```ft
cap TurnToolSet.gapFills
cap TurnToolSet.capabilities
cap TurnToolSet.expansion
```

## No Global Registry

All tools are derived from state. The LLM calls functions that are only dereferenceable within the local scope of the current turn. A global tool registry would create stale reference risks -- a tool from a previous turn may refer to state that no longer exists.

```ft
-- Tool call validation:
-- 1. Check toolName exists in current TurnToolSet
-- 2. Validate input against tool's inputSchema
-- 3. If both pass, map call to state updates
-- 4. If toolName not found, reject: "tool not found in current scope"
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Gap-fill tools generated from gaps with constrained schemas | `GapFillTool` with `inputSchema` and `constraints` derived from gap type |
| Capability tools persist across turns | `CapabilityTool` with `persistent: true` |
| Expansion tools scoped to valid tokens | `ExpansionTool` with `validTokens` from current render |
| Tool set changes per turn | `TurnToolSet.turnFrame` -- filled gaps remove tools |
| No global function calls | Tool calls validated against current `TurnToolSet` only |
| Tool calls map to state updates | `ToolCallResult` contains `StateUpdate` entries |
| Unified tool interface | All three categories presented as callable tools to LLM |
| Invalid tool calls rejected | Validation rejects names not in current scope |
