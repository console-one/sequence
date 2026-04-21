# FSM

## Problem Context

- **Actor(s)**: Entities with lifecycle states (e.g., orders), External triggers (e.g., payment, shipment), Consumers (need to know valid actions for current state)
- **Domain**: State machine enforcement -- entities transition through a defined lifecycle with conditional transitions, required data per transition, and visibility into which transitions are currently valid
- **Core Tension**: Invalid transitions must not silently fail or corrupt state. The set of valid actions must always be derivable from the current state without maintaining a separate transition table. Intent for an invalid transition should be preserved (not destroyed) in case the state changes to make it valid later.

## Requirements

**R1**: An entity's state SHALL be constrained to a defined set of valid lifecycle values (e.g., "created", "paid", "shipped", "delivered").
- *Rationale*: The state field must never hold an invalid value.
- *Verifiable by*: Attempting to set state to an undefined value and confirming it is rejected.

**R2**: An entity SHALL be in exactly one state at any time.
- *Rationale*: Ambiguous state (two simultaneous states) makes transitions undefined.
- *Verifiable by*: After any operation, querying the entity's state returns exactly one value.

**R3**: A state transition SHALL only succeed when the entity's current state matches the required precondition for that transition.
- *Rationale*: The transition graph defines the valid lifecycle. Skipping states (e.g., shipping an unpaid order) must be prevented.
- *Verifiable by*: Attempting to transition from "created" directly to "shipped" and confirming it does not succeed.

**R4**: An attempted transition that does not match the current state SHALL be suspended (intent preserved), not rejected (intent destroyed).
- *Rationale*: Suspension preserves intent. If a later state change makes the transition valid, it can proceed. Rejection destroys information.
- *Verifiable by*: Attempting "pay" on a "paid" entity, then reverting the entity to "created", and confirming the suspended "pay" intent can now proceed.

**R5**: Each transition SHALL carry required associated data (e.g., "pay" requires a payment reference, "ship" requires a tracking number).
- *Rationale*: Transitions are not just status changes; they accumulate data that is meaningful for the entity's lifecycle.
- *Verifiable by*: Completing a "pay" transition and confirming the payment reference is stored on the entity.

**R6**: A transition attempted without its required data SHALL surface the missing data as identifiable, actionable items.
- *Rationale*: The system must tell the caller exactly what is needed to complete the transition.
- *Verifiable by*: Attempting "pay" without a payment reference and confirming the missing field is reported.

**R7**: The set of currently valid transitions SHALL be derivable from the entity's current state at any time.
- *Rationale*: Consumers need to know what actions are possible without consulting a separate transition table.
- *Verifiable by*: When state is "created", querying valid transitions returns "pay". When state is "paid", it returns "ship".

**R8**: After a transition succeeds, the previously-valid transition SHALL no longer be valid.
- *Rationale*: The transition graph is directional. "Pay" is valid from "created" but not from "paid".
- *Verifiable by*: After transitioning to "paid", confirming "pay" is no longer listed as a valid transition.

**R9**: Multiple entities of the same type SHALL maintain independent state. Transitioning one entity SHALL NOT affect another.
- *Rationale*: Entity independence is fundamental; shared state machines are a different pattern.
- *Verifiable by*: Entity A in "created" and entity B in "paid"; transitioning A to "paid" does not change B.

## Acceptance Criteria

**AC1** [R1]: Given the valid states "created", "paid", "shipped", "delivered", when attempting to set state to "cancelled" (not in the valid set), then the operation is rejected.

**AC2** [R3]: Given an entity in state "created", when a "pay" transition is attempted with a payment reference, then the state becomes "paid" and the payment reference is stored.

**AC3** [R3]: Given an entity in state "created", when a "ship" transition is attempted, then the transition does not succeed (the precondition "paid" is not met).

**AC4** [R4]: Given an entity in state "paid", when a "pay" transition is attempted, then the intent is suspended. If the entity later reverts to "created", the suspended "pay" can proceed.

**AC5** [R5, R6]: Given an entity in state "created", when "pay" is attempted without a payment reference, then the missing "paymentRef" field is surfaced as required.

**AC6** [R7]: Given an entity in state "paid", when valid transitions are queried, then "ship" (with "tracking" required) is returned.

**AC7** [R8]: Given an entity just transitioned to "paid", when valid transitions are queried, then "pay" is no longer listed.

**AC8** [R9]: Given entity A in "created" and entity B in "paid", when entity A transitions to "paid", then entity B remains in "paid" unaffected.

## Open Questions

- Should suspension have a timeout? If a suspended intent waits indefinitely, it could accumulate unboundedly.
- Are reverse transitions (e.g., "paid" back to "created") allowed, or is the lifecycle strictly forward?
- Can the valid state set and transition graph be defined dynamically, or is it fixed at declaration time?
