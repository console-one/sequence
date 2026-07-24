# Community Clocks

Independent participants in a community have no shared clock. Each has its own local notion of time. The system must synthesize a shared ordering that respects causality -- if event A caused event B, then A is ordered before B -- while honestly acknowledging concurrency. Two events produced independently, with no message passing between them, must not be given a fabricated ordering. The system says "these are concurrent" because that is the truth.

Physical timestamps are unreliable across hosts. Logical clocks are consistent but lose wall-clock meaning. The tradeoff is between simplicity (scalar Lamport clocks, which can say "possibly before" but not "definitely concurrent") and precision (vector clocks, which track per-participant counters and give exact causality information at the cost of O(n) storage per event).

## The Participant Clock

Each participant maintains a local logical clock that advances monotonically. Every event the participant produces is tagged with the current clock value:

```ft
ParticipantClock = {
  participantId: string,
  counter: number.integer >= 0,
  lastEvent: number.integer >= 0
}
```

The `counter` never decreases. On each local event, the participant advances the counter and tags the event with the new value. `lastEvent` records the clock value of the most recent event for external inspection.

## Clock Advancement

When a participant produces a local event, the clock advances by one:

```ft
clock1 = ParticipantClock
clock1 << { participantId: "participant-A", counter: 0, lastEvent: 0 }

-- Local event occurs
clock1 << { counter: prev + 1 }
clock1 << { lastEvent: prev.counter }
```

The `counter: prev + 1` is the monotonic increment. Each event gets a strictly greater clock value than the previous one. The increment is unconditional -- every event, whether sent or purely local, advances the clock.

## Clock Merge on Message Receipt

When a participant receives a message from another participant, the recipient's clock must advance to at least the sender's clock value plus one. This is the core Lamport property -- it ensures causal ordering across participants:

```ft
-- Participant B receives message from A with clock value 10
-- B's current counter is 7
-- B must advance to at least max(7, 10) + 1 = 11
clock2 = ParticipantClock
clock2 << { participantId: "participant-B", counter: 11, lastEvent: 11 }
```

The merge rule: `new_counter = max(local_counter, received_counter) + 1`. This guarantees that all events after receipt are ordered after the send event. The causal chain is preserved in the clock values.

## Vector Clocks

For precise concurrency detection, each participant maintains a vector -- one counter per participant in the community:

```ft
VectorClock = {
  participantId: string,
  entries: ref(vectorEntries)
}
```

Each entry in the vector tracks the latest known counter value for one participant. When comparing two vector clocks, the ordering is determined component-wise: clock A is "before" clock B if every component of A is less than or equal to the corresponding component of B (and at least one is strictly less). If neither clock dominates the other, the events are concurrent.

Vector clock comparison is O(n) where n is the number of participants -- linear in community size, not exponential.

## Causal Ordering

Given two events, the system determines one of three verdicts: A happened before B, B happened before A, or the events are concurrent:

```ft
CausalOrder = {
  eventA: ref(eventRecord),
  eventB: ref(eventRecord),
  verdict: "before" | "after" | "concurrent"
}
```

For scalar Lamport clocks, `clock(A) < clock(B)` means A is "possibly before" B (but could be concurrent). For vector clocks, the component-wise comparison gives an exact answer. Two events produced independently by different participants with no message exchange between them are reported as concurrent -- the system does not fabricate an ordering.

## Event Tagging

Every event produced by a participant carries the participant's clock value at the time of production:

```ft
EventRecord = {
  participantId: string,
  clockValue: number.integer >= 0,
  payload: ref(eventPayload)
}
```

The clock tag is how recipients determine ordering. An untagged event is unorderable and must be rejected.

## Capabilities

Clock operations -- advancement, merging, and event tagging -- are provided by the participant process:

```ft
cap ParticipantClock.counter
cap ParticipantClock.lastEvent
cap VectorClock.entries
cap EventRecord.clockValue
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Clock advances monotonically on local event | `counter: prev + 1` on each event |
| Events tagged with clock value | `EventRecord` carries `clockValue` from participant |
| Clock merges on message receipt | Recipient advances to `max(local, received) + 1` |
| Causal ordering determined | `CausalOrder.verdict` returns before/after/concurrent |
| Concurrent events not falsely ordered | Vector clock comparison: neither dominates means concurrent |
| Vector clocks enable precise concurrency detection | Component-wise comparison distinguishes concurrent from ordered |
| Clock comparison is efficient | O(n) comparison where n = participant count |
| Scales from 2 to hundreds of participants | Clock structures are per-participant, vector grows linearly |
