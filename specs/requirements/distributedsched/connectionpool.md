# Connection Pool

Connections are expensive to create and limited in number. Too many exhaust the target; too few create bottlenecks. The pool enforces a hard cap, queues excess requests, and automatically serves them when capacity becomes available. There is no busy-waiting, no retry logic pushed to callers, and no manual lock management.

The core mechanism: a bounded counter gates acquisition. When the count reaches the maximum, subsequent requests suspend. When a connection is released, the oldest pending request resumes automatically. The pool is self-managing.

## Problem Context

- **Actor(s)**: Client code requesting connections, the pool manager enforcing capacity, downstream targets (databases, APIs) that have finite connection limits.
- **Domain**: Resource management for expensive, limited-supply connections to external services.
- **Core Tension**: Callers need connections on demand, but the target cannot handle unbounded concurrency. The pool must bound concurrency without forcing callers to implement retry/backoff logic.

## Requirements

**R1**: Each pool SHALL enforce a configurable maximum number of concurrent active connections.
- *Rationale*: Different targets have different concurrency limits. A database may tolerate 10 connections; a high-throughput API may tolerate 200.
- *Verifiable by*: A pool configured with max N never has more than N connections in "active" status simultaneously.

**R2**: The pool SHALL report whether it is full, derived from comparing the active connection count against the configured maximum.
- *Rationale*: Callers and monitoring systems need to know current capacity without inspecting individual connections.
- *Verifiable by*: A pool with N active connections and max N reports `full = true`; a pool with fewer than N active reports `full = false`.

**R3**: When the pool is full, new connection requests SHALL be queued rather than rejected.
- *Rationale*: Callers should not need to implement retry logic. Queuing absorbs transient bursts and serves requests as capacity returns.
- *Verifiable by*: A request made against a full pool does not receive an error; it receives a connection after one is released.

**R4**: Queued requests SHALL be served in FIFO order when capacity becomes available.
- *Rationale*: Fairness prevents starvation of earlier requests. Without ordering, later requests could repeatedly jump the queue.
- *Verifiable by*: Given requests A, B, C queued in that order, A receives a connection before B, and B before C, as connections are released.

**R5**: Each connection SHALL track its target, acquisition time, and current status ("active" or "released").
- *Rationale*: Connection metadata is needed for monitoring, debugging, and enforcing lifecycle rules.
- *Verifiable by*: An active connection exposes its target, the time it was acquired, and its current status.

**R6**: Releasing a connection SHALL invalidate all operations that depend on that connection being active.
- *Rationale*: Operations using a released connection would produce errors or undefined behavior. Cascading invalidation prevents use-after-release.
- *Verifiable by*: An operation conditioned on a connection being active terminates or suspends when that connection is released.

**R7**: Multiple pools targeting different services SHALL operate independently.
- *Rationale*: Exhausting the connection budget for one service must not block connections to another service.
- *Verifiable by*: Pool A at capacity while Pool B has available connections; a request to Pool B succeeds immediately.

## Acceptance Criteria

**AC1** [R1]: Given a pool with `maxConnections: 10`, when 10 connections are acquired, then the 11th acquisition request is not immediately fulfilled.

**AC2** [R2]: Given a pool with `maxConnections: 10` and 10 active connections, when the pool's full status is queried, then it reports `true`. When one connection is released, it reports `false`.

**AC3** [R3]: Given a full pool, when a new connection request is made, then no error is returned; the request is queued.

**AC4** [R4]: Given queued requests A, B, C (in order) against a full pool, when three connections are released one at a time, then A is served first, then B, then C.

**AC5** [R5]: Given an active connection, when its metadata is inspected, then it exposes the target address, acquisition timestamp, and status "active".

**AC6** [R6]: Given an active connection with dependent operations, when the connection is released, then all dependent operations are terminated or suspended.

**AC7** [R7]: Given Pool A (full, targeting service-a) and Pool B (available, targeting service-b), when a connection is requested from Pool B, then it is served immediately regardless of Pool A's state.

## Open Questions

- **Connection health checks**: Should the pool validate that a connection is still usable before handing it to a queued requester? Stale connections from long-idle pools are a common production issue.
- **Queue depth limits**: Should there be a configurable maximum queue depth, beyond which requests are rejected rather than queued indefinitely?
- **Connection TTL**: Should connections have a maximum lifetime after which they are forcibly released, even if still in use?
