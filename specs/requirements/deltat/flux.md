# Flux -- Expected Type Shift Over Delta T

## Original Notes

### FLUX

- Is the shift we expect for some type's API constract, or internal implementation IF computed over delta T

- For example, you can maitain a rolling time-wise sum by:

Modelling a blocks memory as:

// Open question: how do we use type semantics to model tail eviction?

[
  ${PATCH}
  sum = ${'./prev'} + diff(${./push}, ${'self WHERE REALTIME === '})['computepath']
]

^---- THIS SYNTAX (GETTING IT CORRECT, IS SUPER IMPORTANT AND TOTALLY DONE HORRIBLY CURRENTLY)

---

## Problem Context

- **Actor(s)**: Values at a path over time (accumulating, decaying, or windowed), the system (which tracks the append-only history), consumers (who read current aggregate state).
- **Domain**: Temporal value accumulation and time-windowed eviction -- how values at the same path evolve when they receive multiple updates over time, including rolling sums, deltas, and expiring contributions.
- **Core Tension**: The system is append-only (no mutation), but users need accumulation (adding to previous values) and eviction (removing old contributions after a time window). These must be modeled without mutation, and eviction must never be silent.

## Requirements

**R1**: A path's new value SHALL be expressible as a function of its previous value (e.g., `new = previous + delta`).
- *Rationale*: Rolling sums, counters, and moving averages all require referencing the prior state of the same path.
- *Verifiable by*: After three successive additions of 5, 3, and 12 to a path starting at 0, the path's value is 20.

**R2**: Each accumulation step SHALL be recorded as a new entry in the append-only log. No existing entry SHALL be modified.
- *Rationale*: Append-only semantics preserve full history for auditing and replay.
- *Verifiable by*: After 3 accumulations, the log contains 3 (or more, including the initial) distinct entries. No entry's content has changed.

**R3**: The difference between the current and previous value of a path SHALL be computable at any time.
- *Rationale*: Delta computation is fundamental to change detection, alerting, and derivative calculations.
- *Verifiable by*: After updating a temperature reading from 72 to 75, the delta is 3.

**R4**: The system SHALL support time-windowed contributions: a value that automatically expires after a specified duration.
- *Rationale*: Rolling windows (e.g., "requests in the last 60 seconds") require contributions to self-invalidate after their window closes.
- *Verifiable by*: A value contributed at t=100 with a window of 60 is present at t=150 and absent at t=161.

**R5**: When a time-windowed contribution expires, the system SHALL produce an explicit expiration signal. Expiration SHALL NOT be silent.
- *Rationale*: Downstream computations (e.g., windowed aggregates) need to know when a contribution has been removed so they can recompute. Silent expiration causes stale aggregates.
- *Verifiable by*: When a windowed entry expires, an expiration event is recorded and any registered consumers are notified.

**R6**: Aggregations derived from a set of active windowed contributions SHALL automatically recompute when any contribution expires or is added.
- *Rationale*: A rolling windowed sum must stay accurate without manual refresh.
- *Verifiable by*: Given three active entries summing to 60, when the oldest (value 10) expires, the aggregate automatically updates to 50.

**R7**: Eviction of expired entries from the log SHALL be handled by the general state management layer, not by the accumulation mechanism itself.
- *Rationale*: The flux mechanism records invalidation; it does not delete. Log compaction is a separate concern.
- *Verifiable by*: After a windowed entry expires, the original entry still exists in the raw log alongside a new invalidation entry.

**R8**: The full state of a rolling metric SHALL be queryable at any time: current aggregate value, number of active contributions, and the expiration times of the oldest and newest contributions.
- *Rationale*: Operators need to understand not just the aggregate but how it is composed and when it will next change.
- *Verifiable by*: Querying a windowed metric returns aggregate, active count, oldest expiry time, and newest expiry time.

**R9**: Accumulation SHALL support both additive and multiplicative operations (and arbitrary arithmetic on previous values).
- *Rationale*: Not all accumulation is additive. Compound growth, decay factors, and ratio tracking require multiplicative composition.
- *Verifiable by*: A path using multiplicative accumulation (previous * 1.05) starting at 100 has value 110.25 after two steps.

## Acceptance Criteria

**AC1** [R1, R2]: Given a path "total" starting at 0, when three additions of 5, 3, and 12 are applied, then total = 20 and the log contains at least 4 entries (initial + 3 additions).

**AC2** [R3]: Given a path "temperature" with previous value 72, when updated to 75, then the computed delta is 3.

**AC3** [R4, R5]: Given a windowed entry contributed at t=100 with window duration 60, when the clock reaches t=161, then the entry is no longer active and an expiration signal has been produced.

**AC4** [R6]: Given a windowed sum of three entries (10, 20, 30) = 60, when the entry with value 10 expires, then the windowed sum automatically becomes 50 and the active count drops from 3 to 2.

**AC5** [R7]: Given an expired windowed entry, when inspecting the raw log, then both the original contribution entry and the invalidation entry are present. Nothing has been deleted.

**AC6** [R8]: Given a rolling metric with 5 active entries, when querying state, then the response includes aggregate value, active count = 5, oldest expiry time, and newest expiry time.

**AC7** [R9]: Given a path using multiplicative accumulation (previous * 2) starting at 1, when applied 3 times, then the value is 8.

## Open Questions

1. What happens when a windowed contribution expires but the aggregate depends on the order of contributions (not just their sum)? Is there a requirement for order-sensitive aggregation?
2. Should the system support overlapping windows (e.g., 1-minute and 5-minute windows on the same path simultaneously)?
3. How does the clock source for windowed expiration interact with the event-driven nature of the system? Is there a background tick, or do expirations only evaluate when the system is otherwise active?
