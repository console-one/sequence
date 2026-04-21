# Linux Runtime

## Original Notes

Linux is the server-side and power-user runtime. It runs the system headless -- as a daemon, a background service, a container entry point. It has access to everything: filesystem, processes, sockets, cgroups, namespaces. The system runs as a systemd service, talks to other processes via Unix domain sockets, uses inotify for filesystem watching, and manages resource limits via cgroups. This is the runtime for wiring the system into infrastructure.

The tension is that Linux provides extremely powerful primitives (namespaces, cgroups, signals, inotify) but they are all imperative, stateful, and side-effectful. The FT system's declarative constraint model must map cleanly onto these imperative OS interfaces without losing deterministic state transitions.

## Problem Context

- **Actor(s)**: System administrator; systemd; other local processes; filesystem events; container orchestrators.
- **Domain**: Running the system as a long-lived headless daemon on Linux, integrated with standard infrastructure (systemd, cgroups, inotify, Unix sockets).
- **Core Tension**: Linux provides powerful but imperative, stateful OS primitives (signals, cgroups, inotify). The system must bridge its declarative model onto these interfaces cleanly.

## Requirements

**R1**: The runtime SHALL run as a systemd-managed daemon with a PID file and configurable data directory.
- *Rationale*: systemd is the standard Linux init system; integration enables standard service management (start, stop, restart, status).
- *Verifiable by*: `systemctl start/stop/restart/status` works correctly; the PID file is created on start and removed on stop.

**R2**: The runtime SHALL handle SIGTERM (graceful shutdown with state persistence), SIGHUP (configuration reload), and SIGINT (immediate clean exit).
- *Rationale*: These are the standard Unix signal conventions. Violating them breaks every process manager and shell.
- *Verifiable by*: Send SIGTERM -- state is persisted and process exits cleanly. Send SIGHUP -- configuration is reloaded without restart. Send SIGINT -- process exits immediately after cleanup.

**R3**: The runtime SHALL expose an IPC interface via Unix domain sockets, allowing any local process to submit statements and read state using the wire protocol.
- *Rationale*: Unix sockets are the standard local IPC mechanism; no SDK should be required for integration.
- *Verifiable by*: A separate process connects to the socket, submits a statement, and reads back the resulting state using only the documented wire protocol.

**R4**: The runtime SHALL monitor filesystem paths via inotify and reflect changes as state within a configurable debounce interval (default: 1 second).
- *Rationale*: Filesystem events are a primary integration point for infrastructure automation.
- *Verifiable by*: Modify a watched file -- the corresponding state change appears within the debounce interval. Rapid modifications to the same file produce a single debounced state update.

**R5**: The runtime SHALL optionally enforce resource limits via cgroups v2 (memory, CPU quota, I/O weight).
- *Rationale*: Server deployments require resource isolation to prevent one service from starving others.
- *Verifiable by*: Set a memory limit -- the runtime evicts low-priority state and degrades gracefully before the OOM killer intervenes.

**R6**: The runtime SHALL proactively monitor its own memory usage and evict low-priority state before reaching cgroup limits.
- *Rationale*: Waiting for the OOM killer results in process termination; proactive eviction preserves service availability.
- *Verifiable by*: Under memory pressure, the runtime logs eviction events and continues operating; the OOM killer is never triggered.

**R7**: Persistence SHALL use atomic write operations (write-ahead log or rename-based atomicity) so that a SIGKILL during a write leaves the store in a consistent state.
- *Rationale*: Server processes can be killed at any time (deployment, crash, OOM); partial writes must never corrupt the store.
- *Verifiable by*: SIGKILL the process during a write, restart -- the store recovers to a consistent state with no partial writes visible.

**R8**: Multiple isolated instances SHALL run on the same host, each with its own data directory, socket path, and PID file.
- *Rationale*: Multi-tenant or multi-project deployments require isolation without separate VMs or containers.
- *Verifiable by*: Start two instances with different configurations simultaneously -- they operate independently with no state or socket conflicts.

**R9**: The runtime SHALL produce structured JSON logs compatible with standard aggregation tools (journald, jq, ELK).
- *Rationale*: Server operators require machine-parseable logs for monitoring and debugging.
- *Verifiable by*: Every log line is valid JSON with timestamp, level, and message fields; `jq` parses them without errors.

**R10**: Child processes spawned by capabilities SHALL be tracked within the service tree, with no orphaned processes surviving the daemon's lifecycle.
- *Rationale*: Orphaned processes consume resources and are invisible to process managers.
- *Verifiable by*: Stop the daemon -- all child processes are also terminated. No orphans remain.

## Acceptance Criteria

**AC1** [R1, R2]: Given a systemd service unit, when `systemctl start` is run, then the daemon starts, creates a PID file, and responds correctly to SIGTERM, SIGHUP, and SIGINT.

**AC2** [R3]: Given a separate process connecting via the Unix socket, when it submits a statement and reads state, then the correct result is returned using only the wire protocol.

**AC3** [R4]: Given a watched file, when it is modified, then the corresponding state change appears within the debounce interval.

**AC4** [R5, R6]: Given a configured cgroup memory limit, when memory usage approaches the limit, then the runtime evicts low-priority state and continues operating without OOM termination.

**AC5** [R7]: Given a SIGKILL during a write operation, when the daemon restarts, then the store is consistent with no partial writes.

**AC6** [R8]: Given two instances with different configurations, when both are started, then they run simultaneously with independent state, sockets, and PID files.

**AC7** [R9]: Given runtime logs, when parsed with `jq`, then every line is valid JSON with timestamp, level, and message fields.

**AC8** [R10]: Given a daemon with spawned child processes, when the daemon is stopped, then all child processes are also terminated.

## FT System Demands

- **Required Primitives**: Configurable filesystem watchers with debounce. Resource limit monitoring with eviction triggers. Structured logging output.
- **Required Operations**: Atomic persistence (WAL or rename). Unix socket IPC with a documented wire protocol.
- **Gaps**: None identified -- Linux provides all necessary OS primitives.

## Open Questions

- Should the wire protocol be newline-delimited JSON, length-prefixed binary, or configurable?
- What is the default debounce interval for inotify events, and should it be per-watch configurable?
