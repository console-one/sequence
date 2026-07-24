# Self-Render Semantics

A process generates its own prompt by reading its own state through the same interface that any external consumer would use. The prompt is not "built" by a separate prompt-construction system -- it is a projection of the process's typed state into text. Different consumers (LLM, UI, scheduler) see the same data in different formats, but the data is identical.

The hard part is attention management. A process has regions (system instructions, tools, state, history, input), each competing for token space in a finite context window. Regions have budgets, and when content exceeds a budget, the excess is compressed into expansion references the LLM can request to expand. Budget composition is monotonic -- refinement can only tighten budgets, never widen them.

## The Prompt Region

A process organizes its state into named regions, each with a purpose, type, budget, lock state, and mutation policy. Regions are the structural units of a prompt.

```ft
PromptRegion = {
  name: string,
  content: string,
  budget: number.integer >= 0,
  locked: boolean,
  mutations: "expand" | "compress"
}
```

A locked region cannot be modified by the LLM or downstream refinement. Mutation policies declare what transformations are permitted -- "expand" means the region can grow (show more detail), "compress" means it can shrink (summarize).

## Self-Rendering

The process reads itself through a standard readable interface -- the same one available to any consumer. The rendered prompt is a projection of all regions, respecting their budgets.

```ft
SelfRender = {
  identity: { id: string, moment: number.integer >= 0 },
  regions: ref(PromptRegion),
  gaps: ref(GapEntry),
  format: "prompt" | "terminal" | "structured"
}

GapEntry = {
  path: string,
  expectedType: string
}
```

The identity is the process's unique ID and current moment (turn number). The regions are references to the process's PromptRegions. The gaps section lists all unresolved obligations. The format determines the output shape (same data, different presentation).

## Budget Enforcement and Compression

When a region's content exceeds its budget, excess content is compressed into expansion references. Each reference is content-addressable -- it maps to a specific path in the process state and carries a type signature showing what expansion would reveal.

```ft
ExpansionRef = {
  token: string,
  path: string,
  typeSignature: string,
  estimatedCost: number.integer >= 0
}
```

The token is a short identifier (like "1.2.1") the LLM can reference. The path points back to the process state. The type signature tells the LLM what it would get by expanding. The estimated cost is the approximate token count of the expanded content.

Budget composition is monotonic: a child region's budget can only be tighter (smaller) than what the parent allocated. Attempting to widen a budget beyond the parent's allocation is rejected.

```ft
-- Budget enforcement: region renders at most `budget` tokens of content
-- Excess is replaced with ExpansionRef entries
-- Budget refinement is monotonic: can only decrease, never increase
```

## Locked Regions

Locked regions appear verbatim in the prompt and cannot be modified. System instructions are the canonical example -- they persist across the entire conversation.

```ft
systemRegion = PromptRegion
systemRegion << { name: "system", locked: true, content: "You are agent-X in moment 11", budget: 500 }
```

The lock indicator is part of the rendered output. No operation -- not the LLM, not downstream refinement -- can change a locked region's content.

## Multi-Format Projection

The same process state renders in different formats for different consumers. The LLM sees a text prompt. The CLI sees terminal output. The UI sees structured data. The underlying data is identical across all formats.

```ft
cap SelfRender.regions
cap SelfRender.gaps
```

Reading the regions and gaps through the same interface, regardless of format, guarantees that no consumer sees different data -- only different presentations of the same data.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Self-reading produces prompt from own state | `SelfRender` reads `regions` and `gaps` through standard interface |
| Named regions with budgets | `PromptRegion` with `name`, `budget`, `content` |
| Budget enforcement with compression | Excess content replaced with `ExpansionRef` entries |
| Expansion refs are content-addressable with type signatures | `ExpansionRef` with `token`, `path`, `typeSignature` |
| Locked regions appear verbatim | `systemRegion` with `locked: true` |
| Mutation policies on regions | `PromptRegion.mutations` declares expand or compress |
| Gaps section lists unresolved obligations | `GapEntry` with `path` and `expectedType` |
| Multi-format projection | `SelfRender.format` -- same data, different presentation |
| Monotonic budget refinement | Budget can only decrease, never increase |
