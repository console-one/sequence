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

## Problem Context

- **Actor(s)**: Agents that need text generation; multiple LLM providers (cloud APIs, local models, custom endpoints) with different cost/speed/capacity profiles; a selection system that chooses among them.
- **Domain**: LLM provider management -- uniform access to heterogeneous language model backends with automatic selection based on task constraints (budget, latency, context window size).
- **Core Tension**: Providers differ radically in cost ($0/M tokens vs $15/M tokens), speed (15ms/token vs 80ms/token), and capacity (32K vs 200K context). The system must choose the right provider for each task automatically, which requires every provider to expose the same structural interface AND declare its cost, latency, and capacity parameters so constraints can be evaluated BEFORE any API call is made.

## Requirements

**R1**: All LLM providers SHALL expose a uniform completion interface that accepts a prompt (with optional system prompt, max output tokens, and temperature) and returns generated text with token usage metadata (input tokens, output tokens, model identifier).
- *Rationale*: Without a uniform interface, the system cannot swap providers or compare them. Every provider -- cloud, local, custom -- must look the same to the caller.
- *Verifiable by*: Any registered provider accepts `{prompt, systemPrompt?, maxOutputTokens?, temperature?}` and returns `{text, inputTokens, outputTokens, model}`.

**R2**: Each provider SHALL declare its per-token cost (input and output cost per million tokens) so that estimated monetary cost is computable from token counts BEFORE any API call.
- *Rationale*: Budget constraints cannot be enforced if cost is only known after the call completes. Pre-call cost estimation enables budget-based provider exclusion.
- *Verifiable by*: Given a provider with `inputCostPerMillion: 3.0` and `outputCostPerMillion: 15.0`, the estimated cost for 1000 input + 500 output tokens is `1000 * 3.0 / 1e6 + 500 * 15.0 / 1e6 = $0.0105`.

**R3**: Each provider SHALL declare its maximum context window (total token capacity). A task whose prompt exceeds this limit SHALL eliminate the provider from selection BEFORE any call is attempted.
- *Rationale*: Sending a 200K-token prompt to a provider with a 32K context window wastes time and money. Pre-call filtering prevents this.
- *Verifiable by*: A provider with `maxTokens: 32000` is excluded from selection for a task with a 50K-token prompt.

**R4**: Each provider SHOULD declare its per-token latency so the system can estimate response time. A provider whose estimated response time exceeds the task's time constraint SHALL be excluded from selection.
- *Rationale*: A local model at 80ms/token producing 500 tokens takes 40 seconds -- unacceptable for a 5-second deadline. Latency-based filtering prevents selecting providers that cannot meet time constraints.
- *Verifiable by*: A provider with `msPerToken: 80` is excluded for a task requiring 500 output tokens within 5 seconds (estimated time: 40s > 5s).

**R5**: Provider discovery SHALL be structural -- any installed tool whose interface matches the LLM completion signature is automatically recognized as an LLM provider and included in selection. No explicit registry or hardcoded provider list.
- *Rationale*: The user's original notes specify that "when a particular tool installation satisfies it, we know that that tool is an instance of an LLM." Structural matching is the discovery mechanism.
- *Verifiable by*: Installing a custom tool with the correct input/output shape causes it to appear in the provider selection pool without any additional registration step.

**R6**: Given a task with constraints (prompt size, budget, time limit), the system SHALL evaluate all registered providers against those constraints and select one that satisfies all of them. If no provider satisfies all constraints, the system SHALL report which constraints are unsatisfiable.
- *Rationale*: Automatic selection is the core value proposition. The user's original notes describe "a standardized rail-based constraint structure that would enable us to pick."
- *Verifiable by*: For a task with 50K tokens, $0.01 budget, 5-second limit, providers that exceed any constraint are excluded, and the remaining provider (if any) is selected. If none qualify, the system reports which constraints cannot be met.

**R7**: After each completion call, the system SHALL record actual token counts alongside the pre-call estimates, enabling estimate accuracy tracking over time.
- *Rationale*: Pre-call estimates (based on maxOutputTokens) may differ significantly from actual usage. Tracking the gap enables the system to improve its estimates and deprioritize providers with unreliable cost models.
- *Verifiable by*: After a completion call, a usage record exists containing both `estimatedCost` and `actualCost`, and the delta between them is observable.

**R8**: Multiple providers SHALL be registerable simultaneously, and the system SHALL consider all of them during selection.
- *Rationale*: Real deployments have multiple providers available (e.g., Claude, GPT-4, a local model). The selection system must consider all registered options.
- *Verifiable by*: Three providers with different profiles are registered, and each is evaluated during selection for a given task.

**R9**: The system SHOULD support downgrading to a cheaper or higher-capacity model when the preferred model's constraints conflict with the task's requirements.
- *Rationale*: The user's original notes describe "potentially downgrading the model in order to obtain a larger token window." When the preferred model cannot fit the prompt, a lower-tier model with a larger context window should be considered.
- *Verifiable by*: When a task's prompt exceeds the preferred provider's context window but fits a cheaper provider's window, the cheaper provider is selected.

## Acceptance Criteria

**AC1** [R1]: Given three providers (Claude, GPT-4, LocalLlama) all registered, when any of them completes a prompt, then the response contains `{text, inputTokens, outputTokens, model}`.

**AC2** [R2]: Given a provider with `inputCostPerMillion: 3.0, outputCostPerMillion: 15.0`, when estimating cost for 1000 input tokens and 500 output tokens, then the estimated cost is $0.0105.

**AC3** [R3]: Given a provider with `maxTokens: 32000`, when selecting providers for a 50K-token prompt, then this provider is excluded from the candidate set.

**AC4** [R4]: Given a provider with `msPerToken: 80`, when selecting providers for a task requiring 500 output tokens within 5 seconds, then this provider is excluded (estimated 40s > 5s).

**AC5** [R5]: Given a custom tool installed with signature `(prompt: string) -> {text: string, inputTokens: number, outputTokens: number, model: string}`, when the system enumerates LLM providers, then this tool appears as a candidate.

**AC6** [R6]: Given providers Claude ($0.16), GPT-4 ($0.13), LocalLlama ($0, 40s) for a task with $0.01 budget and 5-second limit, when selecting, then all three are excluded and the system reports that no provider satisfies both budget and time constraints simultaneously.

**AC7** [R7]: Given a completion call with estimated cost $0.01 and actual cost $0.008, when querying usage records, then both values are present and the delta ($0.002) is observable.

**AC8** [R9]: Given a 180K-token prompt, when the preferred provider has a 128K context window but a secondary provider has a 200K window, then the secondary provider is selected despite being non-preferred.

## Open Questions

1. **Trailing token / rolling window constraints**: The original notes mention "trailing token" and "token rolling window constraints." Are these per-session token budgets that accumulate across calls? If so, the selection system needs to track cumulative usage, not just per-call estimates.
2. **Dual feedback model**: The original notes reference a "dual feedback model" for comparing implementations. What are the two feedback channels, and how do they interact with provider selection?
3. **Latency estimation accuracy**: Pre-call latency estimates use `maxOutputTokens * msPerToken`, but actual output length is typically much less than the maximum. Should the system use historical average output length for better estimates?
