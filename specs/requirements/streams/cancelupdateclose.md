# Cancel, Update, Close

## Original Notes

An active operation is one whose lifetime condition currently holds. There is no "status" flag to toggle -- liveness is derived from whether the declared condition is true. The three lifecycle transitions (update, cancel, close) must be distinct in semantics but expressed through existing mechanisms: write, invalidation, and condition-break. Cancel is unilateral revocation. Close is graceful self-termination. Update is just another write.

No separate "update", "cancel", or "close" primitives exist. Reactions to lifecycle changes are declarative (condition-based), never procedural (callback-based).

## Problem Context

- **Actor(s)**: The operation itself (self-termination via close); an external authority (unilateral cancellation); any writer (updates); downstream operations (reacting to lifecycle changes).
- **Domain**: Managing the lifecycle of long-running or stateful operations with three distinct transitions: update (modify in place), close (graceful self-termination), and cancel (unilateral external revocation).
- **Core Tension**: These three transitions have fundamentally different semantics (update preserves liveness, close is cooperative, cancel is unilateral), but they should be expressible through the same general-purpose mechanisms rather than requiring dedicated lifecycle primitives.

## Requirements

**R1**: An operation SHALL be considered active while its declared lifetime condition holds, and inactive when the condition no longer holds.
- *Rationale*: Liveness is derived from conditions, not status flags, ensuring consistency between the operation's state and its observability.
- *Verifiable by*: An operation with a lifetime condition is observable while the condition holds; it becomes unobservable when the condition is broken.

**R2**: Update SHALL be a write to the operation's value path that replaces the previous value without affecting the lifetime condition.
- *Rationale*: Updating an operation is just data modification; it should not change liveness.
- *Verifiable by*: Write a new value to an active operation -- the value changes and the operation remains active with the same lifetime condition.

**R3**: Close SHALL be a graceful self-termination where the operation writes a value that breaks its own lifetime condition.
- *Rationale*: Close is cooperative -- the operation itself decides to terminate by invalidating its own liveness condition.
- *Verifiable by*: An operation sets its status to "closed", breaking its "status = active" lifetime condition -- the operation's value becomes unobservable and a closure signal is emitted.

**R4**: Cancel SHALL be a unilateral external revocation that removes the operation's contributions from observable state.
- *Rationale*: Cancel is non-cooperative -- an external authority terminates the operation regardless of the operation's own lifecycle.
- *Verifiable by*: An external actor cancels an operation -- the operation's value is removed from observable state and the status is recorded as "cancelled".

**R5**: Cancel and close SHALL be distinguishable in the audit trail.
- *Rationale*: Post-mortem analysis needs to determine whether an operation ended by its own decision or was forcibly terminated.
- *Verifiable by*: After a close, the recorded status is "closed". After a cancel, the recorded status is "cancelled". These are distinct values.

**R6**: A closure signal SHALL be emitted when an operation closes, enabling downstream operations to react declaratively.
- *Rationale*: Downstream operations (e.g., cleanup, archival) need to know when an upstream operation terminates, without polling or callbacks.
- *Verifiable by*: A downstream operation conditioned on the closure signal activates automatically when the upstream operation closes.

**R7**: Downstream reactions to lifecycle changes SHALL be condition-based (declarative), not callback-based (procedural).
- *Rationale*: Callbacks create temporal coupling and ordering dependencies; condition-based reactions are idempotent and order-independent.
- *Verifiable by*: A downstream operation that depends on a closure signal is declared as a condition, not registered as a callback -- and it activates regardless of when it was declared relative to the close event.

## Acceptance Criteria

**AC1** [R1]: Given an operation with lifetime condition "status = active", when status is "active", then the operation's value is observable. When status changes to anything else, then the value is no longer observable.

**AC2** [R2]: Given an active operation with value "initial payload", when the value is updated to "updated payload", then the operation's value is "updated payload" and the operation remains active.

**AC3** [R3]: Given an active operation, when it sets its own status to "closed", then its value becomes unobservable and a closure signal is emitted.

**AC4** [R4]: Given an active operation, when an external actor cancels it, then the operation's value is removed from observable state and status is "cancelled".

**AC5** [R5]: Given one closed operation and one cancelled operation, when the audit trail is inspected, then they have distinct status values ("closed" vs. "cancelled").

**AC6** [R6, R7]: Given a downstream operation conditioned on a closure signal, when the upstream operation closes, then the downstream operation activates automatically without polling or callback registration.

## Open Questions

- Can a cancelled operation be "uncancelled" (reactivated), or is cancellation permanent?
- Should the closure signal carry metadata (e.g., close reason, final value)?
- How should concurrent cancel and close (racing) be resolved -- does cancel always win?
