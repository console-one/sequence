# Contract Hoisting

## Original Notes

The system knows what it needs (typed obligations) and what can fulfill those needs (capabilities with input/output contracts). The LLM knows none of this unless told. Contract hoisting is the projection of the obligation model into natural language text that an LLM can act on. The prompt expresses commitments -- "if you produce X, I will execute Y" -- not a tool catalog.

The core tension is fidelity vs. budget. Under-specification produces LLM output that misses the contract. Over-specification wastes tokens and confuses the model. The prompt must faithfully represent obligations, capabilities, temporal constraints, and backward requirements, all within a token budget, ordered by priority.

## Problem Context

- **Actor(s)**: The system (generating prompts), LLMs (consuming prompts and producing output), capabilities (being described as contracts in the prompt).
- **Domain**: LLM prompt generation where system obligations and capabilities must be communicated as actionable contracts within a token budget.
- **Core Tension**: The prompt must convey enough detail for the LLM to produce conforming output, but not so much that it wastes tokens or confuses the model. Priority ordering and budget-constrained truncation are essential when obligations exceed the available context.

## Requirements

**R1**: Each open obligation SHALL be rendered as a prompt segment containing the path, the required type/schema description, and any matching capabilities.
- *Rationale*: The LLM needs to know what is required, where it goes, and how it can be fulfilled.
- *Verifiable by*: A generated prompt contains segments corresponding to each open obligation with path, type, and capability information.

**R2**: Obligations SHALL be ordered by priority (highest first) in the generated prompt.
- *Rationale*: If the prompt is truncated, the most important obligations must survive.
- *Verifiable by*: The first segment in the prompt corresponds to the highest-priority obligation.

**R3**: Capabilities SHALL be expressed as commitments ("if your output provides X, I will execute Y and return Z"), not as a tool catalog ("available tools: search").
- *Rationale*: Commitment framing tells the LLM that producing conforming output triggers automatic execution, leading to more actionable responses.
- *Verifiable by*: The generated prompt uses if-then commitment language for each capability, not descriptive listing.

**R4**: Temporal constraints on capabilities SHALL be included in the prompt when they exist; expired capabilities SHALL be excluded entirely.
- *Rationale*: Showing the LLM capabilities it cannot use wastes budget and causes invalid actions.
- *Verifiable by*: A capability that has expired does not appear in the prompt; a capability with a future expiration includes its time bound.

**R5**: Backward requirements (inputs that only the LLM can provide) SHALL be surfaced as explicit asks in the prompt.
- *Rationale*: The LLM must know what it specifically needs to produce for capabilities to execute.
- *Verifiable by*: The prompt contains explicit requests for LLM-provided inputs, distinguishing them from already-available inputs.

**R6**: The prompt generation system SHALL enforce a token budget; when total prompt content exceeds the budget, lower-priority segments SHALL be truncated.
- *Rationale*: LLMs have finite context windows; exceeding them causes failure or degraded output.
- *Verifiable by*: The generated prompt does not exceed the specified budget, and a truncation count indicates how many obligations were omitted.

**R7**: The truncation count (number of obligations omitted due to budget) SHALL be reported to downstream consumers.
- *Rationale*: Consumers need to know that the prompt is incomplete so they can take corrective action (e.g., re-prioritize, increase budget).
- *Verifiable by*: After budget-constrained generation, the truncation count is available and accurate.

## Acceptance Criteria

**AC1** [R1, R2]: Given 5 open obligations with different priorities, when the prompt is generated, then all 5 appear as segments ordered by priority descending.

**AC2** [R3]: Given a capability "search" with input {query: string} and output {results: string[]}, when the prompt is generated, then it reads as a commitment (e.g., "if your output provides query, I will execute search and return results") rather than a catalog entry.

**AC3** [R4]: Given two capabilities, one expired and one valid with a future expiration, when the prompt is generated, then the expired one is absent and the valid one includes its time bound.

**AC4** [R5]: Given a capability that requires an LLM-provided "query" input and an already-available "context" input, when the prompt is generated, then "query" is surfaced as an explicit ask and "context" is not.

**AC5** [R6, R7]: Given 10 obligations and a budget that fits only 6, when the prompt is generated, then 6 segments appear (highest priority), the prompt is within budget, and the truncation count reports 4.

## Open Questions

- What format should temporal bounds use in the prompt (countdown, absolute time, or constraint expression)?
- Should there be a minimum number of obligation segments that are always included regardless of budget pressure?
