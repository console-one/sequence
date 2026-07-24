# Electron Runtime

Electron is the primary desktop runtime. The constraint store lives in the main process (where Node runs, persistence happens, the kernel boots), and the renderer process sees a live projection of it via IPC. The hard part is the IPC boundary -- every read from the renderer crosses a process boundary, and that must be fast enough for the UI to feel native. The main process is a singleton that handles multiple windows without duplicating the store.

The tension is security vs. performance: Electron's security model mandates process isolation between main and renderer, but the FT system needs low-latency state reads from the UI layer. Every state access crosses IPC. Additionally, the renderer must never directly access the store -- it works through a minimal preload bridge.

## Store in Main Process

The constraint store resides in the main process with full access to Node.js APIs, filesystem, and native modules:

```ft
MainStore = {
  processRole: "main",
  initialized: boolean,
  statementCount: number >= 0,
  persistencePath: string
}
```

The store initializes in the main process before any renderer window is created.

## IPC Protocol

The renderer receives state projections via a structured IPC protocol. It never has direct access to the store object:

```ft
IPCProtocol = {
  read: (path: string) -> { value: string },
  write: (path: string) -> { success: boolean },
  subscribe: (path: string) -> { updateId: string },
  fork: (name: string) -> { forkId: string },
  merge: (forkId: string) -> { success: boolean }
}
```

These five operations are the IPC surface. Each is a transparent proxy -- invoking from the renderer produces the same result as invoking directly in the main process.

## Low-Latency Notifications

State change notifications are pushed from main to renderer. Interactive state updates must arrive within one frame (16ms):

```ft
NotificationConfig = {
  batchInterval: number,
  maxLatency: number,
  pendingUpdates: number >= 0
}
```

Multiple rapid state changes can be coalesced into a single IPC message. The renderer sees the final state, not every intermediate step. But no update is missed -- batching is about reducing IPC calls, not dropping changes.

## Multi-Window Consistency

Multiple renderer windows share the same constraint store, each with independent projections:

```ft
WindowRegistry = {
  windowCount: number >= 0,
  activeSubscriptions: number >= 0
}
```

A write from window A is visible in window B's projection without explicit sync. The main process is the single source of truth; renderers hold projections only.

## Filesystem Persistence

The store persists to the user data directory and restores on restart. Persistence uses atomic writes to prevent corruption:

```ft
PersistenceLayer = {
  dataDir: string,
  flushInterval: number,
  lastFlush: number,
  crashRecoverable: boolean
}
```

After quitting and relaunching, previously written state is fully present. After a crash (SIGKILL), at most the last N seconds of state is lost, where N is determined by the flush interval.

## Preload Security

The preload script exposes only the minimum necessary API surface to the renderer:

```ft
PreloadBridge = {
  exposedMethods: number >= 0,
  contextIsolation: boolean,
  nodeIntegration: boolean
}
```

```ft
PreloadBridge << { contextIsolation: true, nodeIntegration: false }
```

The renderer has no way to access Node.js primitives or the store directly. The preload bridge is typed and minimal.

## OS Lifecycle Integration

The runtime handles OS-level events to ensure durability:

```ft
LifecycleEvents = {
  onQuit: boolean,
  onSleep: boolean,
  onWake: boolean,
  onCrash: boolean
}
```

Unexpected shutdown triggers the persistence path. The store is recoverable after any form of process termination.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Store in main process | `MainStore.processRole = "main"` |
| Renderer uses IPC, no direct access | `IPCProtocol` with five operations |
| Sub-16ms state notifications | `NotificationConfig.maxLatency` |
| Multi-window consistency | `WindowRegistry` with shared store |
| State persists across restarts | `PersistenceLayer` with atomic flush |
| Bounded crash data loss | `PersistenceLayer.flushInterval` determines max loss |
| Minimal preload surface | `PreloadBridge` with context isolation |
| Hot reload preserves state | Store unchanged when renderer reloads |
