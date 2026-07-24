# LLM Provider Interface

## Original Notes

General interfaces which we would be using to contrast and compare different LLM implementations when there's a sort of dual feedback model. Constraints on the per-token LLM policies that the user has enforce a potential for us to consider potentially downgrading the model in order to obtain a larger token window. That token window is then filled out to compare to other alternatives.
We would only be able to run this type of process if all of our LLMs conform to a standard interface that we could use. When figuring out how to satisfy some gap on the back-inference model, we would attach that LLM's prompt as the next back-inference of the host. In order to do all of that, we would have to have a general LLM interface that, when a particular tool installation satisfies it, we know that that tool is an instance of an LLM. Whether or not it's something that's implemented on host, remotely implemented, or uses the actual canonical host like ChatGPT or Claude endpoints, it would also have normalized methods for calculating:
- token cost
- token limit per call
- trailing token
- token rolling window constraints
- call constraints
- et cetera
that we would use to have a standardized rail-based constraint structure that would enable us to pick

---

Different LLM providers have radically different cost, speed, and capacity profiles. The system needs to choose between them automatically based on a task's requirements -- prompt size, budget, time constraint. This requires every LLM to expose the same structural interface AND that cost, latency, and capacity be computable from input parameters BEFORE the call is made. A model that costs $15/M output tokens vs. one that runs free locally -- this difference must be visible before any call happens.

The core insight: an LLM provider is not a special entity. It is any installed tool whose type structurally matches the LLM interface. If it has the right input/output shape, it IS an LLM. No registry, no hardcoded list. Structural type matching is the discovery mechanism.

## The LLM Type

Every LLM provider must satisfy this structural contract. The input takes a prompt with optional parameters. The output returns text with token usage metadata:

```ft
LLM = {
  complete: (prompt: string, systemPrompt?: string, maxOutputTokens?: number >= 0, temperature?: number) -> { text: string, inputTokens: number >= 0, outputTokens: number >= 0, model: string }
}
```

This is the uniform interface. Claude, GPT-4, a local Llama instance, a custom fine-tuned model behind a REST endpoint -- all must return `{ text, inputTokens, outputTokens, model }`. Anything that structurally matches this type is recognized as an LLM provider and included in model selection automatically.

## Cost Model

Each provider declares its cost as a function of token counts. Cost is computable before the call -- given estimated input and output token counts, the system can compute estimated monetary cost without making any API call:

```ft
CostModel = {
  inputCostPerMillion: number >= 0,
  outputCostPerMillion: number >= 0
}
```

The cost formula is: `cost = inputTokens * inputCostPerMillion / 1e6 + outputTokens * outputCostPerMillion / 1e6`. This is a behavioral identity on the provider -- given token counts, cost is deterministic. A provider with `inputCostPerMillion = 3.0` and `outputCostPerMillion = 15.0` has a computed cost of $0.0105 for a 1000-input, 500-output call.

## Token Limit

Each provider declares its maximum context window. A prompt that exceeds this limit eliminates the provider from selection before any call is attempted:

```ft
TokenLimit = {
  maxTokens: number >= 0
}
```

The constraint is: `inputTokens + outputTokens <= maxTokens`. A provider with `maxTokens = 128000` is excluded for any task whose prompt exceeds 128K tokens. This is checked at selection time, not at call time.

## Latency Model

Providers optionally declare their per-token latency so the system can estimate response time. A local model at 80ms/token is fine for 100 tokens but unacceptable for 10,000:

```ft
LatencyModel = {
  msPerToken: number >= 0
}
```

The estimated duration is `maxOutputTokens * msPerToken`. If a task requires completion within 10 seconds and the estimated time exceeds that, the provider is excluded. The estimate uses `maxOutputTokens` (from the input), not `outputTokens` (from the output) -- you cannot reference the output before making the call.

## Concrete Providers

Concrete providers compose the structural interface with their specific cost, capacity, and latency parameters:

```ft
claude = LLM
claude << { inputCostPerMillion: 3.0, outputCostPerMillion: 15.0 }
claude << { maxTokens: 200000 }
claude << { msPerToken: 20 }

gpt4 = LLM
gpt4 << { inputCostPerMillion: 2.5, outputCostPerMillion: 10.0 }
gpt4 << { maxTokens: 128000 }
gpt4 << { msPerToken: 15 }

localLlama = LLM
localLlama << { inputCostPerMillion: 0, outputCostPerMillion: 0 }
localLlama << { maxTokens: 32000 }
localLlama << { msPerToken: 80 }
```

All three are registered simultaneously. The system sees three providers with different profiles and can evaluate constraints against each.

## Automatic Selection

Given a task with constraints (prompt size, budget, time limit), the system evaluates all registered providers and selects the one that satisfies all constraints. This is not a separate selection algorithm -- it is constraint satisfaction over the composed types.

For a task with a 50K-token prompt, $0.01 budget, and 5-second time limit with an estimated 500 output tokens:
- **localLlama**: cost = $0 (within budget), time = 500 * 80ms = 40s (exceeds 5s -- excluded)
- **gpt4**: cost = ~$0.13 (exceeds $0.01 budget -- excluded)
- **claude**: cost = ~$0.16 (exceeds $0.01 budget -- excluded)

If no provider satisfies all constraints, the system surfaces this as an unresolvable gap -- the user must relax a constraint (increase budget, extend time limit, reduce prompt).

## Usage Tracking

After each call, actual token counts are recorded alongside the pre-call estimate. This enables estimate refinement over time:

```ft
UsageRecord = {
  estimatedCost: number >= 0,
  actualCost: number >= 0,
  inputTokens: number >= 0,
  outputTokens: number >= 0,
  model: string
}
```

The behavioral identity is: after a call completes, a usage record exists with both estimated and actual values. The difference between estimated and actual cost is observable, enabling the system to improve its estimates.

The estimate-vs-actual comparison is enforced through predicate observation on the cost model. After each call, the Sequence checks whether the actual cost matches the pre-call estimate within a tolerance. When estimates are accurate, the cost model's reliability prior alpha increments, strengthening confidence in that provider's cost predictions. When estimates are significantly off -- because the model generated far more tokens than expected, or pricing changed -- beta increments, degrading confidence. The posterior predictive `P(next estimate accurate) = alpha / (alpha + beta)` directly affects provider selection ranking: a provider with an unreliable cost model is deprioritized even if its nominal cost is lower, because budget feasibility cannot be confidently computed.

## Capabilities and Backward Inference

The complete operation is registered as a capability. When backward inference identifies a need for generated text, it discovers available LLM providers through structural matching:

```ft
cap claude.complete
cap gpt4.complete
cap localLlama.complete
```

When a gap requires `{ text: string }`, the system finds all capabilities whose output type includes `text: string`. Each matching provider is evaluated against the task's constraints. The within-budget, within-capacity, within-time provider is selected automatically.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Uniform input/output across providers | `LLM` type definition with complete signature |
| Pre-call cost estimation | `CostModel` fields + cost formula in prose |
| Token limit exclusion | `TokenLimit.maxTokens` field, constraint check in prose |
| Latency-based exclusion | `LatencyModel.msPerToken` field, time estimate in prose |
| Automatic model selection | Constraint satisfaction over composed provider types |
| Concurrent provider registration | Three providers instantiated and registered simultaneously |
| Post-call usage tracking | `UsageRecord` type with estimated and actual fields |
| Backward inference discovers providers | `cap` registrations + structural matching on output type |
| Structural recognition of custom tools | Any tool matching `LLM` type is included in selection |
