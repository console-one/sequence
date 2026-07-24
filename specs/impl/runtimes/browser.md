# Browser Runtime

The browser is the most constrained environment: no filesystem, no persistent processes, per-tab memory limits, and the tab can be closed or frozen at any time. But it is also the most portable -- any device with a browser can run the system. The constraint store must operate using only web-standard APIs: IndexedDB for persistence, Web Workers for background computation, and fetch/WebSocket for network. The user opens a tab and the system works, even if they close the tab and come back later.

The fundamental tension is that the FT system assumes durable state and long-running processes, but browsers provide neither. The runtime bridges this gap: persisting to IndexedDB, offloading computation to workers, enforcing a memory budget, and handling tab lifecycle events gracefully.

## Store Persistence

State survives tab closures and browser restarts via IndexedDB. The append-only log must not be lost on tab close:

```ft
BrowserStore = {
  backend: "indexeddb",
  statementCount: number >= 0,
  durable: boolean,
  lastPersist: number
}
```

All state entries must be serializable via structured clone -- no functions, no closures in stored state. This is a hard constraint of the browser storage API.

## Web Worker Offloading

Computationally intensive operations run in Web Workers to prevent blocking the main thread. The main thread stays responsive for rendering:

```ft
WorkerPool = {
  workerCount: number >= 0,
  busyCount: number >= 0,
  queueDepth: number >= 0
}
```

A reduction over a large constraint set completes without dropping frames. If the worker pool is exhausted, operations queue rather than crash.

## Tab Lifecycle

Browsers aggressively throttle or freeze background tabs. In-flight operations must not silently fail -- they become suspensions recoverable when the tab is foregrounded:

```ft
TabState = {
  visibility: "visible" | "hidden" | "frozen" | "discarded",
  pendingSuspensions: number >= 0,
  lastActive: number
}
```

When the browser fires a freeze event, any pending remote capability call is recorded as suspended. On resume, the suspension is visible and resumable. If the tab is discarded entirely, state survives via IndexedDB persistence.

## Memory Budget

The runtime enforces a configurable memory ceiling. When the budget is approached, low-concreteness state is evicted. Evicted state is recoverable from persistence or remote sync:

```ft
MemoryBudget = {
  limitBytes: number >= 0,
  currentBytes: number >= 0,
  evictionCount: number >= 0
}
```

Browsers have per-tab memory limits. Unbounded state accumulation crashes the tab. The eviction strategy prioritizes keeping high-concreteness state in memory.

## Remote Capability Delegation

Capabilities requiring filesystem, shell, or hardware access cannot execute in the browser. They delegate to a configured remote endpoint:

```ft
RemoteCapability = {
  name: string,
  endpoint: string,
  delegated: boolean,
  lastCallStatus: "success" | "failure" | "pending"
}
```

```ft
tool RemoteCapability.name when endpoint EXISTS
```

The runtime routes capability invocations to the remote server when local execution is impossible. The result is incorporated into local state.

## Synchronous Rendering Reads

The rendering layer reads from a main-thread projection, not directly from the worker-hosted store. State changes are reflected in reads within the same animation frame:

```ft
RenderProjection = {
  synced: boolean,
  lastUpdate: number,
  staleEntries: number >= 0
}
```

## Offline Operation

The runtime queues outbound operations when offline and replays them on reconnection:

```ft
OfflineBuffer = {
  pendingStatements: number >= 0,
  oldestPending: number,
  syncOnReconnect: boolean
}
```

Replaying queued operations on reconnect must be idempotent -- no duplicate effects.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Standard browser APIs only | `BrowserStore` backed by IndexedDB, no extensions |
| State persists across tab closure | `BrowserStore.durable` via IndexedDB round-trip |
| Main thread not blocked | `WorkerPool` offloads reduction to workers |
| Frozen tab preserves operations | `TabState` with pending suspensions |
| Memory budget enforced | `MemoryBudget` with eviction of low-concreteness |
| Remote capability delegation | `RemoteCapability` routes to server endpoint |
| Synchronous reads for rendering | `RenderProjection` updated within animation frame |
| Offline operation with replay | `OfflineBuffer` queues and replays on reconnect |
