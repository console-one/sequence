# Claude Code Agent

## Original Notes

Can it be like a standard set of ways if you're on a particular environment that can connect to a Claude Code instance, whether local or remote, like different configurations to interact with its shell, boot it up, ask it what it's doing, and get feedback from it, just within this sort of kernel as another user.

---

A Claude Code agent is an external LLM-powered CLI tool treated as a first-class process within the system. The user connects to it (local or remote), sends prompts, receives structured responses, and reviews interaction history. The key property: it is a peer participant, addressable by other system processes, not just by the user directly.

The tension is that Claude Code is an external process with its own lifecycle, state, and failure modes. The system must represent it honestly -- the connection is inherently unreliable (process death, network failure, timeout) but the interaction model should be uniform. Messages sent to a disconnected agent suspend until reconnection rather than being silently dropped.

## Connection Configuration

A connection is established in one of two modes (local or remote) with declarative, inspectable configuration:

```ft
ClaudeCodeConnection = {
  mode: "local" | "remote",
  workdir: string,
  model: string,
  endpoint: string,
  status: "connected" | "disconnected" | "errored"
}
```

```ft
localConn = ClaudeCodeConnection
localConn << { mode: "local", workdir: "/projects/myapp", model: "opus" }
```

```ft
remoteConn = ClaudeCodeConnection
remoteConn << { mode: "remote", endpoint: "https://remote-host:3000" }
```

Configuration is first-class visible state. Any process can read the current connection parameters at any time.

## Connection Status

Status automatically reflects the actual state of the underlying process. When the process dies, status changes without manual intervention:

```ft
ClaudeCodeConnection << {
  status: "connected" while processAlive EXISTS
}
```

The `while` condition breaks when the underlying process terminates. Status transitions from "connected" to "disconnected" automatically. When the process is restarted and reconnected, status transitions back.

The mechanism for detecting process liveness (heartbeat, PID check, network probe) is a runtime integration detail. The type system expresses the condition, not the detection mechanism.

## Prompt and Response

Sending a prompt produces a structured response with at minimum text output and tool calls made:

```ft
Interaction = {
  prompt: string,
  response: string,
  toolCalls: number >= 0,
  timestamp: number
}
```

```ft
tool ClaudeCodeConnection.prompt
```

The capability accepts a prompt string and returns a structured response. This is a typed function call across a process boundary.

## Interaction History

An ordered history of interactions persists for the session duration:

```ft
SessionHistory = {
  interactions: string,
  count: number >= 0,
  sessionId: string
}
```

After N interactions, all N are retrievable in chronological order. History provides conversational context and enables reviewing prior exchanges.

## Suspension on Disconnect

Operations directed at a disconnected instance do not fail silently. They suspend until reconnection or surface as visible gaps:

```ft
PendingMessage = {
  prompt: string,
  status: "pending" | "delivered" | "surfaced",
  queuedAt: number
}
```

A message sent while disconnected becomes a pending item. On reconnection, it is either delivered or explicitly surfaced to the user for decision. This matches the kernel's gap/suspension model -- a message to an offline agent is a pending obligation, not a dropped message.

## Multiple Connections

Multiple Claude Code connections operate simultaneously as independent sessions:

```ft
conn1 = ClaudeCodeConnection
conn1 << { mode: "local", workdir: "/projects/app1" }

conn2 = ClaudeCodeConnection
conn2 << { mode: "local", workdir: "/projects/app2" }
```

Each connection has independent status, history, and configuration. Sending a prompt to one does not affect the other.

## Inter-Process Addressability

The agent is addressable by other system processes, not just by the user:

```ft
AgentAddress = {
  processId: string,
  addressable: boolean,
  callerType: "user" | "process"
}
```

```ft
tool AgentAddress.prompt when addressable = true
```

A non-user process can send a prompt to the agent and receive a response through the same interface.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Local connection established | `localConn` with mode "local" and workdir |
| Remote connection established | `remoteConn` with mode "remote" and endpoint |
| Configuration inspectable | `ClaudeCodeConnection` with typed fields |
| Structured prompt/response | `Interaction` with response and toolCalls |
| Auto status on process death | `status while processAlive EXISTS` |
| Ordered history | `SessionHistory` with chronological interactions |
| Suspended on disconnect | `PendingMessage` with status "pending" |
| Delivered on reconnect | `PendingMessage.status` transitions to "delivered" |
| Multiple independent connections | Separate `conn1` and `conn2` instances |
| Addressable by other processes | `AgentAddress` with callerType "process" |
