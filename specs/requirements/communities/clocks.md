# Community Clocks

## Problem Context

- **Actor(s)**: Independent participants in a distributed community, each with its own local clock.
- **Domain**: Distributed time and causal ordering. Participants produce events independently with no shared clock. The system must establish ordering relationships (happened-before, happened-after, concurrent) without relying on synchronized physical timestamps.
- **Core Tension**: Physical timestamps are unreliable across hosts (clock skew, drift). Logical clocks provide consistent ordering but lose wall-clock meaning. Scalar Lamport clocks are simple but can only say "possibly before" -- they cannot distinguish "definitely before" from "concurrent". Vector clocks give exact causality at O(n) storage per event, where n is the number of participants. The design must choose the right tradeoff for the expected community size.

## Requirements

**R1**: Each participant SHALL maintain a local logical clock that advances monotonically. Every event produced by the participant SHALL be tagged with the current clock value.
- *Rationale*: Monotonic advancement guarantees that a participant's own events are totally ordered. Tagging events with clock values is the basis for all ordering comparisons.
- *Verifiable by*: For any sequence of events from a single participant, each event's clock value is strictly greater than the previous event's clock value.

**R2**: On each local event, the participant's clock SHALL advance by at least one.
- *Rationale*: A clock that does not advance on every event would produce events with identical timestamps, making ordering ambiguous even for a single participant's own events.
- *Verifiable by*: After producing N events, the participant's clock value is at least N.

**R3**: When a participant receives a message from another participant, the recipient's clock SHALL advance to at least `max(local_counter, received_counter) + 1` before tagging any subsequent event.
- *Rationale*: This is the Lamport clock merge rule. It ensures that all events causally following a message receipt are ordered after the send event. Without this, causal ordering across participants is lost.
- *Verifiable by*: Participant B at clock 7 receives a message sent by A at clock 10. B's next event has clock value >= 12 (max(7, 10) + 1).

**R4**: The system SHALL support vector clocks for precise concurrency detection. Each participant's vector clock SHALL maintain one counter per known participant.
- *Rationale*: Scalar Lamport clocks cannot distinguish "happened-before" from "concurrent". Vector clocks resolve this by tracking per-participant progress, giving exact causality at the cost of O(n) storage.
- *Verifiable by*: Two events produced independently by different participants with no message exchange between them are correctly identified as concurrent (neither vector dominates the other).

**R5**: Given two events, the system SHALL determine one of three verdicts: A happened-before B, B happened-before A, or A and B are concurrent.
- *Rationale*: This is the fundamental ordering query. "Concurrent" means the events are causally independent -- fabricating an ordering would be incorrect and could lead to wrong conflict resolution.
- *Verifiable by*: For events with a causal chain (A sent a message that B received before producing its event), the verdict is "happened-before". For events produced independently with no message exchange, the verdict is "concurrent".

**R6**: An event without a clock tag SHALL be rejected as unorderable.
- *Rationale*: An untagged event cannot participate in ordering. Accepting it would create a gap in the causal history that could lead to incorrect merge decisions.
- *Verifiable by*: Submitting an event without a clock value produces an error. The event is not incorporated into the ordering.

**R7**: The clock system SHALL scale from 2 to hundreds of participants without requiring protocol changes.
- *Rationale*: Communities grow. The clock protocol must not break or require redesign as participants are added.
- *Verifiable by*: A vector clock comparison with 200 participants completes in O(n) time. Adding a new participant does not require reprocessing existing events.

## Data Model

```ft
ParticipantClock = {
  participantId: string,
  counter: number.integer >= 0,
  lastEvent: number.integer >= 0
}

VectorClock = {
  participantId: string,
  entries: ref(vectorEntries)
}

EventRecord = {
  participantId: string,
  clockValue: number.integer >= 0,
  payload: ref(eventPayload)
}

CausalOrder = {
  eventA: ref(eventRecord),
  eventB: ref(eventRecord),
  verdict: "before" | "after" | "concurrent"
}
```

## Acceptance Criteria

**AC1** [R1, R2]: Given participant A with clock at 0, when A produces 5 local events, then each event's clock value is strictly greater than the previous, and the final clock value is at least 5.

**AC2** [R3]: Given participant B with clock at 7, when B receives a message from participant A sent at clock 10, then B's next event has clock value >= 12.

**AC3** [R4, R5]: Given participant A producing event E1 and participant B producing event E2 with no message exchange between them, when their causal order is queried, then the verdict is "concurrent".

**AC4** [R4, R5]: Given participant A producing event E1 and sending a message to B, and B producing event E2 after receiving that message, when the causal order of E1 and E2 is queried, then the verdict is "E1 happened-before E2".

**AC5** [R6]: Given an event with no clock value, when it is submitted to the ordering system, then it is rejected.

**AC6** [R7]: Given a community of 200 participants, when two vector clocks are compared, then the comparison completes in O(n) time with n = 200.

## Open Questions

- Should the system support both scalar Lamport clocks (simpler, less storage) and vector clocks (precise concurrency), or commit to vector clocks only?
- What is the garbage collection strategy for vector clock entries when participants leave the community?
- Should there be a physical timestamp alongside the logical clock for human-readable display, explicitly marked as unreliable for ordering?
