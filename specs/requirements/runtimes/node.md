# Node.js Runtime

## Original Notes

Node is the actual execution environment for the kernel. It boots the constraint store, runs agent loops, talks to the filesystem, spawns processes, and serves as the backbone for both the CLI and Electron main process. This is the runtime where performance matters most -- it is in the hot path of every agent turn: compile package, call LLM, execute tool, repeat.

The tension: Node is the most capable JS runtime (filesystem, processes, native modules) but it is still single-threaded. The agent loop is latency-sensitive and must not block the event loop, yet many operations (SQLite writes, file reads, process spawning) are naturally synchronous.

## Problem Context

- **Actor(s)**: Agent loop; filesystem; child processes (external tools); LLM endpoints; CLI and Electron main process.
- **Domain**: The primary execution environment where performance-critical agent turns (compile, call LLM, execute tool) run in the hot path.
- **Core Tension**: Node is the most capable JS runtime but still single-threaded. The agent loop is latency-sensitive, yet many operations (database writes, file I/O, process spawning) are naturally blocking.

## Requirements

**R1**: Persistence operations SHALL use native modules (e.g., better-sqlite3) and complete within 5ms for typical write batches of 10-100 statements.
- *Rationale*: The agent loop is latency-sensitive; pure-JS persistence is too slow for the hot path.
- *Verifiable by*: Benchmark a batch of 50 statement writes -- median latency is under 5ms.

**R2**: Persistence writes SHALL be batched in single transactions for atomicity.
- *Rationale*: Partial writes on crash corrupt state; transactional batching ensures all-or-nothing semantics.
- *Verifiable by*: Kill the process mid-batch -- on restart, either all statements in the batch are present or none are.

**R3**: Large file operations SHALL use streaming to bound memory usage.
- *Rationale*: Reading a 1GB file into memory causes OOM; streaming processes data in bounded-size chunks.
- *Verifiable by*: Read a 1GB file -- resident memory stays proportional to the chunk size, not the file size.

**R4**: Every child process execution SHALL produce a structured result containing stdout, stderr, exit code, signal (if any), and duration.
- *Rationale*: External tool results must be fully captured for debugging, logging, and downstream processing.
- *Verifiable by*: Execute a command that writes to stdout and stderr, then exits with code 1 -- all five fields are populated in the result.

**R5**: Child processes that produce unbounded output SHALL stream it rather than buffering it entirely in memory.
- *Rationale*: A tool that produces gigabytes of output must not crash the host process.
- *Verifiable by*: Execute a command producing 1GB of stdout -- the host process memory stays bounded.

**R6**: Child processes that never exit SHALL be terminated after a configurable timeout.
- *Rationale*: Hanging tools must not block the agent loop indefinitely.
- *Verifiable by*: Execute a command that never exits -- it is terminated after the timeout and produces a timeout result.

**R7**: The maximum event loop delay SHALL NOT exceed a configurable threshold (default: 100ms) during agent turn processing.
- *Rationale*: The event loop handles IPC (Electron), socket I/O (CLI), and timers; blocking it stalls everything.
- *Verifiable by*: During an agent turn processing 50 tools, event loop delay measured via `monitorEventLoopDelay` stays under 100ms.

**R8**: Multiple concurrent async I/O operations SHALL overlap in wall-clock time while maintaining sequential consistency of results.
- *Rationale*: An agent turn involves parallel LLM calls, file reads, and HTTP fetches; serializing them wastes time.
- *Verifiable by*: Three parallel async operations (LLM call, file read, HTTP fetch) complete in approximately the time of the slowest, not the sum, and results are incorporated in deterministic order.

**R9**: CPU-intensive operations SHALL be offloadable to worker threads, keeping the main thread event loop delay below 10ms.
- *Rationale*: Large computations block the main thread, stalling IPC and I/O.
- *Verifiable by*: During a CPU-intensive operation running in a worker thread, main thread event loop delay stays under 10ms.

**R10**: Configuration SHALL be loaded once at boot from environment variables or config files and written to the store as typed state. No runtime code SHALL read environment variables directly after boot.
- *Rationale*: Ambient globals (process.env) scattered through the codebase are opaque and hard to debug; typed configuration is inspectable and declarative.
- *Verifiable by*: After boot, `process.env` is not accessed by any application code; all configuration is readable from the store.

**R11**: The runtime SHALL handle process lifecycle events (uncaught exception, unhandled rejection, SIGTERM, SIGINT) and persist state before exiting.
- *Rationale*: Unexpected termination must not cause data loss.
- *Verifiable by*: Trigger an unhandled promise rejection -- the runtime persists state and exits gracefully rather than crashing with data loss.

## Acceptance Criteria

**AC1** [R1, R2]: Given a batch of 50 statement writes, when persisted, then the batch completes in under 5ms and is atomic (all-or-nothing on crash).

**AC2** [R3]: Given a 1GB file read operation, when executed, then resident memory stays proportional to chunk size, not file size.

**AC3** [R4, R5, R6]: Given a child process that writes 100MB to stdout and then hangs, when executed with a 30s timeout, then stdout is streamed (bounded memory), the process is killed at timeout, and the result contains stdout (streamed), stderr, exit code/signal, and duration.

**AC4** [R7]: Given an agent turn processing 50 tools, when event loop delay is measured, then it does not exceed 100ms.

**AC5** [R8]: Given three concurrent async operations taking 1s, 2s, and 3s respectively, when executed in parallel, then total wall time is approximately 3s (not 6s) and results are in deterministic order.

**AC6** [R9]: Given a CPU-intensive computation offloaded to a worker thread, when the main thread event loop delay is measured, then it stays under 10ms.

**AC7** [R10]: Given environment variables set at startup, when the system is running, then all configuration is available as typed state in the store and no code reads `process.env` directly.

**AC8** [R11]: Given an unhandled promise rejection, when it occurs, then the runtime persists state and exits gracefully.

## FT System Demands

- **Required Primitives**: Native persistence with sub-5ms batch writes. Streaming file I/O with bounded memory. Structured child process results.
- **Required Operations**: Worker thread delegation for CPU-bound work. Parallel async I/O with sequential consistency.
- **Gaps**: None identified -- Node.js provides all necessary primitives.

## Open Questions

- Should the event loop budget (100ms) be configurable per-deployment or fixed?
- What is the default child process timeout -- 30s, 60s, or deployment-specific?
