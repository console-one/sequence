# Local Image Container

A local image is a node of the distributed system installed on the user's machine. It bridges local resources (filesystem, shell, user-installed tools) to the broader system while respecting user sovereignty -- nothing is exposed without explicit permission. It heartbeats with the central server to maintain its registration, queues messages when offline, and syncs bidirectionally when connectivity is available. The user's machine is not a server; the node must be resource-frugal and offline-capable.

The core tension: the node must be a fully functional distributed participant while also being useful standalone when offline. Local resources are privileged (remote nodes cannot access them), but synchronization with the central server must not lose local work during connectivity gaps.

## Node Identity

The local node identifies itself with a stable machine-derived fingerprint that persists across restarts:

```ft
LocalNode = {
  machineId: string,
  mode: "background" | "shell" | "electron",
  status: "online" | "offline",
  lastSync: number
}
```

The `machineId` is derived from hardware characteristics so it stays the same after restart on the same machine but differs on a different machine.

## Interaction Modes

The node supports multiple modes. Mode determines the interaction surface but does not change the underlying capability set:

```ft
LocalNode << { mode: "background" }
-- headless, no UI, runs agents and syncs state
```

```ft
LocalNode << { mode: "shell" }
-- CLI interface for interactive use
```

```ft
LocalNode << { mode: "electron" }
-- graphical application window
```

## Scoped Local Capabilities

Local capabilities expose user resources to the system, scoped by user-specified permissions. The user controls what directories, tools, and operations are available:

```ft
LocalCapability = {
  name: string,
  type: "filesystem" | "shell" | "tool",
  scopePath: string,
  permitted: boolean
}
```

```ft
tool LocalCapability.name when permitted = true
```

A filesystem capability scoped to `/home/user/projects` allows reads within that directory. An attempt to read `/etc/passwd` is denied. The user explicitly configures the scope; nothing is exposed by default.

## Heartbeat and Server Connection

The node heartbeats with the central server via sockets to maintain its lock and registration:

```ft
ServerConnection = {
  endpoint: string,
  heartbeat: number,
  connected: boolean,
  lockValid: boolean while connected = true
}
```

```ft
ServerConnection << { heartbeat: prev }
```

When the network connection drops, `connected` becomes false and the lock is no longer maintained on the server side. The node continues operating locally.

## Offline Message Queue

When offline, the node queues outbound messages locally and delivers them in order when connectivity is restored:

```ft
OfflineQueue = {
  messages: string,
  count: number >= 0,
  oldestTimestamp: number
}
```

Messages generated offline are durable -- they survive process restarts. On reconnection, the queue drains in order. No messages are silently dropped.

## Local Cache and Staleness

The node maintains an on-host cache of relevant remote state for local decision-making. Each cached entry carries staleness metadata:

```ft
CachedEntry = {
  path: string,
  value: string,
  lastSynced: number,
  staleness: number >= 0
}
```

A remote state reference resolves locally when a cached copy exists. The resolution includes staleness information so downstream decisions can account for uncertainty. Stale data is better than no data, but confidence degrades with age.

## Bidirectional Sync

Local changes propagate upstream and remote changes propagate downstream. The node is not read-only -- it generates state from tool execution and user input:

```ft
SyncState = {
  localPending: number >= 0,
  remotePending: number >= 0,
  lastUpSync: number,
  lastDownSync: number,
  conflictCount: number >= 0
}
```

When local and remote changes affect different state, merge is automatic. When they overlap, conflicts are surfaced for resolution.

## User-Installed Capabilities

Users can extend the node by installing additional capabilities:

```ft
InstalledTool = {
  name: string,
  installedBy: string,
  installedAt: number,
  available: boolean
}
```

```ft
tool InstalledTool.name when available = true
```

Installation is user-initiated. The system may suggest useful capabilities but never installs without consent.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Stable machine identity across restarts | `LocalNode.machineId` derived from hardware |
| Multiple interaction modes | `mode: "background" / "shell" / "electron"` |
| Scoped filesystem access | `LocalCapability` with `scopePath` and `permitted` |
| Denied access outside scope | `cap ... when permitted = true` gates access |
| Heartbeat maintains registration | `ServerConnection << { heartbeat: prev }` |
| Lock valid while connected | `lockValid: boolean while connected = true` |
| Offline queue preserves messages | `OfflineQueue` with durable messages |
| Staleness-aware remote resolution | `CachedEntry` with `staleness` metadata |
| Bidirectional sync | `SyncState` tracking local and remote pending |
| User-installed capabilities | `InstalledTool` with user consent |
