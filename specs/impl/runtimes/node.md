# Node.js Runtime

Node is the actual execution environment for the kernel. It boots the constraint store, runs agent loops, talks to the filesystem, spawns processes, and serves as the backbone for both the CLI and Electron main process. This is the runtime where performance matters most -- it is in the hot path of every agent turn: compile package, call LLM, execute tool, repeat.

The tension: Node is the most capable JS runtime (filesystem, processes, native modules) but it is still single-threaded. The agent loop is latency-sensitive and must not block the event loop, yet many operations (SQLite writes, file reads, process spawning) are naturally synchronous.

## Native Persistence

The store uses native module support for performance-critical persistence. Pure-JS persistence layers are too slow for agent loop latency requirements:

```ft
NativePersistence = {
  engine: "better-sqlite3",
  batchWriteMs: number,
  transactional: boolean
}
```

Store persistence operations complete within 5ms for typical write batches (10-100 statements). Writes are batched in single transactions for atomicity.

## Filesystem Capabilities

Filesystem read and write operations are exposed as typed state, not ad-hoc side effects:

```ft
FileCapability = {
  path: string,
  operation: "read" | "write" | "watch",
  result: string,
  streaming: boolean
}
```

```ft
cap FileCapability.operation
```

Large file operations use streaming to prevent OOM. Reading a 1GB file does not require 1GB of resident memory -- the runtime processes it in bounded-size chunks.

## Process Spawning

External tools are executed as child processes with structured result capture:

```ft
ToolExecution = {
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  signal: string,
  durationMs: number >= 0
}
```

Every child process produces a structured result with stdout, stderr, exit code, signal, and duration. Commands that never exit must timeout. Commands that produce unbounded output must stream.

## Event Loop Budget

Agent turn operations do not block the event loop beyond a configurable threshold:

```ft
EventLoopBudget = {
  maxBlockMs: number,
  workerThreadsEnabled: boolean,
  currentDelayMs: number >= 0
}
```

```ft
EventLoopBudget << { maxBlockMs: 100 }
```

During an agent turn processing 50 tools, the maximum event loop delay does not exceed 100ms. The event loop also handles IPC (Electron), socket I/O (CLI), and timers -- blocking it stalls everything.

## Concurrent Async I/O

Multiple I/O-bound operations overlap in time without violating the store's sequential consistency:

```ft
AsyncExecution = {
  pendingOps: number >= 0,
  completedOps: number >= 0,
  sequentialConsistency: boolean
}
```

Three parallel async operations (LLM call, file read, HTTP fetch) complete and their results are incorporated into the store in a deterministic order. Total wall time is approximately the max of individual times, not the sum.

## Worker Thread Delegation

CPU-intensive operations (large reductions, constraint composition) can be offloaded to worker threads:

```ft
WorkerThreadPool = {
  threadCount: number >= 0,
  busyCount: number >= 0,
  queueDepth: number >= 0
}
```

While a reduction runs in a worker thread, the main thread remains responsive. Event loop delay stays below 10ms during worker execution.

## Typed Configuration

Environment variables and configuration files are read once at boot and written to the store as typed state:

```ft
BootConfig = {
  source: "env" | "file" | "default",
  loadedAt: number,
  entryCount: number >= 0
}
```

No runtime code reads `process.env` directly after boot. Configuration is inspectable and declarative, not ambient globals scattered through the codebase.

## Process Lifecycle

The runtime handles Node.js process events to ensure store durability on unexpected termination:

```ft
ProcessLifecycle = {
  uncaughtExceptionHandled: boolean,
  unhandledRejectionHandled: boolean,
  signalHandlers: boolean,
  gracefulShutdown: boolean
}
```

An unhandled promise rejection triggers a graceful shutdown that persists the store before exiting.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Native SQLite persistence under 10ms | `NativePersistence` with batch timing |
| Typed filesystem capabilities | `FileCapability` with operation and result |
| Structured process output | `ToolExecution` with stdout, stderr, exit code, duration |
| Event loop not blocked beyond 100ms | `EventLoopBudget.maxBlockMs` |
| Streaming for large I/O | `FileCapability.streaming` prevents OOM |
| Concurrent async without races | `AsyncExecution.sequentialConsistency` |
| Worker threads for CPU-bound work | `WorkerThreadPool` offloads reductions |
| Configuration as typed state | `BootConfig` loaded once at boot |
| Graceful shutdown on errors | `ProcessLifecycle` handles uncaught exceptions |
