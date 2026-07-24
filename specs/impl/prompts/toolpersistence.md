# Tool Persistence

## Original Notes

The requirements for tool persistence are pretty precise here: every time that we generate a prompt in a frame to show to an LLM, we need to have a stable snapshot of the gaps and the exact frame of gaps that the tool calls. Those two calls were made consequent to, and that's because we're going to be generating unique input sequences for particular tools that we're showing, like something called expand. We would show, having a unique input type for every single compressed thing in that prompt that could be expanded. We're just going to give each symbol that we have, something compressed that could be expanded, a unique letter, and then say, "Okay, here's the expand tool. Call it with all the unique letters you saw when we showed you the prompt you see in this prompt within these delimiters." The next time that you get this narrative, those will be expanded, but also here's the cost of doing those expansions, and then somehow show how the pipeline that's being used in compressed, relevant to the display that it has, was determined. If possible, how the gaps that it's filling flow back via the backwards inference into something that is ultimately going to result in a loop where it is going to get called again? If we could show that, that would be f***ing amazing, and we could show it over time and show that the deadlines, the various task deadlines of work that's on in a shared context, that would be just so insanely sick. Then show, for all of the inputs of tools that it could call, like we're pulling data or function references, which would be relevant to making the determinations of what concrete values to input into those tools. Like, it makes such perfect f***ing sense.

---

Every prompt generation produces a durable frame snapshot. The snapshot captures the exact mapping between expansion tokens and state paths, the gap surface, the tool definitions, and the expansion cost estimates -- all frozen at the moment the prompt was generated. Tool calls from the LLM are validated against this snapshot, not against the current state, because there is a timing gap between prompt generation and response processing during which the state may have changed.

The hard part is making the snapshot useful beyond validation. The snapshot should show the LLM (and the user) what each gap-fill unblocks downstream (backward inference flow), what the expansion cost is for each compressed section, what data sources are relevant to each tool's inputs, and how the gap surface has evolved across frames. This turns a snapshot from a passive record into an active reasoning aid.

## The Frame Snapshot

A frame snapshot captures the complete tool context at prompt-generation time. It is immutable once created.

```ft
FrameSnapshot = {
  frame: number.integer >= 0,
  tokenMap: ref(TokenMapping),
  gaps: ref(GapRecord),
  tools: ref(ToolDef),
  timestamp: number
}

TokenMapping = {
  token: string,
  path: string,
  estimatedCost: number.integer >= 0
}

GapRecord = {
  path: string,
  expectedType: string,
  concreteness: number 0..100,
  unblocks: string
}

ToolDef = {
  name: string,
  inputSchema: string,
  relevantSources: string
}
```

The token map links expansion tokens to state paths with cost estimates. Each gap record includes its concreteness level and what downstream computations it would unblock when filled. Each tool definition includes references to data sources relevant to its inputs.

## Snapshot-Scoped Validation

Tool calls are validated against the snapshot they were generated from. The LLM is responding to a specific prompt; if the state has changed since that prompt, the LLM's token references may be stale.

```ft
-- Validation rules:
-- 1. Look up tool call's frame number
-- 2. Retrieve FrameSnapshot for that frame
-- 3. Validate token references against snapshot's tokenMap
-- 4. If token maps to a path that no longer exists, return stale token error
-- 5. If valid, resolve using snapshot's recorded state
```

A stale token (one whose underlying path no longer exists or has changed) produces an explicit error rather than silently returning incorrect data.

## Expansion Cost Estimates

Each expansion token carries an estimated cost in tokens. The LLM uses this to make budget-aware expansion decisions -- expanding a 50-token section is cheap, expanding a 1200-token section is expensive.

```ft
-- Each compressed reference in the prompt shows:
-- token identifier (e.g., "A", "B", "C")
-- estimated cost (e.g., "~300 tokens", "~1200 tokens")
-- type signature of what expansion reveals
```

Cost estimates must have a clear unit and consistent methodology so the LLM can compare them meaningfully.

## Backward Inference Flow

Gap-fill tools show what downstream computations they unblock. This is the backward inference flow -- when a gap is filled, what becomes computable?

```ft
-- Example: filling tasks.t1.output unblocks:
--   tasks.t2.input (depends on t1.output)
--   report.summary (depends on t1.output)
-- The gap-fill tool's description includes "Unblocks: tasks.t2.input, report.summary"
```

This helps the LLM prioritize which gaps to fill first. A gap that unblocks many downstream computations is more valuable to fill than one that unblocks nothing.

## Gap Evolution Across Frames

Frame snapshots are persisted as part of the process state, queryable by frame number. This enables tracking how the gap surface evolved -- which gaps appeared, which closed, which persisted.

```ft
GapEvolution = {
  frames: ref(FrameSnapshot),
  appeared: string,
  closed: string,
  persisted: string
}
```

Gap evolution across frames makes convergence (or lack thereof) visible. A gap that persists across many frames is stuck. A gap surface that is shrinking indicates progress.

```ft
cap FrameSnapshot.tokenMap
cap FrameSnapshot.gaps
cap FrameSnapshot.tools
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Durable frame snapshot on prompt generation | `FrameSnapshot` with `tokenMap`, `gaps`, `tools`, `timestamp` |
| Token-to-path mapping with costs | `TokenMapping` with `token`, `path`, `estimatedCost` |
| Snapshot-scoped validation | Tool calls validated against originating frame's snapshot |
| Stale token detection | Error when token's path no longer exists |
| Per-token expansion costs | `TokenMapping.estimatedCost` shown in prompt |
| Backward inference flow per gap | `GapRecord.unblocks` lists downstream dependencies |
| Concreteness per gap | `GapRecord.concreteness` percentage |
| Historical frame query | `GapEvolution.frames` -- all snapshots queryable by frame |
| Relevant data sources per tool | `ToolDef.relevantSources` references informing inputs |
