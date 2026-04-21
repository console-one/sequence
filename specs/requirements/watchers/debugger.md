# Debugger

## Problem Context

- **Actor(s)**: Developers (need to observe state changes), Watchers (observe and log changes to specific paths), a debug flag (controls watcher lifecycle)
- **Domain**: Runtime observability -- recording what changed, when, and what the previous value was, without altering the watched data or requiring external event subscription infrastructure
- **Core Tension**: The watcher must participate in the normal change propagation cycle (not be an out-of-band subscription that can miss changes or fire out of order). It must be purely read-only. And it must be trivially cheap to enable/disable -- a single flag.

## Requirements

**R1**: A watcher SHALL target a specific data path and accumulate a change log for that path.
- *Rationale*: Targeted observation prevents noise; the developer chooses what to watch.
- *Verifiable by*: Creating a watcher on path "X" and confirming it only logs changes to "X".

**R2**: Each change log entry SHALL record the old value (value before the change), the new value (value after the change), and a timestamp.
- *Rationale*: Debugging requires knowing what changed, what it changed from, and when.
- *Verifiable by*: Changing a watched value and confirming the log entry contains all three fields with correct values.

**R3**: Every change to the watched path while the watcher is active SHALL produce exactly one log entry.
- *Rationale*: No missed changes and no duplicate entries.
- *Verifiable by*: Making 3 changes to the watched path and confirming exactly 3 log entries exist.

**R4**: The watcher SHALL be activated by the presence of a debug flag and deactivated by the removal of that flag.
- *Rationale*: No explicit start/stop API. Lifecycle is controlled by a single flag, making it trivial to enable/disable.
- *Verifiable by*: Setting the debug flag and confirming the watcher activates; removing the flag and confirming it deactivates.

**R5**: When the debug flag is removed, the watcher SHALL stop logging and produce a signal confirming deactivation.
- *Rationale*: Consumers need confirmation that observation has ceased.
- *Verifiable by*: Removing the debug flag and confirming a "stopped" signal is produced and no further changes are logged.

**R6**: Changes occurring after deactivation SHALL NOT produce log entries.
- *Rationale*: An inactive watcher must consume no resources and produce no output.
- *Verifiable by*: Removing the debug flag, then changing the watched value, and confirming no new log entry appears.

**R7**: The watcher SHALL NOT alter the watched data path. Observation is strictly read-only.
- *Rationale*: A debugging tool that changes what it observes is worse than useless.
- *Verifiable by*: Activating a watcher and confirming the watched path's value is unchanged.

**R8**: Multiple watchers on different paths SHALL operate independently. A change to path "A" SHALL only trigger the watcher for path "A", not the watcher for path "B".
- *Rationale*: Independent watchers prevent cross-contamination and unexpected side effects.
- *Verifiable by*: Two watchers on paths "A" and "B"; changing "A" produces a log entry only in watcher A.

**R9**: The watcher SHALL observe changes within the same propagation cycle as the change itself, not asynchronously after the fact.
- *Rationale*: Out-of-band observation can miss changes or fire in the wrong order, defeating the purpose of debugging.
- *Verifiable by*: A change and its log entry are both visible in the same consistent state read.

## Acceptance Criteria

**AC1** [R2, R3]: Given an active watcher on path "target", when the value changes from null to "first", then a log entry is created with oldValue=null, newValue="first", and a timestamp.

**AC2** [R3]: Given an active watcher, when 3 changes are made to the watched path, then exactly 3 log entries exist with correct old/new values.

**AC3** [R4]: Given no debug flag, when the debug flag is set, then the watcher activates and begins logging changes.

**AC4** [R5, R6]: Given an active watcher, when the debug flag is removed, then the watcher produces a "stopped" signal and subsequent changes to the watched path produce no log entries.

**AC5** [R8]: Given watcher A on path "alpha" and watcher B on path "beta", when path "alpha" changes, then only watcher A produces a log entry.

**AC6** [R7]: Given an active watcher on path "target" with value "X", when the watcher is active, then the value at "target" remains "X".

## Open Questions

- Should the change log have a maximum size or retention policy to prevent unbounded growth during long debug sessions?
- Can a watcher target a subtree (all paths under a prefix) or only a single specific path?
- When the debug flag is re-set after removal, should a new watcher be created or should the previous one resume?
