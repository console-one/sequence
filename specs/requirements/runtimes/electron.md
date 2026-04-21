# Electron Runtime

## Original Notes

Electron is the primary desktop runtime. The constraint store lives in the main process (where Node runs, persistence happens, the kernel boots), and the renderer process sees a live projection of it via IPC. The hard part is the IPC boundary -- every read from the renderer crosses a process boundary, and that must be fast enough for the UI to feel native. The main process is a singleton that handles multiple windows without duplicating the store.

The tension is security vs. performance: Electron's security model mandates process isolation between main and renderer, but the FT system needs low-latency state reads from the UI layer. Every state access crosses IPC. Additionally, the renderer must never directly access the store -- it works through a minimal preload bridge.

## Problem Context

- **Actor(s)**: Main process (state owner); renderer process(es) (UI); preload bridge (security boundary); OS (lifecycle events).
- **Domain**: Desktop application where a single state store must be accessible from multiple renderer windows with low latency, strong security isolation, and crash-safe persistence.
- **Core Tension**: Electron's mandatory process isolation means every UI state read crosses an IPC boundary, but the UI must feel native (<16ms response). Security requires the renderer never directly accesses Node.js or the store.

## Requirements

**R1**: The state store SHALL reside in the main process with full Node.js API access.
- *Rationale*: The main process is the only process with filesystem and native module access; it is the natural home for persistence and state management.
- *Verifiable by*: The store is initialized and accessible only in the main process; renderer processes have no direct reference to it.

**R2**: The store SHALL initialize before any renderer window is created.
- *Rationale*: Renderers depend on the store being available; creating windows before the store is ready causes race conditions.
- *Verifiable by*: The first renderer window opens with the store already populated from the previous session.

**R3**: Renderer processes SHALL access state exclusively through a structured IPC protocol supporting read, write, subscribe, fork, and merge operations.
- *Rationale*: Direct store access from renderers violates Electron's security model and couples the UI to internals.
- *Verifiable by*: The renderer performs all five operations via IPC and receives correct results identical to direct main-process invocation.

**R4**: Interactive state change notifications SHALL arrive at the renderer within one frame (16ms).
- *Rationale*: Users perceive latency above 16ms as lag; the UI must feel native.
- *Verifiable by*: A state write in the main process triggers a renderer callback within 16ms, measurable via performance timestamps.

**R5**: Rapid state changes SHOULD be coalesced into batched IPC messages without dropping any changes.
- *Rationale*: Reducing IPC call volume improves performance, but no update may be silently lost.
- *Verifiable by*: 100 rapid writes produce a renderer state that reflects all 100 changes, even if delivered in fewer IPC messages.

**R6**: Multiple renderer windows SHALL share the same store, each with independent projections.
- *Rationale*: Desktop apps commonly have multiple windows; they must see consistent state without explicit synchronization.
- *Verifiable by*: A write from window A is visible in window B's next read without any manual sync step.

**R7**: The store SHALL persist to the user data directory using atomic writes to prevent corruption.
- *Rationale*: Non-atomic writes risk half-written state on crash or power loss.
- *Verifiable by*: After a SIGKILL during a write, relaunch shows consistent (not corrupted) state, losing at most the last flush interval's worth of data.

**R8**: After quitting and relaunching, all previously written state SHALL be fully present.
- *Rationale*: Desktop users expect their data to survive application restarts.
- *Verifiable by*: Write state, quit the app, relaunch -- all state is present.

**R9**: The preload bridge SHALL expose only the minimum necessary API surface to the renderer, with context isolation enabled and Node.js integration disabled.
- *Rationale*: Electron security best practices require minimizing the renderer's access to prevent supply-chain and XSS attacks.
- *Verifiable by*: The renderer cannot access `require`, `process`, `fs`, or any Node.js API. Only the explicitly exposed IPC methods are available.

**R10**: The runtime SHALL handle OS lifecycle events (quit, sleep, wake, crash) and persist state before termination.
- *Rationale*: Unexpected shutdown (OS sleep, crash, force-quit) must not cause data loss beyond the flush interval.
- *Verifiable by*: Trigger OS sleep, wake, verify state is intact. Force-kill the process, relaunch, verify state loss is bounded.

**R11**: Hot-reloading the renderer SHALL NOT affect stored state.
- *Rationale*: During development, renderer reloads are frequent; they must not clear or corrupt the store.
- *Verifiable by*: Write state, hot-reload the renderer, verify all state is unchanged.

## Acceptance Criteria

**AC1** [R1, R2]: Given a fresh application launch, when the first renderer window opens, then the store is initialized and previous session state is available.

**AC2** [R3]: Given a renderer process, when it performs read, write, subscribe, fork, and merge via IPC, then each operation returns results identical to direct main-process invocation.

**AC3** [R4, R5]: Given 100 rapid state writes in the main process, when the renderer receives notifications, then all 100 changes are reflected and the first notification arrives within 16ms.

**AC4** [R6]: Given two open windows, when window A writes state, then window B's next read reflects the change without manual synchronization.

**AC5** [R7, R10]: Given a SIGKILL during a write operation, when the application relaunches, then the store is consistent and data loss is bounded by the flush interval.

**AC6** [R9]: Given a renderer process, when it attempts to access Node.js APIs (require, process, fs), then the access fails -- only the preload bridge methods are available.

**AC7** [R11]: Given stored state, when the renderer is hot-reloaded, then all state remains unchanged.

## FT System Demands

- **Required Primitives**: IPC-transparent read/write/subscribe/fork/merge protocol. Atomic persistence with configurable flush interval.
- **Required Operations**: Batched notification delivery with guaranteed completeness. Multi-window projection independence.
- **Gaps**: None identified -- Electron provides the necessary OS-level primitives.

## Open Questions

- What is the maximum acceptable flush interval for crash-safe persistence (1s, 5s, configurable)?
- Should the IPC protocol support streaming reads for large state subtrees, or is snapshot-based transfer sufficient?
