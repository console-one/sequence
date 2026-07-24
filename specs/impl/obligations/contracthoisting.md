# Contract Hoisting

The system knows what it needs (typed obligations) and what can fulfill those needs (capabilities with input/output contracts). The LLM knows none of this unless told. Contract hoisting is the projection of the obligation model into natural language text that an LLM can act on. The prompt expresses commitments -- "if you produce X, I will execute Y" -- not a tool catalog.

The core tension is fidelity vs. budget. Under-specification produces LLM output that misses the contract. Over-specification wastes tokens and confuses the model. The prompt must faithfully represent obligations, capabilities, temporal constraints, and backward requirements, all within a token budget, ordered by priority.

## The Obligation Prompt Type

Each open obligation becomes a prompt segment. Obligations carry priority so the most important work appears first. The prompt itself is a structured projection with a budget constraint:

```ft
ObligationPrompt = {
  path: string,
  requiredType: ref(schemaDescription),
  priority: number 0..1,
  capabilities: ref(matchingCapabilities),
  backwardRequirements: ref(llmProvidedInputs),
  temporalConstraint: ref(expirationInfo)
}

PromptProjection = {
  segments: ref(ObligationPrompt),
  budget: number.integer >= 0,
  truncated: number.integer >= 0
}
```

The `segments` are ordered by priority descending. When the total exceeds `budget`, lower-priority segments are dropped and `truncated` records how many were omitted.

## Commitment Language

The prompt expresses each capability as a contract, not a menu item. This is the difference between "available tools: search" and "if your output provides {query: string}, I will execute search and return results":

```ft
CapabilityCommitment = {
  capabilityName: string,
  requiredInput: ref(inputSchema),
  producesOutput: ref(outputSchema),
  description: string
}
```

Behavioral predicate (prose): the generated text MUST use commitment framing -- "if your output matches [input schema], I will execute [capability]" -- rather than descriptive framing like "here are your available tools." The obligation model is a contract, not a catalog. The LLM should understand that producing conforming output triggers automatic execution.

## Temporal Constraints

Capabilities can expire. The prompt must include these bounds so the LLM can prioritize accordingly:

```ft
CapabilityCommitment << { temporalBound: string when expirationTime EXISTS }
```

When `expirationTime` exists, the prompt segment includes the constraint (e.g., "available until 3:00 PM"). Expired capabilities are excluded entirely -- showing the LLM capabilities it cannot use wastes budget and causes invalid actions.

Behavioral predicate (prose): at prompt generation time, the system checks each capability's temporal constraints against the current time. Expired capabilities are filtered out before rendering. Temporal bounds are rendered in a format appropriate to the LLM (countdown, absolute time, or constraint expression -- this is a policy decision).

## Backward Requirements

Some capabilities need inputs that only the LLM can provide. Backward inference determines these and surfaces them explicitly:

```ft
BackwardRequirement = {
  capabilityName: string,
  requiredFromLLM: ref(inputFields),
  alreadySatisfied: ref(availableFields)
}
```

The prompt renders backward requirements as explicit asks: "to execute [capability], provide [required fields]." This is the write-read relationship between the LLM's output and the capability's input -- behavioral predicate enforcement on observation updates the system's reliability priors for that capability-LLM pairing.

## Priority Ordering and Budget

When there are more obligations than the prompt budget allows, the system truncates from the bottom:

```ft
promptGeneration = (input: { obligations: ref(allOpenObligations), budget: number.integer >= 0 }) -> { prompt: ref(PromptProjection) }
```

Behavioral predicate (prose): obligations are sorted by priority descending. The system renders segments top-down, tracking token count. When the next segment would exceed the budget, rendering stops. The `truncated` count tells downstream consumers how many obligations were omitted. The prompt MUST NOT exceed the LLM's context limit -- budget management happens at generation time, not at the LLM boundary.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Obligations listed by priority | `ObligationPrompt.priority` + sorted `segments` in `PromptProjection` |
| Commitment language, not tool catalog | `CapabilityCommitment` + behavioral predicate on framing |
| Temporal constraints included | `temporalBound` gated on `expirationTime EXISTS` |
| Backward requirements surfaced | `BackwardRequirement` with `requiredFromLLM` |
| Budget-constrained truncation | `promptGeneration` with budget, `truncated` count |
