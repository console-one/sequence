# Browser Runtime

## Original Notes

The browser is the most constrained environment: no filesystem, no persistent processes, per-tab memory limits, and the tab can be closed or frozen at any time. But it is also the most portable -- any device with a browser can run the system. The constraint store must operate using only web-standard APIs: IndexedDB for persistence, Web Workers for background computation, and fetch/WebSocket for network. The user opens a tab and the system works, even if they close the tab and come back later.

The fundamental tension is that the FT system assumes durable state and long-running processes, but browsers provide neither. The runtime bridges this gap: persisting to IndexedDB, offloading computation to workers, enforcing a memory budget, and handling tab lifecycle events gracefully.

## Problem Context

- **Actor(s)**: End user via browser tab; background workers; remote service endpoints.
- **Domain**: Running a stateful system inside a browser where the platform provides no filesystem, no persistent processes, and aggressive resource limits.
- **Core Tension**: The system requires durable state and long-running computation, but browsers offer neither -- tabs freeze, close, and have per-tab memory ceilings.

## Requirements

**R1**: The runtime SHALL persist all state using only web-standard APIs (IndexedDB), with no browser extensions or plugins required.
- *Rationale*: Portability across all modern browsers requires using only standardized storage APIs.
- *Verifiable by*: State written in one session is fully retrievable after tab closure and browser restart, using only IndexedDB.

**R2**: State SHALL survive tab closure and browser restart without data loss.
- *Rationale*: Users expect their work to persist even if they accidentally close the tab.
- *Verifiable by*: Write state, close tab, reopen -- all previously written state is present.

**R3**: All stored state SHALL be serializable via the structured clone algorithm (no functions, no closures).
- *Rationale*: IndexedDB uses structured clone; non-serializable values would silently fail or corrupt persistence.
- *Verifiable by*: Attempting to store a function or closure produces an error at write time, not silent data loss.

**R4**: Computationally intensive operations SHALL execute in Web Workers to avoid blocking the main thread.
- *Rationale*: Blocking the main thread causes dropped frames and unresponsive UI.
- *Verifiable by*: During a large computation, the main thread maintains 60fps rendering (no frame drops exceeding 16ms).

**R5**: When all workers are busy, additional operations SHALL queue rather than fail.
- *Rationale*: Bursty workloads should degrade gracefully, not crash.
- *Verifiable by*: Submitting more concurrent operations than available workers results in queued execution, not errors.

**R6**: The runtime SHALL handle tab lifecycle events (visibility change, freeze, discard) without losing in-flight operations.
- *Rationale*: Browsers aggressively throttle or freeze background tabs; in-flight work must not silently vanish.
- *Verifiable by*: Start an operation, switch away until the tab freezes, return -- the operation is either completed or visibly suspended and resumable.

**R7**: The runtime SHALL enforce a configurable memory ceiling and evict low-priority state when approaching the limit.
- *Rationale*: Browsers impose per-tab memory limits; unbounded state accumulation crashes the tab.
- *Verifiable by*: Under sustained state growth, memory usage stays below the configured ceiling and eviction events are logged.

**R8**: Evicted state SHALL be recoverable from persistence or remote sync.
- *Rationale*: Eviction is a memory optimization, not data destruction.
- *Verifiable by*: After eviction, re-requesting the evicted state retrieves it from IndexedDB or the remote endpoint.

**R9**: Operations requiring filesystem, shell, or hardware access SHALL delegate to a configured remote endpoint.
- *Rationale*: Browsers cannot access local filesystem or spawn processes; a remote server must handle these.
- *Verifiable by*: A filesystem operation invoked in the browser produces a network call to the configured endpoint and returns the result.

**R10**: The rendering layer SHALL read from a main-thread projection, with state changes reflected within the same animation frame.
- *Rationale*: Synchronous reads are necessary for consistent rendering within a single frame.
- *Verifiable by*: A state change and a subsequent read in the same requestAnimationFrame callback return the updated value.

**R11**: The runtime SHALL queue outbound operations when offline and replay them idempotently on reconnection.
- *Rationale*: Users may work offline; queued operations must not produce duplicate effects when connectivity returns.
- *Verifiable by*: Perform writes while offline, reconnect -- writes are applied exactly once with no duplicates.

## Acceptance Criteria

**AC1** [R1, R2]: Given a browser tab with state written via IndexedDB, when the tab is closed and reopened, then all previously written state is retrievable.

**AC2** [R3]: Given an attempt to store a non-serializable value (function, closure), when the write is attempted, then it fails with a clear error message.

**AC3** [R4, R5]: Given a computation that takes >100ms, when it is submitted, then the main thread frame time remains under 16ms, and if workers are saturated, the operation queues.

**AC4** [R6]: Given an in-flight remote operation, when the browser fires a freeze event, then the operation is recorded as suspended and is resumable when the tab is foregrounded.

**AC5** [R7, R8]: Given state accumulation approaching the memory ceiling, when the limit is reached, then low-priority state is evicted and remains retrievable from persistence.

**AC6** [R9]: Given a capability requiring filesystem access, when invoked in the browser, then the request is routed to the configured remote endpoint and the result is returned to the caller.

**AC7** [R10]: Given a state change during a render cycle, when a read occurs in the same animation frame, then the read reflects the updated value.

**AC8** [R11]: Given writes performed while offline, when connectivity is restored, then each write is replayed exactly once.

## FT System Demands

- **Required Primitives**: Configurable memory budget with eviction priority. Remote capability delegation with endpoint configuration. Suspension/resumption for in-flight operations across tab lifecycle.
- **Required Operations**: Idempotent replay of queued operations. Synchronous projection reads on the main thread while writes occur in workers.
- **Gaps**: The system must define an eviction priority scheme (e.g., based on recency, access frequency, or data criticality).

## Open Questions

- What is the eviction priority policy -- LRU, concreteness-based, or configurable per deployment?
- Should the memory ceiling be auto-detected from browser heuristics or always explicitly configured?
- How should the runtime handle IndexedDB quota exhaustion (browser storage limits)?
