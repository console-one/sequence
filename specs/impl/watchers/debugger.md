# Debugger

A developer needs to see what changed, when, and what it changed from. The standard approach is an external event subscription (EventEmitter, pub/sub). That bypasses constraint propagation and can miss changes or fire out of order. The right answer: the watcher is a derived computation that participates in the normal change cycle. It lives while a debug flag exists, dies when the flag is removed, and logs every change with old value, new value, and timestamp.

The watcher must not alter the watched path. It is read-only observation. And it must be cheap to enable/disable -- set a flag, remove a flag, done.

## The Watcher Type

A watcher targets a specific path and accumulates a change log. Each entry records what the value was, what it became, and when:

```ft
ChangeEntry = {
  oldValue: string | null,
  newValue: string | null,
  timestamp: number
}

Watcher = {
  target: string,
  changeLog: ChangeEntry,
  signal: "watching" | "stopped"
}
```

Entries are written under `changeLog` with unique keys (e.g., `changeLog.e0`, `changeLog.e1`). Each key holds a ChangeEntry.

The watcher's signal field indicates whether it is actively observing or has been shut down.

## Activation via Debug Flag

The watcher is conditioned on a debug flag. When the flag exists, the watcher is alive. When the flag is removed, the watcher stops and a signal is produced:

```ft
watcher = Watcher while debugMode EXISTS
```

The `while debugMode EXISTS` gate is the entire lifecycle control. No explicit start/stop API. Set the flag to start. Remove the flag to stop.

## Logging Changes

Each change to the watched path appends an entry to the change log. The entry captures prev (the value before the change), the new value, and a timestamp:

```ft
watcher << { target: "first" }
watcher << { changeLog: { e0: { oldValue: null, newValue: "first", timestamp: 1000 } } }

watcher << { target: "second" }
watcher << { changeLog: { e1: { oldValue: "first", newValue: "second", timestamp: 2000 } } }
```

The mechanism by which prev is available -- whether from the append-only log or explicit storage -- is an implementation detail. The watcher's contract is: every change produces an entry with both values.

## Deactivation and Signal

When the debug flag is removed, the watcher stops. A signal confirms deactivation:

```ft
delete debugMode
-- watcher deactivates because "while debugMode EXISTS" breaks
-- watcher.signal becomes "stopped"
```

Changes after deactivation do not produce log entries. The watcher consumes no resources when inactive.

## Multiple Independent Watchers

Multiple watchers on different paths operate independently:

```ft
watcherAlpha = Watcher while debugMode EXISTS
watcherAlpha << { target: "alpha" }

watcherBeta = Watcher while debugMode EXISTS
watcherBeta << { target: "beta" }
```

A change to "alpha" fires only watcherAlpha. A change to "beta" fires only watcherBeta. No cross-contamination.

## Capabilities

The debug flag and the watched path are externally provided:

```ft
cap debugMode
cap watcher.target
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Change logged with old/new/timestamp | `ChangeEntry = { oldValue, newValue, timestamp }` |
| 3 changes produce 3 entries | Each change appends to `changeLog` |
| Debug flag activates watcher | `while debugMode EXISTS` gate |
| Flag removal deactivates, stops logging | `delete debugMode` breaks the while gate |
| Stopped signal on deactivation | `watcher.signal` becomes `"stopped"` |
| Fires during same propagation cycle | Watcher is a derived computation, not async subscription |
| Multiple watchers independent | Separate watcher instances on separate paths |
