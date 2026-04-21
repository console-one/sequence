# Remote Chat Agent

A remote chat agent runs on a server while the user interacts from a local client over a network connection. Conversation state lives remotely, but the experience must feel local. Network latency, disconnections, and message ordering all threaten the illusion of a seamless conversation. The system handles the inherent unreliability of network communication without losing messages or corrupting state.

The server is the single source of truth for conversation state. The client holds a projection. Messages sent during disconnection queue locally and deliver on reconnection.

---

## Problem Context

- **Actor(s)**: A user on a local client, a chat agent running on a remote server, and the network connection between them.
- **Domain**: Conversational AI over an unreliable network, where server-side state is authoritative but the client experience must feel local and responsive.
- **Core Tension**: The server is the single source of truth for conversation state, but the network is unreliable. Messages can be lost, reordered, or delayed. The system must preserve message ordering, handle disconnections gracefully (no silent message loss), and allow the client to reconnect and resume without data loss.

## Requirements

**R1**: Each chat session SHALL be uniquely identified and bound to an authenticated user.
- *Rationale*: Session identity is the handle for reconnection, message routing, and access control. Without it, the client cannot resume after disconnection.
- *Verifiable by*: A session is created with a unique ID and associated user ID. The same session ID is used for reconnection.

**R2**: User messages SHALL be delivered and displayed in send order. Agent responses SHALL appear after the message that prompted them.
- *Rationale*: Out-of-order messages make conversation incoherent. Causal ordering (response follows prompt) is essential for a conversational interface.
- *Verifiable by*: Messages sent in order A, B, C appear in the conversation in that order. Each response follows the message that prompted it.

**R3**: The server SHALL maintain the full, authoritative conversation history for the session duration.
- *Rationale*: The server is the single source of truth. The client can reconnect and retrieve the current state at any time.
- *Verifiable by*: After 10 exchanges, all 10 are retrievable from the server in chronological order. A reconnecting client receives the full history.

**R4**: Messages sent by the client during a disconnection SHALL be queued locally and delivered in order when the connection is restored.
- *Rationale*: Silent message loss during disconnection erodes user trust. The user should be able to type during a brief outage and have their messages delivered when connectivity returns.
- *Verifiable by*: A message sent while disconnected is stored locally. After reconnection, it is delivered and appears in the correct position in the server's conversation history.

**R5**: Message delivery SHALL be at-least-once with server-side deduplication.
- *Rationale*: Retrying until acknowledged prevents message loss, but retries can cause duplicates. Server-side deduplication ensures each message appears exactly once.
- *Verifiable by*: A message is retried twice due to network issues. The server accepts it once and the conversation contains a single copy.

**R6**: When the agent uses server-side tools during response generation, the tool invocations and results SHALL be visible in the conversation record.
- *Rationale*: Transparent tool use builds user trust and enables debugging. Hidden tool calls make agent behavior opaque.
- *Verifiable by*: The agent uses a tool. The conversation record includes both the tool invocation and its result.

**R7**: Server-side context management SHALL prevent unbounded conversation growth while maintaining response quality.
- *Rationale*: Long conversations must remain usable without requiring the user to manage token budgets. The system must handle context limits transparently.
- *Verifiable by*: A conversation with 100+ exchanges still produces quality responses. Context stays within configured limits.

**R8**: Multiple chat sessions for the same user SHALL operate independently.
- *Rationale*: Users may have multiple conversations for different purposes. Cross-contamination between sessions would be confusing and potentially leak sensitive context.
- *Verifiable by*: Two sessions are created for the same user. Messages sent to one do not appear in the other. Each has its own history.

## Acceptance Criteria

**AC1** [R1]: Given an authenticated user, when a new session is created, then it has a unique session ID and is associated with the user.

**AC2** [R2]: Given messages sent in order A, B, C, when the conversation is viewed, then they appear in order A, B, C with responses following their respective prompts.

**AC3** [R3]: Given a session with 10 exchanges, when the history is queried from the server, then all 10 exchanges are returned in chronological order.

**AC4** [R3]: Given a disconnected client, when it reconnects and requests the current state, then the full server-side history is retrievable.

**AC5** [R4]: Given a client that sends a message while disconnected, when the connection is restored, then the message is delivered and appears in the correct position in the conversation.

**AC6** [R5]: Given a message retried twice due to network failure, when the server processes it, then the conversation contains exactly one copy.

**AC7** [R6]: Given an agent that uses a tool during response generation, when the conversation is viewed, then the tool invocation and result are visible.

**AC8** [R7]: Given a conversation with 100+ exchanges, when a new prompt is sent, then the response is generated within token limits and maintains quality.

**AC9** [R8]: Given two sessions for the same user, when a message is sent to one session, then the other session's history is unaffected.

## FT System Demands

- The type system must support expressing server-authoritative state with client-side projections.
- The kernel must handle message ordering guarantees (sequence numbers, causal ordering) across an unreliable transport.

## Open Questions

- What is the maximum offline queue depth on the client before messages are rejected?
- How long do sessions persist on the server after the last interaction (session TTL)?
- Should the client show optimistic updates (display sent messages immediately) or wait for server acknowledgment?
