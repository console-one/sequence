# Local Image Container

## Original Notes

(No original notes section was present in the original file. The narrative below the heading served as the design description.)

## Problem Context

- **Actor(s)**: End user (machine owner), local node process (daemon/shell/app on user's machine), central orchestrator server, remote workers.
- **Domain**: A node installed on the user's machine that participates in the distributed system while respecting user sovereignty over local resources. Must work both online (connected to the central server) and offline (standalone).
- **Core Tension**: The node must be a fully functional distributed participant while also being useful standalone when offline. Local resources are privileged -- remote nodes cannot access them -- but synchronization must not lose local work during connectivity gaps.

## Requirements

**R1**: The local node SHALL identify itself with a stable, machine-derived fingerprint that persists across process restarts on the same machine and differs on different machines.
- *Rationale*: The central server must recognize a reconnecting node as the same participant, not register a duplicate.
- *Verifiable by*: Restarting the node process on the same machine produces the same identity. Running on a different machine produces a different identity.

**R2**: The local node SHALL support at least three interaction modes: background (headless daemon), shell (CLI), and graphical (Electron or equivalent).
- *Rationale*: Users operate in different contexts -- servers run headless, developers use CLI, end-users prefer GUI. Mode affects the interaction surface but not the underlying capabilities.
- *Verifiable by*: The same set of capabilities is available in all three modes; only the input/output interface differs.

**R3**: Local capabilities (filesystem access, shell commands, installed tools) SHALL be exposed to the system only with explicit user permission, scoped to specific paths or operations.
- *Rationale*: The user's machine is not a server. Nothing is exposed by default. The user controls what directories, tools, and operations are available.
- *Verifiable by*: A capability scoped to `/home/user/projects` allows reads within that directory. An attempt to access `/etc/passwd` is denied. No capabilities are active until the user configures them.

**R4**: The local node SHALL send periodic heartbeats to the central server to maintain its registration and lock validity.
- *Rationale*: The central server must know which local nodes are currently reachable for task routing.
- *Verifiable by*: While connected, the server's registry shows the node as "online." When heartbeats stop, the server marks it accordingly.

**R5**: When the network connection drops, the node SHALL continue operating locally without data loss.
- *Rationale*: Network outages should not interrupt local work. The node is useful standalone.
- *Verifiable by*: Disconnecting the network mid-operation does not crash the node or lose in-progress state.

**R6**: The node SHALL queue outbound messages durably when offline and deliver them in order when connectivity is restored.
- *Rationale*: Work performed offline must eventually reach the central server. Messages must survive process restarts.
- *Verifiable by*: Messages generated during an offline period are delivered (in order) after reconnection. Restarting the node process while offline does not lose queued messages.

**R7**: The node SHALL maintain a local cache of relevant remote state, with staleness metadata (time since last sync) attached to each cached entry.
- *Rationale*: Offline decisions benefit from recent remote state. Staleness information lets downstream logic account for uncertainty -- stale data is better than no data, but confidence degrades with age.
- *Verifiable by*: Cached entries include a staleness duration. After 10 minutes without sync, a cached entry reports staleness of at least 10 minutes.

**R8**: The node SHALL support bidirectional synchronization: local changes propagate upstream to the server and remote changes propagate downstream to the node.
- *Rationale*: The node is not read-only -- it generates state from tool execution and user input. Both directions must flow.
- *Verifiable by*: A local change is visible on the server after sync. A remote change is visible locally after sync.

**R9**: When local and remote changes affect the same state, the node SHALL surface the conflict for resolution rather than silently overwriting either side.
- *Rationale*: Silent overwrites lose work. The user or a configured policy must decide how to resolve overlapping changes.
- *Verifiable by*: Conflicting edits produce a conflict record. Neither side is silently discarded.

**R10**: Users SHALL be able to install additional capabilities (tools, integrations) on the local node, with installation requiring explicit user consent.
- *Rationale*: Extensibility is a first-class concern. The system may suggest capabilities but must never install without consent.
- *Verifiable by*: A suggested capability is not installed until the user confirms. After installation, the capability is available for use.

## Acceptance Criteria

**AC1** [R1]: Given a node running on machine M, when the node process is restarted, then it registers with the same machine identity.

**AC2** [R2]: Given a node running in "background" mode, when switched to "shell" mode, then the same capabilities remain available and prior state is preserved.

**AC3** [R3]: Given a filesystem capability scoped to `/home/user/projects`, when a request accesses `/home/user/projects/foo.txt`, then access is granted. When a request accesses `/etc/passwd`, then access is denied.

**AC4** [R5, R6]: Given a node that goes offline with 5 pending outbound messages, when connectivity is restored, then all 5 messages are delivered in order.

**AC5** [R6]: Given a node that goes offline, generates 3 messages, and is then restarted (still offline), when connectivity is restored, then all 3 messages are delivered.

**AC6** [R7]: Given a cached entry last synced 15 minutes ago, when the entry is read locally, then it reports staleness of at least 15 minutes.

**AC7** [R8]: Given a local change to path X and a remote change to path Y (non-overlapping), when sync occurs, then the server has the change to X and the node has the change to Y.

**AC8** [R9]: Given a local change to path X and a remote change to path X (overlapping), when sync occurs, then a conflict is surfaced and neither change is silently discarded.

**AC9** [R10]: Given a suggested capability "git-integration", when the user has not confirmed installation, then the capability is NOT active. After confirmation, it is active.

## Open Questions

- **Conflict resolution policy**: Should conflicts default to manual resolution, or should there be configurable auto-resolution strategies (e.g., last-write-wins, local-wins)?
- **Cache eviction**: How much remote state should the local cache retain? Is there a size budget or LRU policy?
- **Multi-user machines**: If two users share a machine, should they share a node identity or have separate identities?
