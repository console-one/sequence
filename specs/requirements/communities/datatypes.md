# Community Data Types

## Problem Context

- **Actor(s)**: Multiple participants editing shared data concurrently without real-time coordination.
- **Domain**: Conflict-free replicated data types (CRDTs) for distributed state. When independent edits converge, the system must merge them deterministically into a single consistent state.
- **Core Tension**: Concurrent edits to shared state can conflict. Traditional locking prevents concurrency. CRDTs resolve this by restricting operations to those with mathematically guaranteed convergence -- but this limits expressiveness. The design must provide useful building blocks (counters, sets, registers, maps) whose merge functions are provably commutative, associative, and idempotent, while supporting composition (a map of counters, a set of registers).

## Requirements

**R1**: All merge-aware data types SHALL satisfy three algebraic properties: commutativity (merge(A, B) = merge(B, A)), associativity (merge(merge(A, B), C) = merge(A, merge(B, C))), and idempotency (merge(A, A) = A).
- *Rationale*: These three properties guarantee eventual consistency. Any two participants who have seen the same set of operations converge to the same state, regardless of delivery order, batching, or duplicate messages.
- *Verifiable by*: For each data type, applying the same set of operations in different orders and groupings produces an identical final state.

**R2**: The system SHALL provide a Counter type where merging is additive -- each participant's delta is summed, not overwritten.
- *Rationale*: A "last writer wins" counter loses increments when two participants increment concurrently. Additive merge preserves every participant's contribution.
- *Verifiable by*: Participant A increments by 3, participant B increments by 5, independently. After merge, the counter value is 8.

**R3**: Counters SHALL support both increment and decrement operations.
- *Rationale*: Real-world counters go both directions (credits spent and earned, stock added and removed).
- *Verifiable by*: Participant A decrements by 2, participant B increments by 5. After merge, the counter value is 3.

**R4**: The system SHALL provide a Set type with a configurable conflict policy for concurrent add-and-remove of the same element. The supported policies SHALL include at least "add-wins" and "remove-wins".
- *Rationale*: When one participant adds element X while another concurrently removes it, the outcome is ambiguous. The policy must be declared at creation time so the merge is deterministic.
- *Verifiable by*: With "add-wins" policy, concurrent add and remove of element X results in X being present. With "remove-wins" policy, X is absent.

**R5**: Set operations SHALL be idempotent -- adding the same element twice produces the same set as adding it once. Merging the same edit set twice produces the same state as merging it once.
- *Rationale*: Network duplicates are inevitable in distributed systems. Idempotency ensures that duplicate delivery does not corrupt state.
- *Verifiable by*: Adding element X twice results in a set containing exactly one X. Merging the same delta twice produces the same state as merging it once.

**R6**: The system SHALL provide a Register type that holds a single value with a configurable conflict policy for concurrent writes. The supported policies SHALL include at least "last-writer-wins" and "multi-value".
- *Rationale*: Two participants writing different values to the same register is a fundamental conflict. "Last-writer-wins" auto-resolves by timestamp. "Multi-value" preserves all conflicting values for explicit resolution.
- *Verifiable by*: With "last-writer-wins", the value with the higher timestamp survives. With "multi-value", both concurrent values are retained and surfaced.

**R7**: The system SHALL provide a Map type that merges per-key, recursively applying each value's merge semantics.
- *Rationale*: Maps are the composition point. A map of counters, a map of sets, or nested maps must all merge correctly by delegating to each value type's merge function.
- *Verifiable by*: Participant A sets map["hits"] += 3, participant B sets map["hits"] += 2 and map["errors"] += 1. After merge, map contains {hits: 5, errors: 1} (counter merge on same key, independent keys coexist).

**R8**: Merge-aware types SHALL be composable -- a map of counters, a set of registers, a map of maps -- with the merge function applied structurally and recursively.
- *Rationale*: Real-world data structures are nested. The merge guarantees must hold for arbitrary compositions, not just flat primitives.
- *Verifiable by*: A map containing a counter at key "views" and a set at key "tags" merges correctly: the counter merges additively and the set merges per its policy.

## Data Model

```ft
Counter = {
  value: number,
  delta: number
}

MergeSet = {
  elements: ref(setElements),
  policy: "add-wins" | "remove-wins"
}

Register = {
  value: ref(registerValue),
  timestamp: number.integer >= 0,
  writer: string,
  policy: "last-writer-wins" | "multi-value"
}

MergeMap = {
  entries: ref(mapEntries),
  keyMerge: ref(mergeStrategy)
}
```

## Acceptance Criteria

**AC1** [R1, R2]: Given counter A with delta +3 and counter B with delta +5, when merged in either order (A-then-B or B-then-A), then the result is 8.

**AC2** [R3]: Given counter A with delta -2 and counter B with delta +5, when merged, then the result is 3.

**AC3** [R1]: Given counters A (+3), B (+5), C (+2) merged as (A,B) then C and as A then (B,C), then both produce 10.

**AC4** [R4]: Given a set with "add-wins" policy, when participant A adds "foo" and participant B concurrently removes "foo", then after merge "foo" is present.

**AC5** [R4]: Given a set with "remove-wins" policy, when participant A adds "foo" and participant B concurrently removes "foo", then after merge "foo" is absent.

**AC6** [R5]: Given a set, when "foo" is added twice, then the set contains exactly one "foo". When the same delta is merged twice, the set is unchanged.

**AC7** [R6]: Given a register with "last-writer-wins" policy, when participant A writes "hello" at T=5 and participant B writes "world" at T=7, then after merge the register contains "world".

**AC8** [R6]: Given a register with "multi-value" policy, when participant A writes "hello" and participant B concurrently writes "world", then after merge both values are retained.

**AC9** [R7, R8]: Given a map with key "hits" (counter type) and key "tags" (set type with add-wins), when participant A sets hits += 3 and adds tag "new", and participant B sets hits += 2, then after merge hits = 5 and tags contains "new".

**AC10** [R1]: Given any merge-aware type and the same set of operations applied in 10 different random orders, then all 10 produce the identical final state.

## Open Questions

- Should there be a "conflict" data type that explicitly captures unresolved conflicts for types beyond registers (e.g., structural conflicts in maps)?
- What is the garbage collection strategy for tombstones in remove-wins sets?
- Should the system support custom merge functions, or restrict to the four built-in types?
