# Remote Chat Agent

A remote chat agent runs on a server while the user interacts from a local client over a network connection. Conversation state lives remotely, but the experience must feel local. Network latency, disconnections, and message ordering all threaten the illusion of a seamless conversation. The system handles the inherent unreliability of network communication without losing messages or corrupting state.

The server is the single source of truth for conversation state. The client holds a projection. Messages sent during disconnection queue locally and deliver on reconnection.

## Session Identity

Each chat session is uniquely identified and bound to an authenticated user:

```ft
ChatSession = {
  sessionId: string,
  userId: string,
  createdAt: number,
  status: "active" | "disconnected" | "closed"
}
```

The session ID is the handle by which both client and server refer to the conversation. Without it, reconnection and message routing are impossible.

## Message Ordering

User messages are delivered and appear in send order. Agent responses appear after the message that prompted them:

```ft
ChatMessage = {
  messageId: string,
  role: "user" | "agent",
  content: string,
  timestamp: number,
  sequenceNumber: number >= 0
}
```

Messages sent in order A, B, C appear in the conversation in that order. A response follows its prompt. The `sequenceNumber` ensures ordering survives network reordering.

## Server-Side Conversation State

The full conversation history is maintained on the server for the session duration:

```ft
ConversationHistory = {
  sessionId: string,
  messageCount: number >= 0,
  authoritative: boolean
}
```

```ft
ConversationHistory << { authoritative: true }
-- server is single source of truth
```

After 10 exchanges, all 10 are retrievable from the server in chronological order. The client can retrieve the current state at any time for reconnection or UI refresh.

## Client-Side Offline Queue

Messages sent during disconnection are queued locally and delivered in order when the connection is restored:

```ft
ClientQueue = {
  pendingMessages: number >= 0,
  oldestPending: number,
  deliveryOrder: "preserved"
}
```

A message sent while disconnected is stored locally, delivered after reconnection, and appears in the correct position in the conversation. Messages are retried until acknowledged, with deduplication on the server.

## Server-Side Tool Use

The agent can use server-side capabilities during response generation. Tool invocations and results are visible in the conversation:

```ft
ServerTool = {
  toolName: string,
  invocation: string,
  result: string,
  visibleInConversation: boolean
}
```

```ft
ServerTool << { visibleInConversation: true }
```

When the agent uses a tool, the invocation and result are part of the conversation record. Tool use is transparent, not hidden.

## Context Management

Server-side context management prevents unbounded growth:

```ft
RemoteContextManager = {
  maxTokens: number >= 0,
  currentTokens: number >= 0,
  managedAutomatically: boolean
}
```

A conversation with 100+ exchanges still produces quality responses. The system manages context size transparently -- the user does not need to understand token limits.

## Multiple Concurrent Sessions

Multiple chat sessions for the same user operate independently:

```ft
session1 = ChatSession
session1 << { sessionId: "s001", userId: "user-42" }

session2 = ChatSession
session2 << { sessionId: "s002", userId: "user-42" }
```

Messages sent to session1 do not appear in session2. Each session has its own conversation history and context.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Session created with unique ID and user | `ChatSession` with sessionId and userId |
| Messages in send order | `ChatMessage.sequenceNumber` preserves order |
| Responses follow their prompts | Role alternation with sequential numbering |
| Full history on server | `ConversationHistory.authoritative = true` |
| Reconnection retrieves state | Client queries server for current history |
| Offline messages queued and delivered | `ClientQueue` with preserved delivery order |
| Tool use visible in conversation | `ServerTool.visibleInConversation = true` |
| Context managed within limits | `RemoteContextManager.managedAutomatically` |
| Multiple sessions independent | Separate session instances with own state |
