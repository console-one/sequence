# Open Claude Agent

An Open Claude agent wraps the Claude API as a first-class agent with typed tool use, conversation state management, and context projection. The API is stateless -- every call requires the full conversation context. But the agent accumulates state over time (history, tool results, task progress). The system bridges this gap: maintaining rich state locally while projecting the right slice into each API call.

The tension: too much context wastes tokens and hits limits; too little makes the agent forget. Context management is the core problem.

---

## Problem Context

- **Actor(s)**: The agent (wrapping Claude API), users or processes that submit prompts, and tool providers that supply capabilities.
- **Domain**: Stateful agent built on top of a stateless LLM API, where each API call requires explicit context construction from accumulated local state (conversation history, tool results, task progress).
- **Core Tension**: The Claude API is stateless -- every call requires the full conversation context to be passed in. But the agent accumulates state over time. Too much context wastes tokens and hits limits; too little makes the agent forget. Context management -- deciding what to include in each call -- is the core engineering problem.

## Requirements

**R1**: The agent SHALL validate API configuration (model, API key, token limits) before making any API call.
- *Rationale*: A missing or invalid API key discovered mid-execution wastes work and produces confusing errors. Fail-fast at configuration time.
- *Verifiable by*: An agent configured with a missing API key produces an explicit configuration error before any API call is attempted.

**R2**: Tools SHALL be declared with typed input schemas, output schemas, and descriptions, and presented to the API in its expected format.
- *Rationale*: The Claude API requires tool declarations in a specific format. Typed schemas enable validation and composition of tools from different sources.
- *Verifiable by*: Tools from two different sources are declared and both appear in the API call's tool list without conflict.

**R3**: The full conversation state SHALL be maintained locally, independent of the API, and SHALL survive API call failures.
- *Rationale*: The API is stateless. If local state is lost on an API failure, the entire conversation must be restarted. Local state must be the durable record.
- *Verifiable by*: After an API call failure, the conversation state is intact and the call can be retried without data loss.

**R4**: Each API call SHALL include a context projection derived from the current agent state, containing the system prompt, relevant conversation history, available tools, and current task context.
- *Rationale*: The API sees only what is passed in each call. The projection must be computed from actual state, not hardcoded, so it adapts as state evolves.
- *Verifiable by*: Two consecutive API calls with different agent state produce different context projections reflecting the state change.

**R5**: Conversation context size SHALL be managed to stay within configured token limits, even for long-running conversations.
- *Rationale*: Exceeding token limits causes API errors. Long conversations must be usable without the user understanding or managing token budgets.
- *Verifiable by*: A conversation with 100+ turns still produces valid API calls within the configured token limit.

**R6**: When the API response includes tool calls, the tools SHALL be executed locally and results fed back into the agent's state for subsequent API calls.
- *Rationale*: The tool execution loop (API requests tool -> system executes -> system sends result -> API continues) is the mechanism by which the agent takes actions in the world.
- *Verifiable by*: The API requests a tool call. The tool is executed locally. The result appears in the next API call's context.

**R7**: The agent SHALL have a structured completion condition (output schema or goal) whose fulfillment status is inspectable at any time.
- *Rationale*: Without a completion condition, there is no way to know when the agent is done. Inspectability enables external processes to check progress.
- *Verifiable by*: An agent's completion status is queried and reports either "fulfilled" or "unfulfilled" with the current state of the output.

**R8**: Tools from different sources SHALL be composable without conflict.
- *Rationale*: Different tasks require different tool sets. A research task might need search tools; a coding task might need file and shell tools. The agent must be composable.
- *Verifiable by*: A search tool and a code tool are both installed. The agent can use either within the same conversation.

## Acceptance Criteria

**AC1** [R1]: Given an agent with a missing API key, when initialization is attempted, then a configuration error is raised before any API call.

**AC2** [R1]: Given an agent with valid configuration, when initialization completes, then the agent is ready to accept prompts.

**AC3** [R2]: Given tools from two different sources (e.g., search and code), when both are declared, then both appear in API calls without naming conflicts.

**AC4** [R3]: Given an in-progress conversation, when an API call fails (timeout, rate limit, server error), then the local conversation state is intact and a retry succeeds.

**AC5** [R4]: Given an agent with conversation history and available tools, when an API call is made, then the request includes a system prompt, relevant history, and tool declarations derived from current state.

**AC6** [R5]: Given a conversation with 100+ turns, when an API call is made, then the request stays within the configured token limit.

**AC7** [R6]: Given an API response containing a tool call, when the tool is executed locally, then the result is included in the next API call's context.

**AC8** [R7]: Given an agent working toward a defined goal, when the completion status is queried, then it reports "fulfilled" or "unfulfilled" accurately.

## FT System Demands

- The type system must support expressing tool declarations with typed input and output schemas that can be validated and composed.
- Context projection must be derivable from the current state of the agent, not statically defined.

## Open Questions

- What is the compaction strategy for long conversations (summarize older turns, drop low-relevance turns, sliding window)?
- How are tool name conflicts resolved when composing tools from different sources?
- Should the agent support streaming responses, and if so, how does streaming interact with tool call detection?
