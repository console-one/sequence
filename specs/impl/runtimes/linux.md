# Linux Runtime

Linux is the server-side and power-user runtime. It runs the system headless -- as a daemon, a background service, a container entry point. It has access to everything: filesystem, processes, sockets, cgroups, namespaces. The system runs as a systemd service, talks to other processes via Unix domain sockets, uses inotify for filesystem watching, and manages resource limits via cgroups. This is the runtime for wiring the system into infrastructure.

The tension is that Linux provides extremely powerful primitives (namespaces, cgroups, signals, inotify) but they are all imperative, stateful, and side-effectful. The FT system's declarative constraint model must map cleanly onto these imperative OS interfaces without losing deterministic state transitions.

## Daemon Process

The runtime runs as a long-lived daemon managed by systemd. It handles service lifecycle signals correctly:

```ft
DaemonProcess = {
  initSystem: "systemd",
  pidFile: string,
  dataDir: string,
  status: "starting" | "running" | "stopping" | "stopped"
}
```

SIGTERM triggers graceful shutdown (flush state, close sockets, exit). SIGHUP triggers configuration reload. SIGINT triggers immediate but clean termination. The constraint store is cleanly persisted on each stop.

## Unix Socket IPC

The runtime exposes an IPC interface via Unix domain sockets for communication with other local processes:

```ft
UnixSocketIPC = {
  socketPath: string,
  protocol: string,
  connectedClients: number >= 0
}
```

A separate process can connect to the socket, submit a statement, and read back state. No SDK required -- any process that can speak the wire protocol can interact.

## Filesystem Watching

The runtime monitors filesystem paths via inotify and reflects changes as state in the constraint store:

```ft
FileWatcher = {
  watchPath: string,
  eventTypes: string,
  debounceMs: number,
  lastEvent: number
}
```

When a watched file is modified, a corresponding state change appears in the store within 1 second. Debouncing prevents noisy directories from flooding the store with intermediate states.

## Resource Limits

The runtime optionally constrains its resource footprint via cgroups v2:

```ft
ResourceLimits = {
  memoryLimitBytes: number >= 0,
  cpuQuota: number >= 0,
  ioWeight: number >= 0,
  enforced: boolean
}
```

When a memory limit is set, the runtime evicts low-priority state and degrades gracefully (eviction, not crash) when approaching the limit. The runtime monitors its own memory proactively -- it does not wait for the OOM killer.

## Crash-Safe Persistence

The store persists using atomic write operations (write-ahead log or rename-based atomicity):

```ft
AtomicPersistence = {
  strategy: "wal" | "rename",
  lastCommit: number,
  recoverable: boolean
}
```

After a SIGKILL during a write operation, the store recovers to a consistent state on restart. No partial writes are visible.

## Multi-Instance Isolation

Multiple isolated instances can run on the same host, each with its own data directory, socket, and PID file:

```ft
InstanceConfig = {
  instanceId: string,
  dataDir: string,
  socketPath: string,
  pidFile: string
}
```

Two instances with different configurations run simultaneously without interfering with each other's state or socket.

## Structured Logging

The runtime produces JSON-formatted logs compatible with standard aggregation tools:

```ft
LogConfig = {
  format: "json",
  destination: "stdout" | "file" | "journald",
  level: "debug" | "info" | "warn" | "error"
}
```

Every log line is valid JSON with timestamp, level, and message fields, parseable by jq.

## Process Spawning

Capabilities that require external tools spawn child processes. The runtime tracks their lifecycle as state:

```ft
ChildProcess = {
  command: string,
  pid: number >= 0,
  exitCode: number,
  stdout: string,
  stderr: string
}
```

All child processes are tracked within the service tree. No orphaned processes survive outside the main service's lifecycle.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Runs as systemd service | `DaemonProcess` with init system, PID file |
| Graceful signal handling | SIGTERM/SIGHUP/SIGINT mapped to status transitions |
| Unix socket IPC | `UnixSocketIPC` with socket path and protocol |
| Filesystem event monitoring | `FileWatcher` with inotify and debouncing |
| cgroup resource limits | `ResourceLimits` with memory, CPU, IO constraints |
| Crash-safe persistence | `AtomicPersistence` with WAL or rename strategy |
| Multi-instance isolation | `InstanceConfig` with separate data/socket/PID |
| Structured JSON logs | `LogConfig` with JSON format |
| Process spawning and tracking | `ChildProcess` with lifecycle capture |
