# Claude Code Agent

## Original Notes

Can it be like a standard set of ways if you're on a particular environment that can connect to a Claude Code instance, whether local or remote, like different configurations to interact with its shell, boot it up, ask it what it's doing, and get feedback from it, just within this sort of kernel as another user.

---

## Problem Context

- **Actor(s)**: Users, other system processes, and Claude Code instances (local or remote).
- **Domain**: Integrating an external LLM-powered CLI tool as a peer participant in a multi-process system, with uniform interaction semantics regardless of deployment topology.
- **Core Tension**: Claude Code is an external process with its own lifecycle, state, and failure modes. The connection is inherently unreliable (process death, network failure, timeout), but the interaction model must be uniform across local and remote modes, and messages must never be silently dropped.

## Requirements

**R1**: The system SHALL support establishing connections to Claude Code instances in both local and remote modes.
- *Rationale*: Users need to interact with Claude Code running on the same machine (local) or on a different host (remote) through a single consistent interface.
- *Verifiable by*: A local connection is successfully established given a working directory and model; a remote connection is successfully established given a network endpoint.

**R2**: Connection configuration SHALL be inspectable by any authorized process at any time.
- *Rationale*: Other processes and users need to discover how an agent is configured (mode, endpoint, model, working directory) to route work and diagnose issues.
- *Verifiable by*: A process queries a connection's configuration and receives its current mode, endpoint, model, and working directory.

**R3**: Connection status SHALL automatically reflect the actual state of the underlying Claude Code process.
- *Rationale*: Manual status management is error-prone. If the process dies, the system must detect this and update status without human intervention.
- *Verifiable by*: When the underlying process terminates, the connection status transitions to "disconnected" without any manual action. When the process is restored, status transitions back to "connected."

**R4**: Sending a prompt to a connected Claude Code instance SHALL produce a structured response containing at minimum the text output, tool calls made, and a timestamp.
- *Rationale*: Structured responses enable programmatic consumption by other system components, not just human reading.
- *Verifiable by*: A prompt is sent and a response is received containing text content, a tool call count, and a timestamp.

**R5**: An ordered history of all interactions within a session SHALL be maintained and retrievable.
- *Rationale*: Conversational context and auditability require that prior exchanges are accessible in chronological order.
- *Verifiable by*: After N interactions, querying the session history returns all N interactions in chronological order.

**R6**: Messages sent to a disconnected Claude Code instance SHALL NOT be silently dropped.
- *Rationale*: Silent message loss is unacceptable in a system where processes depend on agent responses. Pending messages must be visible and recoverable.
- *Verifiable by*: A message sent while disconnected is queued. On reconnection, the message is either delivered to the agent or explicitly surfaced to the sender for decision.

**R7**: Multiple simultaneous connections to different Claude Code instances SHALL operate independently.
- *Rationale*: Users and processes may need to interact with multiple agents concurrently (e.g., one per project).
- *Verifiable by*: Two connections are established with different configurations. Sending a prompt to one does not affect the other's state or history.

**R8**: The Claude Code agent SHALL be addressable by other system processes, not only by the user.
- *Rationale*: For the agent to be a peer participant in a multi-process system, automated workflows must be able to send prompts and receive responses through the same interface a user would.
- *Verifiable by*: A non-user process sends a prompt to the agent and receives a structured response.

## Acceptance Criteria

**AC1** [R1]: Given valid local configuration (working directory, model), when a local connection is requested, then the connection is established and reports mode "local."

**AC2** [R1]: Given valid remote configuration (endpoint URL), when a remote connection is requested, then the connection is established and reports mode "remote."

**AC3** [R2]: Given an established connection, when any authorized process queries its configuration, then the current mode, endpoint, model, and working directory are returned.

**AC4** [R3]: Given an established connection with status "connected," when the underlying Claude Code process terminates, then the connection status transitions to "disconnected" without manual intervention.

**AC5** [R3]: Given a disconnected connection, when the underlying Claude Code process is restored and detected, then the connection status transitions back to "connected."

**AC6** [R4]: Given a connected instance, when a prompt is sent, then a structured response is returned containing text output, tool call count, and timestamp.

**AC7** [R5]: Given a session with 10 completed interactions, when the history is queried, then all 10 interactions are returned in chronological order.

**AC8** [R6]: Given a disconnected instance, when a message is sent, then the message is queued as pending. On reconnection, the message is either delivered or surfaced to the sender.

**AC9** [R7]: Given two independent connections, when a prompt is sent to one, then the other's state and history are unaffected.

**AC10** [R8]: Given an addressable agent, when a non-user process sends a prompt, then a structured response is returned through the same interface.

## FT System Demands

- The type system must be able to express conditional validity (connection status is "connected" only while the underlying process is alive).
- The kernel must support suspending operations directed at unavailable targets and resuming them when the target becomes available again.
- Agent connections must be representable as first-class typed state that other processes can discover and interact with.

## Open Questions

- What is the liveness detection mechanism for local vs. remote processes (heartbeat interval, PID polling, TCP probe)?
- What is the maximum queue depth for messages pending delivery to a disconnected agent?
- Should there be a TTL on pending messages, after which they are surfaced to the sender regardless of reconnection?
