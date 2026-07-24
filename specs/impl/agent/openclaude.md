# Open Claude Agent

An Open Claude agent wraps the Claude API as a first-class agent with typed tool use, conversation state management, and context projection. The API is stateless -- every call requires the full conversation context. But the agent accumulates state over time (history, tool results, task progress). The system bridges this gap: maintaining rich state locally while projecting the right slice into each API call.

The tension: too much context wastes tokens and hits limits; too little makes the agent forget. Context management is the core problem.

## API Configuration

The connection is configured with model selection, API key, and token limit. Configuration is validated before any API call:

```ft
ClaudeAPIConfig = {
  model: string,
  apiKey: string,
  maxTokens: number >= 0,
  validated: boolean
}
```

```ft
ClaudeAPIConfig << { validated: false }
-- missing apiKey surfaces as structured error before any LLM call
```

A missing or invalid API key produces an explicit error at configuration time, not mid-execution.

## Tool Declarations

Tools are presented to the API as typed function declarations with input schemas, output schemas, and descriptions:

```ft
ToolDeclaration = {
  name: string,
  description: string,
  inputSchema: string,
  outputSchema: string,
  source: string
}
```

```ft
tool ToolDeclaration.name
```

Tools from different sources combine without conflict. The agent is composable -- install a search tool for research tasks, a code tool for programming tasks.

## Local Conversation State

The full conversation state is maintained locally, independent of the API:

```ft
ConversationState = {
  messageCount: number >= 0,
  turnCount: number >= 0,
  lastRole: "user" | "assistant",
  intactAfterFailure: boolean
}
```

After an API failure, the conversation state is intact and the call can be retried without data loss. The API is stateless, but the system is not.

## Context Projection

Each API call includes a context projection derived from the current agent state:

```ft
ContextProjection = {
  systemPrompt: string,
  conversationSlice: string,
  availableTools: number >= 0,
  withinTokenLimit: boolean
}
```

The system prompt, relevant history, available tools, and current obligations are all projected. The projection is derived from actual state, not hardcoded.

## Context Compaction

Conversation context size is managed to stay within token limits:

```ft
ContextCompaction = {
  maxTokens: number >= 0,
  currentTokens: number >= 0,
  compactedTurns: number >= 0,
  strategy: string
}
```

A conversation with 100+ turns still produces valid API calls within the configured limit. Older turns are compressed or archived, but the most recent and relevant turns are preserved.

## Tool Execution Loop

Tool invocations from the API response are executed locally. Results are fed back to the agent's state for subsequent calls:

```ft
ToolResult = {
  toolName: string,
  input: string,
  output: string,
  executedAt: number
}
```

When the API response includes a tool call, the tool is executed and the result appears in the next API call's context. This loop is automatic: API requests tool call, system executes, system sends result back, API continues.

## Output Obligation

The agent has a structured completion condition:

```ft
OutputObligation = {
  schema: string,
  fulfilled: boolean,
  value: string
}
```

The obligation defines what the agent is working toward. "Obligation met" means the agent (or the turn) is done. The status is inspectable at any time.

## What This Validates

| AC | Expressed by |
|----|-------------|
| API config with validation | `ClaudeAPIConfig.validated` checked before calls |
| Missing key surfaces as error | Config with missing apiKey errors before LLM call |
| Typed tool declarations | `ToolDeclaration` with schemas and description |
| State survives API failures | `ConversationState.intactAfterFailure` |
| Context projection from state | `ContextProjection` derived per call |
| Context managed within limits | `ContextCompaction` keeps tokens bounded |
| Tool results fed back | `ToolResult` appears in next API call |
| Obligation tracking | `OutputObligation` with fulfilled/unfulfilled |
| Multi-source tool composition | `ToolDeclaration.source` from different sources |
